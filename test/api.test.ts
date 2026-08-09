import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { buildApp, type App } from '../src/server/app.ts'
import { startCleanup } from '../src/server/cleanup.ts'
import { loadConfig } from '../src/server/config.ts'
import { EventHub } from '../src/server/events.ts'
import { sanitizeName } from '../src/server/store/files.ts'

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

describe('LanSync API', () => {
  let app: App
  let base: string
  let dataDir: string
  let token: string

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'lansync-test-'))
    // tls отключаем: тесты ходят обычным fetch по http, самоподписанный сертификат тут только мешает
    const config = loadConfig({
      dataDir,
      port: 0,
      host: '127.0.0.1',
      mdns: false,
      watchClipboard: false,
      tls: false,
    })
    token = config.token
    app = await buildApp(config)
    await app.server.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.server.address()
    assert.ok(address && typeof address === 'object')
    base = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('отдаёт сведения о сервере', async () => {
    const response = await fetch(`${base}/api/info`)
    assert.equal(response.status, 200)
    const info = (await response.json()) as { deviceName: string }
    assert.ok(info.deviceName.length > 0)
  })

  it('принимает файл, показывает в списке и отдаёт байт в байт', async () => {
    const payload = randomBytes(256 * 1024)
    const form = new FormData()
    form.append('files', new Blob([payload]), 'заметка ✨.bin')

    const upload = await fetch(`${base}/api/files`, { method: 'POST', body: form })
    assert.equal(upload.status, 200)

    const listed = (await (await fetch(`${base}/api/files`)).json()) as {
      files: { id: string; name: string; size: number }[]
    }
    const entry = listed.files.find((file) => file.name === 'заметка ✨.bin')
    assert.ok(entry, 'файл должен появиться в списке')
    assert.equal(entry.size, payload.length)

    const download = await fetch(`${base}/api/files/${entry.id}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('accept-ranges'), 'bytes')
    const received = new Uint8Array(await download.arrayBuffer())
    assert.equal(sha256(received), sha256(payload), 'содержимое не должно измениться')
  })

  it('поддерживает Range — без него не работает перемотка видео', async () => {
    const payload = randomBytes(10_000)
    const form = new FormData()
    form.append('files', new Blob([payload]), 'clip.mp4')
    await fetch(`${base}/api/files`, { method: 'POST', body: form })

    const listed = (await (await fetch(`${base}/api/files`)).json()) as { files: { id: string; name: string }[] }
    const entry = listed.files.find((file) => file.name === 'clip.mp4')
    assert.ok(entry)

    const response = await fetch(`${base}/api/files/${entry.id}`, { headers: { Range: 'bytes=100-199' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 100-199/${payload.length}`)
    const chunk = new Uint8Array(await response.arrayBuffer())
    assert.equal(chunk.length, 100)
    assert.equal(sha256(chunk), sha256(payload.subarray(100, 200)))
  })

  it('не даёт выйти за пределы каталога обмена', async () => {
    const form = new FormData()
    form.append('files', new Blob([Buffer.from('payload')]), '../../evil.txt')
    const response = await fetch(`${base}/api/files`, { method: 'POST', body: form })
    assert.equal(response.status, 200)

    const names = await readdir(join(dataDir, 'inbox'))
    assert.ok(
      names.includes('evil.txt'),
      `файл должен лечь прямо в inbox, а не выше по дереву: ${names.join(', ')}`,
    )
    const outside = await readdir(dataDir)
    assert.ok(!outside.includes('evil.txt'), 'ничего не должно записываться за пределы inbox')
  })

  it('разводит одинаковые имена суффиксом', async () => {
    for (let i = 0; i < 2; i++) {
      const form = new FormData()
      form.append('files', new Blob([Buffer.from(`копия ${i}`)]), 'dup.txt')
      await fetch(`${base}/api/files`, { method: 'POST', body: form })
    }
    const names = await readdir(join(dataDir, 'inbox'))
    assert.ok(names.includes('dup.txt'))
    assert.ok(names.includes('dup (2).txt'))
  })

  it('сохраняет и возвращает текстовые записи', async () => {
    const response = await fetch(`${base}/api/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'привет из теста', from: 'тест' }),
    })
    assert.equal(response.status, 200)

    const listed = (await (await fetch(`${base}/api/clips`)).json()) as { clips: { text: string; from: string }[] }
    assert.equal(listed.clips[0]?.text, 'привет из теста')
    assert.equal(listed.clips[0]?.from, 'тест')
  })

  it('отклоняет пустой текст', async () => {
    const response = await fetch(`${base}/api/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    })
    assert.equal(response.status, 400)
  })

  // Запросы с самой машины авторизуются автоматически, поэтому проверяем через inject
  // с подменённым адресом — так выглядит обращение с телефона.
  it('требует токен от устройств из сети', async () => {
    const denied = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.50',
    })
    assert.equal(denied.statusCode, 401)

    const allowed = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.50',
      headers: { 'x-sync-token': token },
    })
    assert.equal(allowed.statusCode, 200)

    const viaQuery = await app.server.inject({
      method: 'GET',
      url: `/api/files?t=${encodeURIComponent(token)}`,
      remoteAddress: '192.168.1.50',
    })
    assert.equal(viaQuery.statusCode, 200, 'ссылки на скачивание передают токен в query')
  })

  it('не показывает токен подключения устройствам из сети', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/connect?t=${encodeURIComponent(token)}`,
      remoteAddress: '192.168.1.50',
    })
    assert.equal(response.statusCode, 403)
  })

  it('сообщает, что именно принято, когда пачка не влезла целиком', async () => {
    const form = new FormData()
    for (let i = 1; i <= 60; i++) {
      form.append('files', new Blob([Buffer.from(`файл ${i}`)]), `over-${String(i).padStart(2, '0')}.txt`)
    }
    const response = await fetch(`${base}/api/files`, { method: 'POST', body: form })
    assert.equal(response.status, 413)

    const body = (await response.json()) as { error: string; saved: { name: string }[] }
    const onDisk = (await readdir(join(dataDir, 'inbox'))).filter((n) => n.startsWith('over-')).length
    assert.ok(Array.isArray(body.saved), 'ответ должен перечислять принятое')
    assert.equal(
      body.saved.length,
      onDisk,
      'число в ответе должно совпадать с тем, что реально записано на диск',
    )
    assert.match(body.error, /принято файлов/)
  })

  it('смена токена доступна только с этого компьютера и отзывает старый', async () => {
    const denied = await app.server.inject({
      method: 'POST',
      url: `/api/token/rotate?t=${encodeURIComponent(token)}`,
      remoteAddress: '192.168.1.50',
    })
    assert.equal(denied.statusCode, 403, 'с телефона менять токен нельзя')

    const rotated = await fetch(`${base}/api/token/rotate`, { method: 'POST' })
    assert.equal(rotated.status, 200)

    const withOldToken = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.50',
      headers: { 'x-sync-token': token },
    })
    assert.equal(withOldToken.statusCode, 401, 'старый токен должен перестать работать')

    const fresh = (await (await fetch(`${base}/api/connect`)).json()) as { token: string }
    assert.notEqual(fresh.token, token)

    const withNewToken = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.50',
      headers: { 'x-sync-token': fresh.token },
    })
    assert.equal(withNewToken.statusCode, 200)
    token = fresh.token
  })

  // Привязка и отзыв имеют смысл только для устройств из сети: запросы с самой
  // машины авторизуются по адресу, поэтому здесь всюду inject с чужим remoteAddress.
  it('выдаёт устройству персональный токен и позволяет отозвать его отдельно', async () => {
    const paired = await app.server.inject({
      method: 'POST',
      url: '/api/pair',
      remoteAddress: '192.168.1.77',
      headers: {
        'x-sync-token': token,
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      },
    })
    assert.equal(paired.statusCode, 200)
    const { device, token: personal } = paired.json() as { device: { id: string; name: string }; token: string }
    assert.match(device.name, /iPhone/)
    assert.notEqual(personal, token, 'персональный токен не должен совпадать с общим')

    const listed = await app.server.inject({ method: 'GET', url: '/api/devices' })
    const devices = (listed.json() as { devices: { id: string; name: string }[] }).devices
    assert.ok(
      devices.some((item) => item.id === device.id),
      'устройство должно появиться в реестре',
    )

    const withPersonal = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.77',
      headers: { 'x-sync-token': personal },
    })
    assert.equal(withPersonal.statusCode, 200)

    const revokedFromLan = await app.server.inject({
      method: 'DELETE',
      url: `/api/devices/${device.id}`,
      remoteAddress: '192.168.1.77',
      headers: { 'x-sync-token': personal },
    })
    assert.equal(revokedFromLan.statusCode, 403, 'отзывать устройства можно только с компьютера')

    const revoked = await app.server.inject({ method: 'DELETE', url: `/api/devices/${device.id}` })
    assert.equal(revoked.statusCode, 200)

    const afterRevoke = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.77',
      headers: { 'x-sync-token': personal },
    })
    assert.equal(afterRevoke.statusCode, 401, 'отозванный токен должен перестать работать')

    // общий токен продолжает действовать — отзыв одного устройства не трогает остальные
    const sharedStillWorks = await app.server.inject({
      method: 'GET',
      url: '/api/files',
      remoteAddress: '192.168.1.78',
      headers: { 'x-sync-token': token },
    })
    assert.equal(sharedStillWorks.statusCode, 200)
  })

  it('собирает архив из нескольких файлов', async () => {
    for (const name of ['arch-a.txt', 'arch-b.txt']) {
      const form = new FormData()
      form.append('files', new Blob([Buffer.from(`содержимое ${name}`)]), name)
      await fetch(`${base}/api/files`, { method: 'POST', body: form })
    }

    const listed = (await (await fetch(`${base}/api/files`)).json()) as { files: { id: string; name: string }[] }
    const ids = listed.files.filter((file) => file.name.startsWith('arch-')).map((file) => file.id)
    assert.equal(ids.length, 2)

    const response = await fetch(`${base}/api/archive?ids=${ids.join(',')}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/zip')

    const zip = Buffer.from(await response.arrayBuffer())
    assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK', 'должна быть сигнатура ZIP')
    // имена лежат в архиве открытым текстом — достаточно, чтобы убедиться в составе
    assert.match(zip.toString('latin1'), /arch-a\.txt/)
    assert.match(zip.toString('latin1'), /arch-b\.txt/)
  })

  it('удаляет файлы пакетом', async () => {
    for (const name of ['bulk-1.txt', 'bulk-2.txt']) {
      const form = new FormData()
      form.append('files', new Blob([Buffer.from('x')]), name)
      await fetch(`${base}/api/files`, { method: 'POST', body: form })
    }
    const listed = (await (await fetch(`${base}/api/files`)).json()) as { files: { id: string; name: string }[] }
    const ids = listed.files.filter((file) => file.name.startsWith('bulk-')).map((file) => file.id)

    const response = await fetch(`${base}/api/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as { removed: string[] }).removed.length, 2)

    const names = await readdir(join(dataDir, 'inbox'))
    assert.ok(!names.some((name) => name.startsWith('bulk-')))
  })

  it('принимает миниатюру, присланную отправителем', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const form = new FormData()
    form.append('files', new Blob([png]), 'с-превью.png')
    form.append('thumb', new Blob([Buffer.from('поддельное-превью')]), 'thumb.jpg')
    const upload = await fetch(`${base}/api/files`, { method: 'POST', body: form })
    assert.equal(upload.status, 200)

    const listed = (await (await fetch(`${base}/api/files`)).json()) as { files: { id: string; name: string }[] }
    const entry = listed.files.find((file) => file.name === 'с-превью.png')
    assert.ok(entry)

    const thumb = await fetch(`${base}/api/files/${entry.id}/thumb`)
    assert.equal(thumb.status, 200, 'присланное превью должно отдаваться как есть')
    assert.equal(await thumb.text(), 'поддельное-превью')
  })

  it('строит миниатюру сам, если доступен sharp', async () => {
    const info = (await (await fetch(`${base}/api/info`)).json()) as { serverThumbs: boolean }
    if (!info.serverThumbs) return // sharp не установился — штатный режим для сборки в один файл

    const { default: sharp } = await import('sharp')
    const png = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#204080' },
    })
      .png()
      .toBuffer()

    const form = new FormData()
    form.append('files', new Blob([png]), 'картинка.png')
    await fetch(`${base}/api/files`, { method: 'POST', body: form })

    const listed = (await (await fetch(`${base}/api/files`)).json()) as {
      files: { id: string; name: string; thumb: boolean }[]
    }
    const entry = listed.files.find((file) => file.name === 'картинка.png')
    assert.ok(entry)
    assert.equal(entry.thumb, true, 'для картинки должен подниматься флаг thumb')

    const thumb = await fetch(`${base}/api/files/${entry.id}/thumb`)
    assert.equal(thumb.status, 200)
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg')

    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()
    assert.ok((meta.width ?? 0) <= 256 && (meta.height ?? 0) <= 256, 'миниатюра должна быть уменьшена')
  })

  it('управление приложением закрыто для устройств из сети', async () => {
    for (const [method, url] of [
      ['GET', '/api/autostart'],
      ['POST', '/api/autostart'],
      ['POST', '/api/shutdown'],
    ] as const) {
      const response = await app.server.inject({
        method,
        url: `${url}?t=${encodeURIComponent(token)}`,
        remoteAddress: '192.168.1.90',
        ...(method === 'POST' ? { payload: { enabled: true } } : {}),
      })
      assert.equal(response.statusCode, 403, `${method} ${url} должен быть запрещён из сети`)
    }
  })

  it('сообщает состояние автозапуска для локального запроса', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/autostart' })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { enabled: boolean; supported: boolean }
    assert.equal(typeof body.enabled, 'boolean')
    // Тесты идут из исходников, поэтому автозапуск здесь принципиально недоступен —
    // интерфейс по этому флагу гасит переключатель вместо молчаливого отказа.
    assert.equal(body.supported, false)
  })

  it('остановка недоступна, если приложение запущено без обработчика', async () => {
    const response = await app.server.inject({ method: 'POST', url: '/api/shutdown' })
    assert.equal(response.statusCode, 501)
  })

  it('отдаёт страницу приложения', async () => {
    const response = await fetch(`${base}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /LanSync/)
  })
})

describe('ресурсы клиента', () => {
  it('WEB_FILES перечисляет ровно то, что лежит в src/web', async () => {
    // Сборка в один файл кладёт внутрь всё содержимое каталога, а отдаёт сервер только
    // перечисленное в WEB_FILES. Расхождение означало бы, что файл упакован, но недоступен.
    const { WEB_FILES } = await import('../src/server/static.ts')
    const onDisk = (await readdir(join(import.meta.dirname, '..', 'src', 'web'), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual([...WEB_FILES].sort(), onDisk)
  })
})

describe('автоочистка', () => {
  it('удаляет файлы старше срока и не трогает свежие', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lansync-clean-'))
    try {
      const config = loadConfig({
        dataDir: dir,
        port: 0,
        mdns: false,
        watchClipboard: false,
        tls: false,
        keepDays: 7,
      })
      const inbox = join(dir, 'inbox')

      await writeFile(join(inbox, 'старый.txt'), 'x')
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      await utimes(join(inbox, 'старый.txt'), longAgo, longAgo)
      await writeFile(join(inbox, 'свежий.txt'), 'x')

      const cleaner = startCleanup(config, new EventHub())
      const removed = await cleaner.ready
      cleaner.stop()

      assert.deepEqual(removed, ['старый.txt'])
      const left = await readdir(inbox)
      assert.ok(left.includes('свежий.txt'), 'свежий файл должен остаться')
      assert.ok(!left.includes('старый.txt'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('при выключенной автоочистке ничего не удаляет', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lansync-clean-off-'))
    try {
      const config = loadConfig({
        dataDir: dir,
        port: 0,
        mdns: false,
        watchClipboard: false,
        tls: false,
        keepDays: 0,
      })
      const inbox = join(dir, 'inbox')
      await writeFile(join(inbox, 'древний.txt'), 'x')
      const longAgo = new Date(Date.now() - 900 * 24 * 60 * 60 * 1000)
      await utimes(join(inbox, 'древний.txt'), longAgo, longAgo)

      const cleaner = startCleanup(config, new EventHub())
      assert.deepEqual(await cleaner.ready, [])
      cleaner.stop()
      assert.ok((await readdir(inbox)).includes('древний.txt'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('sanitizeName', () => {
  it('срезает путь и запрещённые символы', () => {
    assert.equal(sanitizeName('../../etc/passwd'), 'passwd')
    assert.equal(sanitizeName('C:\\Windows\\system32\\evil.exe'), 'evil.exe')
    assert.equal(sanitizeName('a|b*c?.txt'), 'a_b_c_.txt')
    assert.equal(sanitizeName('...'), 'file')
    assert.equal(sanitizeName(''), 'file')
  })

  it('не оставляет символов, запрещённых в именах файлов', () => {
    // Двоеточие обрабатывается по-разному (на Windows `a:` — префикс диска),
    // поэтому проверяем инвариант, а не конкретную строку.
    for (const raw of ['a:b.txt', 'x<y>z.txt', 'q"w.txt', 'tab\there.txt']) {
      const name = sanitizeName(raw)
      assert.doesNotMatch(name, /[<>:"/\\|?*]/, `«${raw}» → «${name}»`)
      assert.ok(name.length > 0)
    }
  })

  it('сохраняет обычные имена без изменений', () => {
    assert.equal(sanitizeName('Отчёт 2026-08-05.pdf'), 'Отчёт 2026-08-05.pdf')
    assert.equal(sanitizeName('photo.jpg'), 'photo.jpg')
  })
})
