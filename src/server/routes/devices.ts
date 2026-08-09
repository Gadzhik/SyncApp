import type { FastifyInstance } from 'fastify'
import { authorize, isLoopback } from '../auth.js'
import type { Config } from '../config.js'
import { describeClient, type DeviceStore } from '../devices.js'
import type { EventHub } from '../events.js'

interface Options {
  config: Config
  hub: EventHub
  devices: DeviceStore
}

interface IdParams {
  id: string
}

export async function devicesRoutes(app: FastifyInstance, { config, hub, devices }: Options): Promise<void> {
  /**
   * Обмен общего токена из QR-кода на персональный. После привязки устройство
   * ходит со своим токеном, и его можно отозвать, не трогая остальные.
   */
  app.post('/api/pair', async (request, reply) => {
    const auth = authorize(request, config, devices)
    if (!auth.ok) return reply.code(401).send({ error: 'нужен токен доступа' })
    if (auth.device) return { device: { id: auth.device.id, name: auth.device.name }, token: auth.device.token }
    if (auth.local) return reply.code(400).send({ error: 'этот компьютер не нуждается в привязке' })

    const name = describeClient(String(request.headers['user-agent'] ?? ''))
    const device = await devices.pair(name, request.ip)
    hub.broadcast('devices:changed')
    return { device: { id: device.id, name: device.name }, token: device.token }
  })

  app.get('/api/devices', async () => {
    const online = hub.onlineDeviceIds()
    return {
      devices: devices.list().map((device) => ({ ...device, online: online.has(device.id) })),
      localConnections: hub.localConnections(),
    }
  })

  /** Отвязка конкретного устройства: только с самого компьютера. */
  app.delete<{ Params: IdParams }>('/api/devices/:id', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send({ error: 'доступно только с этого компьютера' })
    const removed = await devices.remove(request.params.id)
    if (!removed) return reply.code(404).send({ error: 'устройство не найдено' })
    hub.closeDevice(request.params.id)
    hub.broadcast('devices:changed')
    return { ok: true }
  })
}
