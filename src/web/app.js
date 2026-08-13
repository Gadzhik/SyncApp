import {
  adoptTokenFromUrl,
  api,
  ApiError,
  clearToken,
  connectEvents,
  getToken,
  setToken,
  uploadFiles,
  urlWithToken,
} from './api.js'

const $ = (selector) => document.querySelector(selector)

const el = {
  deviceName: $('#device-name'),
  connDot: $('#conn-dot'),
  tabs: document.querySelectorAll('.tab'),
  panels: { files: $('#panel-files'), text: $('#panel-text') },
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  pickFiles: $('#pick-files'),
  uploads: $('#uploads'),
  files: $('#files'),
  filesCount: $('#files-count'),
  filesEmpty: $('#files-empty'),
  filesToolbar: $('#files-toolbar'),
  selectAll: $('#select-all'),
  selectionInfo: $('#selection-info'),
  downloadZip: $('#download-zip'),
  deleteSelected: $('#delete-selected'),
  clipInput: $('#clip-input'),
  clipSend: $('#clip-send'),
  clips: $('#clips'),
  clipsCount: $('#clips-count'),
  clipsEmpty: $('#clips-empty'),
  devices: $('#devices'),
  devicesList: $('#devices-list'),
  devicesCount: $('#devices-count'),
  devicesEmpty: $('#devices-empty'),
  sendTo: $('#send-to'),
  peers: $('#peers'),
  peersList: $('#peers-list'),
  peersCount: $('#peers-count'),
  peersEmpty: $('#peers-empty'),
  peerTransfers: $('#peer-transfers'),
  peerCode: $('#peer-code'),
  peerCodeShow: $('#peer-code-show'),
  peerCodeHide: $('#peer-code-hide'),
  peerHost: $('#peer-host'),
  peerPort: $('#peer-port'),
  peerCodeInput: $('#peer-code-input'),
  peerAdd: $('#peer-add'),
  connect: $('#connect'),
  connectQr: $('#connect-qr'),
  connectUrl: $('#connect-url'),
  connectAddresses: $('#connect-addresses'),
  connectHint: $('#connect-hint'),
  certNote: $('#cert-note'),
  cleanupNote: $('#cleanup-note'),
  rotateToken: $('#rotate-token'),
  disconnect: $('#disconnect'),
  control: $('#control'),
  autostart: $('#autostart'),
  autostartNote: $('#autostart-note'),
  shutdown: $('#shutdown'),
  toast: $('#toast'),
  gate: $('#token-gate'),
  tokenInput: $('#token-input'),
  tokenSave: $('#token-save'),
  tokenError: $('#token-error'),
}

/** Имя, под которым устройство подписывает свои текстовые записи. */
const clientName = matchMedia('(pointer: coarse)').matches ? 'телефон' : 'компьютер'

// --- утилиты отображения -------------------------------------------------

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

function formatTime(ms) {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`
}

function formatAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return 'только что'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ч назад`
  return formatTime(ms)
}

let toastTimer = null
function toast(message) {
  el.toast.textContent = message
  el.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.toast.hidden = true
  }, 2600)
}

function button(label, className, onClick) {
  const node = document.createElement('button')
  node.className = `btn btn-sm ${className}`.trim()
  node.textContent = label
  node.addEventListener('click', onClick)
  return node
}

function link(label, href, download) {
  const node = document.createElement('a')
  node.className = 'btn btn-sm'
  node.textContent = label
  node.href = href
  if (download) node.setAttribute('download', '')
  else node.target = '_blank'
  node.rel = 'noopener'
  return node
}

/**
 * Копирование, работающее и по http://. navigator.clipboard доступен только в
 * защищённом контексте, поэтому запасной путь — скрытая textarea и execCommand.
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* пробуем запасной путь */
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, area.value.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

// --- состояние и отрисовка ----------------------------------------------

const state = {
  files: [],
  clips: [],
  devices: [],
  info: {},
  selected: new Set(),
  /** Соседние компьютеры: и привязанные, и просто найденные в сети. */
  peers: [],
  /** Передачи соседям — идущие и недавно завершённые. */
  transfers: [],
  /** Свой код привязки, пока он показан. */
  peerCode: null,
  /** Адреса этого компьютера с готовыми QR — по одному на сеть. */
  connect: [],
}

/** Соседи, которым можно отправлять: привязанные и с неизменившимся сертификатом. */
const readyPeers = () => state.peers.filter((peer) => peer.paired && !peer.changedFingerprint)

const PREVIEWABLE = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|m4a|wav|pdf|txt|md)$/i
const VIDEO = /\.(mp4|mov|webm|mkv|avi)$/i
const AUDIO = /\.(mp3|m4a|wav|ogg|flac)$/i

/*
 * Превью или значок того же размера — иначе список «прыгает» при загрузке картинок.
 * Наличие миниатюры заранее неизвестно: она может быть прислана отправителем, построена
 * сервером или отсутствовать вовсе. Поэтому запрашиваем всегда и подменяем значком по
 * ошибке — это надёжнее, чем угадывать по флагам.
 */
function filePreview(file) {
  if (file.thumb) {
    const image = document.createElement('img')
    image.className = 'thumb'
    image.loading = 'lazy'
    image.alt = ''
    image.src = urlWithToken(`/api/files/${file.id}/thumb`)
    // миниатюры может не быть (например, HEIC без поддержки) — подменяем значком
    image.addEventListener('error', () => image.replaceWith(fileIcon(file)))
    return image
  }
  return fileIcon(file)
}

function fileIcon(file) {
  const box = document.createElement('div')
  box.className = 'thumb-icon'
  box.textContent =
    VIDEO.test(file.name) ? '🎬'
    : AUDIO.test(file.name) ? '🎵'
    : /\.(zip|rar|7z|tar|gz)$/i.test(file.name) ? '🗜️'
    : /\.pdf$/i.test(file.name) ? '📕'
    : '📄'
  return box
}

function renderFiles() {
  el.files.replaceChildren()
  el.filesEmpty.hidden = state.files.length > 0
  el.filesCount.textContent = state.files.length ? `${state.files.length} шт.` : ''
  el.filesToolbar.hidden = state.files.length === 0

  for (const file of state.files) {
    const item = document.createElement('li')
    item.className = 'card'
    if (state.selected.has(file.id)) item.classList.add('is-selected')

    const row = document.createElement('div')
    row.className = 'card-row'

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = state.selected.has(file.id)
    check.addEventListener('change', () => {
      if (check.checked) state.selected.add(file.id)
      else state.selected.delete(file.id)
      item.classList.toggle('is-selected', check.checked)
      renderSelection()
    })

    const main = document.createElement('div')
    main.className = 'card-main'
    const title = document.createElement('div')
    title.className = 'card-title'
    title.textContent = file.name
    const meta = document.createElement('div')
    meta.className = 'card-meta'
    meta.textContent = `${formatSize(file.size)} · ${formatTime(file.mtime)}`
    main.append(title, meta)

    row.append(check, filePreview(file), main)

    const actions = document.createElement('div')
    actions.className = 'card-actions'
    actions.append(link('Скачать', urlWithToken(`/api/files/${file.id}`), true))
    if (PREVIEWABLE.test(file.name)) {
      actions.append(link('Открыть', urlWithToken(`/api/files/${file.id}?inline=1`), false))
    }
    actions.append(
      button('Удалить', 'btn-danger', async () => {
        if (!confirm(`Удалить «${file.name}»?`)) return
        try {
          await api(`/api/files/${file.id}`, { method: 'DELETE' })
          state.selected.delete(file.id)
          toast('Файл удалён')
        } catch (error) {
          toast(error.message)
        }
      }),
    )

    item.append(row, actions)
    el.files.append(item)
  }

  renderSelection()
}

function renderSelection() {
  const count = state.selected.size
  el.selectionInfo.textContent = count ? `выбрано ${count}` : ''
  el.deleteSelected.hidden = count === 0
  el.downloadZip.textContent = count ? `Скачать выбранное (${count})` : 'Скачать всё архивом'
  el.selectAll.checked = count > 0 && count === state.files.length
  el.selectAll.indeterminate = count > 0 && count < state.files.length

  // Отправка соседу — рядом со скачиванием и удалением: это действие над той же выборкой.
  el.sendTo.replaceChildren()
  if (count > 0) {
    for (const peer of readyPeers()) {
      el.sendTo.append(button(`→ ${peer.name}`, '', () => void sendSelectionTo(peer)))
    }
  }
}

function renderClips() {
  el.clips.replaceChildren()
  el.clipsEmpty.hidden = state.clips.length > 0
  el.clipsCount.textContent = state.clips.length ? `${state.clips.length} шт.` : ''

  for (const clip of state.clips) {
    const item = document.createElement('li')
    item.className = 'card'

    const text = document.createElement('pre')
    text.className = 'clip-text'
    text.textContent = clip.text

    const meta = document.createElement('div')
    meta.className = 'card-meta'
    meta.textContent = `${clip.from} · ${formatTime(clip.ts)}`

    const actions = document.createElement('div')
    actions.className = 'card-actions'
    actions.append(
      button('Копировать', '', async () => {
        toast((await copyText(clip.text)) ? 'Скопировано' : 'Не удалось скопировать — выделите вручную')
      }),
      button('В буфер ПК', '', async () => {
        try {
          await api(`/api/clips/${clip.id}/to-pc-clipboard`, { method: 'POST' })
          toast('Отправлено в буфер обмена ПК')
        } catch (error) {
          toast(error.message)
        }
      }),
      button('Удалить', 'btn-danger', async () => {
        try {
          await api(`/api/clips/${clip.id}`, { method: 'DELETE' })
        } catch (error) {
          toast(error.message)
        }
      }),
    )

    // Та же запись — соседнему компьютеру. У него она появится в истории и в буфере.
    for (const peer of readyPeers()) {
      actions.append(button(`→ ${peer.name}`, '', () => void sendClipTo(peer, clip.text)))
    }

    item.append(text, meta, actions)
    el.clips.append(item)
  }
}

function renderDevices() {
  el.devicesList.replaceChildren()
  const online = state.devices.filter((device) => device.online).length
  el.devicesCount.textContent = state.devices.length ? `на связи ${online} из ${state.devices.length}` : ''
  el.devicesEmpty.hidden = state.devices.length > 0

  for (const device of state.devices) {
    const item = document.createElement('li')
    item.className = 'card'

    const row = document.createElement('div')
    row.className = 'card-row'

    const dot = document.createElement('span')
    dot.className = `dot ${device.online ? 'online' : ''}`

    const main = document.createElement('div')
    main.className = 'card-main'
    const title = document.createElement('div')
    title.className = 'card-title'
    title.textContent = device.name
    const meta = document.createElement('div')
    meta.className = 'card-meta'
    meta.textContent = device.online ? `${device.ip} · на связи` : `${device.ip} · ${formatAgo(device.lastSeen)}`
    main.append(title, meta)
    row.append(dot, main)
    item.append(row)

    // Отвязать устройство можно только с самого компьютера — так же, как сменить токен.
    if (state.info.local) {
      const actions = document.createElement('div')
      actions.className = 'card-actions'
      actions.append(
        button('Отвязать', 'btn-danger', async () => {
          if (!confirm(`Отвязать «${device.name}»? Устройство потеряет доступ.`)) return
          try {
            await api(`/api/devices/${device.id}`, { method: 'DELETE' })
            toast('Устройство отвязано')
          } catch (error) {
            toast(error.message)
          }
        }),
      )
      item.append(actions)
    }

    el.devicesList.append(item)
  }
}

// --- соседние компьютеры -------------------------------------------------

async function sendSelectionTo(peer) {
  const ids = [...state.selected]
  if (ids.length === 0) return
  try {
    await api(`/api/peers/${peer.id}/send`, { method: 'POST', body: JSON.stringify({ ids }) })
    toast(`Отправляю на «${peer.name}»`)
  } catch (error) {
    toast(error.message)
  }
}

async function sendClipTo(peer, text) {
  try {
    await api(`/api/peers/${peer.id}/clip`, { method: 'POST', body: JSON.stringify({ text }) })
    toast(`Отправлено на «${peer.name}»`)
  } catch (error) {
    toast(error.message)
  }
}

async function pairPeer(host, port, code) {
  try {
    const result = await api('/api/peers/pair', {
      method: 'POST',
      body: JSON.stringify({ host, port: Number(port) || undefined, code }),
    })
    toast(`Привязан «${result.peer.name}»`)
    return true
  } catch (error) {
    toast(error.message)
    return false
  }
}

function renderTransfers() {
  el.peerTransfers.replaceChildren()

  for (const transfer of state.transfers) {
    const item = document.createElement('li')
    item.className = `upload ${transfer.status === 'error' ? 'is-failed' : ''}`.trim()

    const row = document.createElement('div')
    row.className = 'upload-row'
    const name = document.createElement('span')
    name.className = 'upload-name'
    name.textContent = `${transfer.name} → ${transfer.peerName}`
    const status = document.createElement('span')
    status.className = 'muted'
    const percent = transfer.size ? Math.round((transfer.sent / transfer.size) * 100) : 0
    status.textContent =
      transfer.status === 'queued' ? `${formatSize(transfer.size)} · в очереди`
      : transfer.status === 'sending' ? `${percent}% из ${formatSize(transfer.size)}`
      : transfer.status === 'done' ? 'доставлено'
      : transfer.status === 'cancelled' ? 'отменено'
      : (transfer.error ?? 'ошибка')
    row.append(name, status)

    const bar = document.createElement('div')
    bar.className = 'bar'
    const fill = document.createElement('i')
    fill.style.width = `${transfer.status === 'done' ? 100 : percent}%`
    bar.append(fill)

    item.append(row, bar)

    if (transfer.status === 'queued' || transfer.status === 'sending') {
      const actions = document.createElement('div')
      actions.className = 'card-actions'
      actions.append(
        button('Отменить', 'btn-danger', async () => {
          try {
            await api(`/api/peers/transfers/${transfer.id}`, { method: 'DELETE' })
          } catch (error) {
            toast(error.message)
          }
        }),
      )
      item.append(actions)
    }

    el.peerTransfers.append(item)
  }
}

function renderPeers() {
  el.peersList.replaceChildren()
  const paired = state.peers.filter((peer) => peer.paired).length
  el.peersCount.textContent =
    state.peers.length ? `найдено ${state.peers.length}${paired ? `, привязано ${paired}` : ''}` : ''
  el.peersEmpty.hidden = state.peers.length > 0

  el.peerCode.hidden = !state.peerCode
  el.peerCode.textContent = state.peerCode ? state.peerCode.code : ''
  el.peerCodeShow.hidden = Boolean(state.peerCode)
  el.peerCodeHide.hidden = !state.peerCode

  for (const peer of state.peers) {
    const item = document.createElement('li')
    item.className = 'card'

    const row = document.createElement('div')
    row.className = 'card-row'
    const dot = document.createElement('span')
    dot.className = `dot ${peer.online ? 'online' : ''}`
    const main = document.createElement('div')
    main.className = 'card-main'
    const title = document.createElement('div')
    title.className = 'card-title'
    title.textContent = peer.name
    const meta = document.createElement('div')
    meta.className = 'card-meta'
    meta.textContent =
      peer.changedFingerprint ? `${peer.host}:${peer.port} · сертификат изменился`
      : peer.paired ? `${peer.host}:${peer.port} · привязан${peer.online ? ', в сети' : ''}`
      : `${peer.host}:${peer.port} · не привязан`
    main.append(title, meta)
    row.append(dot, main)
    item.append(row)

    const actions = document.createElement('div')
    actions.className = 'card-actions'

    if (!peer.paired) {
      actions.append(
        button('Привязать', 'btn-primary', async () => {
          const code = prompt(`Код с экрана «${peer.name}» — там нажмите «Показать код»`)
          if (!code) return
          if (await pairPeer(peer.host, peer.port, code.trim())) await refreshPeers()
        }),
      )
    } else {
      if (peer.changedFingerprint) {
        /*
         * Сертификат соседа перевыпускается сам при смене его адресов, но отличить это
         * от подмены нельзя — поэтому решает человек, а до тех пор отправка закрыта.
         */
        actions.append(
          button('Это точно он — принять', 'btn-danger', async () => {
            if (!confirm(`Принять новый сертификат «${peer.name}»? Убедитесь, что это тот же компьютер.`)) return
            try {
              await api(`/api/peers/${peer.id}/trust`, { method: 'POST' })
              await refreshPeers()
            } catch (error) {
              toast(error.message)
            }
          }),
        )
      } else if (state.selected.size > 0) {
        actions.append(
          button(`Отправить выбранное (${state.selected.size})`, '', () => void sendSelectionTo(peer)),
        )
      }
      actions.append(
        button('Забыть', 'btn-danger', async () => {
          if (!confirm(`Забыть «${peer.name}»? Отправлять на него больше не получится.`)) return
          try {
            await api(`/api/peers/${peer.id}`, { method: 'DELETE' })
            await refreshPeers()
          } catch (error) {
            toast(error.message)
          }
        }),
      )
    }

    item.append(actions)
    el.peersList.append(item)
  }

  renderTransfers()
}

// --- загрузка данных -----------------------------------------------------

async function refreshPeers() {
  try {
    const data = await api('/api/peers')
    state.peers = data.peers
    state.transfers = data.transfers
    state.peerCode = data.code
    el.peers.hidden = false
    renderPeers()
    renderSelection()
    renderClips()
  } catch {
    // с телефона обмен между компьютерами закрыт — блок просто не показываем
    el.peers.hidden = true
  }
}

async function refreshFiles() {
  const data = await api('/api/files')
  state.files = data.files
  // выбор мог указывать на уже удалённые файлы
  const alive = new Set(state.files.map((file) => file.id))
  for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id)
  renderFiles()
}

async function refreshClips() {
  const data = await api('/api/clips')
  state.clips = data.clips
  renderClips()
}

async function refreshDevices() {
  try {
    const data = await api('/api/devices')
    state.devices = data.devices
    el.devices.hidden = false
    renderDevices()
  } catch {
    el.devices.hidden = true
  }
}

async function refreshAll() {
  await Promise.all([refreshFiles(), refreshClips()])
  void refreshDevices()
  void refreshPeers()
}

// --- действия над выбранными файлами -------------------------------------

function downloadArchive() {
  const ids = [...state.selected]
  const path = ids.length ? `/api/archive?ids=${ids.join(',')}` : '/api/archive'
  // архив собирается на лету, поэтому просто открываем ссылку — браузер покажет прогресс сам
  const anchor = document.createElement('a')
  anchor.href = urlWithToken(path)
  anchor.download = ''
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  toast(ids.length ? `Архив из ${ids.length} файлов` : 'Архив со всеми файлами')
}

async function deleteSelected() {
  const ids = [...state.selected]
  if (ids.length === 0) return
  if (!confirm(`Удалить выбранные файлы (${ids.length})?`)) return
  try {
    const result = await api('/api/files/delete', { method: 'POST', body: JSON.stringify({ ids }) })
    state.selected.clear()
    toast(`Удалено: ${result.removed.length}`)
  } catch (error) {
    toast(error.message)
  }
}

// --- отправка файлов -----------------------------------------------------

/*
 * Каждый файл уходит отдельным запросом, а не одним пакетом. Так у него свой
 * прогресс и своя отмена, а главное — исчезает потолок на число файлов в запросе:
 * при пакетной отправке сервер отвечал 413 на всю пачку, хотя часть файлов уже
 * была записана, и пользователь видел ошибку вместо частичного успеха.
 */
const MAX_PARALLEL_UPLOADS = 3

const queue = []
let activeUploads = 0

function createUploadCard(file) {
  const card = document.createElement('li')
  card.className = 'upload'

  const row = document.createElement('div')
  row.className = 'upload-row'
  const name = document.createElement('span')
  name.className = 'upload-name'
  name.textContent = file.name
  const status = document.createElement('span')
  status.className = 'muted'
  status.textContent = `${formatSize(file.size)} · в очереди`
  row.append(name, status)

  const bar = document.createElement('div')
  bar.className = 'bar'
  const fill = document.createElement('i')
  bar.append(fill)

  const actions = document.createElement('div')
  actions.className = 'card-actions'

  card.append(row, bar, actions)
  el.uploads.prepend(card)
  return { card, status, fill, actions }
}

function createTask(file) {
  const view = createUploadCard(file)
  const task = { file, view, upload: null, cancelled: false }

  const cancelBtn = button('Отменить', 'btn-danger', () => {
    task.cancelled = true
    if (task.upload) {
      task.upload.cancel()
    } else {
      const index = queue.indexOf(task)
      if (index !== -1) queue.splice(index, 1)
      view.card.remove()
    }
  })
  view.actions.append(cancelBtn)
  task.cancelBtn = cancelBtn
  return task
}

const THUMB_SIZE = 256

/**
 * Превью строится здесь, а не на сервере: браузер уже держит картинку распакованной,
 * так что это почти бесплатно, а серверу не нужна нативная библиотека обработки
 * изображений — благодаря этому приложение собирается в один самодостаточный файл.
 * Если формат браузеру не по силам (например, HEIC), возвращаем null: сервер попробует
 * построить превью сам, а если не сможет — покажется значок.
 */
async function makeThumbnail(file) {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null

  let bitmap
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image', // иначе фото с телефона лягут набок
      resizeWidth: THUMB_SIZE * 2, // декодируем уменьшенным — экономит память на телефоне
      resizeQuality: 'medium',
    })
  } catch {
    return null
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const offsetX = (bitmap.width - side) / 2
    const offsetY = (bitmap.height - side) / 2

    let canvas
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE)
    } else {
      canvas = document.createElement('canvas')
      canvas.width = THUMB_SIZE
      canvas.height = THUMB_SIZE
    }

    const context = canvas.getContext('2d')
    context.drawImage(bitmap, offsetX, offsetY, side, side, 0, 0, THUMB_SIZE, THUMB_SIZE)

    return canvas.convertToBlob ?
        await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
  } catch {
    return null
  } finally {
    bitmap.close?.()
  }
}

async function runTask(task) {
  const { view, file } = task
  view.status.textContent = 'превью…'
  const thumb = await makeThumbnail(file)
  if (task.cancelled) {
    view.card.remove()
    return
  }
  view.status.textContent = '0%'

  task.upload = uploadFiles([file], {
    thumb,
    onProgress: (loaded, total) => {
      const percent = Math.round((loaded / (total || file.size || 1)) * 100)
      view.fill.style.width = `${percent}%`
      view.status.textContent = percent >= 100 ? 'обработка…' : `${percent}% · ${formatSize(loaded)}`
    },
  })

  return task.upload.promise
    .then(() => {
      view.status.textContent = 'готово'
      view.fill.style.width = '100%'
      task.cancelBtn.remove()
      setTimeout(() => view.card.remove(), 1500)
    })
    .catch((error) => {
      if (task.cancelled) {
        view.card.remove()
        return
      }
      view.card.classList.add('is-failed')
      view.status.textContent = error.message
      task.cancelBtn.remove()
      view.actions.append(
        button('Повторить', '', () => {
          view.card.remove()
          sendFiles([file])
        }),
      )
      view.actions.append(button('Убрать', '', () => view.card.remove()))
      if (error instanceof ApiError && error.status === 401) openGate()
    })
}

function pumpQueue() {
  while (activeUploads < MAX_PARALLEL_UPLOADS && queue.length > 0) {
    const task = queue.shift()
    if (task.cancelled) continue
    activeUploads += 1
    void runTask(task).finally(() => {
      activeUploads -= 1
      pumpQueue()
    })
  }
}

function sendFiles(fileList) {
  const files = [...fileList]
  if (files.length === 0) return
  for (const file of files) queue.push(createTask(file))
  pumpQueue()
}

// --- экран токена --------------------------------------------------------

function openGate() {
  el.gate.hidden = false
  el.tokenInput.value = ''
  el.tokenInput.focus()
}

/** Отвязывает это устройство: токен забыт, поток событий закрыт, данные убраны с экрана. */
function disconnect() {
  clearToken()
  events?.close()
  events = null
  state.files = []
  state.clips = []
  state.devices = []
  state.peers = []
  state.transfers = []
  state.selected.clear()
  renderFiles()
  renderClips()
  el.devices.hidden = true
  el.peers.hidden = true
  el.connDot.classList.remove('online')
  el.connDot.classList.add('offline')
  openGate()
}

async function tryToken() {
  const value = el.tokenInput.value.trim()
  if (!value) return
  setToken(value)
  try {
    await refreshAll()
    await pairDevice()
    el.gate.hidden = true
    el.tokenError.hidden = true
    el.disconnect.hidden = false
    start()
  } catch {
    el.tokenError.hidden = false
  }
}

/**
 * Меняет общий токен из QR-кода на персональный. После этого устройство видно в
 * списке на компьютере, и его можно отвязать отдельно от остальных.
 */
async function pairDevice() {
  if (state.info.local) return
  try {
    const result = await api('/api/pair', { method: 'POST' })
    if (result?.token && result.token !== getToken()) setToken(result.token)
  } catch {
    // привязка необязательна: общий токен продолжит работать
  }
}

// --- панель подключения (видна только на самом ПК) -----------------------

/**
 * Показывает QR выбранного адреса. Адресов у компьютера бывает несколько — проводная сеть,
 * Wi-Fi, своя точка доступа, — и телефон достучится только по адресу той сети, в которой
 * находится сам. Угадать её за человека нельзя, поэтому предлагаем переключатель.
 */
function showAddress(address) {
  const chosen = state.connect.find((entry) => entry.address === address) ?? state.connect[0]
  if (!chosen) return
  el.connectQr.innerHTML = chosen.qr
  el.connectUrl.textContent = chosen.url

  el.connectAddresses.replaceChildren()
  for (const entry of state.connect) {
    const node = button(entry.address, entry === chosen ? 'btn-primary' : '', () => showAddress(entry.address))
    node.disabled = entry === chosen
    el.connectAddresses.append(node)
  }
  el.connectAddresses.hidden = state.connect.length < 2
  el.connectHint.hidden = state.connect.length < 2
}

async function loadConnectPanel() {
  try {
    const data = await api('/api/connect')
    state.connect = data.addresses ?? []
    showAddress(state.connect[0]?.address)
    el.certNote.hidden = !data.secure
    el.cleanupNote.textContent =
      state.info.keepDays > 0 ?
        `Автоочистка: принятые файлы старше ${state.info.keepDays} дн. удаляются автоматически.`
      : 'Автоочистка выключена. Включить: переменная LANSYNC_KEEP_DAYS.'
    el.connect.hidden = false
  } catch {
    // с телефона этот эндпоинт закрыт — панель просто не показываем
  }
}

/*
 * Управление приложением с самого компьютера. Человеку, запустившему программу двойным
 * кликом, больше нечем ни выключить её, ни настроить автозапуск: значка в трее нет, а
 * командная строка и диспетчер задач — не тот уровень сложности.
 */
async function loadControlPanel() {
  try {
    const data = await api('/api/autostart')
    el.autostart.checked = data.enabled
    el.autostart.disabled = !data.supported
    if (!data.supported) {
      el.autostartNote.textContent =
        'Автозапуск доступен только для собранного приложения, а сейчас оно работает из исходников.'
    }
    el.control.hidden = false
  } catch {
    // с телефона управление закрыто — панель не показываем
  }
}

async function toggleAutostart() {
  const wanted = el.autostart.checked
  el.autostart.disabled = true
  try {
    const result = await api('/api/autostart', { method: 'POST', body: JSON.stringify({ enabled: wanted }) })
    el.autostart.checked = result.enabled
    toast(wanted ? 'Будет запускаться вместе с системой' : 'Автозапуск отключён')
  } catch (error) {
    el.autostart.checked = !wanted
    toast(error.message)
  } finally {
    el.autostart.disabled = false
  }
}

async function shutdown() {
  if (!confirm('Выключить LanSync? Обмен файлами станет недоступен.')) return
  el.shutdown.disabled = true
  try {
    await api('/api/shutdown', { method: 'POST' })
    events?.close()
    events = null
    // Сервер выключается через мгновение — показываем это вместо «нет связи».
    document.body.innerHTML =
      '<div class="gate"><div class="gate-card">' +
      '<h2>LanSync выключен</h2>' +
      '<p class="muted">Чтобы запустить снова, откройте файл LanSync на компьютере.</p>' +
      '</div></div>'
  } catch (error) {
    toast(error.message)
    el.shutdown.disabled = false
  }
}

async function rotateToken() {
  if (!confirm('Сменить токен? Все подключённые устройства потеряют доступ.')) return
  el.rotateToken.disabled = true
  try {
    await api('/api/token/rotate', { method: 'POST' })
    await loadConnectPanel()
    await refreshDevices()
    toast('Токен сменён — отсканируйте новый код')
  } catch (error) {
    toast(error.message)
  } finally {
    el.rotateToken.disabled = false
  }
}

// --- события -------------------------------------------------------------

let events = null

function start() {
  events?.close()
  events = connectEvents({
    onStatus: (status) => {
      el.connDot.classList.toggle('online', status === 'online')
      el.connDot.classList.toggle('offline', status === 'offline')
    },
    onEvent: (message) => {
      if (message.type === 'file:added' || message.type === 'file:removed') void refreshFiles()
      if (message.type === 'clip:added' || message.type === 'clip:removed') void refreshClips()
      if (message.type === 'devices:changed') void refreshDevices()
      if (message.type === 'peers:changed') void refreshPeers()
      // Прогресс приходит готовым списком — перерисовываем без похода на сервер.
      if (message.type === 'peer:progress') {
        state.transfers = message.payload?.transfers ?? []
        renderTransfers()
      }
    },
  })
}

// --- инициализация -------------------------------------------------------

for (const tab of el.tabs) {
  tab.addEventListener('click', () => {
    for (const other of el.tabs) other.classList.toggle('is-active', other === tab)
    el.panels.files.hidden = tab.dataset.tab !== 'files'
    el.panels.text.hidden = tab.dataset.tab !== 'text'
  })
}

el.pickFiles.addEventListener('click', () => el.fileInput.click())
el.fileInput.addEventListener('change', () => {
  sendFiles(el.fileInput.files)
  el.fileInput.value = ''
})

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault()
    el.dropzone.classList.add('is-over')
  })
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('is-over'))
}
el.dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  sendFiles(event.dataTransfer.files)
})
// Браузер по умолчанию открывает файл, брошенный мимо зоны, — гасим это.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (event) => event.preventDefault())
}

el.selectAll.addEventListener('change', () => {
  state.selected.clear()
  if (el.selectAll.checked) for (const file of state.files) state.selected.add(file.id)
  renderFiles()
})
el.downloadZip.addEventListener('click', downloadArchive)
el.deleteSelected.addEventListener('click', () => void deleteSelected())

async function sendClip() {
  const text = el.clipInput.value
  if (!text.trim()) return
  el.clipSend.disabled = true
  try {
    await api('/api/clips', { method: 'POST', body: JSON.stringify({ text, from: clientName }) })
    el.clipInput.value = ''
    toast('Отправлено')
  } catch (error) {
    toast(error.message)
    if (error instanceof ApiError && error.status === 401) openGate()
  } finally {
    el.clipSend.disabled = false
  }
}

el.clipSend.addEventListener('click', () => void sendClip())
el.clipInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void sendClip()
})

el.peerCodeShow.addEventListener('click', async () => {
  try {
    await api('/api/peers/code', { method: 'POST' })
    await refreshPeers()
  } catch (error) {
    toast(error.message)
  }
})
el.peerCodeHide.addEventListener('click', async () => {
  try {
    await api('/api/peers/code', { method: 'DELETE' })
    await refreshPeers()
  } catch (error) {
    toast(error.message)
  }
})
el.peerAdd.addEventListener('click', async () => {
  const host = el.peerHost.value.trim()
  const code = el.peerCodeInput.value.trim()
  if (!host || !code) {
    toast('Нужны адрес соседа и код с его экрана')
    return
  }
  el.peerAdd.disabled = true
  try {
    if (await pairPeer(host, el.peerPort.value.trim(), code)) {
      el.peerHost.value = ''
      el.peerCodeInput.value = ''
      await refreshPeers()
    }
  } finally {
    el.peerAdd.disabled = false
  }
})

el.disconnect.addEventListener('click', disconnect)
el.rotateToken.addEventListener('click', () => void rotateToken())
el.autostart.addEventListener('change', () => void toggleAutostart())
el.shutdown.addEventListener('click', () => void shutdown())

el.tokenSave.addEventListener('click', () => void tryToken())
el.tokenInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void tryToken()
})

async function init() {
  adoptTokenFromUrl()

  try {
    state.info = await api('/api/info')
    el.deviceName.textContent = state.info.deviceName
    // На самом ПК токена нет, отключаться не от чего — там доступна смена токена.
    el.disconnect.hidden = state.info.local
  } catch {
    el.deviceName.textContent = 'нет связи'
  }

  try {
    await refreshAll()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      openGate()
      return
    }
    toast(error.message)
  }

  await pairDevice()
  await loadConnectPanel()
  await loadControlPanel()
  start()
}

void init()

// Service worker обслуживает офлайн-оболочку и приём «Поделиться → LanSync».
// Регистрируется только в защищённом контексте: по http:// браузер его не даст.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  // Токен кладём в Cache: service worker не имеет доступа к localStorage,
  // а для приёма файлов из системного меню «Поделиться» он ему нужен.
  const publishToken = () => {
    const token = getToken()
    if (!token) return
    void caches.open('lansync-auth').then((cache) => cache.put('/__token', new Response(token)))
  }
  publishToken()
  window.addEventListener('pageshow', publishToken)
}

if (new URL(location.href).searchParams.has('shared')) {
  const url = new URL(location.href)
  url.searchParams.delete('shared')
  history.replaceState(null, '', url.pathname + url.search)
  toast('Принято из меню «Поделиться»')
}
