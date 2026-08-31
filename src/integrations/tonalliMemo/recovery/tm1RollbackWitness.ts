export const TM1_ROLLBACK_WITNESS_PROTOCOL = 'tonalli.tm1-rollback-witness'
export const TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION = 1

const MAX_IDENTIFIER_LENGTH = 256
const MAX_RECEIPT_LENGTH = 4_096
const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/
const STORE_ID_PATTERN = /^tm1-store:v1:[0-9a-f]{64}$/

export type Tm1RollbackWitnessRecordState = 'pending' | 'stable'

export type Tm1RollbackWitnessRecord = Readonly<{
  protocol: typeof TM1_ROLLBACK_WITNESS_PROTOCOL
  protocolVersion: typeof TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION
  slotId: string
  storeId: string
  generation: number
  logicalRoot: string
  previousStableReceiptHash: string | null
  operationId: string
  state: Tm1RollbackWitnessRecordState
  witnessKeyId: string
  receiptHash: string
  authenticatedReceipt: string
}>

export type Tm1RollbackWitnessSnapshot = Readonly<{
  stable: Tm1RollbackWitnessRecord
  pending: Tm1RollbackWitnessRecord | null
}>

export type Tm1RollbackWitnessRead = Readonly<{
  slotId: string
  signal?: AbortSignal
}>

export type Tm1RollbackWitnessEnrollment = Readonly<{
  slotId: string
  storeId: string
  logicalRoot: string
  operationId: string
  signal?: AbortSignal
}>

export type Tm1RollbackWitnessReservation = Readonly<{
  slotId: string
  storeId: string
  expectedStableGeneration: number
  expectedStableLogicalRoot: string
  expectedStableReceiptHash: string
  nextGeneration: number
  nextLogicalRoot: string
  operationId: string
  signal?: AbortSignal
}>

export type Tm1RollbackWitnessFinalization = Readonly<{
  slotId: string
  storeId: string
  generation: number
  logicalRoot: string
  operationId: string
  pendingReceiptHash: string
  signal?: AbortSignal
}>

/**
 * Authenticated service boundary for the independent rollback witness.
 *
 * Return values remain unknown so the authority gate must parse, snapshot and
 * authenticate every response. A null read means the slot has never been
 * enrolled; it is not permission to enroll during ordinary startup.
 */
export interface Tm1RollbackWitness {
  read(input: Tm1RollbackWitnessRead): Promise<unknown | null>
  enroll(input: Tm1RollbackWitnessEnrollment): Promise<unknown>
  reserve(input: Tm1RollbackWitnessReservation): Promise<unknown>
  finalize(input: Tm1RollbackWitnessFinalization): Promise<unknown>
  verifyRecord(record: Tm1RollbackWitnessRecord): Promise<boolean>
}

export type Tm1RollbackWitnessErrorCode =
  | 'INVALID_WITNESS_INPUT'
  | 'INVALID_WITNESS_RECORD'
  | 'WITNESS_ALREADY_ENROLLED'
  | 'WITNESS_CONFLICT'
  | 'WITNESS_NOT_CONFIGURED'
  | 'WITNESS_NOT_ENROLLED'
  | 'WITNESS_UNAVAILABLE'
  | 'WITNESS_UNVERIFIABLE'

export class Tm1RollbackWitnessError extends Error {
  readonly code: Tm1RollbackWitnessErrorCode

  constructor(code: Tm1RollbackWitnessErrorCode) {
    super(code)
    this.name = 'Tm1RollbackWitnessError'
    this.code = code
  }
}

export function parseTm1RollbackWitnessRecord(
  value: unknown
): Tm1RollbackWitnessRecord {
  const source = exactRecord(value, [
    'protocol',
    'protocolVersion',
    'slotId',
    'storeId',
    'generation',
    'logicalRoot',
    'previousStableReceiptHash',
    'operationId',
    'state',
    'witnessKeyId',
    'receiptHash',
    'authenticatedReceipt'
  ])
  const protocol = dataValue(source, 'protocol')
  const protocolVersion = dataValue(source, 'protocolVersion')
  const state = dataValue(source, 'state')
  if (
    protocol !== TM1_ROLLBACK_WITNESS_PROTOCOL ||
    protocolVersion !== TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION ||
    state !== 'pending' && state !== 'stable'
  ) invalidRecord()
  const generation = requireNonNegativeSafeInteger(dataValue(source, 'generation'))
  const previousStableReceiptHash = requireNullableHash(
    dataValue(source, 'previousStableReceiptHash')
  )
  if ((generation === 0) !== (previousStableReceiptHash === null)) invalidRecord()
  return Object.freeze({
    protocol,
    protocolVersion,
    slotId: requireIdentifier(dataValue(source, 'slotId')),
    storeId: requireStoreId(dataValue(source, 'storeId')),
    generation,
    logicalRoot: requireCanonicalHash(dataValue(source, 'logicalRoot')),
    previousStableReceiptHash,
    operationId: requireIdentifier(dataValue(source, 'operationId')),
    state,
    witnessKeyId: requireIdentifier(dataValue(source, 'witnessKeyId')),
    receiptHash: requireCanonicalHash(dataValue(source, 'receiptHash')),
    authenticatedReceipt: requireReceipt(dataValue(source, 'authenticatedReceipt'))
  })
}

export function parseTm1RollbackWitnessSnapshot(
  value: unknown
): Tm1RollbackWitnessSnapshot {
  const source = exactRecord(value, ['stable', 'pending'])
  const stable = parseTm1RollbackWitnessRecord(dataValue(source, 'stable'))
  const pendingValue = dataValue(source, 'pending')
  const pending = pendingValue === null
    ? null
    : parseTm1RollbackWitnessRecord(pendingValue)
  if (stable.state !== 'stable') invalidRecord()
  if (pending !== null && (
    pending.state !== 'pending' ||
    pending.slotId !== stable.slotId ||
    pending.storeId !== stable.storeId ||
    pending.witnessKeyId !== stable.witnessKeyId ||
    pending.generation !== stable.generation + 1 ||
    pending.previousStableReceiptHash !== stable.receiptHash
  )) invalidRecord()
  return Object.freeze({ stable, pending })
}

export function snapshotTm1RollbackWitnessRead(
  value: Tm1RollbackWitnessRead
): Tm1RollbackWitnessRead {
  return snapshotInput(value, ['slotId', 'signal'], source => ({
    slotId: requireIdentifier(dataValue(source, 'slotId')),
    ...optionalSignal(source)
  }))
}

export function snapshotTm1RollbackWitnessEnrollment(
  value: Tm1RollbackWitnessEnrollment
): Tm1RollbackWitnessEnrollment {
  return snapshotInput(value, [
    'slotId', 'storeId', 'logicalRoot', 'operationId', 'signal'
  ], source => ({
    slotId: requireIdentifier(dataValue(source, 'slotId')),
    storeId: requireStoreId(dataValue(source, 'storeId')),
    logicalRoot: requireCanonicalHash(dataValue(source, 'logicalRoot')),
    operationId: requireIdentifier(dataValue(source, 'operationId')),
    ...optionalSignal(source)
  }))
}

export function snapshotTm1RollbackWitnessReservation(
  value: Tm1RollbackWitnessReservation
): Tm1RollbackWitnessReservation {
  return snapshotInput(value, [
    'slotId',
    'storeId',
    'expectedStableGeneration',
    'expectedStableLogicalRoot',
    'expectedStableReceiptHash',
    'nextGeneration',
    'nextLogicalRoot',
    'operationId',
    'signal'
  ], source => ({
    slotId: requireIdentifier(dataValue(source, 'slotId')),
    storeId: requireStoreId(dataValue(source, 'storeId')),
    expectedStableGeneration: requireNonNegativeSafeInteger(
      dataValue(source, 'expectedStableGeneration')
    ),
    expectedStableLogicalRoot: requireCanonicalHash(
      dataValue(source, 'expectedStableLogicalRoot')
    ),
    expectedStableReceiptHash: requireCanonicalHash(
      dataValue(source, 'expectedStableReceiptHash')
    ),
    nextGeneration: requireNonNegativeSafeInteger(
      dataValue(source, 'nextGeneration')
    ),
    nextLogicalRoot: requireCanonicalHash(dataValue(source, 'nextLogicalRoot')),
    operationId: requireIdentifier(dataValue(source, 'operationId')),
    ...optionalSignal(source)
  }))
}

export function snapshotTm1RollbackWitnessFinalization(
  value: Tm1RollbackWitnessFinalization
): Tm1RollbackWitnessFinalization {
  return snapshotInput(value, [
    'slotId',
    'storeId',
    'generation',
    'logicalRoot',
    'operationId',
    'pendingReceiptHash',
    'signal'
  ], source => ({
    slotId: requireIdentifier(dataValue(source, 'slotId')),
    storeId: requireStoreId(dataValue(source, 'storeId')),
    generation: requireNonNegativeSafeInteger(dataValue(source, 'generation')),
    logicalRoot: requireCanonicalHash(dataValue(source, 'logicalRoot')),
    operationId: requireIdentifier(dataValue(source, 'operationId')),
    pendingReceiptHash: requireCanonicalHash(dataValue(source, 'pendingReceiptHash')),
    ...optionalSignal(source)
  }))
}

function snapshotInput<T>(
  value: unknown,
  allowedKeys: readonly string[],
  create: (source: Record<string, unknown>) => T
): T {
  const source = allowedRecord(value, allowedKeys)
  return Object.freeze(create(source)) as T
}

function optionalSignal(source: Record<string, unknown>): { signal?: AbortSignal } {
  if (!Reflect.ownKeys(source).includes('signal')) return {}
  const signal = dataValue(source, 'signal')
  if (signal === undefined) return {}
  if (!(signal instanceof AbortSignal)) invalidInput()
  return { signal }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = allowedRecord(value, keys)
  const actualKeys = Reflect.ownKeys(source)
  if (keys.some(key => !actualKeys.includes(key))) invalidRecord()
  return source
}

function allowedRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidInput()
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidInput()
  }
  if (
    prototype !== Object.prototype && prototype !== null ||
    keys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))
  ) invalidInput()
  return value as Record<string, unknown>
}

function dataValue(source: Record<string, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key)
  } catch {
    return invalidInput()
  }
  if (descriptor === undefined || !('value' in descriptor)) invalidInput()
  return descriptor.value
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    value.includes('\0')
  ) invalidInput()
  return value
}

function requireStoreId(value: unknown): string {
  if (typeof value !== 'string' || !STORE_ID_PATTERN.test(value)) invalidInput()
  return value
}

function requireCanonicalHash(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_HASH_PATTERN.test(value)) invalidInput()
  return value
}

function requireNullableHash(value: unknown): string | null {
  return value === null ? null : requireCanonicalHash(value)
}

function requireReceipt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RECEIPT_LENGTH ||
    value.includes('\0')
  ) invalidRecord()
  return value
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidInput()
  return value as number
}

function invalidInput(): never {
  throw new Tm1RollbackWitnessError('INVALID_WITNESS_INPUT')
}

function invalidRecord(): never {
  throw new Tm1RollbackWitnessError('INVALID_WITNESS_RECORD')
}
