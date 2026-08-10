import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

export interface LanAddress {
  address: string
  /** Имя сетевого интерфейса — по нему отсеиваем виртуальные адаптеры. */
  iface: string
}

/**
 * Адаптеры WSL, Hyper-V, VirtualBox, VMware и Docker дают адреса из приватных
 * диапазонов, но телефон по ним не достучится: это изолированные подсети хоста.
 */
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-?v|docker|loopback|tailscale|zerotier|tap-|tun\d|npcap/i

function rank({ address, iface }: LanAddress): number {
  if (VIRTUAL.test(iface)) return 10
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2
  return 3
}

/**
 * Внешние IPv4-адреса машины. Отсеиваем loopback и APIPA (169.254.*) — они
 * бесполезны для телефона.
 */
export function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = []
  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      found.push({ address: addr.address, iface })
    }
  }
  return found.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
}

/**
 * Адрес принадлежит одному из интерфейсов самой машины. Берём их напрямую, а не через
 * `lanAddresses`: там адреса отобраны для телефона (без виртуальных адаптеров и APIPA),
 * а здесь важен любой адрес, с которого может прийти запрос с этого же компьютера.
 */
export function isOwnAddress(ip: string): boolean {
  // IPv4 в IPv6-обёртке (::ffff:10.0.0.5) и ссылочный адрес с зоной (fe80::1%wlan0)
  const clean = (ip.startsWith('::ffff:') ? ip.slice(7) : ip).split('%')[0]
  if (!clean) return false
  for (const addresses of Object.values(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (!addr.internal && addr.address === clean) return true
    }
  }
  return false
}

/**
 * Адрес интерфейса, через который система реально выходит в сеть. UDP-сокет
 * ничего не отправляет: connect лишь заставляет ядро выбрать маршрут, после чего
 * локальный адрес сокета и есть нужный. Это надёжнее любой эвристики по именам,
 * потому что решение принимает сама таблица маршрутизации.
 */
function routedAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createSocket>
    try {
      socket = createSocket('udp4')
    } catch {
      resolve(null)
      return
    }
    const done = (value: string | null): void => {
      try {
        socket.close()
      } catch {
        /* уже закрыт */
      }
      resolve(value)
    }
    const timer = setTimeout(() => done(null), 300)
    timer.unref()
    socket.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    try {
      socket.connect(53, '198.51.100.1', () => {
        clearTimeout(timer)
        try {
          const { address } = socket.address()
          done(address && address !== '0.0.0.0' ? address : null)
        } catch {
          done(null)
        }
      })
    } catch {
      clearTimeout(timer)
      done(null)
    }
  })
}

/** Адрес для QR-кода: маршрутизируемый, иначе лучший по эвристике, иначе localhost. */
export async function primaryAddress(): Promise<string> {
  const routed = await routedAddress()
  if (routed) {
    const known = lanAddresses().find((entry) => entry.address === routed)
    // адрес из таблицы маршрутизации принимаем, даже если интерфейс не в списке
    if (!known || !VIRTUAL.test(known.iface)) return routed
  }
  return lanAddresses()[0]?.address ?? '127.0.0.1'
}

export function connectUrl(address: string, port: number, token: string, secure = false): string {
  return `${secure ? 'https' : 'http'}://${address}:${port}/?t=${encodeURIComponent(token)}`
}
