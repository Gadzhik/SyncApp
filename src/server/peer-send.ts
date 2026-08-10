import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { ClientRequest } from 'node:http'
import type { EventHub } from './events.js'
import { peerJson, peerRequest, PeerError, type PeerTarget } from './peer-client.js'
import type { Peer, PeerStore } from './peer-store.js'
import { mimeOf, type FileEntry } from './store/files.js'

/**
 * Отправка файлов соседнему компьютеру.
 *
 * Тело запроса собирается вручную, хотя `fetch` с `FormData` выглядел бы короче: undici
 * буферизует такую форму целиком, и файл на 5 ГБ уезжает в память отправителя (замер
 * описан в docs/pitfalls.md). Здесь тело — поток с диска, а `Content-Length` известен
 * заранее, потому что размер файла известен.
 *
 * Принимающая сторона ничего нового не разбирает: это обычный `POST /api/files`, тот же,
 * которым шлёт браузер.
 */

/** Столько же одновременных передач, сколько у страницы: три идут, остальные ждут. */
const MAX_PARALLEL = 3
/** Чаще четырёх раз в секунду перерисовывать прогресс незачем. */
const PROGRESS_INTERVAL_MS = 250

export type TransferStatus = 'queued' | 'sending' | 'done' | 'error' | 'cancelled'

export interface Transfer {
  id: string
  peerId: string
  peerName: string
  name: string
  size: number
  sent: number
  status: TransferStatus
  error?: string
}

interface Task {
  transfer: Transfer
  entry: FileEntry
  peer: Peer
  controller: AbortController
}

function targetOf(peer: Peer): PeerTarget {
  return { host: peer.host, port: peer.port, tls: peer.tls, fingerprint: peer.fingerprint, token: peer.token }
}

/** Имя в заголовке: ASCII-запасной вариант плюс UTF-8, как того требует RFC 5987. */
function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export class PeerSender {
  readonly #hub: EventHub
  readonly #peers: PeerStore
  readonly #queue: Task[] = []
  readonly #active = new Map<string, Task>()
  readonly #recent: Transfer[] = []

  constructor(hub: EventHub, peers: PeerStore) {
    this.#hub = hub
    this.#peers = peers
  }

  /** Текущие и недавно завершённые передачи — страница показывает их списком. */
  list(): Transfer[] {
    return [...this.#active.values()].map((task) => task.transfer).concat(this.#recent)
  }

  send(peer: Peer, entries: FileEntry[]): Transfer[] {
    const created = entries.map((entry) => {
      const transfer: Transfer = {
        id: randomUUID(),
        peerId: peer.id,
        peerName: peer.name,
        name: entry.name,
        size: entry.size,
        sent: 0,
        status: 'queued',
      }
      this.#queue.push({ transfer, entry, peer, controller: new AbortController() })
      return transfer
    })
    this.#announce()
    this.#pump()
    return created
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id)
    if (active) {
      active.controller.abort()
      return true
    }
    const waiting = this.#queue.findIndex((task) => task.transfer.id === id)
    if (waiting === -1) return false
    const [task] = this.#queue.splice(waiting, 1)
    if (task) this.#finish(task, 'cancelled')
    return true
  }

  /** Отменяет всё, что летит к этому соседу, — при отвязке ждать бессмысленно. */
  cancelForPeer(peerId: string): void {
    for (const task of [...this.#active.values(), ...this.#queue]) {
      if (task.transfer.peerId === peerId) this.cancel(task.transfer.id)
    }
  }

  stop(): void {
    for (const task of this.#active.values()) task.controller.abort()
    this.#queue.length = 0
  }

  #announce(): void {
    this.#hub.broadcast('peer:progress', { transfers: this.list() })
  }

  #finish(task: Task, status: TransferStatus, error?: string): void {
    task.transfer.status = status
    if (error) task.transfer.error = error
    this.#active.delete(task.transfer.id)
    // Хвост завершённых нужен, чтобы человек увидел итог, а не пустоту вместо передачи.
    this.#recent.unshift(task.transfer)
    this.#recent.splice(10)
    this.#announce()
    this.#pump()
  }

  #pump(): void {
    while (this.#active.size < MAX_PARALLEL && this.#queue.length > 0) {
      const task = this.#queue.shift()
      if (!task) return
      this.#active.set(task.transfer.id, task)
      task.transfer.status = 'sending'
      void this.#run(task)
    }
    this.#announce()
  }

  async #run(task: Task): Promise<void> {
    const { entry, peer, transfer, controller } = task
    const boundary = `----LanSync${randomBytes(16).toString('hex')}`
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; ${dispositionName(entry.name)}\r\n` +
        `Content-Type: ${mimeOf(entry.name)}\r\n\r\n`,
      'utf8',
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

    let lastTick = 0
    try {
      const response = await peerRequest(targetOf(peer), {
        method: 'POST',
        path: '/api/files',
        signal: controller.signal,
        // Крупный файл идёт минутами и часами: сторожевой таймер здесь навредил бы.
        timeoutMs: 0,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(head.length + entry.size + tail.length),
        },
        write: async (stream: ClientRequest) => {
          stream.write(head)
          const file = createReadStream(entry.path)
          file.on('data', (chunk) => {
            transfer.sent += chunk.length
            const now = Date.now()
            if (now - lastTick < PROGRESS_INTERVAL_MS) return
            lastTick = now
            this.#announce()
          })
          await new Promise<void>((resolve, reject) => {
            file.on('error', reject)
            file.on('end', resolve)
            controller.signal.addEventListener('abort', () => file.destroy(), { once: true })
            file.pipe(stream, { end: false })
          })
          stream.write(tail)
        },
      })

      if (response.status !== 200) {
        const message =
          typeof response.body === 'object' && response.body !== null && 'error' in response.body ?
            String((response.body as { error: unknown }).error)
          : `сосед ответил ${response.status}`
        this.#finish(task, 'error', message)
        return
      }

      await this.#peers.seen(peer.id)
      this.#finish(task, 'done')
    } catch (error) {
      if (controller.signal.aborted) {
        this.#finish(task, 'cancelled')
        return
      }
      if (error instanceof PeerError && error.code === 'fingerprint') {
        if (error.seen) await this.#peers.flagFingerprint(peer.id, error.seen)
        this.#hub.broadcast('peers:changed')
      }
      this.#finish(task, 'error', error instanceof Error ? error.message : 'не удалось отправить')
    }
  }
}

/** Текстовая запись уходит обычным `POST /api/clips` — то же, что делает браузер. */
export async function sendClipToPeer(peer: Peer, text: string, from: string): Promise<void> {
  const response = await peerJson(targetOf(peer), {
    method: 'POST',
    path: '/api/clips',
    json: { text, from },
  })
  if (response.status !== 200) {
    throw new PeerError(`сосед ответил ${response.status}`, 'http', { status: response.status })
  }
}
