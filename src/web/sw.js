const CACHE = 'lansync-shell-v2'
const AUTH_CACHE = 'lansync-auth'
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/api.js', '/icon.svg', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE && key !== AUTH_CACHE).map((key) => caches.delete(key))),
      ),
  )
  self.clients.claim()
})

/** Страница кладёт сюда токен: у service worker нет доступа к localStorage. */
async function readToken() {
  try {
    const cache = await caches.open(AUTH_CACHE)
    const stored = await cache.match('/__token')
    return stored ? await stored.text() : null
  } catch {
    return null
  }
}

/**
 * Приём из системного меню «Поделиться». Браузер отправляет сюда POST с файлами
 * или текстом; пересылаем их в обычные эндпоинты и возвращаем пользователя на
 * главную страницу.
 */
async function handleShare(request) {
  const token = await readToken()
  const headers = token ? { 'X-Sync-Token': token } : {}

  try {
    const form = await request.formData()
    const files = form.getAll('files').filter((item) => item instanceof File && item.size > 0)

    if (files.length > 0) {
      // По одному запросу на файл — так же, как это делает страница.
      for (const file of files) {
        const body = new FormData()
        body.append('files', file, file.name)
        await fetch('/api/files', { method: 'POST', headers, body })
      }
    }

    const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n').trim()
    if (files.length === 0 && text) {
      await fetch('/api/clips', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: 'поделиться' }),
      })
    }
  } catch {
    // ошибку покажет сама страница: список просто не пополнится
  }

  return Response.redirect('/?shared=1', 303)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(event.request))
    return
  }

  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return

  /*
   * Кэшируется только оболочка. Данные (/api/*) всегда идут в сеть: показать
   * устаревший список файлов хуже, чем честно показать отсутствие связи.
   */
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match('/index.html'))),
  )
})
