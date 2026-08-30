import {
  Tm1PublicationRecoveryStoreError
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import {
  TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION,
  Tm1RollbackWitnessError,
  parseTm1RollbackWitnessSnapshot,
  snapshotTm1RollbackWitnessReservation,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessRecord,
  type Tm1RollbackWitnessReservation,
  type Tm1RollbackWitnessSnapshot
} from '../../../src/integrations/tonalliMemo/recovery/tm1RollbackWitness'

declare const reservationGrantBrand: unique symbol

export type Tm1RollbackWitnessReservationGrant = Readonly<{
  protocolVersion: typeof TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION
  slotId: string
  storeId: string
  previousStableGeneration: number
  previousStableLogicalRoot: string
  previousStableReceiptHash: string
  nextGeneration: number
  nextLogicalRoot: string
  operationId: string
  pendingReceiptHash: string
  witnessKeyId: string
  readonly [reservationGrantBrand]: never
}>

export type Tm1RollbackWitnessPendingObservation = Readonly<{
  stable: Tm1RollbackWitnessRecord
  pending: Tm1RollbackWitnessRecord
}>

export type Tm1RollbackWitnessReservationOutcome = Readonly<{
  observation: Tm1RollbackWitnessPendingObservation
  grant: Tm1RollbackWitnessReservationGrant
}>

export type Tm1RollbackWitnessReservationGrantEvidence = Readonly<{
  protocolVersion: typeof TM1_ROLLBACK_WITNESS_PROTOCOL_VERSION
  slotId: string
  storeId: string
  previousStableGeneration: number
  previousStableLogicalRoot: string
  previousStableReceiptHash: string
  nextGeneration: number
  nextLogicalRoot: string
  operationId: string
  pendingReceiptHash: string
  witnessKeyId: string
  stableRecord: Tm1RollbackWitnessRecord
  pendingRecord: Tm1RollbackWitnessRecord
}>

const grantEvidence = new WeakMap<object, Tm1RollbackWitnessReservationGrantEvidence>()
const consumedGrants = new WeakSet<object>()

/**
 * Wins one authenticated remote reserve CAS and issues its process-local
 * bearer capability. A read/parse/verify path never calls this issuer and
 * therefore can never reconstruct the grant after a crash.
 */
export async function reserveTm1RollbackWitnessWithGrant(
  witnessValue: Tm1RollbackWitness,
  inputValue: Tm1RollbackWitnessReservation
): Promise<Tm1RollbackWitnessReservationOutcome> {
  const witness = snapshotWitness(witnessValue)
  const request = snapshotTm1RollbackWitnessReservation(inputValue)
  if (request.nextGeneration !== request.expectedStableGeneration + 1) {
    throw new Tm1RollbackWitnessError('INVALID_WITNESS_INPUT')
  }
  assertNotAborted(request.signal)

  let snapshot: Tm1RollbackWitnessSnapshot
  try {
    snapshot = parseTm1RollbackWitnessSnapshot(await witness.reserve(request))
  } catch (error) {
    throw normalizeWitnessError(error)
  }
  assertNotAborted(request.signal)
  const pending = snapshot.pending
  if (pending === null) throw new Tm1RollbackWitnessError('WITNESS_UNVERIFIABLE')

  await authenticateRecord(witness, snapshot.stable)
  await authenticateRecord(witness, pending)
  assertNotAborted(request.signal)
  if (!matchesReservation(snapshot.stable, pending, request)) {
    throw new Tm1RollbackWitnessError('WITNESS_UNVERIFIABLE')
  }

  const evidence = Object.freeze({
    protocolVersion: pending.protocolVersion,
    slotId: pending.slotId,
    storeId: pending.storeId,
    previousStableGeneration: snapshot.stable.generation,
    previousStableLogicalRoot: snapshot.stable.logicalRoot,
    previousStableReceiptHash: snapshot.stable.receiptHash,
    nextGeneration: pending.generation,
    nextLogicalRoot: pending.logicalRoot,
    operationId: pending.operationId,
    pendingReceiptHash: pending.receiptHash,
    witnessKeyId: pending.witnessKeyId,
    stableRecord: snapshot.stable,
    pendingRecord: pending
  }) satisfies Tm1RollbackWitnessReservationGrantEvidence
  const grant = Object.freeze({
    protocolVersion: evidence.protocolVersion,
    slotId: evidence.slotId,
    storeId: evidence.storeId,
    previousStableGeneration: evidence.previousStableGeneration,
    previousStableLogicalRoot: evidence.previousStableLogicalRoot,
    previousStableReceiptHash: evidence.previousStableReceiptHash,
    nextGeneration: evidence.nextGeneration,
    nextLogicalRoot: evidence.nextLogicalRoot,
    operationId: evidence.operationId,
    pendingReceiptHash: evidence.pendingReceiptHash,
    witnessKeyId: evidence.witnessKeyId
  }) as Tm1RollbackWitnessReservationGrant
  grantEvidence.set(grant, evidence)

  return Object.freeze({
    observation: Object.freeze({ stable: snapshot.stable, pending }),
    grant
  })
}

/**
 * Store-only capability consumption boundary.
 *
 * Non-authoritative prepare remains retryable. After successful prepare
 * the exact grant is burned, then operate runs. BEGIN/COMMIT/rollback
 * failure cannot restore the CAS-winning bearer.
 */
export function withTm1RollbackWitnessReservationGrant<T>(
  grantValue: unknown,
  prepare: (evidence: Tm1RollbackWitnessReservationGrantEvidence) => void,
  operate: (evidence: Tm1RollbackWitnessReservationGrantEvidence) => T
): T {
  if (grantValue === null || typeof grantValue !== 'object') grantRequired()
  const evidence = grantEvidence.get(grantValue)
  if (evidence === undefined) grantRequired()
  if (consumedGrants.has(grantValue) || !grantStillMatches(grantValue, evidence)) {
    fenceMismatch()
  }
  if (typeof prepare !== 'function' || typeof operate !== 'function') {
    fenceMismatch()
  }
  prepare(evidence)
  consumedGrants.add(grantValue)
  return operate(evidence)
}

function snapshotWitness(value: Tm1RollbackWitness): Readonly<{
  reserve: Tm1RollbackWitness['reserve']
  verifyRecord: Tm1RollbackWitness['verifyRecord']
}> {
  if (value === null || typeof value !== 'object') {
    throw new Tm1RollbackWitnessError('INVALID_WITNESS_INPUT')
  }
  let reserve: Tm1RollbackWitness['reserve']
  let verifyRecord: Tm1RollbackWitness['verifyRecord']
  try {
    reserve = value.reserve
    verifyRecord = value.verifyRecord
  } catch {
    throw new Tm1RollbackWitnessError('INVALID_WITNESS_INPUT')
  }
  if (typeof reserve !== 'function' || typeof verifyRecord !== 'function') {
    throw new Tm1RollbackWitnessError('INVALID_WITNESS_INPUT')
  }
  return Object.freeze({
    reserve: reserve.bind(value),
    verifyRecord: verifyRecord.bind(value)
  })
}

async function authenticateRecord(
  witness: Readonly<{ verifyRecord: Tm1RollbackWitness['verifyRecord'] }>,
  record: Tm1RollbackWitnessRecord
): Promise<void> {
  let verified: boolean
  try {
    verified = await witness.verifyRecord(record)
  } catch (error) {
    throw normalizeWitnessError(error)
  }
  if (verified !== true) throw new Tm1RollbackWitnessError('WITNESS_UNVERIFIABLE')
}

function matchesReservation(
  stable: Tm1RollbackWitnessRecord,
  pending: Tm1RollbackWitnessRecord,
  request: Tm1RollbackWitnessReservation
): boolean {
  return stable.slotId === request.slotId &&
    stable.storeId === request.storeId &&
    stable.generation === request.expectedStableGeneration &&
    stable.logicalRoot === request.expectedStableLogicalRoot &&
    stable.receiptHash === request.expectedStableReceiptHash &&
    pending.slotId === request.slotId &&
    pending.storeId === request.storeId &&
    pending.generation === request.nextGeneration &&
    pending.logicalRoot === request.nextLogicalRoot &&
    pending.previousStableReceiptHash === request.expectedStableReceiptHash &&
    pending.operationId === request.operationId
}

function grantStillMatches(
  grant: object,
  evidence: Tm1RollbackWitnessReservationGrantEvidence
): boolean {
  const visible = grant as Partial<Tm1RollbackWitnessReservationGrant>
  return Object.isFrozen(grant) &&
    visible.protocolVersion === evidence.protocolVersion &&
    visible.slotId === evidence.slotId &&
    visible.storeId === evidence.storeId &&
    visible.previousStableGeneration === evidence.previousStableGeneration &&
    visible.previousStableLogicalRoot === evidence.previousStableLogicalRoot &&
    visible.previousStableReceiptHash === evidence.previousStableReceiptHash &&
    visible.nextGeneration === evidence.nextGeneration &&
    visible.nextLogicalRoot === evidence.nextLogicalRoot &&
    visible.operationId === evidence.operationId &&
    visible.pendingReceiptHash === evidence.pendingReceiptHash &&
    visible.witnessKeyId === evidence.witnessKeyId
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Tm1RollbackWitnessError('WITNESS_UNAVAILABLE')
}

function normalizeWitnessError(error: unknown): never {
  if (error instanceof Tm1RollbackWitnessError) throw error
  throw new Tm1RollbackWitnessError('WITNESS_UNAVAILABLE')
}

function grantRequired(): never {
  throw new Tm1PublicationRecoveryStoreError('WITNESS_RESERVATION_GRANT_REQUIRED')
}

function fenceMismatch(): never {
  throw new Tm1PublicationRecoveryStoreError('WITNESS_RESERVATION_FENCE_MISMATCH')
}
