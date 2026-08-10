import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Соседний компьютер, к которому этот привязан. Хранится **у отправителя**: это его ключи
 * к чужим машинам. Обратная сторона привязки — обычная запись в реестре устройств соседа,
 * поэтому отзывается она там же, где отвязываются телефоны.
 */
export interface Peer {
  id: string
  name: string
  host: string
  port: number
  tls: boolean
  /** Персональный токен, выданный соседом при привязке. */
  token: string
  /**
   * Отпечаток сертификата соседа, запомненный при привязке. Центра сертификации нет,
   * поэтому это единственный способ убедиться, что отвечает та же машина.
   */
  fingerprint: string | null
  /**
   * Сертификат соседа перевыпускается при смене набора его адресов — например при переходе
   * на другой Wi-Fi. Тогда отпечаток законно меняется, но отличить это от подмены нельзя:
   * сосед помечается и ждёт повторного подтверждения человеком.
   */
  changedFingerprint?: string
  addedAt: number
  lastSeen: number
}

/** Сосед в том виде, в каком его можно отдавать наружу — без выданного нам токена. */
export type PublicPeer = Omit<Peer, 'token'>

export class PeerStore {
  readonly #file: string
  #peers: Peer[] = []
  #writing: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.#file = join(dataDir, 'peers.json')
    this.#peers = this.#read()
  }

  #read(): Peer[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is Peer =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Peer).id === 'string' &&
          typeof (item as Peer).token === 'string',
      )
    } catch {
      return []
    }
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#peers, null, 2)
    this.#writing = this.#writing.then(() => writeFile(this.#file, snapshot, 'utf8')).catch(() => {})
    return this.#writing
  }

  list(): PublicPeer[] {
    return this.#peers
      .map(({ token: _token, ...rest }) => rest)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): Peer | undefined {
    return this.#peers.find((peer) => peer.id === id)
  }

  /** Привязка заново к уже известному соседу перезаписывает запись, а не плодит вторую. */
  async save(peer: Peer): Promise<Peer> {
    this.#peers = [peer, ...this.#peers.filter((item) => item.id !== peer.id)]
    await this.#persist()
    return peer
  }

  async remove(id: string): Promise<boolean> {
    const next = this.#peers.filter((peer) => peer.id !== id)
    if (next.length === this.#peers.length) return false
    this.#peers = next
    await this.#persist()
    return true
  }

  /**
   * Адрес соседа меняется вместе с сетью, а обнаружение приносит свежий. Пишем на диск
   * только при настоящем изменении: отметка «был на связи» не стоит обращения к диску.
   */
  async seen(id: string, patch: Partial<Pick<Peer, 'host' | 'port' | 'name' | 'tls'>> = {}): Promise<void> {
    const peer = this.get(id)
    if (!peer) return
    const changed = Object.entries(patch).some(
      ([key, value]) => value !== undefined && peer[key as keyof typeof patch] !== value,
    )
    Object.assign(peer, patch)
    peer.lastSeen = Date.now()
    if (changed) await this.#persist()
  }

  /** Пометить, что сосед предъявил другой сертификат: дальше решает человек. */
  async flagFingerprint(id: string, fingerprint: string): Promise<void> {
    const peer = this.get(id)
    if (!peer || peer.changedFingerprint === fingerprint) return
    peer.changedFingerprint = fingerprint
    await this.#persist()
  }

  /** Принять новый сертификат соседа после подтверждения человеком. */
  async trustFingerprint(id: string): Promise<boolean> {
    const peer = this.get(id)
    if (!peer?.changedFingerprint) return false
    peer.fingerprint = peer.changedFingerprint
    delete peer.changedFingerprint
    await this.#persist()
    return true
  }
}
