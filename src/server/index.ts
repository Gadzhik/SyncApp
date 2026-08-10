import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import qrcodeTerminal from 'qrcode-terminal'
import { buildApp } from './app.js'
import { autostartEnabled, installAutostart, uninstallAutostart } from './autostart.js'
import { loadConfig } from './config.js'
import { firewallCommand, firewallRuleExists, installFirewallRule } from './firewall.js'
import { connectUrl, lanAddresses, primaryAddress } from './network.js'

const VERSION = '0.3.0'

const HELP = `
LanSync ${VERSION} — обмен файлами и текстом по локальной сети

Использование:
  lansync                       запустить сервис (или открыть, если уже запущен)
  lansync --quiet               запустить без вывода и без открытия браузера
  lansync --open                открыть интерфейс в браузере
  lansync --stop                остановить работающий сервис

Настройка системы:
  lansync --allow-firewall      разрешить входящие подключения (запросит права администратора)
  lansync --install-autostart   запускать вместе с системой
  lansync --remove-autostart    отключить автозапуск
  lansync --status              что настроено на этой машине

Прочее:
  lansync --help                эта справка
  lansync --version             версия

Переменные окружения:
  LANSYNC_PORT           порт (по умолчанию 8420)
  LANSYNC_DIR            каталог данных (по умолчанию ~/LanSync)
  LANSYNC_NAME           имя компьютера в интерфейсе
  LANSYNC_TLS=0          работать по HTTP вместо HTTPS
  LANSYNC_KEEP_DAYS=7    удалять принятые файлы старше N дней
  LANSYNC_WATCH_CLIPBOARD=1  следить за буфером обмена компьютера
`

/**
 * Не даёт окну закрыться раньше, чем сообщение прочитают. При запуске двойным кликом
 * консоль исчезает вместе с процессом, и пользователь видит только вспышку — то есть
 * «ничего не произошло». В конвейерах stdin не терминал, там ждать не нужно.
 */
async function waitForKey(): Promise<void> {
  if (!process.stdin.isTTY || process.argv.includes('--no-wait')) return
  process.stdout.write('  Нажмите Enter, чтобы закрыть окно… ')
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', () => resolve())
    process.stdin.resume()
  })
}

/** Отвечает ли на этом порту уже запущенный LanSync. */
function probeExisting(port: number, tls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    void (async () => {
      const transport = tls ? await import('node:https') : await import('node:http')
      const request = transport.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/info',
          timeout: 2000,
          // свой самоподписанный сертификат проверять незачем
          ...(tls ? { rejectUnauthorized: false } : {}),
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            try {
              const info: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              resolve(typeof info === 'object' && info !== null && 'deviceName' in info)
            } catch {
              resolve(false)
            }
          })
        },
      )
      request.on('error', () => resolve(false))
      request.on('timeout', () => {
        request.destroy()
        resolve(false)
      })
      request.end()
    })().catch(() => resolve(false))
  })
}

/**
 * Сервер на соседнем порту, который только перенаправляет на HTTPS. Нужен для
 * случая, когда адрес набирают руками или открывают старую закладку с http://.
 */
function startRedirectServer(httpPort: number, httpsPort: number): Server {
  const server = createServer((request, response) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '')
    response.writeHead(301, { Location: `https://${host}:${httpsPort}${request.url ?? '/'}` })
    response.end()
  })
  server.on('error', () => {}) // порт занят — редирект не критичен
  server.listen(httpPort)
  server.unref()
  return server
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]]
  try {
    spawn(command[0] as string, command[1] as string[], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // не критично: адрес всё равно напечатан в консоли
  }
}

async function showStatus(): Promise<void> {
  const config = loadConfig()
  const scheme = config.tls ? 'https' : 'http'
  console.log(`\nLanSync ${VERSION}`)
  console.log(`  Каталог данных:   ${config.dataDir}`)
  console.log(`  Адрес:            ${scheme}://localhost:${config.port}`)
  console.log(`  Автозапуск:       ${autostartEnabled() ? 'включён' : 'выключен'}`)
  if (process.platform === 'win32') {
    console.log(`  Брандмауэр:       ${firewallRuleExists(config.port) ? 'разрешено' : 'НЕ разрешено'}`)
  }
  console.log(`  Автоочистка:      ${config.keepDays > 0 ? `${config.keepDays} дн.` : 'выключена'}`)
  console.log('')
}

/** Просит уже запущенный экземпляр остановиться. */
function requestStop(port: number, tls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    void (async () => {
      const transport = tls ? await import('node:https') : await import('node:http')
      const request = transport.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/shutdown',
          method: 'POST',
          timeout: 3000,
          ...(tls ? { rejectUnauthorized: false } : {}),
        },
        (response) => {
          response.resume()
          resolve(response.statusCode === 200)
        },
      )
      request.on('error', () => resolve(false))
      request.on('timeout', () => {
        request.destroy()
        resolve(false)
      })
      request.end()
    })().catch(() => resolve(false))
  })
}

async function serve(quiet: boolean): Promise<void> {
  const config = loadConfig()

  let stop: () => void = () => process.exit(0)
  const app = await buildApp(config, { onShutdown: () => stop() })

  await app.server.listen({ port: config.port, host: config.host })

  const scheme = config.tls ? 'https' : 'http'
  const primary = await primaryAddress()
  const url = connectUrl(primary, config.port, config.token, config.tls)
  // Анонс и поиск соседей ведёт сам сервер: они завязаны на сертификат и рассылку событий.
  const redirect = config.tls ? startRedirectServer(config.port + 1, config.port) : null

  if (!quiet) {
    const addresses = lanAddresses()
    console.log('')
    console.log(`  LanSync — ${config.deviceName}`)
    console.log(`  Каталог обмена: ${config.inboxDir}`)
    if (config.keepDays > 0) console.log(`  Автоочистка: файлы старше ${config.keepDays} дн. удаляются`)
    console.log('')
    console.log(`  На этом ПК:      ${scheme}://localhost:${config.port}`)
    if (addresses.length > 0) {
      for (const { address, iface } of addresses) {
        const mark = address === primary ? '←' : ' '
        console.log(`  В сети:          ${scheme}://${address}:${config.port}  ${mark} (${iface})`)
      }
    } else {
      console.log('  В сети:          сетевых интерфейсов не найдено — проверьте подключение к Wi-Fi')
    }
    if (redirect) console.log(`  Перенаправление: http://${primary}:${config.port + 1} → HTTPS`)
    console.log('')
    console.log('  Отсканируйте QR-код телефоном (ссылка уже содержит токен доступа):')
    console.log('')
    qrcodeTerminal.generate(url, { small: true })
    console.log(`  ${url}`)
    console.log('')
    if (config.tls) {
      console.log('  Сертификат самоподписанный: при первом заходе браузер покажет предупреждение.')
      console.log('  Нужно один раз выбрать «Дополнительно» → «Перейти на сайт».')
      console.log('')
    }

    // Заблокированный брандмауэр — самая частая причина «телефон не видит компьютер»,
    // поэтому предупреждаем сразу, а не оставляем разбираться самостоятельно.
    if (process.platform === 'win32' && !firewallRuleExists(config.port)) {
      console.log('  ⚠ Брандмауэр Windows не пропускает входящие подключения — телефон')
      console.log('    не откроет страницу. Разрешить одной командой:')
      console.log('')
      console.log(`      lansync --allow-firewall`)
      console.log('')
      console.log('    Либо вручную в PowerShell от администратора:')
      console.log(`      ${firewallCommand(config.port)}`)
      console.log('')
    }

    if (config.watchClipboard) console.log('  Слежение за буфером обмена ПК: включено')
    // Окно консоли — это и есть жизнь приложения: закрыв его, пользователь остановит сервис.
    console.log('  Это окно должно оставаться открытым. Закрыть окно или Ctrl+C — остановить.')
    console.log('  Чтобы приложение стартовало само и скрыто: lansync --install-autostart')
    console.log('')
  }

  if (!quiet && process.env['LANSYNC_NO_BROWSER'] !== '1') {
    openBrowser(`${scheme}://localhost:${config.port}`)
  }

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (!quiet) console.log('\n  Останавливаюсь…')
    redirect?.close()
    void app.close().then(() => process.exit(0))
  }
  stop = shutdown
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))

  if (args.has('--help') || args.has('-h')) {
    console.log(HELP)
    return
  }
  if (args.has('--version') || args.has('-v')) {
    console.log(VERSION)
    return
  }
  if (args.has('--status')) {
    await showStatus()
    return
  }
  if (args.has('--open')) {
    const config = loadConfig()
    openBrowser(`${config.tls ? 'https' : 'http'}://localhost:${config.port}`)
    return
  }
  if (args.has('--stop')) {
    const config = loadConfig()
    if (await requestStop(config.port, config.tls)) {
      console.log('\n  LanSync остановлен.\n')
    } else {
      console.log('\n  LanSync не запущен (или уже остановлен).\n')
    }
    return
  }
  if (args.has('--allow-firewall')) {
    const config = loadConfig()
    const result = await installFirewallRule(config.port)
    console.log(`\n${result.message}\n`)
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (args.has('--install-autostart')) {
    const result = await installAutostart()
    console.log(`\n${result.message}\n`)
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (args.has('--remove-autostart')) {
    const result = await uninstallAutostart()
    console.log(`\n${result.message}\n`)
    return
  }

  await serve(args.has('--quiet'))
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('EADDRINUSE')) {
    const config = loadConfig()
    const url = `${config.tls ? 'https' : 'http'}://localhost:${config.port}`

    // Порт занят самим LanSync — значит, приложение уже работает. Для человека,
    // запустившего файл второй раз, правильный ответ не ошибка, а открытый интерфейс.
    if (await probeExisting(config.port, config.tls)) {
      console.log('\n  LanSync уже запущен — открываю интерфейс.')
      console.log(`  ${url}\n`)
      openBrowser(url)
      process.exit(0)
    }

    console.error(`\n  Порт ${config.port} занят другой программой.`)
    console.error('  Запустите на другом порту, например:\n')
    console.error(
      process.platform === 'win32' ?
        `      set LANSYNC_PORT=8500 && lansync\n`
      : `      LANSYNC_PORT=8500 lansync\n`,
    )
    await waitForKey()
    process.exit(1)
  }

  console.error('\n  Не удалось запустить LanSync:', message, '\n')
  await waitForKey()
  process.exit(1)
})
