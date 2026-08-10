import { timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Config } from './config.js'
import type { Device, DeviceStore } from './devices.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Токен приходит заголовком или в query — ссылки на скачивание и WebSocket заголовок задать не могут. */
export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers['x-sync-token']
  if (typeof header === 'string' && header) return header
  const query = request.query as Record<string, unknown> | undefined
  const fromQuery = query?.['t']
  return typeof fromQuery === 'string' && fromQuery ? fromQuery : null
}

export interface AuthResult {
  ok: boolean
  /** Запрос пришёл с самой машины — токен не требуется. */
  local: boolean
  /** Устройство, чей персональный токен предъявлен. */
  device: Device | null
  /** Предъявлен общий токен привязки, а не персональный. */
  shared: boolean
}

/**
 * Доступ даётся тремя путями:
 *  - запрос с самой машины (иначе пришлось бы копировать секрет в свой же браузер);
 *  - персональный токен устройства — его можно отозвать отдельно;
 *  - общий токен из QR-кода — он же код привязки и запасной путь для скриптов.
 */
export function authorize(request: FastifyRequest, config: Config, devices: DeviceStore): AuthResult {
  if (LOOPBACK.has(request.ip)) return { ok: true, local: true, device: null, shared: false }

  const token = extractToken(request)
  if (!token) return { ok: false, local: false, device: null, shared: false }

  const device = devices.byToken(token)
  if (device) {
    devices.touch(device.id, request.ip)
    return { ok: true, local: false, device, shared: false }
  }

  if (equals(token, config.token)) return { ok: true, local: false, device: null, shared: true }
  return { ok: false, local: false, device: null, shared: false }
}

export function isLoopback(request: FastifyRequest): boolean {
  return LOOPBACK.has(request.ip)
}

/**
 * `/api/peers/adopt` — вторая и последняя дверь без токена: соседний компьютер при первом
 * знакомстве ещё ничего не знает. Её стережёт временный код привязки, показанный на этой
 * машине человеком; без активного кода роут отвечает отказом.
 */
const OPEN = new Set(['/api/info', '/api/peers/adopt'])

export function needsAuth(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return path.startsWith('/api/') && !OPEN.has(path)
}
