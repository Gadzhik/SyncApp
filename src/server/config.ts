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
  /**
   * Постоянный идентификатор этого компьютера. Нужен, чтобы отличать соседей в сети
   * и узнавать собственный анонс: адрес и имя для этого не годятся — адрес меняется,
   * а два экземпляра на одной машине (так проверяется обмен) делят и адрес, и хост.
   */
  peerId: string
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
  peerId: string
}

function newToken(): string {
  return randomBytes(16).toString('base64url')
}

function write(dataDir: string, persisted: PersistedConfig): void {
  const file = join(dataDir, 'config.json')
  writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
}

/**
 * Токен и идентификатор машины лежат в одном файле и создаются одинаково: чего нет —
 * дописываем, не трогая остальное. Смена токена (`rotateToken`) идентификатор сохраняет —
 * иначе «отключить все устройства» выглядело бы для соседей как появление нового компьютера.
 */
function loadOrCreate(dataDir: string): PersistedConfig {
  const file = join(dataDir, 'config.json')
  let token = ''
  let peerId = ''
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedConfig>
    if (typeof parsed.token === 'string' && parsed.token.length >= 16) token = parsed.token
    if (typeof parsed.peerId === 'string' && parsed.peerId.length >= 8) peerId = parsed.peerId
  } catch {
    // файла нет или он повреждён — создадим заново
  }

  if (token && peerId) return { token, peerId }
  const persisted: PersistedConfig = { token: token || newToken(), peerId: peerId || newToken() }
  write(dataDir, persisted)
  return persisted
}

/**
 * Выдаёт новый токен взамен прежнего. Все ранее подключённые устройства сразу
 * теряют доступ — это способ «отвязать всё», например если телефон потерян.
 */
export function rotateToken(dataDir: string): string {
  const token = newToken()
  write(dataDir, { token, peerId: loadOrCreate(dataDir).peerId })
  return token
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? process.env.LANSYNC_DIR ?? join(homedir(), 'LanSync')
  const inboxDir = overrides.inboxDir ?? join(dataDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })
  const persisted = loadOrCreate(dataDir)

  return {
    port: overrides.port ?? Number(process.env.LANSYNC_PORT ?? DEFAULT_PORT),
    host: overrides.host ?? process.env.LANSYNC_HOST ?? '0.0.0.0',
    dataDir,
    inboxDir,
    token: overrides.token ?? persisted.token,
    peerId: overrides.peerId ?? persisted.peerId,
    deviceName: overrides.deviceName ?? process.env.LANSYNC_NAME ?? hostname(),
    watchClipboard: overrides.watchClipboard ?? process.env.LANSYNC_WATCH_CLIPBOARD === '1',
    maxClips: overrides.maxClips ?? 50,
    mdns: overrides.mdns ?? process.env.LANSYNC_MDNS !== '0',
    tls: overrides.tls ?? process.env.LANSYNC_TLS !== '0',
    keepDays: overrides.keepDays ?? Math.max(0, Number(process.env.LANSYNC_KEEP_DAYS ?? 0) || 0),
  }
}
