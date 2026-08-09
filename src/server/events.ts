export type EventType =
  | 'file:added'
  | 'file:removed'
  | 'clip:added'
  | 'clip:removed'
  | 'devices:changed'

export interface Subscriber {
  send(message: string): void
  close(code?: number, reason?: string): void
  /** Привязанное устройство; null для подключений с самого компьютера. */
  deviceId: string | null
  ip: string
  since: number
}

/**
 * Хаб WebSocket-подписчиков. Роуты вызывают broadcast после любой мутации,
 * клиенты перерисовываются сами — поллинг не нужен.
 */
export class EventHub {
  readonly #clients = new Set<Subscriber>()

  add(client: Subscriber): () => void {
    this.#clients.add(client)
    return () => this.#clients.delete(client)
  }

  get size(): number {
    return this.#clients.size
  }

  /** Идентификаторы устройств, которые сейчас на связи. */
  onlineDeviceIds(): Set<string> {
    const ids = new Set<string>()
    for (const client of this.#clients) {
      if (client.deviceId) ids.add(client.deviceId)
    }
    return ids
  }

  /** Число подключений с самого компьютера — они не привязаны к устройству. */
  localConnections(): number {
    let count = 0
    for (const client of this.#clients) {
      if (!client.deviceId) count += 1
    }
    return count
  }

  broadcast(type: EventType, payload: unknown = null): void {
    const message = JSON.stringify({ type, payload })
    for (const client of this.#clients) {
      try {
        client.send(message)
      } catch {
        // разорванное соединение уберётся своим обработчиком close
      }
    }
  }

  /** Разрывает подписки одного устройства — при его отвязке. */
  closeDevice(deviceId: string): void {
    for (const client of this.#clients) {
      if (client.deviceId !== deviceId) continue
      try {
        client.close(4003, 'device revoked')
      } catch {
        // уже закрыт
      }
      this.#clients.delete(client)
    }
  }

  /** Разрывает все подписки — при смене общего токена. */
  closeAll(): void {
    for (const client of this.#clients) {
      try {
        client.close(4001, 'token rotated')
      } catch {
        // уже закрыт
      }
    }
    this.#clients.clear()
  }
}
