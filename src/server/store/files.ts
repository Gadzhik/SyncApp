import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export interface FileEntry {
  id: string
  name: string
  size: number
  mtime: number
  path: string
}

/** id выводится из имени — стабилен между перезапусками, отдельный индекс не нужен. */
export function fileId(name: string): string {
  return createHash('sha1').update(name).digest('hex').slice(0, 16)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function listFiles(dir: string): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: FileEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    try {
      const info = await stat(path)
      files.push({ id: fileId(entry.name), name: entry.name, size: info.size, mtime: info.mtimeMs, path })
    } catch {
      // файл исчез между readdir и stat — просто пропускаем
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

export async function findFile(dir: string, id: string): Promise<FileEntry | undefined> {
  return (await listFiles(dir)).find((file) => file.id === id)
}

/** Символы, недопустимые в именах файлов Windows. */
const ILLEGAL = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

/**
 * Приводит присланное имя к безопасному: только базовое имя, без управляющих и
 * недопустимых символов, без ведущих точек. Без этого загрузка с именем
 * `../../evil.exe` записала бы файл за пределы каталога обмена.
 */
export function sanitizeName(raw: string): string {
  const flattened = basename(raw.replace(/\\/g, '/'))
  const cleaned = [...flattened]
    .map((char) => (char.codePointAt(0)! < 0x20 || ILLEGAL.has(char) ? '_' : char))
    .join('')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || 'file').slice(0, 180)
}

/** Разрешает коллизии имён суффиксом: `photo.jpg` → `photo (2).jpg`. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  let counter = 1
  while (await exists(join(dir, candidate))) {
    counter += 1
    candidate = `${stem} (${counter})${ext}`
  }
  return join(dir, candidate)
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
}

export function mimeOf(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
}
