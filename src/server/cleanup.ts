import { unlink } from 'node:fs/promises'
import type { Config } from './config.js'
import type { EventHub } from './events.js'
import { listFiles } from './store/files.js'
import { pruneThumbnails } from './thumbs.js'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface Cleaner {
  stop(): void
  /** Разовый проход; возвращает удалённые имена. */
  sweep(): Promise<string[]>
  /** Проход, выполняемый при старте: даёт дождаться первой уборки. */
  ready: Promise<string[]>
}

/**
 * Удаляет из каталога обмена файлы старше заданного срока. Без этого каталог
 * растёт бесконечно: приложение задумано как перевалочный пункт, а не хранилище.
 */
export function startCleanup(config: Config, hub: EventHub): Cleaner {
  const sweep = async (): Promise<string[]> => {
    const entries = await listFiles(config.inboxDir)

    if (config.keepDays > 0) {
      const deadline = Date.now() - config.keepDays * 24 * 60 * 60 * 1000
      const expired = entries.filter((entry) => entry.mtime < deadline)
      const removed: string[] = []
      for (const entry of expired) {
        try {
          await unlink(entry.path)
          removed.push(entry.name)
        } catch {
          // файл занят или уже удалён — попробуем в следующий раз
        }
      }
      if (removed.length > 0) {
        const rest = entries.filter((entry) => !removed.includes(entry.name))
        await pruneThumbnails(rest, config.dataDir)
        hub.broadcast('file:removed', { cleaned: removed })
        return removed
      }
    }

    // даже при выключенной автоочистке подчищаем осиротевшие миниатюры
    await pruneThumbnails(entries, config.dataDir)
    return []
  }

  const ready = sweep().catch((): string[] => [])
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
  timer.unref()

  return { stop: () => clearInterval(timer), sweep, ready }
}
