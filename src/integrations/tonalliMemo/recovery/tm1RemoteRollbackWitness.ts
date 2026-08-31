import {
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessRecord,
  snapshotTm1RollbackWitnessEnrollment,
  snapshotTm1RollbackWitnessFinalization,
  snapshotTm1RollbackWitnessRead,
  snapshotTm1RollbackWitnessReservation,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessEnrollment,
  type Tm1RollbackWitnessErrorCode,
  type Tm1RollbackWitnessFinalization,
  type Tm1RollbackWitnessRead,
  type Tm1RollbackWitnessRecord,
  type Tm1RollbackWitnessReservation
} from './tm1RollbackWitness'

export const TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL =
  'tonalli.tm1-rollback-witness-http'
export const TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION = 1

const DEFAULT_TIMEOUT_MS = 8_000
const MAX_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BYTES = 65_536
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const KNOWN_REMOTE_ERROR_CODES: ReadonlySet<Tm1RollbackWitnessErrorCode> = new Set([
  'INVALID_WITNESS_INPUT',
  'INVALID_WITNESS_RECORD',
  'WITNESS_ALREADY_ENROLLED',
  'WITNESS_CONFLICT',
  'WITNESS_NOT_ENROLLED',
  'WITNESS_UNAVAILABLE',
  'WITNESS_UNVERIFIABLE'
])

export type Tm1RemoteRollbackWitnessHttpOperation =
  | 'read'
  | 'enroll'
  | 'reserve'
  | 'finalize'
  | 'verifyRecord'

type FrozenConfig = Readonly<{
  endpointUrl: string
  timeoutMs: number
  fetch: typeof fetch
}>

/**
 * Production HTTP client for an independently persisted rollback witness.
 * Missing or invalid configuration fails closed. This module never falls back
 * to the in-memory test double and never talks to a chain indexer.
 */
export class Tm1RemoteRollbackWitness implements Tm1RollbackWitness {
  readonly endpointUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: FrozenConfig) {
    this.endpointUrl = config.endpointUrl
    this.timeoutMs = config.timeoutMs
    this.fetchImpl = config.fetch
  }

  async read(input: Tm1RollbackWitnessRead): Promise<unknown | null> {
    const request = snapshotTm1RollbackWitnessRead(input)
    return this.call('read', { slotId: request.slotId }, request.signal)
  }

  async enroll(input: Tm1RollbackWitnessEnrollment): Promise<unknown> {
    const request = snapshotTm1RollbackWitnessEnrollment(input)
    return this.call('enroll', {
      slotId: request.slotId,
      storeId: request.storeId,
      logicalRoot: request.logicalRoot,
      operationId: request.operationId
    }, request.signal)
  }

  async reserve(input: Tm1RollbackWitnessReservation): Promise<unknown> {
    const request = snapshotTm1RollbackWitnessReservation(input)
    return this.call('reserve', {
      slotId: request.slotId,
      storeId: request.storeId,
      expectedStableGeneration: request.expectedStableGeneration,
      expectedStableLogicalRoot: request.expectedStableLogicalRoot,
      expectedStableReceiptHash: request.expectedStableReceiptHash,
      nextGeneration: request.nextGeneration,
      nextLogicalRoot: request.nextLogicalRoot,
      operationId: request.operationId
    }, request.signal)
  }

  async finalize(input: Tm1RollbackWitnessFinalization): Promise<unknown> {
    const request = snapshotTm1RollbackWitnessFinalization(input)
    return this.call('finalize', {
      slotId: request.slotId,
      storeId: request.storeId,
      generation: request.generation,
      logicalRoot: request.logicalRoot,
      operationId: request.operationId,
      pendingReceiptHash: request.pendingReceiptHash
    }, request.signal)
  }

  async verifyRecord(recordValue: Tm1RollbackWitnessRecord): Promise<boolean> {
    let record: Tm1RollbackWitnessRecord
    try {
      record = parseTm1RollbackWitnessRecord(recordValue)
    } catch {
      return false
    }
    const result = await this.call('verifyRecord', record)
    return result === true
  }

  private async call(
    operation: Tm1RemoteRollbackWitnessHttpOperation,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) unavailable()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = (): void => {
      controller.abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.fetchImpl(operationUrl(this.endpointUrl, operation), {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
        headers: Object.freeze({
          accept: 'application/json',
          'content-type': 'application/json'
        }),
        body: JSON.stringify(Object.freeze({
          protocol: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL,
          protocolVersion: TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION,
          operation,
          payload
        }))
      })
      return await decodeResponse(response, operation, controller.signal)
    } catch (error) {
      if (error instanceof Tm1RollbackWitnessError) throw error
      unavailable()
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function createTm1RemoteRollbackWitness(
  configValue: unknown
): Tm1RemoteRollbackWitness {
  return new Tm1RemoteRollbackWitness(parseConfig(configValue))
}

/**
 * Explicit environment mapping. Absence of TM1_ROLLBACK_WITNESS_ENDPOINT_URL
 * is WITNESS_NOT_CONFIGURED. Never substitutes the in-memory test double.
 */
export function createTm1RemoteRollbackWitnessFromEnv(
  env: Readonly<Record<string, string | undefined>>
): Tm1RemoteRollbackWitness {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) notConfigured()
  const endpointUrl = env.TM1_ROLLBACK_WITNESS_ENDPOINT_URL
  const timeoutRaw = env.TM1_ROLLBACK_WITNESS_TIMEOUT_MS
  if (typeof endpointUrl !== 'string' || endpointUrl.length === 0) notConfigured()
  const config: Record<string, unknown> = { endpointUrl }
  if (typeof timeoutRaw === 'string' && timeoutRaw.length > 0) {
    const timeoutMs = Number(timeoutRaw)
    if (!Number.isSafeInteger(timeoutMs)) notConfigured()
    config.timeoutMs = timeoutMs
  }
  return createTm1RemoteRollbackWitness(Object.freeze(config))
}

function parseConfig(value: unknown): FrozenConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    notConfigured()
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return notConfigured()
  }
  const allowed = ['endpointUrl', 'timeoutMs', 'fetch']
  if (
    prototype !== Object.prototype && prototype !== null ||
    keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    !keys.includes('endpointUrl')
  ) notConfigured()
  const source = value as Record<string, unknown>
  const endpointUrl = normalizeEndpointUrl(dataValue(source, 'endpointUrl'))
  const timeoutMs = keys.includes('timeoutMs')
    ? requireTimeout(dataValue(source, 'timeoutMs'))
    : DEFAULT_TIMEOUT_MS
  const fetchImpl = keys.includes('fetch')
    ? requireFetch(dataValue(source, 'fetch'))
    : requireFetch(globalThis.fetch)
  return Object.freeze({ endpointUrl, timeoutMs, fetch: fetchImpl })
}

function normalizeEndpointUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    notConfigured()
  }
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return notConfigured()
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) notConfigured()
  if (endpoint.hash.length > 0 || endpoint.search.length > 0) notConfigured()
  if (endpoint.protocol === 'https:') {
    if (endpoint.hostname.length === 0) notConfigured()
  } else if (endpoint.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) notConfigured()
  } else {
    notConfigured()
  }
  const path = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/+$/, '')
  return `${endpoint.origin}${path}`
}

function requireTimeout(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_TIMEOUT_MS
  ) notConfigured()
  return value as number
}

function requireFetch(value: unknown): typeof fetch {
  if (typeof value !== 'function') notConfigured()
  return value as typeof fetch
}

function operationUrl(
  endpointUrl: string,
  operation: Tm1RemoteRollbackWitnessHttpOperation
): string {
  return `${endpointUrl}/v1/${operation}`
}

async function decodeResponse(
  response: Response,
  operation: Tm1RemoteRollbackWitnessHttpOperation,
  signal: AbortSignal
): Promise<unknown> {
  const body = await readLimitedBody(response, signal)
  if (body.length === 0) unavailable()
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    unavailable()
  }
  if (isErrorEnvelope(parsed)) {
    throw new Tm1RollbackWitnessError(parsed.error)
  }
  if (!response.ok) unavailable()
  if (isSuccessEnvelope(parsed)) {
    return parsed.result
  }
  if (parsed === null) unavailable()
  if (operation === 'verifyRecord') unverifiable()
  return parsed
}

async function readLimitedBody(
  response: Response,
  signal: AbortSignal
): Promise<string> {
  const stream = response.body
  if (stream === null) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let received = 0
  const parts: string[] = []
  const abortRead = (): void => {
    void cancelReader(reader)
  }
  if (signal.aborted) {
    abortRead()
    unavailable()
  }
  signal.addEventListener('abort', abortRead, { once: true })
  try {
    while (true) {
      if (signal.aborted) unavailable()
      const { done, value } = await reader.read()
      if (signal.aborted) unavailable()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      received += value.byteLength
      if (received > MAX_RESPONSE_BYTES) {
        await cancelReader(reader)
        unavailable()
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } catch (error) {
    if (error instanceof Tm1RollbackWitnessError) throw error
    unavailable()
  } finally {
    signal.removeEventListener('abort', abortRead)
  }
}

function isSuccessEnvelope(value: unknown): value is Readonly<{
  protocol: typeof TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL
  protocolVersion: typeof TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION
  ok: true
  result: unknown
}> {
  if (!isEnvelopeShape(value) || dataValue(value, 'ok') !== true) return false
  return Reflect.ownKeys(value).includes('result')
}

function isErrorEnvelope(value: unknown): value is Readonly<{
  protocol: typeof TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL
  protocolVersion: typeof TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION
  ok: false
  error: Tm1RollbackWitnessErrorCode
}> {
  if (!isEnvelopeShape(value) || dataValue(value, 'ok') !== false) return false
  const error = dataValue(value, 'error')
  return typeof error === 'string' &&
    KNOWN_REMOTE_ERROR_CODES.has(error as Tm1RollbackWitnessErrorCode)
}

function isEnvelopeShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return false
  }
  return dataValue(value as Record<string, unknown>, 'protocol') ===
      TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL &&
    dataValue(value as Record<string, unknown>, 'protocolVersion') ===
      TM1_REMOTE_ROLLBACK_WITNESS_HTTP_PROTOCOL_VERSION &&
    keys.every(key => typeof key === 'string' &&
      (key === 'protocol' || key === 'protocolVersion' || key === 'ok' ||
        key === 'result' || key === 'error'))
}

function dataValue(source: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key)
  } catch {
    return undefined
  }
  if (descriptor === undefined || !('value' in descriptor)) return undefined
  return descriptor.value
}

function notConfigured(): never {
  throw new Tm1RollbackWitnessError('WITNESS_NOT_CONFIGURED')
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  return reader.cancel().then(() => undefined, () => undefined)
}

function unavailable(): never {
  throw new Tm1RollbackWitnessError('WITNESS_UNAVAILABLE')
}

function unverifiable(): never {
  throw new Tm1RollbackWitnessError('WITNESS_UNVERIFIABLE')
}
