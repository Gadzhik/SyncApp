import type { FastifyInstance } from 'fastify'
import { isLoopback } from '../auth.js'
import type { Config } from '../config.js'
import type { DeviceStore } from '../devices.js'
import type { EventHub } from '../events.js'
import { PeerError } from '../peer-client.js'
import { peerJson } from '../peer-client.js'
import type { PeerStore } from '../peer-store.js'
import type { PeerSender } from '../peer-send.js'
import { sendClipToPeer } from '../peer-send.js'
import type { Discovery } from '../peers.js'
import type { PairingCode } from '../pairing.js'
import { listFiles } from '../store/files.js'

interface Options {
  config: Config
  hub: EventHub
  devices: DeviceStore
  peers: PeerStore
  discovery: Discovery
  sender: PeerSender
  pairing: PairingCode
}

interface IdParams {
  id: string
}

const LOCAL_ONLY = { error: 'доступно только с этого компьютера' }

/** Имя соседа приходит из сети: обрезаем и чистим, оно попадёт в список устройств. */
function cleanName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  // \p{C} — управляющие и невидимые символы: в списке устройств им делать нечего
  return text.replace(/\p{C}/gu, '').trim().slice(0, 64) || 'компьютер'
}

/** Понятная человеку причина вместо кода ошибки транспорта. */
function explain(error: unknown): { code: number; message: string } {
  if (error instanceof PeerError) {
    if (error.code === 'fingerprint') {
      return { code: 409, message: 'сертификат соседа не совпадает с запомненным' }
    }
    if (error.code === 'timeout') return { code: 504, message: 'сосед не отвечает' }
    return { code: 502, message: error.message }
  }
  return { code: 502, message: error instanceof Error ? error.message : 'не удалось связаться с соседом' }
}

export async function peersRoutes(app: FastifyInstance, options: Options): Promise<void> {
  const { config, hub, devices, peers, discovery, sender, pairing } = options

  /**
   * Единственная точка входа без токена, кроме `/api/info`: сосед ещё не знает секретов,
   * ему нечего предъявить. Дверь открыта, только пока на этом компьютере показан код
   * привязки, и закрывается сразу после удачного обмена.
   */
  app.post<{ Body: { code?: unknown; id?: unknown; name?: unknown } }>(
    '/api/peers/adopt',
    async (request, reply) => {
      const active = pairing.active()
      if (!active) return reply.code(403).send({ error: 'привязка не запрошена' })

      const code = typeof request.body?.code === 'string' ? request.body.code : ''
      if (!pairing.verify(code)) return reply.code(403).send({ error: 'код не подходит' })

      const name = cleanName(request.body?.name)
      const device = await devices.pair(`${name} (компьютер)`, request.ip)
      hub.broadcast('devices:changed')
      hub.broadcast('peers:changed')
      return { token: device.token, id: config.peerId, name: config.deviceName }
    },
  )

  app.get('/api/peers', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)

    const known = peers.list()
    const seen = discovery.list()
    const online = new Map(seen.map((peer) => [peer.id, peer]))

    // Адрес соседа меняется вместе с сетью — подхватываем свежий из анонса.
    for (const peer of known) {
      const fresh = online.get(peer.id)
      if (fresh) await peers.seen(peer.id, { host: fresh.host, port: fresh.port, name: fresh.name, tls: fresh.tls })
    }

    const paired = peers.list().map((peer) => ({ ...peer, paired: true, online: online.has(peer.id) }))
    const strangers = seen
      .filter((peer) => !peers.get(peer.id))
      .map((peer) => ({ ...peer, addedAt: 0, changedFingerprint: undefined, paired: false, online: true }))

    return { peers: [...paired, ...strangers], transfers: sender.list(), code: pairing.active(), self: config.peerId }
  })

  /** Показать код для приёма: его вводят на том компьютере, который хочет отправлять. */
  app.post('/api/peers/code', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    const issued = pairing.issue()
    hub.broadcast('peers:changed')
    return issued
  })

  app.delete('/api/peers/code', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    pairing.clear()
    hub.broadcast('peers:changed')
    return { ok: true }
  })

  /** Привязаться к соседу: сходить к нему с кодом и запомнить выданный токен. */
  app.post<{ Body: { host?: unknown; port?: unknown; tls?: unknown; code?: unknown } }>(
    '/api/peers/pair',
    async (request, reply) => {
      if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)

      const host = typeof request.body?.host === 'string' ? request.body.host.trim() : ''
      const port = Number(request.body?.port ?? config.port)
      const code = typeof request.body?.code === 'string' ? request.body.code.trim() : ''
      const tls = request.body?.tls !== false
      if (!host || !Number.isInteger(port) || port <= 0) {
        return reply.code(400).send({ error: 'нужен адрес соседа и порт' })
      }
      if (!code) return reply.code(400).send({ error: 'нужен код с экрана соседа' })

      try {
        // fingerprint: null — первое знакомство. Что предъявили, то и запоминаем.
        const response = await peerJson<{ token?: string; id?: string; name?: string; error?: string }>(
          { host, port, tls, fingerprint: null },
          { method: 'POST', path: '/api/peers/adopt', json: { code, id: config.peerId, name: config.deviceName } },
        )

        if (response.status !== 200 || !response.body?.token || !response.body.id) {
          return reply.code(response.status === 403 ? 403 : 502).send({
            error: response.body?.error ?? `сосед ответил ${response.status}`,
          })
        }

        const peer = await peers.save({
          id: response.body.id,
          name: response.body.name || host,
          host,
          port,
          tls,
          token: response.body.token,
          fingerprint: response.fingerprint,
          addedAt: Date.now(),
          lastSeen: Date.now(),
        })
        hub.broadcast('peers:changed')
        const { token: _token, ...pub } = peer
        return { peer: pub }
      } catch (error) {
        const { code: status, message } = explain(error)
        return reply.code(status).send({ error: message })
      }
    },
  )

  /** Принять новый сертификат соседа — после того как человек убедился, что это он. */
  app.post<{ Params: IdParams }>('/api/peers/:id/trust', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    if (!(await peers.trustFingerprint(request.params.id))) {
      return reply.code(404).send({ error: 'нечего подтверждать' })
    }
    hub.broadcast('peers:changed')
    return { ok: true }
  })

  app.delete<{ Params: IdParams }>('/api/peers/:id', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    sender.cancelForPeer(request.params.id)
    if (!(await peers.remove(request.params.id))) return reply.code(404).send({ error: 'сосед не найден' })
    hub.broadcast('peers:changed')
    return { ok: true }
  })

  app.post<{ Params: IdParams; Body: { ids?: unknown } }>('/api/peers/:id/send', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    const peer = peers.get(request.params.id)
    if (!peer) return reply.code(404).send({ error: 'сосед не привязан' })
    if (peer.changedFingerprint) {
      return reply.code(409).send({ error: 'сертификат соседа изменился — подтвердите его заново' })
    }

    const ids = request.body?.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'нужен непустой список ids' })
    }
    const wanted = new Set(ids.map(String))
    const entries = (await listFiles(config.inboxDir)).filter((entry) => wanted.has(entry.id))
    if (entries.length === 0) return reply.code(404).send({ error: 'файлы не найдены' })

    return { transfers: sender.send(peer, entries) }
  })

  app.post<{ Params: IdParams; Body: { text?: unknown } }>('/api/peers/:id/clip', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    const peer = peers.get(request.params.id)
    if (!peer) return reply.code(404).send({ error: 'сосед не привязан' })

    const text = typeof request.body?.text === 'string' ? request.body.text : ''
    if (!text.trim()) return reply.code(400).send({ error: 'пустой текст' })

    try {
      await sendClipToPeer(peer, text, config.deviceName)
      await peers.seen(peer.id)
      return { ok: true }
    } catch (error) {
      const { code: status, message } = explain(error)
      return reply.code(status).send({ error: message })
    }
  })

  /** Отменить отправку — крупный файл идёт долго, передумать успевают. */
  app.delete<{ Params: IdParams }>('/api/peers/transfers/:id', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send(LOCAL_ONLY)
    if (!sender.cancel(request.params.id)) return reply.code(404).send({ error: 'передача не найдена' })
    return { ok: true }
  })
}
