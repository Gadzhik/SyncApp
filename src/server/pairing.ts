import { randomInt, timingSafeEqual } from 'node:crypto'

/**
 * Код привязки соседнего компьютера — то же, чем для телефона служит QR-код: способ
 * подтвердить, что человек имеет доступ к обеим машинам. Отличие в сроке жизни: QR-код
 * показывает постоянный общий токен, а этот код одноразовый и живёт минуты, потому что
 * его вводят руками и он открывает дверь без токена вовсе.
 *
 * Живёт только в памяти: пережившего перезапуск кода быть не должно.
 */

const TTL_MS = 5 * 60_000
/** Кодов всего миллион, поэтому перебор ограничен: после пяти промахов код гаснет. */
const MAX_ATTEMPTS = 5

export interface ActiveCode {
  code: string
  expiresAt: number
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class PairingCode {
  #code: string | null = null
  #expiresAt = 0
  #attempts = 0

  issue(): ActiveCode {
    this.#code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.#expiresAt = Date.now() + TTL_MS
    this.#attempts = 0
    return { code: this.#code, expiresAt: this.#expiresAt }
  }

  active(): ActiveCode | null {
    if (!this.#code || Date.now() > this.#expiresAt) return null
    return { code: this.#code, expiresAt: this.#expiresAt }
  }

  clear(): void {
    this.#code = null
    this.#expiresAt = 0
    this.#attempts = 0
  }

  /** Проверка одноразовая: удачная гасит код, неудачные исчерпывают попытки. */
  verify(candidate: string): boolean {
    const active = this.active()
    if (!active) {
      this.clear()
      return false
    }
    if (equals(active.code, candidate)) {
      this.clear()
      return true
    }
    this.#attempts += 1
    if (this.#attempts >= MAX_ATTEMPTS) this.clear()
    return false
  }
}
