/**
 * Обнаружение соседних компьютеров с LanSync в той же сети.
 *
 * Телефон подключается по QR-коду, но между двумя компьютерами сканировать нечего: адрес
 * соседа пришлось бы вводить руками. mDNS решает это тем же способом, каким принтеры и
 * колонки находятся в сети, и не требует ни сервера в интернете, ни новых зависимостей —
 * `bonjour-service` уже используется для анонса.
 *
 * Полагаться только на mDNS нельзя: в гостевых и офисных сетях многоадресную рассылку
 * часто режут. Поэтому соседа всегда можно добавить и вручную по адресу — обнаружение
 * лишь избавляет от этого в обычном случае.
 */

/** Тип службы. Собственный, а не `http`: искать нужно именно LanSync, а не всё подряд. */
export const SERVICE_TYPE = 'lansync'

export interface DiscoveredPeer {
  id: string
  name: string
  host: string
  port: number
  tls: boolean
  /** Отпечаток сертификата из анонса. Доверять ему нельзя — он лишь подсказка до привязки. */
  fingerprint: string | null
  lastSeen: number
}

export interface DiscoveryOptions {
  /** Идентификатор этого компьютера: по нему отсеивается собственный анонс. */
  selfId: string
  deviceName: string
  port: number
  tls: boolean
  fingerprint: string | null
  onChange?: () => void
}

export interface Discovery {
  list(): DiscoveredPeer[]
  get(id: string): DiscoveredPeer | undefined
  stop(): void
}

/** Заглушка на случай выключенного mDNS: соседей добавляют вручную по адресу. */
export const NO_DISCOVERY: Discovery = {
  list: () => [],
  get: () => undefined,
  stop: () => {},
}

/** Адрес, по которому до соседа реально достучаться: IPv4 без APIPA. */
function pickAddress(addresses: string[] | undefined): string | null {
  for (const address of addresses ?? []) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue
    if (address.startsWith('169.254.')) continue
    return address
  }
  return null
}

/** Значения TXT-записи приходят строками или буферами — приводим к строке. */
function txtValue(txt: Record<string, unknown> | undefined, key: string): string | null {
  const value = txt?.[key]
  if (typeof value === 'string') return value || null
  if (Buffer.isBuffer(value)) return value.toString('utf8') || null
  return null
}

export async function startDiscovery(options: DiscoveryOptions): Promise<Discovery> {
  try {
    const { Bonjour } = await import('bonjour-service')
    const bonjour = new Bonjour()
    const found = new Map<string, DiscoveredPeer>()

    bonjour.publish({
      /*
       * Имя службы должно быть уникальным в сети, а два экземпляра на одной машине
       * (штатный способ проверить обмен) делят и имя хоста, и адрес. Хвост из
       * идентификатора разводит их; людям показывается `name` из TXT-записи.
       */
      name: `LanSync (${options.deviceName}) ${options.selfId.slice(0, 6)}`,
      type: SERVICE_TYPE,
      port: options.port,
      txt: {
        id: options.selfId,
        name: options.deviceName,
        tls: options.tls ? '1' : '0',
        ...(options.fingerprint ? { fp: options.fingerprint } : {}),
      },
    })

    const remember = (service: { txt?: Record<string, unknown>; addresses?: string[]; port: number }): void => {
      const id = txtValue(service.txt, 'id')
      // Чужие службы того же типа без нашей TXT-записи и собственный анонс пропускаем.
      if (!id || id === options.selfId) return
      const host = pickAddress(service.addresses)
      if (!host) return

      found.set(id, {
        id,
        name: txtValue(service.txt, 'name') ?? host,
        host,
        port: service.port,
        tls: txtValue(service.txt, 'tls') !== '0',
        fingerprint: txtValue(service.txt, 'fp'),
        lastSeen: Date.now(),
      })
      options.onChange?.()
    }

    const forget = (service: { txt?: Record<string, unknown> }): void => {
      const id = txtValue(service.txt, 'id')
      if (id && found.delete(id)) options.onChange?.()
    }

    const browser = bonjour.find({ type: SERVICE_TYPE })
    browser.on('up', remember)
    browser.on('txt-update', remember)
    browser.on('srv-update', remember)
    browser.on('down', forget)

    return {
      list: () => [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
      get: (id) => found.get(id),
      stop: () => {
        try {
          browser.stop()
          bonjour.destroy()
        } catch {
          /* уже остановлено */
        }
      },
    }
  } catch {
    // mDNS — необязательная приятность; без него остаётся добавление соседа по адресу
    return NO_DISCOVERY
  }
}
