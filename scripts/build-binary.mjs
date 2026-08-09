#!/usr/bin/env node
/*
 * Сборка одного самодостаточного исполняемого файла через Node SEA.
 *
 * Собирается ВСЕГДА под текущую платформу. Кросс-сборка возможна технически, но для
 * macOS требует переподписи бинарника средствами самой macOS (`codesign`), иначе
 * Gatekeeper не даст его запустить. Поэтому файлы под три ОС делает CI, где каждая
 * сборка идёт на своей системе — см. .github/workflows/release.yml.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { inject } from 'postject'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const outDir = join(root, 'dist-bin')

/** Официальная метка, по которой postject находит место для полезной нагрузки. */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const TARGET_NAMES = {
  win32: 'lansync-windows-x64.exe',
  darwin: `lansync-macos-${process.arch}`,
  linux: `lansync-linux-${process.arch}`,
}

const step = (message) => console.log(`\n▶ ${message}`)

function run(command, args) {
  // Без shell: с ним путь вида "C:\Program Files\nodejs\node.exe" разрывается по пробелу.
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} завершился с кодом ${result.status}`)
  }
}

async function main() {
  rmSync(buildDir, { recursive: true, force: true })
  mkdirSync(buildDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  step('Сборка кода в один модуль')
  await build({
    entryPoints: [join(root, 'src/server/index.ts')],
    outfile: join(buildDir, 'bundle.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: true,
    // sharp — нативный модуль, в один файл он не упаковывается. Остаётся необязательным:
    // при его отсутствии превью строит отправитель, и приложение работает полностью.
    external: ['sharp'],
    // В формате cjs нет import.meta, а он используется для поиска каталога проекта.
    // Подставляем эквивалент на основе __filename, иначе выражение станет пустым.
    banner: {
      js: 'const __lansyncModuleUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    define: { 'import.meta.url': '__lansyncModuleUrl' },
    logLevel: 'warning',
  })
  const bundleSize = statSync(join(buildDir, 'bundle.cjs')).size
  console.log(`  bundle.cjs — ${(bundleSize / 1024).toFixed(0)} КБ`)

  step('Подготовка ресурсов клиента')
  // Файлы клиента кладутся внутрь бинарника как ресурсы SEA и достаются через node:sea.
  // Список читаем с диска, чтобы он не разъезжался с содержимым каталога; за соответствие
  // отдаваемых путей отвечает WEB_FILES в src/server/static.ts, это проверяется тестом.
  const webDir = join(root, 'src/web')
  const assets = {}
  for (const entry of await readdir(webDir, { withFileTypes: true })) {
    if (entry.isFile()) assets[entry.name] = join(webDir, entry.name)
  }
  const seaConfig = {
    main: join(buildDir, 'bundle.cjs'),
    output: join(buildDir, 'sea.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // Кэш кода привязан к версии и платформе Node; выключаем, чтобы сборка была предсказуемой.
    useCodeCache: false,
    assets,
  }
  const configPath = join(buildDir, 'sea-config.json')
  writeFileSync(configPath, JSON.stringify(seaConfig, null, 2))
  console.log(`  ресурсов: ${Object.keys(assets).length}`)

  step('Создание полезной нагрузки SEA')
  run(process.execPath, ['--experimental-sea-config', configPath])

  step('Внедрение в исполняемый файл Node')
  const outName = TARGET_NAMES[process.platform]
  if (!outName) throw new Error(`платформа ${process.platform} не поддерживается`)
  const outPath = join(outDir, outName)
  copyFileSync(process.execPath, outPath)

  // На macOS подпись исходного бинарника становится недействительной после внедрения,
  // поэтому её снимают до и накладывают заново после.
  if (process.platform === 'darwin') {
    spawnSync('codesign', ['--remove-signature', outPath], { stdio: 'inherit' })
  }

  const blob = await readFile(join(buildDir, 'sea.blob'))
  // Скопированный node может быть только для чтения — postject пишет в файл на месте.
  chmodSync(outPath, 0o755)
  await inject(outPath, 'NODE_SEA_BLOB', blob, {
    sentinelFuse: FUSE,
    overwrite: true,
    ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
  })

  if (process.platform === 'darwin') {
    spawnSync('codesign', ['--sign', '-', outPath], { stdio: 'inherit' })
  }
  if (process.platform !== 'win32') {
    run('chmod', ['+x', outPath])
  }

  const size = statSync(outPath).size
  console.log(`\n✓ ${outPath}`)
  console.log(`  ${(size / 1024 / 1024).toFixed(0)} МБ — Node внутри, никаких зависимостей`)
  console.log(`\nПроверка: ${outPath} --version`)
}

main().catch((error) => {
  console.error(`\n✗ Сборка не удалась: ${error.message}`)
  process.exit(1)
})
