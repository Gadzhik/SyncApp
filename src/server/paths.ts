import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Корень проекта ищем вверх по дереву от текущего модуля. Это позволяет одному и тому же
 * коду работать и в dev (tsx выполняет src/server/index.ts), и после сборки
 * (node выполняет dist/server/index.js) — статика всегда берётся из src/web.
 */
function findProjectRoot(start: string): string {
  let dir = start
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

export const projectRoot = findProjectRoot(dirname(fileURLToPath(import.meta.url)))
export const webDir = join(projectRoot, 'src', 'web')
