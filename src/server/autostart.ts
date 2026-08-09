import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/*
 * Автозапуск делается штатными средствами каждой ОС, без сторонних утилит:
 * Windows — ярлык-скрипт в папке «Автозагрузка», macOS — LaunchAgent,
 * Linux — пользовательский юнит systemd.
 */

const LABEL = 'lansync'

/**
 * Путь к запускаемому файлу. В собранном виде это сам бинарник; при запуске из
 * исходников автозапуск прописывать бессмысленно — там нужен ещё и Node с проектом.
 */
function launcher(): { command: string; packaged: boolean } {
  const packaged = !process.execPath.match(/[\\/]node(\.exe)?$/i)
  return { command: process.execPath, packaged }
}

function windowsStartupDir(): string {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

function targetPath(): string {
  if (process.platform === 'win32') return join(windowsStartupDir(), 'LanSync.vbs')
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'LaunchAgents', `com.${LABEL}.plist`)
  }
  return join(homedir(), '.config', 'systemd', 'user', `${LABEL}.service`)
}

function contents(command: string): string {
  if (process.platform === 'win32') {
    // VBScript запускает процесс скрытно: иначе при каждом входе в систему
    // открывалось бы окно консоли.
    const escaped = command.replace(/"/g, '""')
    return [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run """${escaped}"" --quiet", 0, False`,
      '',
    ].join('\r\n')
  }

  if (process.platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${command}</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`
  }

  return `[Unit]
Description=LanSync — обмен файлами по локальной сети

[Service]
ExecStart=${command} --quiet
Restart=on-failure

[Install]
WantedBy=default.target
`
}

export interface AutostartResult {
  ok: boolean
  path: string
  message: string
}

export async function installAutostart(): Promise<AutostartResult> {
  const { command, packaged } = launcher()
  const path = targetPath()

  if (!packaged) {
    return {
      ok: false,
      path,
      message:
        'Автозапуск доступен только для собранного приложения. Соберите его командой\n' +
        '  npm run build:binary\n' +
        'и выполните --install-autostart у получившегося файла.',
    }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents(command), 'utf8')

  if (process.platform === 'linux') {
    // Без reload systemd не увидит новый юнит.
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
    const enabled = spawnSync('systemctl', ['--user', 'enable', `${LABEL}.service`], { stdio: 'ignore' })
    if (enabled.status !== 0) {
      return {
        ok: true,
        path,
        message:
          `Юнит создан: ${path}\n` +
          'Включить не удалось — выполните вручную:\n' +
          `  systemctl --user enable --now ${LABEL}.service`,
      }
    }
  }

  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['load', '-w', path], { stdio: 'ignore' })
  }

  return { ok: true, path, message: `Автозапуск включён: ${path}` }
}

export async function uninstallAutostart(): Promise<AutostartResult> {
  const path = targetPath()
  if (!existsSync(path)) {
    return { ok: true, path, message: 'Автозапуск и так не был включён.' }
  }

  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['unload', '-w', path], { stdio: 'ignore' })
  }
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`], { stdio: 'ignore' })
  }

  await rm(path, { force: true })
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
  }

  return { ok: true, path, message: `Автозапуск отключён: ${path} удалён` }
}

export function autostartEnabled(): boolean {
  return existsSync(targetPath())
}

/**
 * Автозапуск имеет смысл только для собранного приложения: при работе из исходников
 * ярлык на node.exe без проекта бесполезен.
 */
export function autostartSupported(): boolean {
  return launcher().packaged
}
