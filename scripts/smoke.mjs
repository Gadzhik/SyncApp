#!/usr/bin/env node
/*
 * Сквозная проверка против уже запущенного сервера.
 *
 * Ключевая деталь: запросы идут по LAN-адресу машины, а не по localhost. Запросы с
 * loopback авторизуются по адресу, поэтому через localhost логика токенов, привязки и
 * отзыва устройств просто не включается — проверять её так бессмысленно.
 *
 * Запуск:  npm run smoke            (порт из LANSYNC_PORT или 8420)
 *          npm run smoke -- 8500
 */
import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

// Сертификат самоподписанный; доверяем ему только в рамках проверки.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const port = Number(process.argv[2] ?? process.env.LANSYNC_PORT ?? 8420)

let passed = 0
let failed = 0
let skipped = 0

function check(label, ok, extra = '') {
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
}

/** Не всякая проверка применима: буфер обмена недоступен в SSH-сессии и без xclip на Linux. */
function skip(label, reason) {
  skipped += 1
  console.log(`SKIP  ${label} — ${reason}`)
}

/** Адрес, через который система выходит в сеть — тем же способом, что и сам сервер. */
function routedAddress() {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const done = (value) => {
      try {
        socket.close()
      } catch {}
      resolve(value)
    }
    socket.on('error', () => done(null))
    const timer = setTimeout(() => done(null), 300)
    socket.connect(53, '198.51.100.1', () => {
      clearTimeout(timer)
      const address = socket.address().address
      done(address && address !== '0.0.0.0' ? address : null)
    })
  })
}

/** Как и сервер: обычный адрес в приоритете, link-local — только если других нет. */
function fallbackAddress() {
  let linkLocal = null
  for (const addresses of Object.values(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) linkLocal ??= addr.address
      else return addr.address
    }
  }
  return linkLocal
}

async function detectScheme(host) {
  for (const scheme of ['https', 'http']) {
    try {
      const response = await fetch(`${scheme}://${host}:${port}/api/info`, { signal: AbortSignal.timeout(3000) })
      if (response.ok) return scheme
    } catch {
      /* пробуем следующую схему */
    }
  }
  return null
}

async function main() {
  const address = (await routedAddress()) ?? fallbackAddress()
  if (!address) {
    console.error('Не удалось определить сетевой адрес машины — проверьте подключение к сети.')
    process.exit(1)
  }

  const scheme = await detectScheme('127.0.0.1')
  if (!scheme) {
    console.error(`На порту ${port} никто не отвечает. Запустите сервер: npm run dev`)
    process.exit(1)
  }

  const LAN = `${scheme}://${address}:${port}` // «устройство из сети»
  const LOCAL = `${scheme}://127.0.0.1:${port}` // «этот компьютер»
  console.log(`Проверяю ${LAN}\n`)

  const info = await (await fetch(`${LOCAL}/api/info`)).json()
  check('сервер отвечает', Boolean(info.deviceName), `${info.deviceName}, версия ${info.version}`)

  const connect = await (await fetch(`${LOCAL}/api/connect`)).json()
  const shared = connect.token
  check(
    'QR готов на каждый адрес машины',
    connect.addresses.length > 0 &&
      connect.addresses.every((entry) => entry.qr?.startsWith('<svg') && entry.url.includes(entry.address)),
    `адресов ${connect.addresses.length}`,
  )

  // --- доступ ---
  check('без токена из сети — 401', (await fetch(`${LAN}/api/files`)).status === 401)
  check(
    'панель подключения закрыта из сети — 403',
    (await fetch(`${LAN}/api/connect`, { headers: { 'X-Sync-Token': shared } })).status === 403,
  )
  check(
    'управление приложением закрыто из сети — 403',
    (await fetch(`${LAN}/api/autostart`, { headers: { 'X-Sync-Token': shared } })).status === 403,
  )

  check(
    'обмен между компьютерами закрыт из сети — 403',
    (await fetch(`${LAN}/api/peers`, { headers: { 'X-Sync-Token': shared } })).status === 403,
  )
  const peers = await (await fetch(`${LOCAL}/api/peers`)).json()
  check('список соседей отдаётся с ПК', Array.isArray(peers.peers), `найдено ${peers.peers?.length ?? 0}`)

  // --- привязка устройства ---
  const pair = await (
    await fetch(`${LAN}/api/pair`, {
      method: 'POST',
      headers: {
        'X-Sync-Token': shared,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
      },
    })
  ).json()
  check('привязка выдаёт персональный токен', Boolean(pair.token) && pair.token !== shared, pair.device?.name)
  const auth = { 'X-Sync-Token': pair.token }
  check('персональный токен работает', (await fetch(`${LAN}/api/files`, { headers: auth })).status === 200)

  const devices = (await (await fetch(`${LOCAL}/api/devices`)).json()).devices
  check(
    'устройство видно в списке',
    devices.some((device) => device.id === pair.device.id),
    `всего ${devices.length}`,
  )

  // --- файлы: приём, превью, целостность ---
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const name = `smoke-проверка-${process.pid}.png`
  const form = new FormData()
  form.append('files', new Blob([png]), name)
  form.append('thumb', new Blob([Buffer.from('превью-от-отправителя')]), 'thumb.jpg')
  check('загрузка файла', (await fetch(`${LAN}/api/files`, { method: 'POST', headers: auth, body: form })).status === 200)

  const files = (await (await fetch(`${LAN}/api/files`, { headers: auth })).json()).files
  const entry = files.find((file) => file.name === name)
  check('файл в списке', Boolean(entry), entry && `${entry.size} Б`)

  const back = Buffer.from(await (await fetch(`${LAN}/api/files/${entry.id}`, { headers: auth })).arrayBuffer())
  check('скачивается байт в байт', back.equals(png))

  const thumb = await fetch(`${LAN}/api/files/${entry.id}/thumb`, { headers: auth })
  check(
    'превью от отправителя сохранено',
    thumb.status === 200 && (await thumb.text()) === 'превью-от-отправителя',
  )

  const ranged = await fetch(`${LAN}/api/files/${entry.id}`, { headers: { ...auth, Range: 'bytes=0-9' } })
  check('Range отдаёт 206', ranged.status === 206, ranged.headers.get('content-range') ?? '')

  // --- архив ---
  const zip = Buffer.from(
    await (await fetch(`${LAN}/api/archive?ids=${entry.id}`, { headers: auth })).arrayBuffer(),
  )
  check('архив собирается', zip.subarray(0, 2).toString('latin1') === 'PK', `${zip.length} Б`)

  // --- текст ---
  const clip = await (
    await fetch(`${LAN}/api/clips`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'проверка обмена текстом 🎉', from: 'smoke' }),
    })
  ).json()
  check('текстовая запись создана', Boolean(clip.clip?.id))
  const toPc = await fetch(`${LAN}/api/clips/${clip.clip.id}/to-pc-clipboard`, { method: 'POST', headers: auth })
  if (toPc.status === 503) {
    // 503 — штатный ответ там, где буфера нет: сессия без рабочего стола, SSH,
    // Linux без xclip/wl-clipboard. Это не дефект приложения.
    skip('запись в буфер обмена ПК', 'буфер обмена недоступен в этой сессии')
  } else {
    check('запись уходит в буфер обмена ПК', toPc.status === 200, `HTTP ${toPc.status}`)
  }

  // --- уборка за собой ---
  const removed = await (
    await fetch(`${LAN}/api/files/delete`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [entry.id] }),
    })
  ).json()
  check('пакетное удаление', removed.removed.length === 1)
  await fetch(`${LAN}/api/clips/${clip.clip.id}`, { method: 'DELETE', headers: auth })

  check(
    'отзыв устройства с компьютера',
    (await fetch(`${LOCAL}/api/devices/${pair.device.id}`, { method: 'DELETE' })).status === 200,
  )
  check('отозванный токен больше не работает', (await fetch(`${LAN}/api/files`, { headers: auth })).status === 401)

  console.log(`\nПройдено ${passed}, провалено ${failed}${skipped ? `, пропущено ${skipped}` : ''}`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(`\nПроверка сорвалась: ${error.message}`)
  process.exit(1)
})
