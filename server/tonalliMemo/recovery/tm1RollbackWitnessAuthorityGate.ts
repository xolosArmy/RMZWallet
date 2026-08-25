import {
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessSnapshot,
  snapshotTm1RollbackWitnessEnrollment,
  snapshotTm1RollbackWitnessRead,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessRecord,
  type Tm1RollbackWitnessSnapshot
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'
import type { Tm1SqlitePublicationRecoveryStore } from './tm1SqlitePublicationRecoveryStore'
import {
  parseTm1SqliteWitnessBinding,
  type Tm1SqliteWitnessBinding
} from './tm1SqliteSchema'

export type Tm1RollbackWitnessAuthorityGateErrorCode =
  | 'AUTHORITY_GATE_ABORTED'
  | 'AUTHORITY_GATE_CONFIGURATION_INVALID'
  | 'ENROLLMENT_RECOVERY_REQUIRED'
  | 'LOCAL_STATE_AHEAD_OF_WITNESS'
  | 'ROLLBACK_DETECTED'
  | 'STORE_IDENTITY_MISMATCH'
  | 'WITNESS_NOT_CONFIGURED'
  | 'WITNESS_NOT_ENROLLED'
  | 'WITNESS_PENDING_QUARANTINE'
  | 'WITNESS_STATE_MISMATCH'
  | 'WITNESS_UNAVAILABLE'
  | 'WITNESS_UNVERIFIABLE'

export class Tm1RollbackWitnessAuthorityGateError extends Error {
  readonly code: Tm1RollbackWitnessAuthorityGateErrorCode

  constructor(code: Tm1RollbackWitnessAuthorityGateErrorCode) {
    super(code)
    this.name = 'Tm1RollbackWitnessAuthorityGateError'
    this.code = code
  }
}

/**
 * Freshness evidence only. It is not a signing, transport or mutation
 * capability. A future authority-bearing mutation must perform a new remote
 * reserve CAS against stableReceiptHash and then follow the three-stage
 * protocol; retaining this snapshot cannot bypass that CAS.
 */
export type Tm1RollbackWitnessFreshness = Readonly<{
  slotId: string
  storeId: string
  generation: number
  logicalRoot: string
  stableReceiptHash: string
  witnessKeyId: string
}>

export type Tm1RollbackWitnessGateDependencies = Readonly<{
  store: Pick<
    Tm1SqlitePublicationRecoveryStore,
    'inspectWitnessBinding' | 'computeEnrollmentLogicalRoot' | 'enrollWitnessBinding'
  >
  witness?: Tm1RollbackWitness
}>

export type Tm1RollbackWitnessStartup = Readonly<{
  slotId: string
  signal?: AbortSignal
}>

export type Tm1RollbackWitnessProvisioning = Readonly<{
  slotId: string
  storeId: string
  operationId: string
  signal?: AbortSignal
}>

/** Ordinary startup: absence never creates a store or witness enrollment. */
export async function establishTm1RollbackWitnessFreshness(
  dependenciesValue: Tm1RollbackWitnessGateDependencies,
  inputValue: Tm1RollbackWitnessStartup
): Promise<Tm1RollbackWitnessFreshness> {
  const dependencies = snapshotDependencies(dependenciesValue)
  const input = snapshotTm1RollbackWitnessRead(inputValue)
  assertNotAborted(input.signal)
  const witness = requireWitness(dependencies)
  const local = inspectLocal(dependencies)
  const remote = await readRemote(witness, input.slotId, input.signal)

  if (local === null) {
    if (remote === null) fail('WITNESS_NOT_ENROLLED')
    fail('ENROLLMENT_RECOVERY_REQUIRED')
  }
  if (local.slotId !== input.slotId) fail('STORE_IDENTITY_MISMATCH')
  if (remote === null) fail('WITNESS_NOT_ENROLLED')
  await authenticateSnapshot(witness, remote)
  assertSnapshotIdentity(remote, input.slotId, local.storeId)

  let stable = remote.stable
  if (remote.pending !== null) {
    const pending = remote.pending
    if (sameGenerationAndRoot(local, pending)) {
      const finalized = await finalizeMatchingPending(witness, pending, input.signal)
      assertSnapshotIdentity(finalized, input.slotId, local.storeId)
      stable = finalized.stable
    } else if (sameGenerationAndRoot(local, remote.stable)) {
      // DB-old + remote-pending cannot distinguish a pre-commit crash from a
      // restored DB after commit. Never cancel or retry automatically.
      fail('WITNESS_PENDING_QUARANTINE')
    } else {
      classifyMismatch(local, remote)
    }
  }

  if (!sameGenerationAndRoot(local, stable)) {
    classifyMismatch(local, Object.freeze({ stable, pending: null }))
  }
  const rechecked = inspectLocal(dependencies)
  if (rechecked === null || !sameBinding(rechecked, local)) {
    fail('WITNESS_STATE_MISMATCH')
  }
  return freshnessFrom(local, stable)
}

/**
 * Explicit first provisioning. A remote slot that already exists while the
 * local store is unbound always requires administrative recovery; this method
 * never silently resumes or creates a replacement identity.
 */
export async function provisionTm1RollbackWitness(
  dependenciesValue: Tm1RollbackWitnessGateDependencies,
  inputValue: Tm1RollbackWitnessProvisioning
): Promise<Tm1RollbackWitnessFreshness> {
  const dependencies = snapshotDependencies(dependenciesValue)
  const enrollment = snapshotTm1RollbackWitnessEnrollment({
    ...snapshotProvisioning(inputValue),
    logicalRoot: '0'.repeat(64)
  })
  assertNotAborted(enrollment.signal)
  const witness = requireWitness(dependencies)
  if (inspectLocal(dependencies) !== null) fail('STORE_IDENTITY_MISMATCH')
  const existing = await readRemote(witness, enrollment.slotId, enrollment.signal)
  if (existing !== null) {
    await authenticateSnapshot(witness, existing)
    fail('ENROLLMENT_RECOVERY_REQUIRED')
  }

  const logicalRoot = callStore(() => dependencies.computeEnrollmentLogicalRoot({
    slotId: enrollment.slotId,
    storeId: enrollment.storeId
  }))
  let remote: Tm1RollbackWitnessSnapshot
  try {
    remote = parseTm1RollbackWitnessSnapshot(await witness.enroll(Object.freeze({
      slotId: enrollment.slotId,
      storeId: enrollment.storeId,
      logicalRoot,
      operationId: enrollment.operationId,
      ...(enrollment.signal === undefined ? {} : { signal: enrollment.signal })
    })))
  } catch (error) {
    throw normalizeWitnessCallError(error, enrollment.signal)
  }
  await authenticateSnapshot(witness, remote)
  if (
    remote.pending !== null ||
    remote.stable.slotId !== enrollment.slotId ||
    remote.stable.storeId !== enrollment.storeId ||
    remote.stable.generation !== 0 ||
    remote.stable.logicalRoot !== logicalRoot ||
    remote.stable.operationId !== enrollment.operationId ||
    remote.stable.previousStableReceiptHash !== null
  ) fail('WITNESS_STATE_MISMATCH')

  let local: Tm1SqliteWitnessBinding
  try {
    local = parseTm1SqliteWitnessBinding(dependencies.enrollWitnessBinding({
      slotId: enrollment.slotId,
      storeId: enrollment.storeId,
      logicalRoot
    }))
  } catch {
    // The remote enrollment is now authoritative. Retrying as a fresh
    // enrollment would be unsafe; explicit administrative recovery is needed.
    return fail('ENROLLMENT_RECOVERY_REQUIRED')
  }
  if (!sameGenerationAndRoot(local, remote.stable)) {
    fail('WITNESS_STATE_MISMATCH')
  }
  return freshnessFrom(local, remote.stable)
}

type SafeDependencies = Readonly<{
  inspectWitnessBinding: () => Tm1SqliteWitnessBinding | null
  computeEnrollmentLogicalRoot: (
    identity: Readonly<{ slotId: string; storeId: string }>
  ) => string
  enrollWitnessBinding: (
    input: Readonly<{ slotId: string; storeId: string; logicalRoot: string }>
  ) => Tm1SqliteWitnessBinding
  witness?: Readonly<{
    read: Tm1RollbackWitness['read']
    enroll: Tm1RollbackWitness['enroll']
    finalize: Tm1RollbackWitness['finalize']
    verifyRecord: Tm1RollbackWitness['verifyRecord']
  }>
}>

function snapshotDependencies(
  value: Tm1RollbackWitnessGateDependencies
): SafeDependencies {
  if (value === null || typeof value !== 'object') {
    fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  }
  let store: Tm1RollbackWitnessGateDependencies['store']
  let witness: Tm1RollbackWitnessGateDependencies['witness']
  try {
    store = value.store
    witness = value.witness
  } catch {
    return fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  }
  if (
    store === null || typeof store !== 'object' ||
    typeof store.inspectWitnessBinding !== 'function' ||
    typeof store.computeEnrollmentLogicalRoot !== 'function' ||
    typeof store.enrollWitnessBinding !== 'function'
  ) fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  if (witness !== undefined && (
    witness === null || typeof witness !== 'object' ||
    typeof witness.read !== 'function' ||
    typeof witness.enroll !== 'function' ||
    typeof witness.finalize !== 'function' ||
    typeof witness.verifyRecord !== 'function'
  )) fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  return Object.freeze({
    inspectWitnessBinding: store.inspectWitnessBinding.bind(store),
    computeEnrollmentLogicalRoot: store.computeEnrollmentLogicalRoot.bind(store),
    enrollWitnessBinding: store.enrollWitnessBinding.bind(store),
    ...(witness === undefined
      ? {}
      : {
          witness: Object.freeze({
            read: witness.read.bind(witness),
            enroll: witness.enroll.bind(witness),
            finalize: witness.finalize.bind(witness),
            verifyRecord: witness.verifyRecord.bind(witness)
          })
        })
  })
}

function snapshotProvisioning(
  value: Tm1RollbackWitnessProvisioning
): Tm1RollbackWitnessProvisioning {
  if (value === null || typeof value !== 'object') {
    fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  }
  let keys: readonly PropertyKey[]
  let prototype: object | null
  try {
    keys = Reflect.ownKeys(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    return fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  }
  const allowed = ['slotId', 'storeId', 'operationId', 'signal']
  if (
    prototype !== Object.prototype && prototype !== null ||
    keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    !keys.includes('slotId') ||
    !keys.includes('storeId') ||
    !keys.includes('operationId')
  ) fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  return Object.freeze({
    slotId: readData(value, 'slotId') as string,
    storeId: readData(value, 'storeId') as string,
    operationId: readData(value, 'operationId') as string,
    ...(keys.includes('signal') ? { signal: readData(value, 'signal') as AbortSignal } : {})
  })
}

function readData(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  }
  if (descriptor === undefined || !('value' in descriptor)) {
    fail('AUTHORITY_GATE_CONFIGURATION_INVALID')
  }
  return descriptor.value
}

function requireWitness(dependencies: SafeDependencies): NonNullable<SafeDependencies['witness']> {
  if (dependencies.witness === undefined) fail('WITNESS_NOT_CONFIGURED')
  return dependencies.witness
}

function inspectLocal(dependencies: SafeDependencies): Tm1SqliteWitnessBinding | null {
  return callStore(() => {
    const value = dependencies.inspectWitnessBinding()
    return value === null ? null : parseTm1SqliteWitnessBinding(value)
  })
}

async function readRemote(
  witness: NonNullable<SafeDependencies['witness']>,
  slotId: string,
  signal?: AbortSignal
): Promise<Tm1RollbackWitnessSnapshot | null> {
  assertNotAborted(signal)
  let value: unknown | null
  try {
    value = await witness.read(Object.freeze({
      slotId,
      ...(signal === undefined ? {} : { signal })
    }))
  } catch (error) {
    throw normalizeWitnessCallError(error, signal)
  }
  assertNotAborted(signal)
  if (value === null) return null
  try {
    return parseTm1RollbackWitnessSnapshot(value)
  } catch {
    return fail('WITNESS_UNVERIFIABLE')
  }
}

async function authenticateSnapshot(
  witness: NonNullable<SafeDependencies['witness']>,
  snapshot: Tm1RollbackWitnessSnapshot
): Promise<void> {
  const records = snapshot.pending === null
    ? [snapshot.stable]
    : [snapshot.stable, snapshot.pending]
  for (const record of records) {
    let verified: boolean
    try {
      verified = await witness.verifyRecord(record)
    } catch (error) {
      throw normalizeWitnessCallError(error)
    }
    if (verified !== true) fail('WITNESS_UNVERIFIABLE')
  }
}

async function finalizeMatchingPending(
  witness: NonNullable<SafeDependencies['witness']>,
  pending: Tm1RollbackWitnessRecord,
  signal?: AbortSignal
): Promise<Tm1RollbackWitnessSnapshot> {
  assertNotAborted(signal)
  let finalized: Tm1RollbackWitnessSnapshot
  try {
    finalized = parseTm1RollbackWitnessSnapshot(await witness.finalize(Object.freeze({
      slotId: pending.slotId,
      storeId: pending.storeId,
      generation: pending.generation,
      logicalRoot: pending.logicalRoot,
      operationId: pending.operationId,
      pendingReceiptHash: pending.receiptHash,
      ...(signal === undefined ? {} : { signal })
    })))
  } catch (error) {
    throw normalizeWitnessCallError(error, signal)
  }
  await authenticateSnapshot(witness, finalized)
  if (
    finalized.pending !== null ||
    finalized.stable.slotId !== pending.slotId ||
    finalized.stable.storeId !== pending.storeId ||
    finalized.stable.generation !== pending.generation ||
    finalized.stable.logicalRoot !== pending.logicalRoot ||
    finalized.stable.previousStableReceiptHash !== pending.previousStableReceiptHash ||
    finalized.stable.operationId !== pending.operationId ||
    finalized.stable.witnessKeyId !== pending.witnessKeyId
  ) fail('WITNESS_STATE_MISMATCH')
  return finalized
}

function assertSnapshotIdentity(
  snapshot: Tm1RollbackWitnessSnapshot,
  slotId: string,
  storeId: string
): void {
  if (snapshot.stable.slotId !== slotId || snapshot.stable.storeId !== storeId) {
    fail('STORE_IDENTITY_MISMATCH')
  }
}

function classifyMismatch(
  local: Tm1SqliteWitnessBinding,
  remote: Tm1RollbackWitnessSnapshot
): never {
  if (remote.stable.storeId !== local.storeId || remote.stable.slotId !== local.slotId) {
    fail('STORE_IDENTITY_MISMATCH')
  }
  if (remote.stable.generation > local.generation) fail('ROLLBACK_DETECTED')
  if (local.generation > remote.stable.generation && remote.pending === null) {
    fail('LOCAL_STATE_AHEAD_OF_WITNESS')
  }
  fail('WITNESS_STATE_MISMATCH')
}

function sameGenerationAndRoot(
  local: Tm1SqliteWitnessBinding,
  remote: Tm1RollbackWitnessRecord
): boolean {
  return local.generation === remote.generation && local.logicalRoot === remote.logicalRoot
}

function sameBinding(
  left: Tm1SqliteWitnessBinding,
  right: Tm1SqliteWitnessBinding
): boolean {
  return left.slotId === right.slotId &&
    left.storeId === right.storeId &&
    left.generation === right.generation &&
    left.logicalRoot === right.logicalRoot
}

function freshnessFrom(
  local: Tm1SqliteWitnessBinding,
  stable: Tm1RollbackWitnessRecord
): Tm1RollbackWitnessFreshness {
  return Object.freeze({
    slotId: local.slotId,
    storeId: local.storeId,
    generation: local.generation,
    logicalRoot: local.logicalRoot,
    stableReceiptHash: stable.receiptHash,
    witnessKeyId: stable.witnessKeyId
  })
}

function callStore<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    return fail('WITNESS_STATE_MISMATCH')
  }
}

function normalizeWitnessCallError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) fail('AUTHORITY_GATE_ABORTED')
  if (error instanceof Tm1RollbackWitnessAuthorityGateError) throw error
  if (error instanceof Tm1RollbackWitnessError && error.code === 'WITNESS_UNVERIFIABLE') {
    fail('WITNESS_UNVERIFIABLE')
  }
  fail('WITNESS_UNAVAILABLE')
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('AUTHORITY_GATE_ABORTED')
}

function fail(code: Tm1RollbackWitnessAuthorityGateErrorCode): never {
  throw new Tm1RollbackWitnessAuthorityGateError(code)
}
