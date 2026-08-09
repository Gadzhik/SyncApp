import type { FastifyInstance } from 'fastify'
import { writePcClipboard } from '../clipboard.js'
import type { Config } from '../config.js'
import type { EventHub } from '../events.js'
import type { ClipStore } from '../store/clips.js'

interface Options {
  config: Config
  hub: EventHub
  clips: ClipStore
}

interface IdParams {
  id: string
}

interface CreateBody {
  text?: unknown
  from?: unknown
}

export async function clipsRoutes(app: FastifyInstance, { hub, clips }: Options): Promise<void> {
  app.get('/api/clips', async () => ({ clips: clips.list() }))

  app.post<{ Body: CreateBody }>('/api/clips', async (request, reply) => {
    const { text, from } = request.body ?? {}
    if (typeof text !== 'string' || text.trim() === '') {
      return reply.code(400).send({ error: 'поле text обязательно' })
    }
    const clip = await clips.add(text, typeof from === 'string' && from ? from.slice(0, 40) : 'устройство')
    hub.broadcast('clip:added', clip)
    return { clip }
  })

  app.delete<{ Params: IdParams }>('/api/clips/:id', async (request, reply) => {
    const removed = await clips.remove(request.params.id)
    if (!removed) return reply.code(404).send({ error: 'запись не найдена' })
    hub.broadcast('clip:removed', { id: request.params.id })
    return { ok: true }
  })

  app.post<{ Params: IdParams }>('/api/clips/:id/to-pc-clipboard', async (request, reply) => {
    const clip = clips.get(request.params.id)
    if (!clip) return reply.code(404).send({ error: 'запись не найдена' })
    const ok = await writePcClipboard(clip.text)
    if (!ok) return reply.code(503).send({ error: 'буфер обмена ПК недоступен' })
    return { ok: true }
  })
}
