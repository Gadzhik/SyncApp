const TOKEN_KEY = 'lansync.token'

/** Токен приходит в ссылке из QR-кода: сохраняем и убираем из адресной строки. */
export function adoptTokenFromUrl() {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('t')
  if (!fromUrl) return
  setToken(fromUrl)
  url.searchParams.delete('t')
  history.replaceState(null, '', url.pathname + url.search + url.hash)
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* приватный режим — переживём, токен будет жить до перезагрузки */
  }
}

/** Забыть привязку к серверу: устройство перестаёт иметь доступ до нового сканирования QR. */
export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* нечего чистить */
  }
}

/** Для ссылок и WebSocket токен приходится класть в query: заголовок там задать нельзя. */
export function urlWithToken(path) {
  const token = getToken()
  if (!token) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}t=${encodeURIComponent(token)}`
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  const token = getToken()
  if (token) headers['X-Sync-Token'] = token
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetch(path, { ...options, headers })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? `ошибка ${response.status}`)
  }
  return data
}

/**
 * Загрузка через XMLHttpRequest, а не fetch: только он сообщает прогресс отправки
 * (у fetch есть прогресс скачивания, но не выгрузки).
 */
export function uploadFiles(files, { onProgress, onDone, thumb } = {}) {
  const form = new FormData()
  for (const file of files) form.append('files', file, file.name)
  // Превью идёт последним полем: сервер сначала запишет файл, потом получит миниатюру.
  if (thumb) form.append('thumb', thumb, 'thumb.jpg')

  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/files')
    const token = getToken()
    if (token) xhr.setRequestHeader('X-Sync-Token', token)

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total)
    })
    xhr.addEventListener('load', () => {
      let payload = null
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        /* тело не JSON — обработаем ниже по статусу */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload)
      else reject(new ApiError(xhr.status, payload?.error ?? `ошибка ${xhr.status}`))
    })
    xhr.addEventListener('error', () => reject(new ApiError(0, 'сеть недоступна')))
    xhr.addEventListener('abort', () => reject(new ApiError(0, 'отменено')))
    xhr.send(form)
  }).finally(() => onDone?.())

  return { promise, cancel: () => xhr.abort() }
}

/**
 * WebSocket с переподключением: телефон рвёт соединение при блокировке экрана,
 * поэтому без автовосстановления список перестаёт обновляться.
 */
export function connectEvents({ onEvent, onStatus }) {
  let socket = null
  let attempt = 0
  let closed = false
  let timer = null

  const open = () => {
    if (closed) return
    const url = new URL(urlWithToken('/api/events'), location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      attempt = 0
      onStatus?.('online')
    })
    socket.addEventListener('message', (event) => {
      try {
        onEvent?.(JSON.parse(event.data))
      } catch {
        /* некорректное сообщение игнорируем */
      }
    })
    socket.addEventListener('close', () => {
      onStatus?.('offline')
      schedule()
    })
    socket.addEventListener('error', () => socket?.close())
  }

  const schedule = () => {
    if (closed || timer) return
    attempt += 1
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15000)
    timer = setTimeout(() => {
      timer = null
      open()
    }, delay)
  }

  open()

  // Возврат из фона — не ждём таймер, проверяем соединение сразу.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (socket && socket.readyState === WebSocket.OPEN) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    attempt = 0
    open()
  })

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    },
  }
}
