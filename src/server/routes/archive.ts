import { ZipArchive } from 'archiver'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import { listFiles } from '../store/files.js'

interface Options {
  config: Config
}

/** Граница, за которой обычный ZIP перестаёт адресовать данные и нужен ZIP64. */
const ZIP64_THRESHOLD = 4 * 1024 ** 3

function archiveName(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `LanSync ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}.zip`
}

export async function archiveRoutes(app: FastifyInstance, { config }: Options): Promise<void> {
  /**
   * Архив собирается на лету и сразу уходит в сокет — временный файл на диске
   * не создаётся, поэтому размер выборки ограничен только свободным местом
   * у получателя.
   */
  app.get('/api/archive', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const requested = typeof query['ids'] === 'string' && query['ids'] ? query['ids'].split(',') : null

    const all = await listFiles(config.inboxDir)
    const chosen = requested ? all.filter((entry) => requested.includes(entry.id)) : all
    if (chosen.length === 0) return reply.code(404).send({ error: 'нечего архивировать' })

    const total = chosen.reduce((sum, entry) => sum + entry.size, 0)
    const name = archiveName()

    // Сжатие выключено: внутри почти всегда фото и видео, они уже сжаты, а нулевой
    // уровень снимает нагрузку на процессор и заметно ускоряет отдачу.
    const archive = new ZipArchive({
      zlib: { level: 0 },
      store: true,
      forceZip64: total >= ZIP64_THRESHOLD,
    })

    // Отсутствие одного файла (удалён между листингом и упаковкой) не должно
    // рвать весь архив.
    archive.on('warning', () => {})
    archive.on('error', () => {
      reply.raw.destroy()
    })
    request.raw.on('close', () => archive.abort())

    reply
      .header(
        'Content-Disposition',
        `attachment; filename="LanSync.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header('Cache-Control', 'no-store')
      .type('application/zip')

    for (const entry of chosen) archive.file(entry.path, { name: entry.name })
    void archive.finalize()

    return reply.send(archive)
  })
}
