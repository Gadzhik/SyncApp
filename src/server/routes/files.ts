import { createReadStream, createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../config.js'
import type { EventHub } from '../events.js'
import { fileId, findFile, listFiles, mimeOf, sanitizeName, uniquePath } from '../store/files.js'
import { getThumbnail, hasThumbnail, pruneThumbnails, storeThumbnail } from '../thumbs.js'

interface Options {
  config: Config
  hub: EventHub
}

interface IdParams {
  id: string
}

/** RFC 6266: ASCII-запасной вариант плюс UTF-8 для имён с кириллицей и эмодзи. */
function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart = '', rawEnd = ''] = match
  let start: number
  let end: number
  if (rawStart === '') {
    // суффиксный запрос вида `bytes=-500` — последние N байт
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start < 0 || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

export async function filesRoutes(app: FastifyInstance, { config, hub }: Options): Promise<void> {
  app.get('/api/files', async () => {
    const files = await listFiles(config.inboxDir)
    // thumb подсказывает интерфейсу, запрашивать ли превью, чтобы не дёргать
    // сервер ради файлов, у которых миниатюры быть не может
    return { files: files.map((file) => ({ ...file, thumb: hasThumbnail(file.name) })) }
  })

  app.post('/api/files', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'ожидается multipart/form-data' })
    }
    const saved: { name: string; size: number }[] = []
    // Отправитель может приложить готовое превью в поле thumb — оно идёт после файла.
    let providedThumb: Buffer | null = null
    try {
      for await (const part of request.files()) {
        if (part.fieldname === 'thumb') {
          const chunks: Buffer[] = []
          for await (const chunk of part.file) chunks.push(chunk as Buffer)
          if (!part.file.truncated) providedThumb = Buffer.concat(chunks)
          continue
        }

        const name = sanitizeName(part.filename)
        const dest = await uniquePath(config.inboxDir, name)
        try {
          // Поток на диск: гигабайтное видео не должно попадать в память целиком.
          await pipeline(part.file, createWriteStream(dest))
        } catch (error) {
          await unlink(dest).catch(() => {})
          throw error
        }
        if (part.file.truncated) {
          await unlink(dest).catch(() => {})
          return reply.code(413).send({ error: `файл ${name} превысил лимит размера`, saved })
        }
        saved.push({ name: dest.slice(config.inboxDir.length + 1), size: part.file.bytesRead })
      }
    } catch (error) {
      /*
       * Разбор пачки может оборваться на середине — например при превышении лимита
       * на число файлов в запросе. Часть файлов к этому моменту уже лежит на диске,
       * поэтому сообщаем, что именно принято: иначе клиент показывает общую ошибку,
       * а файлы молча оказываются на месте.
       */
      if (saved.length > 0) hub.broadcast('file:added', saved)
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(413).send({
        error: `принято файлов: ${saved.length}, остальные отклонены (${message})`,
        saved,
      })
    }

    if (saved.length === 0) {
      return reply.code(400).send({ error: 'в запросе нет файлов' })
    }

    // Присланное превью относится к единственному файлу запроса — именно так шлёт
    // интерфейс. В пакетной отправке через API сопоставить его не с чем.
    if (providedThumb && saved.length === 1) {
      const entry = await findFile(config.inboxDir, fileId(saved[0]!.name))
      if (entry) await storeThumbnail(entry, config.dataDir, providedThumb)
    }

    hub.broadcast('file:added', saved)
    return { saved }
  })

  /** Пакетное удаление: одним запросом вместо десятка DELETE подряд. */
  app.post<{ Body: { ids?: unknown } }>('/api/files/delete', async (request, reply) => {
    const ids = request.body?.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'нужен непустой список ids' })
    }
    const wanted = new Set(ids.map(String))
    const entries = (await listFiles(config.inboxDir)).filter((entry) => wanted.has(entry.id))

    const removed: string[] = []
    for (const entry of entries) {
      try {
        await unlink(entry.path)
        removed.push(entry.name)
      } catch {
        // файл занят другим процессом — пропускаем, остальные удалим
      }
    }
    if (removed.length > 0) {
      await pruneThumbnails(await listFiles(config.inboxDir), config.dataDir)
      hub.broadcast('file:removed', { removed })
    }
    return { removed, missed: ids.length - removed.length }
  })

  app.get<{ Params: IdParams }>('/api/files/:id/thumb', async (request, reply) => {
    const entry = await findFile(config.inboxDir, request.params.id)
    if (!entry) return reply.code(404).send({ error: 'файл не найден' })

    // getThumbnail сначала отдаёт готовую из кэша — в том числе присланную клиентом,
    // и только при её отсутствии пробует построить сам через sharp.
    const thumb = await getThumbnail(entry, config.dataDir)
    if (!thumb) return reply.code(404).send({ error: 'миниатюра недоступна' })

    const info = await stat(thumb)
    return reply
      .type('image/jpeg')
      // миниатюра неизменна: её имя включает время изменения исходного файла
      .header('Cache-Control', 'private, max-age=86400, immutable')
      .header('Content-Length', info.size)
      .send(createReadStream(thumb))
  })

  app.get<{ Params: IdParams }>('/api/files/:id', async (request, reply): Promise<FastifyReply> => {
    const entry = await findFile(config.inboxDir, request.params.id)
    if (!entry) return reply.code(404).send({ error: 'файл не найден' })

    const inline = (request.query as Record<string, unknown>)['inline'] === '1'
    reply
      .header('Content-Disposition', contentDisposition(entry.name, inline))
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'no-store')
      .type(mimeOf(entry.name))

    const rangeHeader = request.headers.range
    if (rangeHeader) {
      const range = parseRange(rangeHeader, entry.size)
      if (!range) {
        return reply.code(416).header('Content-Range', `bytes */${entry.size}`).send()
      }
      // 206 нужен, чтобы на телефоне работала перемотка видео.
      return reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(createReadStream(entry.path, { start: range.start, end: range.end }))
    }

    return reply.header('Content-Length', entry.size).send(createReadStream(entry.path))
  })

  app.delete<{ Params: IdParams }>('/api/files/:id', async (request, reply) => {
    const entry = await findFile(config.inboxDir, request.params.id)
    if (!entry) return reply.code(404).send({ error: 'файл не найден' })
    await unlink(entry.path)
    await pruneThumbnails(await listFiles(config.inboxDir), config.dataDir)
    hub.broadcast('file:removed', { id: entry.id, name: entry.name })
    return { ok: true }
  })
}
