import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { webDir } from './paths.js'

/**
 * Файлы клиента. Список закрытый: обслуживаются только эти пути, поэтому выход за
 * пределы каталога невозможен в принципе — никакой склейки путей из запроса нет.
 */
export const WEB_FILES = [
  'index.html',
  'app.js',
  'api.js',
  'style.css',
  'icon.svg',
  'manifest.webmanifest',
  'sw.js',
] as const

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
}

function typeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  return TYPES[name.slice(dot)] ?? 'application/octet-stream'
}

/*
 * В собранном одном файле статика лежит внутри исполняемого файла и достаётся через
 * node:sea. Модуль подключаем осторожно: он существует не во всех сборках Node, а
 * при обычном запуске из исходников нам нужен путь с диска.
 */
interface SeaApi {
  isSea(): boolean
  getRawAsset(key: string): ArrayBuffer
}

let seaApi: SeaApi | null | undefined

async function loadSea(): Promise<SeaApi | null> {
  if (seaApi !== undefined) return seaApi
  try {
    const module = (await import('node:sea')) as unknown as SeaApi
    seaApi = typeof module.isSea === 'function' && module.isSea() ? module : null
  } catch {
    seaApi = null
  }
  return seaApi
}

export interface Asset {
  data: Buffer
  type: string
  etag: string
}

const cache = new Map<string, Asset>()

function describe(name: string, data: Buffer): Asset {
  const etag = `W/"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`
  return { data, type: typeFor(name), etag }
}

export async function readWebAsset(name: string): Promise<Asset | null> {
  const hit = cache.get(name)
  if (hit) return hit

  const sea = await loadSea()
  let data: Buffer | null = null
  if (sea) {
    try {
      data = Buffer.from(sea.getRawAsset(name))
    } catch {
      data = null
    }
  } else {
    data = await readFile(join(webDir, name)).catch(() => null)
  }
  if (!data) return null

  const asset = describe(name, data)
  // Внутри бинарника содержимое неизменно — кэшируем. При запуске из исходников
  // не кэшируем, иначе правки в src/web не появлялись бы после обновления страницы.
  if (sea) cache.set(name, asset)
  return asset
}

export async function staticRoutes(app: FastifyInstance): Promise<void> {
  const serve = (name: string) => async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const asset = await readWebAsset(name)
    if (!asset) return reply.code(404).send({ error: 'не найдено' })

    // Оболочка меняется вместе с сервером: no-cache оставляет ревалидацию по ETag,
    // но не даёт браузеру показать старую версию после обновления приложения.
    reply.header('Cache-Control', 'no-cache').header('ETag', asset.etag).type(asset.type)
    if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send()
    return reply.send(asset.data)
  }

  app.get('/', serve('index.html'))
  for (const name of WEB_FILES) app.get(`/${name}`, serve(name))
}
