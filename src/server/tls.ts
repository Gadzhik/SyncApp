import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { generate as generateCertificate } from 'selfsigned'
import { lanAddresses } from './network.js'

export interface TlsMaterial {
  key: string
  cert: string
  /** Имена и адреса, на которые выписан сертификат. */
  names: string[]
  /** Сертификат был создан заново при этом запуске. */
  fresh: boolean
}

const CERT_DAYS = 3650

/**
 * Браузер принимает сертификат, только если запрошенный адрес перечислен в
 * subjectAltName. Адрес в локальной сети меняется, поэтому сертификат
 * выписывается на все текущие адреса машины и перевыпускается, когда их набор
 * изменился.
 */
function currentNames(): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', hostname()])
  for (const { address } of lanAddresses()) names.add(address)
  return [...names].sort()
}

const isIpv4 = (value: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(value)

async function generate(names: string[]): Promise<{ key: string; cert: string }> {
  const altNames = names.map((value) =>
    // 7 — тип IP-адреса в SAN, 2 — тип DNS-имени
    isIpv4(value) ? ({ type: 7, ip: value } as const) : ({ type: 2, value } as const),
  )

  const pems = await generateCertificate([{ name: 'commonName', value: 'LanSync' }], {
    notAfterDate: new Date(Date.now() + CERT_DAYS * 24 * 60 * 60 * 1000),
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  })

  return { key: pems.private, cert: pems.cert }
}

/**
 * Отпечаток сертификата в виде `AB:CD:…`. Центра сертификации здесь нет и быть не может,
 * поэтому соседний компьютер узнаётся именно по отпечатку: он запоминается при привязке,
 * как это делает ssh с ключом хоста.
 */
export function fingerprintOf(cert: string): string {
  return new X509Certificate(cert).fingerprint256
}

/**
 * Возвращает сертификат из каталога данных, создавая его при первом запуске и
 * перевыпуская при смене набора адресов.
 */
export async function ensureCertificate(dataDir: string): Promise<TlsMaterial> {
  const dir = join(dataDir, 'tls')
  mkdirSync(dir, { recursive: true })

  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  const namesPath = join(dir, 'names.json')
  const names = currentNames()

  if (existsSync(keyPath) && existsSync(certPath) && existsSync(namesPath)) {
    try {
      const stored: unknown = JSON.parse(readFileSync(namesPath, 'utf8'))
      // Достаточно, чтобы сертификат покрывал все текущие адреса; лишние не мешают.
      if (Array.isArray(stored) && names.every((name) => stored.includes(name))) {
        return {
          key: readFileSync(keyPath, 'utf8'),
          cert: readFileSync(certPath, 'utf8'),
          names: stored as string[],
          fresh: false,
        }
      }
    } catch {
      // повреждённые файлы — перевыпустим
    }
  }

  const { key, cert } = await generate(names)
  writeFileSync(keyPath, key, 'utf8')
  writeFileSync(certPath, cert, 'utf8')
  writeFileSync(namesPath, JSON.stringify(names, null, 2), 'utf8')
  return { key, cert, names, fresh: true }
}
