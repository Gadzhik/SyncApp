import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Device {
  id: string
  /** Персональный токен устройства: его можно отозвать, не трогая остальные. */
  token: string
  name: string
  ip: string
  pairedAt: number
  lastSeen: number
}

/** Устройство в том виде, в каком его можно показывать в интерфейсе — без токена. */
export type PublicDevice = Omit<Device, 'token'>

/** Человекочитаемое имя из User-Agent: точная модель браузеру недоступна. */
export function describeClient(userAgent: string): string {
  const ua = userAgent || ''
  const platform =
    /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
    : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS/i.test(ua) ? 'Mac'
    : /Linux/i.test(ua) ? 'Linux'
    : 'устройство'

  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /YaBrowser/i.test(ua) ? 'Яндекс'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : ''

  return browser ? `${platform} · ${browser}` : platform
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Реестр привязанных устройств. Общий токен служит кодом привязки: обменяв его
 * на персональный, устройство получает доступ, который можно отозвать отдельно
 * от остальных.
 */
export class DeviceStore {
  readonly #file: string
  #devices: Device[] = []
  #writing: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.#file = join(dataDir, 'devices.json')
    this.#devices = this.#read()
  }

  #read(): Device[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is Device =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Device).id === 'string' &&
          typeof (item as Device).token === 'string',
      )
    } catch {
      return []
    }
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#devices, null, 2)
    this.#writing = this.#writing.then(() => writeFile(this.#file, snapshot, 'utf8')).catch(() => {})
    return this.#writing
  }

  list(): PublicDevice[] {
    return this.#devices
      .map(({ token: _token, ...rest }) => rest)
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  byToken(token: string): Device | undefined {
    return this.#devices.find((device) => equals(device.token, token))
  }

  get(id: string): Device | undefined {
    return this.#devices.find((device) => device.id === id)
  }

  async pair(name: string, ip: string): Promise<Device> {
    const now = Date.now()
    const device: Device = {
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      name,
      ip,
      pairedAt: now,
      lastSeen: now,
    }
    this.#devices = [device, ...this.#devices]
    await this.#persist()
    return device
  }

  /** Отметка активности; запись на диск не чаще раза в минуту, чтобы не дёргать ФС. */
  touch(id: string, ip?: string): void {
    const device = this.get(id)
    if (!device) return
    const now = Date.now()
    const stale = now - device.lastSeen > 60_000
    device.lastSeen = now
    if (ip) device.ip = ip
    if (stale) void this.#persist()
  }

  async remove(id: string): Promise<boolean> {
    const next = this.#devices.filter((device) => device.id !== id)
    if (next.length === this.#devices.length) return false
    this.#devices = next
    await this.#persist()
    return true
  }

  /** Используется при смене общего токена — отвязывает всё разом. */
  async clear(): Promise<void> {
    this.#devices = []
    await this.#persist()
  }
}
