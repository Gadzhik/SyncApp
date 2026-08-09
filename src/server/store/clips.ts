import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Clip {
  id: string
  text: string
  /** Кто прислал: имя устройства или 'ПК' для watcher'а буфера обмена. */
  from: string
  ts: number
}

export const MAX_CLIP_LENGTH = 100_000

/** История текстовых записей. Хранится в одном JSON — объём заведомо мал. */
export class ClipStore {
  readonly #file: string
  readonly #max: number
  #clips: Clip[] = []
  #writing: Promise<void> = Promise.resolve()

  constructor(dataDir: string, max: number) {
    this.#file = join(dataDir, 'clips.json')
    this.#max = max
    this.#clips = this.#read()
  }

  #read(): Clip[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (clip): clip is Clip =>
          typeof clip === 'object' && clip !== null && typeof (clip as Clip).text === 'string',
      )
    } catch {
      return []
    }
  }

  /** Записи сериализуются в очередь, чтобы два быстрых add не перетёрли друг друга. */
  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#clips, null, 2)
    this.#writing = this.#writing.then(() => writeFile(this.#file, snapshot, 'utf8')).catch(() => {})
    return this.#writing
  }

  list(): Clip[] {
    return this.#clips
  }

  get(id: string): Clip | undefined {
    return this.#clips.find((clip) => clip.id === id)
  }

  /** Последняя запись — используется watcher'ом, чтобы не публиковать дубли. */
  latest(): Clip | undefined {
    return this.#clips[0]
  }

  async add(text: string, from: string): Promise<Clip> {
    const clip: Clip = { id: randomUUID(), text: text.slice(0, MAX_CLIP_LENGTH), from, ts: Date.now() }
    this.#clips = [clip, ...this.#clips].slice(0, this.#max)
    await this.#persist()
    return clip
  }

  async remove(id: string): Promise<boolean> {
    const next = this.#clips.filter((clip) => clip.id !== id)
    if (next.length === this.#clips.length) return false
    this.#clips = next
    await this.#persist()
    return true
  }
}
