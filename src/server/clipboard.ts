import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Работа с буфером обмена ПК через штатные утилиты системы. Раньше здесь был
 * clipboardy, но он тащит с собой готовые исполняемые файлы (xsel, clipboard.exe),
 * а их нельзя упаковать в один самодостаточный бинарник. Своя реализация обходится
 * тем, что уже есть в системе.
 */

interface Command {
  file: string
  args: string[]
}

const isWayland = (): boolean => Boolean(process.env['WAYLAND_DISPLAY'])

/** PowerShell — единственный способ прочитать буфер обмена в Windows без сторонних утилит. */
const WINDOWS_READ: Command = {
  file: 'powershell',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw',
  ],
}

function readCommands(): Command[] {
  if (process.platform === 'win32') return [WINDOWS_READ]
  if (process.platform === 'darwin') return [{ file: 'pbpaste', args: [] }]
  return isWayland() ?
      [
        { file: 'wl-paste', args: ['--no-newline'] },
        { file: 'xclip', args: ['-selection', 'clipboard', '-o'] },
      ]
    : [
        { file: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        { file: 'xsel', args: ['--clipboard', '--output'] },
        { file: 'wl-paste', args: ['--no-newline'] },
      ]
}

function writeCommands(): Command[] {
  if (process.platform === 'darwin') return [{ file: 'pbcopy', args: [] }]
  return isWayland() ?
      [
        { file: 'wl-copy', args: [] },
        { file: 'xclip', args: ['-selection', 'clipboard'] },
      ]
    : [
        { file: 'xclip', args: ['-selection', 'clipboard'] },
        { file: 'xsel', args: ['--clipboard', '--input'] },
        { file: 'wl-copy', args: [] },
      ]
}

function run(command: Command, input?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command.file, command.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      resolve(null)
      return
    }

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })

    if (input === undefined) {
      child.stdin?.end()
      return
    }
    child.stdin?.on('error', () => {})
    child.stdin?.end(Buffer.from(input, 'utf8'))
  })
}

/**
 * В Windows запись идёт через временный UTF-8 файл, а не через clip.exe: тот
 * сохраняет BOM как часть текста и переводит \n в \r\n, ломая round-trip.
 * ReadAllText отдаёт строку байт в байт, а Set-Clipboard кладёт её как есть.
 */
async function writeWindows(text: string): Promise<boolean> {
  const file = join(tmpdir(), `lansync-clip-${randomUUID()}.txt`)
  try {
    await writeFile(file, text, 'utf8')
    const quoted = file.replace(/'/g, "''")
    const result = await run({
      file: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${quoted}', [System.Text.Encoding]::UTF8))`,
      ],
    })
    return result !== null
  } catch {
    return false
  } finally {
    await unlink(file).catch(() => {})
  }
}

/** Пробует варианты по очереди: набор доступных утилит зависит от системы. */
async function first(commands: Command[], input?: string): Promise<string | null> {
  for (const command of commands) {
    const result = await run(command, input)
    if (result !== null) return result
  }
  return null
}

const RETRIES = 3
const RETRY_DELAY_MS = 150

/**
 * Буфер обмена — разделяемый на всю сессию ресурс, и пока его держит другой процесс
 * (менеджер буфера, синхронизация RDP, любое приложение в момент копирования), обращение
 * отказывает с «Clipboard operation did not succeed». Отказ транзиентный, поэтому
 * несколько коротких попыток дают заметно более предсказуемое поведение, чем одна.
 */
async function withRetries<T>(attempt: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < RETRIES; i++) {
    const result = await attempt()
    if (result !== null) return result
    if (i < RETRIES - 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  }
  return null
}

export async function readPcClipboard(): Promise<string | null> {
  const raw = await withRetries(() => first(readCommands()))
  if (raw === null) return null
  // Get-Clipboard и xclip дописывают перевод строки, а BOM может прийти от сторонних
  // приложений — ни то, ни другое не является содержимым буфера
  return raw.replace(/^﻿/, '').replace(/\r?\n$/, '')
}

export async function writePcClipboard(text: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return (await withRetries(async () => ((await writeWindows(text)) ? true : null))) === true
  }
  return (await withRetries(() => first(writeCommands(), text))) !== null
}

/** Доступен ли буфер обмена вообще: в SSH-сессии или голом контейнере утилит нет. */
export async function clipboardAvailable(): Promise<boolean> {
  return (await readPcClipboard()) !== null
}

export interface ClipboardWatcher {
  stop(): void
}

/**
 * Опрашивает буфер обмена ПК и сообщает о новом содержимом. Событийного API у ОС
 * нет ни на одной платформе, поэтому опрос — единственный вариант.
 */
export function startClipboardWatcher(
  onChange: (text: string) => void,
  options: { intervalMs?: number; initial?: string | null } = {},
): ClipboardWatcher {
  const intervalMs = options.intervalMs ?? 1000
  let previous = options.initial ?? null
  let busy = false

  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void readPcClipboard()
      .then((text) => {
        if (text === null || text === previous || text.trim() === '') return
        previous = text
        onChange(text)
      })
      .finally(() => {
        busy = false
      })
  }, intervalMs)

  timer.unref()
  return { stop: () => clearInterval(timer) }
}
