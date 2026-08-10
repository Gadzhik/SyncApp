import { connect as netConnect, type Socket } from 'node:net'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

/**
 * Запросы к соседнему компьютеру.
 *
 * Сертификат у соседа самоподписанный, доверять ему по цепочке невозможно. Просто
 * отключить проверку (`rejectUnauthorized: false`) нельзя: тогда отвечать под нужным
 * адресом сможет кто угодно в сети, а мы отправим ему файлы вместе с токеном. Поэтому
 * проверку заменяем своей: отпечаток запоминается при привязке и сверяется на каждом
 * соединении — как ssh поступает с ключом хоста.
 */

export interface PeerTarget {
  host: string
  port: number
  tls: boolean
  /** Ожидаемый отпечаток. null — первое знакомство: запоминаем то, что предъявили. */
  fingerprint: string | null
  /** Персональный токен, выданный этим соседом. При привязке его ещё нет. */
  token?: string
}

export type PeerErrorCode = 'unreachable' | 'fingerprint' | 'timeout' | 'http'

export class PeerError extends Error {
  readonly code: PeerErrorCode
  readonly status: number | undefined
  /** Отпечаток, который предъявили вместо ожидаемого. */
  readonly seen: string | undefined

  constructor(message: string, code: PeerErrorCode, extra: { status?: number; seen?: string } = {}) {
    super(message)
    this.name = 'PeerError'
    this.code = code
    this.status = extra.status
    this.seen = extra.seen
  }
}

export interface PeerResponse<T> {
  status: number
  body: T
  /** Отпечаток, предъявленный соседом; null для соединения без TLS. */
  fingerprint: string | null
}

const TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 8_000

/**
 * Соединение, подлинность которого уже проверена.
 *
 * Проверять отпечаток внутри самого запроса нельзя: у HTTPS-запроса событие `socket`
 * приходит уже после рукопожатия, и к моменту, когда стало бы понятно, что отвечает
 * чужая машина, заголовок с токеном успел бы уйти. Поэтому соединение устанавливается
 * и сверяется отдельно, и только проверенное отдаётся запросу.
 */
async function connectVerified(target: PeerTarget): Promise<{ socket: Socket; fingerprint: string | null }> {
  return new Promise((resolve, reject) => {
    const socket =
      target.tls ?
        tlsConnect({
          host: target.host,
          port: target.port,
          // Цепочке доверять не к чему — подлинность проверяется отпечатком ниже.
          rejectUnauthorized: false,
        })
      : netConnect({ host: target.host, port: target.port })

    const timer = setTimeout(() => {
      socket.destroy()
      reject(new PeerError('сосед не отвечает', 'timeout'))
    }, CONNECT_TIMEOUT_MS)
    timer.unref()

    socket.once('error', () => {
      clearTimeout(timer)
      reject(new PeerError('не удалось связаться с соседом', 'unreachable'))
    })

    socket.once(target.tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      if (!target.tls) {
        resolve({ socket, fingerprint: null })
        return
      }
      const certificate = (socket as import('node:tls').TLSSocket).getPeerCertificate()
      const fingerprint = certificate.fingerprint256 || null
      if (target.fingerprint && fingerprint !== target.fingerprint) {
        socket.destroy()
        reject(
          new PeerError(
            'сертификат соседа не совпадает с запомненным',
            'fingerprint',
            fingerprint ? { seen: fingerprint } : {},
          ),
        )
        return
      }
      resolve({ socket, fingerprint })
    })
  })
}

export interface RawRequestOptions {
  method: string
  path: string
  headers?: Record<string, string>
  /** Тело пишется в поток вызывающим — так гигабайтный файл идёт мимо памяти. */
  write?: (stream: ClientRequest) => Promise<void>
  /** Отправку можно прервать: страница показывает у передачи кнопку отмены. */
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Один запрос к соседу. Ответ читается целиком — все ответы API маленькие; поток
 * наружу нужен только на отправку и делается через `write`.
 */
export async function peerRequest(
  target: PeerTarget,
  options: RawRequestOptions,
): Promise<PeerResponse<unknown>> {
  const { socket, fingerprint } = await connectVerified(target)

  return new Promise((resolve, reject) => {
    const send = target.tls ? httpsRequest : httpRequest
    let failure: PeerError | null = null

    const request = send({
      host: target.host,
      port: target.port,
      path: options.path,
      method: options.method,
      headers: {
        ...(target.token ? { 'X-Sync-Token': target.token } : {}),
        ...options.headers,
      },
      /*
       * Соединение уже установлено и проверено — берём именно его. `agent` не задаём
       * вовсе: с `agent: false` Node завёл бы собственный агент, а `createConnection`
       * учитывается только при отсутствии агента.
       */
      createConnection: () => socket,
    })

    const fail = (error: PeerError): void => {
      failure ??= error
      request.destroy()
      reject(failure)
    }

    request.setTimeout(options.timeoutMs ?? TIMEOUT_MS, () => {
      fail(new PeerError('сосед не отвечает', 'timeout'))
    })

    request.on('error', () => {
      // Своя причина (отпечаток, тайм-аут, отмена) точнее, чем ECONNRESET от destroy
      reject(failure ?? new PeerError('не удалось связаться с соседом', 'unreachable'))
    })

    const onAbort = (): void => fail(new PeerError('отправка отменена', 'unreachable'))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    request.on('response', (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        options.signal?.removeEventListener('abort', onAbort)
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = text
        }
        resolve({ status: response.statusCode ?? 0, body, fingerprint })
      })
    })

    if (options.write) {
      void options
        .write(request)
        .then(() => request.end())
        .catch((error: unknown) => {
          if (failure) return
          fail(new PeerError(error instanceof Error ? error.message : 'ошибка отправки', 'unreachable'))
        })
    } else {
      request.end()
    }
  })
}

/** Запрос с телом и ответом в JSON — им ходят все управляющие вызовы. */
export async function peerJson<T = unknown>(
  target: PeerTarget,
  options: { method: string; path: string; json?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<PeerResponse<T>> {
  const payload = options.json === undefined ? null : Buffer.from(JSON.stringify(options.json), 'utf8')
  const response = await peerRequest(target, {
    method: options.method,
    path: options.path,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {},
    ...(payload ?
      {
        write: async (stream: ClientRequest) => {
          stream.write(payload)
        },
      }
    : {}),
  })
  return response as PeerResponse<T>
}
