import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { FileEntry } from './store/files.js'

const THUMB_SIZE = 256
const THUMB_DIR = '.thumbs'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.tif', '.tiff', '.heic', '.heif'])

export function hasThumbnail(name: string): boolean {
  return IMAGE_EXT.has(extname(name).toLowerCase())
}

/*
 * sharp тянет нативные бинарники, и на некоторых системах установка отваливается.
 * Загружаем его лениво и один раз: если не вышло — миниатюр просто не будет,
 * приложение продолжит работать и покажет значок вместо превью.
 */
type SharpFactory = (typeof import('sharp'))['default']
let sharpPromise: Promise<SharpFactory | null> | null = null

function loadSharp(): Promise<SharpFactory | null> {
  sharpPromise ??= import('sharp')
    // Проверяем именно вызываемость: модуль может разрешиться, но не отдать функцию,
    // и тогда сравнение с null пропустило бы неработающий sharp как доступный.
    .then((module): SharpFactory | null =>
      typeof module.default === 'function' ? module.default : null,
    )
    .catch(() => null)
  return sharpPromise
}

export async function thumbnailsAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Имя кэша включает время изменения — подменённый файл получит новую миниатюру. */
function cacheName(entry: FileEntry): string {
  const stamp = createHash('sha1').update(`${entry.name}:${entry.mtime}`).digest('hex').slice(0, 16)
  return `${stamp}.jpg`
}

/**
 * Принимает миниатюру, построенную самим отправителем. Браузер уже держит картинку
 * распакованной, поэтому превью ему почти ничего не стоит — а серверу это позволяет
 * обходиться без sharp и упаковываться в один файл без нативных зависимостей.
 */
export async function storeThumbnail(entry: FileEntry, dataDir: string, data: Buffer): Promise<boolean> {
  if (!hasThumbnail(entry.name)) return false
  const dir = join(dataDir, THUMB_DIR)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, cacheName(entry)), data)
    return true
  } catch {
    return false
  }
}

/**
 * Путь к миниатюре, создавая её при первом обращении. null — если формат не
 * поддерживается, sharp недоступен или файл не удалось разобрать (например,
 * HEIC без соответствующей сборки libvips).
 */
export async function getThumbnail(entry: FileEntry, dataDir: string): Promise<string | null> {
  if (!hasThumbnail(entry.name)) return null

  const sharp = await loadSharp()
  if (!sharp) return null

  const dir = join(dataDir, THUMB_DIR)
  const target = join(dir, cacheName(entry))
  if (await exists(target)) return target

  try {
    await mkdir(dir, { recursive: true })
    await sharp(entry.path, { failOn: 'none' })
      .rotate() // учесть EXIF-ориентацию, иначе фото с телефона лягут набок
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(target)
    return target
  } catch {
    await unlink(target).catch(() => {})
    return null
  }
}

/** Убирает миниатюры, которым больше не соответствует ни один файл. */
export async function pruneThumbnails(entries: FileEntry[], dataDir: string): Promise<void> {
  const dir = join(dataDir, THUMB_DIR)
  const keep = new Set(entries.filter((entry) => hasThumbnail(entry.name)).map(cacheName))
  try {
    for (const name of await readdir(dir)) {
      if (!keep.has(name)) await unlink(join(dir, name)).catch(() => {})
    }
  } catch {
    // каталога ещё нет — чистить нечего
  }
}
