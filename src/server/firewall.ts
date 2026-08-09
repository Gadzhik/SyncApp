import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Разрешение входящих подключений в брандмауэре Windows. Без него телефон не откроет
 * страницу, и это самая частая причина «ничего не работает». На macOS и Linux
 * встроенный брандмауэр обычно не блокирует входящие на пользовательские порты,
 * поэтому там ничего не требуется.
 */

const ruleName = (port: number): string => `LanSync ${port}`

function powershell(script: string): { status: number; stdout: string } {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  )
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/** Есть ли уже разрешающее правило для нашего порта. */
export function firewallRuleExists(port: number): boolean {
  if (process.platform !== 'win32') return true
  const { status, stdout } = powershell(
    `$r = Get-NetFirewallRule -DisplayName '${ruleName(port)}' -ErrorAction SilentlyContinue; ` +
      `if ($r -and ($r | Where-Object Enabled -eq 'True')) { 'yes' } else { 'no' }`,
  )
  return status === 0 && stdout.trim() === 'yes'
}

/** Категория текущей сети — от неё зависит профиль правила. */
export function networkProfiles(): string {
  if (process.platform !== 'win32') return 'Any'
  const { status, stdout } = powershell(
    "(Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory | Sort-Object -Unique) -join ','",
  )
  const value = stdout.trim()
  if (status !== 0 || !value) return 'Private,Public'
  // DomainAuthenticated в терминах правил называется Domain
  return value.replace(/DomainAuthenticated/g, 'Domain')
}

export function firewallCommand(port: number): string {
  return (
    `New-NetFirewallRule -DisplayName "${ruleName(port)}" -Direction Inbound -Protocol TCP ` +
    `-LocalPort ${port} -Profile ${networkProfiles()} -RemoteAddress LocalSubnet -Action Allow`
  )
}

export interface FirewallResult {
  ok: boolean
  message: string
}

/**
 * Создаёт правило, запросив повышение прав через UAC. Сам процесс не может это
 * сделать без прав администратора, поэтому запускается отдельный элевированный
 * PowerShell со скриптом во временном файле — так не приходится изобретать
 * вложенное экранирование кавычек.
 */
export async function installFirewallRule(port: number): Promise<FirewallResult> {
  if (process.platform !== 'win32') {
    return { ok: true, message: 'На этой системе правило брандмауэра не требуется.' }
  }
  if (firewallRuleExists(port)) {
    return { ok: true, message: `Правило «${ruleName(port)}» уже есть.` }
  }

  const script = join(tmpdir(), `lansync-fw-${randomUUID()}.ps1`)
  await writeFile(script, `${firewallCommand(port)}\n`, 'utf8')

  try {
    const elevated = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList ` +
          `'-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}'; exit $p.ExitCode`,
      ],
      { stdio: 'ignore', windowsHide: true },
    )

    if (elevated.status === 0 && firewallRuleExists(port)) {
      return { ok: true, message: `Правило «${ruleName(port)}» создано.` }
    }
    return {
      ok: false,
      message:
        'Не удалось создать правило (возможно, в UAC нажали «Нет»).\n' +
        'Выполните вручную в PowerShell от администратора:\n\n  ' +
        firewallCommand(port),
    }
  } finally {
    await unlink(script).catch(() => {})
  }
}

/** Открывает системные настройки брандмауэра — на случай, если правило нужно править руками. */
export function openFirewallSettings(): void {
  if (process.platform !== 'win32') return
  try {
    spawn('cmd', ['/c', 'start', '', 'ms-settings:windowsdefender'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch {
    // не критично
  }
}
