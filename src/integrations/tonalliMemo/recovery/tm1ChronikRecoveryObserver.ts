const CANONICAL_TXID = /^[0-9a-f]{64}$/

export type Tm1RecoveryObservationErrorCode =
  | 'INVALID_OBSERVATION_CONFIGURATION'
  | 'INVALID_RECOVERY_OBSERVATION'
  | 'OBSERVATION_UNAVAILABLE'
  | 'OPERATION_ABORTED'

export class Tm1RecoveryObservationError extends Error {
  readonly code: Tm1RecoveryObservationErrorCode

  constructor(code: Tm1RecoveryObservationErrorCode) {
    super(code)
    this.name = 'Tm1RecoveryObservationError'
    this.code = code
  }
}

export type Tm1RecoveryObservation = Readonly<
  | { status: 'absent'; txid: string }
  | { status: 'mempool'; txid: string }
  | {
    status: 'confirmed'
    txid: string
    confirmations: number
    blockHash: string
    blockHeight: number
  }
>

export type Tm1RecoveryObservationRequest = Readonly<{
  txid: string
  signal?: AbortSignal
}>

/** Narrow, read-only boundary that a future Chronik adapter may implement. */
export interface Tm1ChronikTransactionObservationSource {
  observeTransaction(request: Tm1RecoveryObservationRequest): Promise<unknown>
}

export interface Tm1ChronikRecoveryObserver {
  observe(request: Tm1RecoveryObservationRequest): Promise<Tm1RecoveryObservation>
}

export function createTm1ChronikRecoveryObserver(
  source: Tm1ChronikTransactionObservationSource
): Tm1ChronikRecoveryObserver {
  if (!source || typeof source.observeTransaction !== 'function') {
    throw new Tm1RecoveryObservationError('INVALID_OBSERVATION_CONFIGURATION')
  }
  const observeTransaction = source.observeTransaction.bind(source)

  return Object.freeze({
    observe: async (request: Tm1RecoveryObservationRequest) => {
      const txid = requireTxid(request?.txid)
      assertNotAborted(request?.signal)
      let result: unknown
      try {
        const pending = Promise.resolve(observeTransaction(Object.freeze({
          txid,
          ...(request.signal === undefined ? {} : { signal: request.signal })
        })))
        result = await awaitObservationOrAbort(pending, request.signal)
      } catch (error) {
        if (
          request?.signal?.aborted ||
          error instanceof Tm1RecoveryObservationError && error.code === 'OPERATION_ABORTED'
        ) {
          throw new Tm1RecoveryObservationError('OPERATION_ABORTED')
        }
        throw new Tm1RecoveryObservationError('OBSERVATION_UNAVAILABLE')
      }
      assertNotAborted(request.signal)
      return parseTm1RecoveryObservation(result, txid)
    }
  })
}

export function parseTm1RecoveryObservation(
  value: unknown,
  expectedTxid: string
): Tm1RecoveryObservation {
  const txid = requireTxid(expectedTxid)
  const status = dataValue(plainRecord(value), 'status')
  if (status === 'absent' || status === 'mempool') {
    const record = exactRecord(value, ['status', 'txid'])
    const observedTxid = requireTxid(dataValue(record, 'txid'))
    if (observedTxid !== txid) invalidObservation()
    return Object.freeze({ status, txid: observedTxid })
  }
  if (status === 'confirmed') {
    const record = exactRecord(value, [
      'status',
      'txid',
      'confirmations',
      'blockHash',
      'blockHeight'
    ])
    const observedTxid = requireTxid(dataValue(record, 'txid'))
    const confirmations = requireNonNegativeSafeInteger(dataValue(record, 'confirmations'))
    const blockHeight = requireNonNegativeSafeInteger(dataValue(record, 'blockHeight'))
    const blockHash = requireTxid(dataValue(record, 'blockHash'))
    if (observedTxid !== txid || confirmations <= 0) invalidObservation()
    return Object.freeze({
      status,
      txid: observedTxid,
      confirmations,
      blockHash,
      blockHeight
    })
  }
  return invalidObservation()
}

function awaitObservationOrAbort(
  pending: Promise<unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  void pending.catch(() => undefined)
  if (!signal) return pending
  if (signal.aborted) {
    return Promise.reject(new Tm1RecoveryObservationError('OPERATION_ABORTED'))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Tm1RecoveryObservationError('OPERATION_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => {
        if (settled) return
        cleanup()
        settled = true
        if (signal.aborted) {
          reject(new Tm1RecoveryObservationError('OPERATION_ABORTED'))
        } else {
          resolve(value)
        }
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) onAbort()
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Tm1RecoveryObservationError('OPERATION_ABORTED')
}

function requireTxid(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_TXID.test(value)) {
    return invalidObservation()
  }
  return value
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalidObservation()
  }
  return value
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<PropertyKey, unknown> {
  const record = plainRecord(value)
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(record)
  } catch {
    return invalidObservation()
  }
  if (
    keys.some(key => typeof key !== 'string') ||
    keys.length !== expectedKeys.length ||
    expectedKeys.some(key => !keys.includes(key))
  ) return invalidObservation()
  return record
}

function plainRecord(value: unknown): Record<PropertyKey, unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return invalidObservation()
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    return invalidObservation()
  }
  if (prototype !== Object.prototype && prototype !== null) return invalidObservation()
  return value as Record<PropertyKey, unknown>
}

function dataValue(record: Record<PropertyKey, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key)
  } catch {
    return invalidObservation()
  }
  if (!descriptor || !('value' in descriptor)) return invalidObservation()
  return descriptor.value
}

function invalidObservation(): never {
  throw new Tm1RecoveryObservationError('INVALID_RECOVERY_OBSERVATION')
}
