import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import QRCode from 'qrcode'
import { authorize, isLoopback, needsAuth } from './auth.js'
import { autostartEnabled, autostartSupported, installAutostart, uninstallAutostart } from './autostart.js'
import { startCleanup, type Cleaner } from './cleanup.js'
import { startClipboardWatcher, type ClipboardWatcher } from './clipboard.js'
import { rotateToken, type Config } from './config.js'
import { DeviceStore } from './devices.js'
import { EventHub } from './events.js'
import { connectUrl, isOwnAddress, lanAddresses, primaryAddress } from './network.js'
import { PairingCode } from './pairing.js'
import { PeerSender } from './peer-send.js'
import { PeerStore } from './peer-store.js'
import { NO_DISCOVERY, startDiscovery, type Discovery } from './peers.js'
import { archiveRoutes } from './routes/archive.js'
import { clipsRoutes } from './routes/clips.js'
import { devicesRoutes } from './routes/devices.js'
import { filesRoutes } from './routes/files.js'
import { peersRoutes } from './routes/peers.js'
import { staticRoutes } from './static.js'
import { ClipStore } from './store/clips.js'
import { thumbnailsAvailable } from './thumbs.js'
import { ensureCertificate, fingerprintOf } from './tls.js'

/** Период пинга WebSocket. Два пропущенных подряд — соединение считается мёртвым. */
const HEARTBEAT_MS = 30_000

const QR_OPTIONS = { type: 'svg', margin: 1, width: 240 } as const

export interface App {
  server: FastifyInstance
  hub: EventHub
  clips: ClipStore
  devices: DeviceStore
  discovery: Discovery
  config: Config
  close(): Promise<void>
}

export interface AppHooks {
  /** Корректно остановить приложение по запросу из интерфейса. */
  onShutdown?: () => void
}

export async function buildApp(config: Config, hooks: AppHooks = {}): Promise<App> {
  const https = config.tls ? await ensureCertificate(config.dataDir) : null

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    ...(https ? { https: { key: https.key, cert: https.cert } } : {}),
  })

  const hub = new EventHub()
  const clips = new ClipStore(config.dataDir, config.maxClips)
  const devices = new DeviceStore(config.dataDir)
  const peers = new PeerStore(config.dataDir)
  const pairing = new PairingCode()
  const sender = new PeerSender(hub, peers)

  // Анонс и поиск соседей — одна и та же многоадресная рассылка, поэтому LANSYNC_MDNS=0
  // выключает и то и другое: кто её отключил, не хочет её ни в какую сторону.
  const discovery =
    config.mdns ?
      await startDiscovery({
        selfId: config.peerId,
        deviceName: config.deviceName,
        port: config.port,
        tls: Boolean(https),
        fingerprint: https ? fingerprintOf(https.cert) : null,
        onChange: () => hub.broadcast('peers:changed'),
      })
    : NO_DISCOVERY

  app.addHook('onRequest', async (request, reply) => {
    if (!needsAuth(request.url)) return
    if (authorize(request, config, devices).ok) return
    return reply.code(401).send({ error: 'нужен токен доступа' })
  })

  /*
   * Страница, открытая на самом ПК по сетевому адресу машины, упиралась в запрос токена:
   * по адресу источника такой запрос неотличим от телефона, а токен лежит только в ссылке
   * из QR-кода. В стартовом выводе рядом стоят «На этом ПК» и «В сети», и вторую строку
   * копируют чаще. Отправляем на localhost — там доступ даётся по адресу.
   *
   * Ссылку с токеном не трогаем: по ней страницу открывают на ПК нарочно, чтобы посмотреть,
   * что видит телефон. Границу доступа это не двигает — `authorize` по-прежнему признаёт
   * своими только loopback-адреса.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET') return
    const [path, query] = request.url.split('?')
    if (path !== '/' && path !== '/index.html') return
    if (new URLSearchParams(query ?? '').has('t')) return
    if (!isOwnAddress(request.ip)) return
    // Порт берём из запроса, а не из конфигурации: так переживает и нестандартный порт.
    const port = /:\d+$/.exec(request.headers.host ?? '')?.[0] ?? ''
    return reply.redirect(`${https ? 'https' : 'http'}://localhost${port}${request.url}`, 302)
  })

  /*
   * Часть эндпоинтов вызывается методом POST без тела. Некоторые клиенты (например,
   * PowerShell) всё равно подставляют Content-Type формы, и Fastify отвечал 415, хотя
   * тело не нужно вовсе. Разбираем такой запрос как пустой вместо отказа.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body === '' ? undefined : Object.fromEntries(new URLSearchParams(String(body))))
    },
  )

  await app.register(multipart, {
    limits: {
      fileSize: Number.MAX_SAFE_INTEGER,
      files: 50,
      fieldSize: 1024 * 1024,
    },
  })
  await app.register(websocket)
  await app.register(staticRoutes)

  app.get('/api/info', async (request) => ({
    deviceName: config.deviceName,
    version: '0.3.0',
    // На самом ПК токен не используется, поэтому «Отключиться» там не показываем —
    // вместо неё предлагается смена токена, отвязывающая все устройства.
    local: isLoopback(request),
    inboxDir: isLoopback(request) ? config.inboxDir : undefined,
    authorized: authorize(request, config, devices).ok,
    clipboard: config.watchClipboard,
    keepDays: config.keepDays,
    // Превью для присланных файлов строит сам отправитель; этот флаг говорит лишь о том,
    // может ли сервер сделать превью для файлов, положенных в каталог мимо приложения.
    serverThumbs: await thumbnailsAvailable(),
    secure: Boolean(https),
  }))

  /** Панель подключения телефона показывается только на самом ПК — токен наружу не уходит. */
  app.get('/api/connect', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send({ error: 'доступно только с этого компьютера' })
    /*
     * QR готовится на каждый адрес машины, а не только на лучший по эвристике. Угадать
     * нельзя: если компьютер раздаёт точку доступа и сам подключён к другой сети, таблица
     * маршрутизации укажет на вторую, а телефон сидит в первой. Выбор оставляем человеку.
     */
    const primary = await primaryAddress()
    const all = [primary, ...lanAddresses().map((entry) => entry.address)]
    const addresses = await Promise.all(
      [...new Set(all)].map(async (address) => {
        const link = connectUrl(address, config.port, config.token, Boolean(https))
        return { address, url: link, qr: await QRCode.toString(link, QR_OPTIONS) }
      }),
    )
    return {
      url: addresses[0]?.url ?? '',
      qr: addresses[0]?.qr ?? '',
      addresses,
      port: config.port,
      token: config.token,
      secure: Boolean(https),
    }
  })

  app.get('/api/events', { websocket: true }, (socket, request) => {
    const auth = authorize(request, config, devices)
    const remove = hub.add({
      send: (message) => socket.send(message),
      close: (code, reason) => socket.close(code ?? 1000, reason),
      deviceId: auth.device?.id ?? null,
      ip: request.ip,
      since: Date.now(),
    })
    if (auth.device) hub.broadcast('devices:changed')

    /*
     * Оборванное соединение (телефон ушёл из зоны Wi-Fi, заснул) не всегда
     * присылает close — сокет остаётся «наполовину открытым». Пинги выявляют
     * такие соединения и освобождают их; браузер отвечает pong на уровне
     * протокола, без участия кода страницы.
     */
    let alive = true
    socket.on('pong', () => {
      alive = true
      if (auth.device) devices.touch(auth.device.id)
    })
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      try {
        socket.ping()
      } catch {
        socket.terminate()
      }
    }, HEARTBEAT_MS)
    heartbeat.unref()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      remove()
      if (auth.device) hub.broadcast('devices:changed')
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
    socket.send(JSON.stringify({ type: 'hello', payload: { deviceName: config.deviceName } }))
  })

  /*
   * Цель «Поделиться → LanSync» обрабатывает service worker, не доходя до сети.
   * Этот обработчик — на случай, когда worker ещё не активен: без него браузер
   * получил бы 404 и пользователь решил бы, что отправка сорвалась.
   */
  app.post('/share', async (_request, reply) => reply.redirect('/', 303))

  /*
   * Управление приложением из интерфейса — единственный способ, доступный человеку,
   * который запустил его двойным кликом и не работает с командной строкой. Значка в
   * трее нет, а искать процесс в диспетчере задач — не вариант.
   * Только с самого компьютера: останавливать сервис с телефона незачем.
   */
  app.get('/api/autostart', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send({ error: 'доступно только с этого компьютера' })
    return { enabled: autostartEnabled(), supported: autostartSupported() }
  })

  app.post<{ Body: { enabled?: unknown } }>('/api/autostart', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send({ error: 'доступно только с этого компьютера' })
    const wanted = request.body?.enabled === true
    const result = wanted ? await installAutostart() : await uninstallAutostart()
    if (!result.ok) return reply.code(400).send({ error: result.message })
    return { enabled: autostartEnabled(), message: result.message }
  })

  app.post('/api/shutdown', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send({ error: 'доступно только с этого компьютера' })
    if (!hooks.onShutdown) return reply.code(501).send({ error: 'остановка недоступна в этом режиме' })
    // Сначала отвечаем, потом выходим: иначе страница не узнает, что всё получилось.
    setTimeout(() => hooks.onShutdown?.(), 250)
    return { ok: true }
  })

  /** Смена токена: все ранее привязанные устройства мгновенно теряют доступ. */
  app.post('/api/token/rotate', async (request, reply) => {
    if (!isLoopback(request)) return reply.code(403).send({ error: 'доступно только с этого компьютера' })
    config.token = rotateToken(config.dataDir)
    await devices.clear()
    hub.closeAll()
    return { ok: true }
  })

  await app.register(filesRoutes, { config, hub })
  await app.register(clipsRoutes, { config, hub, clips })
  await app.register(devicesRoutes, { config, hub, devices })
  await app.register(archiveRoutes, { config })
  await app.register(peersRoutes, { config, hub, devices, peers, discovery, sender, pairing })

  const cleaner: Cleaner = startCleanup(config, hub)

  let watcher: ClipboardWatcher | undefined
  if (config.watchClipboard) {
    watcher = startClipboardWatcher(
      (text) => {
        if (clips.latest()?.text === text) return
        void clips.add(text, config.deviceName).then((clip) => hub.broadcast('clip:added', clip))
      },
      { initial: clips.latest()?.text ?? null },
    )
  }

  return {
    server: app,
    hub,
    clips,
    devices,
    discovery,
    config,
    close: async () => {
      watcher?.stop()
      cleaner.stop()
      discovery.stop()
      sender.stop()
      await app.close()
    },
  }
}
