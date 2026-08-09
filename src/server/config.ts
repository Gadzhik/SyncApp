import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export interface Config {
  /** Порт HTTP-сервера. */
  port: number
  /** Интерфейс для прослушивания. 0.0.0.0 — виден всей локальной сети. */
  host: string
  /** Каталог с настройками и историей текста. */
  dataDir: string
  /** Каталог обмена файлами. */
  inboxDir: string
  /** Общий секрет: без него запросы из сети отклоняются. */
  token: string
  /** Имя, под которым ПК показывается в интерфейсе. */
  deviceName: string
  /** Следить за буфером обмена ПК и публиковать изменения как записи. */
  watchClipboard: boolean
  /** Сколько текстовых записей хранить. */
  maxClips: number
  /** Анонсировать сервис через mDNS (http://<имя>.local). */
  mdns: boolean
  /** Работать по HTTPS с самоподписанным сертификатом. */
  tls: boolean
  /** Удалять принятые файлы старше N дней. 0 — не удалять. */
  keepDays: number
}

const DEFAULT_PORT = 8420

interface PersistedConfig {
  token: string
}

function newToken(): string {
  return randomBytes(16).toString('base64url')
}

function writeToken(dataDir: string, token: string): void {
  const file = join(dataDir, 'config.json')
  writeFileSync(file, `${JSON.stringify({ token } satisfies PersistedConfig, null, 2)}\n`, 'utf8')
}

function loadOrCreateToken(dataDir: string): string {
  const file = join(dataDir, 'config.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedConfig
    if (typeof parsed.token === 'string' && parsed.token.length >= 16) return parsed.token
  } catch {
    // файла нет или он повреждён — создадим заново
  }
  const token = newToken()
  writeToken(dataDir, token)
  return token
}

/**
 * Выдаёт новый токен взамен прежнего. Все ранее подключённые устройства сразу
 * теряют доступ — это способ «отвязать всё», например если телефон потерян.
 */
export function rotateToken(dataDir: string): string {
  const token = newToken()
  writeToken(dataDir, token)
  return token
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? process.env.LANSYNC_DIR ?? join(homedir(), 'LanSync')
  const inboxDir = overrides.inboxDir ?? join(dataDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })

  return {
    port: overrides.port ?? Number(process.env.LANSYNC_PORT ?? DEFAULT_PORT),
    host: overrides.host ?? process.env.LANSYNC_HOST ?? '0.0.0.0',
    dataDir,
    inboxDir,
    token: overrides.token ?? loadOrCreateToken(dataDir),
    deviceName: overrides.deviceName ?? process.env.LANSYNC_NAME ?? hostname(),
    watchClipboard: overrides.watchClipboard ?? process.env.LANSYNC_WATCH_CLIPBOARD === '1',
    maxClips: overrides.maxClips ?? 50,
    mdns: overrides.mdns ?? process.env.LANSYNC_MDNS !== '0',
    tls: overrides.tls ?? process.env.LANSYNC_TLS !== '0',
    keepDays: overrides.keepDays ?? Math.max(0, Number(process.env.LANSYNC_KEEP_DAYS ?? 0) || 0),
  }
}
