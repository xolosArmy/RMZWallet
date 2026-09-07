import {
  sha256,
  toHex,
  Tx
} from 'ecash-lib'
import {
  Tm1AliasOwnershipVerificationError,
  Tm1AliasOwnershipVerificationPort,
  createTm1AliasOwnershipVerificationPort,
  lookupTm1VerifiedAliasOwnershipToken,
  type Tm1VerifiedAliasOwnershipSnapshot
} from './tm1AliasOwnershipVerificationPort'
import {
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer,
  type Tm1AliasPublicationAuthorization
} from './tm1AliasPublicationAuthorization'
import {
  encodeTm1Draft02Post,
  type Tm1Draft02PostPreview
} from './tm1Draft02'
import {
  TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
  type Tm1Draft02FundingUtxo
} from './tm1Draft02Plan'
import {
  type Tm1Draft02Candidate,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  auditTm1Draft02UnsignedTransaction,
  serializeTm1Draft02UnsignedTransaction,
  type AuditedTm1Draft02UnsignedTransaction
} from './tm1Draft02UnsignedTransaction'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  auditTm1Draft02RegtestSignedTransaction,
  signTm1Draft02RegtestCandidate,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
import {
  Tm1InMemoryDeliveryTransport,
  type Tm1RegtestDeliveryReceipt,
  type Tm1RegtestDeliveryTransport,
  type Tm1RegtestNetworkAttestation
} from './tm1RegtestDeliveryTransport'
import {
  createTm1RegtestDualAuthorizationPorts
} from './tm1RegtestDualAuthorizationComposition'
import type {
  Tm1RegtestAuthorizationDecisionProvider,
  Tm1RegtestAuthorizationProviderDecision
} from './tm1RegtestAuthorizationAdapter'
import type {
  Tm1RegtestBroadcastAuthorizationDecisionProvider,
  Tm1RegtestBroadcastAuthorizationProviderDecision
} from './tm1RegtestBroadcastAuthorizationAdapter'
import {
  Tm1PublicationError,
  Tm1RegtestPublicationOrchestratorImpl,
  type Tm1BroadcastAuthorizationDecision,
  type Tm1BroadcastAuthorizationPort,
  type Tm1Confirmation,
  type Tm1ConfirmationObserverPort,
  type Tm1PreparedReview,
  type Tm1PublicationAuthorizationDecision,
  type Tm1PublicationClock,
  type Tm1PublicationState,
  type Tm1RegtestPublicationDependencies,
  type Tm1RegtestPublicationOrchestrator,
  type Tm1SignedReview,
  type Tm1SubmissionReceipt
} from './tm1RegtestPublicationOrchestrator'
import {
  parseTm1RollbackWitnessSnapshot,
  type Tm1RollbackWitness,
  type Tm1RollbackWitnessEnrollment,
  type Tm1RollbackWitnessRecord,
  type Tm1RollbackWitnessReservation,
  type Tm1RollbackWitnessSnapshot
} from './recovery/tm1RollbackWitness'
import {
  Tm1InMemoryRollbackWitness
} from './recovery/tm1InMemoryRollbackWitness'
import {
  assertTm1DispatchIntentTransition,
  assertTm1ExecutionEvidenceTransition,
  assertTm1OwnershipTransition,
  assertTm1RecoveryTransition,
  assertTm1TransportAcknowledgementTransition,
  consumedCapabilityIds,
  createTm1TransportAcknowledgedRecord,
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord
} from './recovery/tm1PublicationRecoveryModel'
import {
  Tm1PublicationRecoveryStoreError,
  type Tm1PublicationRecoveryStore,
  type Tm1RecoveryStoreCreate,
  type Tm1RecoveryStoreDispatchIntentCommit,
  type Tm1RecoveryStoreExecutionCommit,
  type Tm1RecoveryStoreOwnershipClaim,
  type Tm1RecoveryStoreRecoveryCommit,
  type Tm1RecoveryStoreTransportAcknowledgementCommit
} from './recovery/tm1PublicationRecoveryStore'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from '../../features/externalSign/approval'
import {
  UniversalAuthorizationError
} from '../../features/externalSign/contract'
import type {
  UniversalOperationLease,
  UniversalOperationLock
} from '../../features/externalSign/lock'
import {
  parseCashAddr,
  canonicalizeEcashAddress
} from '../../utils/alias'

export const TM1_PROGRAMMATIC_E2E_FIXTURE_ADDRESS =
  'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'

export const DEFAULT_TM1_PROGRAMMATIC_E2E_MESSAGE =
  'Tonalli Memo TM1 E2E Programmatic Integration'

export function createDefaultFixtureUtxos(
  lockingScriptHex: string = TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  sats: bigint = 100_000n
): readonly Tm1Draft02FreshUtxo[] {
  return Object.freeze([
    Object.freeze({
      txid: '33'.repeat(32),
      outIdx: 0,
      sats,
      lockingScriptHex
    })
  ])
}

export class Tm1HarnessOperationLease implements UniversalOperationLease {
  readonly ownerOperationId: string
  private owned = true
  private readonly onRelease: () => void

  constructor(ownerOperationId: string, onRelease: () => void) {
    this.ownerOperationId = ownerOperationId
    this.onRelease = onRelease
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    if (!this.owned) {
      throw new UniversalAuthorizationError('LEASE_ALREADY_RELEASED')
    }
    this.owned = false
    this.onRelease()
  }
}

export class Tm1HarnessOperationLock implements UniversalOperationLock {
  private activeLease: Tm1HarnessOperationLease | null = null

  async acquire(
    operationId: string,
    signal: AbortSignal
  ): Promise<UniversalOperationLease> {
    if (signal.aborted) {
      throw new UniversalAuthorizationError('OPERATION_ABORTED')
    }
    if (this.activeLease?.isOwned()) {
      throw new UniversalAuthorizationError('OPERATION_ALREADY_ACTIVE')
    }
    const lease = new Tm1HarnessOperationLease(operationId, () => {
      if (this.activeLease === lease) {
        this.activeLease = null
      }
    })
    this.activeLease = lease
    return lease
  }
}

export class Tm1HarnessApprovalLedger implements ApprovalConsumptionLedger {
  private readonly consumed = new Map<string, ApprovalConsumption>()

  async consume(
    consumption: ApprovalConsumption,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      throw new UniversalAuthorizationError('OPERATION_ABORTED')
    }
    if (this.consumed.has(consumption.capabilityId)) {
      throw new UniversalAuthorizationError('APPROVAL_ALREADY_CONSUMED')
    }
    this.consumed.set(consumption.capabilityId, Object.freeze({ ...consumption }))
  }

  getConsumption(capabilityId: string): ApprovalConsumption | undefined {
    return this.consumed.get(capabilityId)
  }

  getAllConsumptions(): readonly ApprovalConsumption[] {
    return Object.freeze(Array.from(this.consumed.values()))
  }
}

export function encodeCanonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonicalJson).join(',')}]`
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('CANONICAL_JSON_ERROR: Object prototype must be Object.prototype or null')
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${encodeCanonicalJson(record[key])}`)
      .join(',')}}`
  }
  throw new Error(`CANONICAL_JSON_ERROR: Unsupported type ${typeof value}`)
}

export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return toHex(sha256(bytes))
}

export function computeCanonicalWholeStoreRoot(input: {
  storeId: string
  slotId: string
  generation: number
  createdAt?: number
  records: readonly Tm1PublicationRecoveryRecord[]
  capabilityIds?: readonly string[]
}): string {
  const sortedRecords = [...input.records]
    .map(r => parseTm1PublicationRecoveryRecord(r))
    .sort((a, b) => a.publicationId.localeCompare(b.publicationId))

  const publications = sortedRecords.map(record => {
    const recordJson = encodeCanonicalJson(record)
    return Object.freeze({
      publicationId: record.publicationId,
      recordJson,
      recordSha256: sha256Hex(recordJson)
    })
  })

  const recordCapabilities = sortedRecords.flatMap(consumedCapabilityIds)
  const rawCapabilities =
    input.capabilityIds !== undefined
      ? [...new Set([...recordCapabilities, ...input.capabilityIds])]
      : recordCapabilities
  const uniqueCapabilities = [...new Set(rawCapabilities)].sort()
  const sortedCapabilities = uniqueCapabilities.map(id =>
    Object.freeze({ capabilityId: id })
  )

  const logicalState = Object.freeze({
    schema: 'tonalli.tm1-logical-state-root',
    schemaVersion: 1,
    witnessProtocolVersion: 1,
    physicalSchemaVersion: 1,
    storeId: input.storeId,
    slotId: input.slotId,
    generation: input.generation,
    createdAt: input.createdAt ?? 0,
    publications: Object.freeze(publications),
    consumedCapabilities: Object.freeze(sortedCapabilities)
  })

  return sha256Hex(encodeCanonicalJson(logicalState))
}

export function extractStoreId(store: Tm1PublicationRecoveryStore): string {
  if (
    'storeId' in store &&
    typeof (store as { storeId?: unknown }).storeId === 'string'
  ) {
    const id = (store as { storeId: string }).storeId
    if (/^tm1-store:v1:[0-9a-f]{64}$/.test(id)) {
      return id
    }
  }
  if (
    'getStoreId' in store &&
    typeof (store as { getStoreId?: unknown }).getStoreId === 'function'
  ) {
    const id = (store as { getStoreId: () => unknown }).getStoreId()
    if (typeof id === 'string' && /^tm1-store:v1:[0-9a-f]{64}$/.test(id)) {
      return id
    }
  }
  return `tm1-store:v1:${sha256Hex('tonalli.tm1-harness-recovery-store:default')}`
}

export function deriveStoreSlotId(storeId: string): string {
  return `slot:${storeId}`
}

export async function isStoreNonEmpty(
  store: Tm1PublicationRecoveryStore
): Promise<boolean> {
  if (
    'getAllRecords' in store &&
    typeof (store as { getAllRecords?: unknown }).getAllRecords === 'function'
  ) {
    const records = (store as { getAllRecords: () => unknown }).getAllRecords()
    if (Array.isArray(records) && records.length > 0) {
      return true
    }
  }
  if ('records' in store && (store as { records?: unknown }).records instanceof Map) {
    if ((store as { records: Map<unknown, unknown> }).records.size > 0) {
      return true
    }
  }
  const recoverable = await store.listRecoverable()
  if (Array.isArray(recoverable) && recoverable.length > 0) {
    return true
  }
  return false
}

export function assertStoreConsistentWithWitnessStableHead(
  localStoreRoot: string,
  stable: Tm1RollbackWitnessRecord
): void {
  if (localStoreRoot !== stable.logicalRoot) {
    throw new Error(
      `STORE_ROLLBACK_DETECTED: Local store canonical root (${localStoreRoot}) does not match witness stable head logical root (${stable.logicalRoot}) at generation ${stable.generation}`
    )
  }
}

export function assertWitnessReservationResponseBinding(
  snapshot: Tm1RollbackWitnessSnapshot,
  request: Tm1RollbackWitnessReservation,
  expectedStable: Tm1RollbackWitnessRecord
): void {
  // Stable head vs last read
  if (
    snapshot.stable.slotId !== expectedStable.slotId ||
    snapshot.stable.storeId !== expectedStable.storeId ||
    snapshot.stable.generation !== expectedStable.generation ||
    snapshot.stable.logicalRoot !== expectedStable.logicalRoot ||
    snapshot.stable.receiptHash !== expectedStable.receiptHash ||
    snapshot.stable.witnessKeyId !== expectedStable.witnessKeyId ||
    snapshot.stable.generation !== request.expectedStableGeneration ||
    snapshot.stable.logicalRoot !== request.expectedStableLogicalRoot ||
    snapshot.stable.receiptHash !== request.expectedStableReceiptHash
  ) {
    throw new Error(
      'WITNESS_RESERVATION_BINDING_MISMATCH: Stable head does not match last read stable record or expected reservation parameters'
    )
  }

  // Pending record slot, store, generation, root and operation ID against request
  if (!snapshot.pending) {
    throw new Error(
      'WITNESS_RESERVATION_MISSING_PENDING: Reservation snapshot must contain pending record'
    )
  }

  const pending = snapshot.pending
  if (pending.slotId !== request.slotId) {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending slotId mismatch (expected ${request.slotId}, got ${pending.slotId})`
    )
  }
  if (pending.storeId !== request.storeId) {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending storeId mismatch (expected ${request.storeId}, got ${pending.storeId})`
    )
  }
  if (pending.generation !== request.nextGeneration) {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending generation mismatch (expected ${request.nextGeneration}, got ${pending.generation})`
    )
  }
  if (pending.logicalRoot !== request.nextLogicalRoot) {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending logicalRoot mismatch (expected ${request.nextLogicalRoot}, got ${pending.logicalRoot})`
    )
  }
  if (pending.operationId !== request.operationId) {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending operationId mismatch (expected ${request.operationId}, got ${pending.operationId})`
    )
  }
  if (pending.previousStableReceiptHash !== request.expectedStableReceiptHash) {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending previousStableReceiptHash mismatch (expected ${request.expectedStableReceiptHash}, got ${pending.previousStableReceiptHash})`
    )
  }
  if (pending.state !== 'pending') {
    throw new Error(
      `WITNESS_RESERVATION_BINDING_MISMATCH: Pending record state must be 'pending', got '${pending.state}'`
    )
  }
}

export function assertWitnessEnrollmentBinding(
  enrolledSnapshot: Tm1RollbackWitnessSnapshot,
  request: {
    slotId: string
    storeId: string
    logicalRoot: string
    operationId: string
  }
): void {
  if (enrolledSnapshot.pending !== null) {
    throw new Error(
      'WITNESS_ENROLLMENT_BINDING_MISMATCH: Enrolled snapshot must have null pending record'
    )
  }
  const stable = enrolledSnapshot.stable
  if (stable.generation !== 0) {
    throw new Error(
      `WITNESS_ENROLLMENT_BINDING_MISMATCH: generation mismatch (expected 0, got ${stable.generation})`
    )
  }
  if (stable.slotId !== request.slotId) {
    throw new Error(
      `WITNESS_ENROLLMENT_BINDING_MISMATCH: slotId mismatch (expected ${request.slotId}, got ${stable.slotId})`
    )
  }
  if (stable.storeId !== request.storeId) {
    throw new Error(
      `WITNESS_ENROLLMENT_BINDING_MISMATCH: storeId mismatch (expected ${request.storeId}, got ${stable.storeId})`
    )
  }
  if (stable.logicalRoot !== request.logicalRoot) {
    throw new Error(
      `WITNESS_ENROLLMENT_BINDING_MISMATCH: logicalRoot mismatch (expected ${request.logicalRoot}, got ${stable.logicalRoot})`
    )
  }
  if (stable.operationId !== request.operationId) {
    throw new Error(
      `WITNESS_ENROLLMENT_BINDING_MISMATCH: operationId mismatch (expected ${request.operationId}, got ${stable.operationId})`
    )
  }
}

export function assertWitnessFinalizationBinding(
  finalizedSnapshot: Tm1RollbackWitnessSnapshot,
  pendingReservation: Tm1RollbackWitnessRecord
): void {
  if (finalizedSnapshot.pending !== null) {
    throw new Error(
      'WITNESS_FINALIZATION_MISMATCH: Finalized snapshot must have null pending record'
    )
  }
  const stable = finalizedSnapshot.stable
  if (stable.slotId !== pendingReservation.slotId) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: slotId mismatch (expected ${pendingReservation.slotId}, got ${stable.slotId})`
    )
  }
  if (stable.storeId !== pendingReservation.storeId) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: storeId mismatch (expected ${pendingReservation.storeId}, got ${stable.storeId})`
    )
  }
  if (stable.generation !== pendingReservation.generation) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: generation mismatch (expected ${pendingReservation.generation}, got ${stable.generation})`
    )
  }
  if (stable.logicalRoot !== pendingReservation.logicalRoot) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: logicalRoot mismatch (expected ${pendingReservation.logicalRoot}, got ${stable.logicalRoot})`
    )
  }
  if (stable.operationId !== pendingReservation.operationId) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: operationId mismatch (expected ${pendingReservation.operationId}, got ${stable.operationId})`
    )
  }
  if (
    stable.previousStableReceiptHash !==
    pendingReservation.previousStableReceiptHash
  ) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: previousStableReceiptHash mismatch (expected ${pendingReservation.previousStableReceiptHash}, got ${stable.previousStableReceiptHash})`
    )
  }
  if (stable.witnessKeyId !== pendingReservation.witnessKeyId) {
    throw new Error(
      `WITNESS_FINALIZATION_MISMATCH: witnessKeyId mismatch (expected ${pendingReservation.witnessKeyId}, got ${stable.witnessKeyId})`
    )
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') {
    return false
  }
  const keysA = Object.keys(a as object)
  const keysB = Object.keys(b as object)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    ) {
      return false
    }
  }
  return true
}

export function assertTm1CommittedDispatchIntentBinding(input: {
  committedRecord: Tm1PublicationRecoveryRecord
  publicationId: string
  expectedRevision: number
  expectedOwnerEpoch: number
  preparedReview: Tm1PreparedReview
  signedReview: Tm1SignedReview
  signingGrant: ApprovalConsumption
  broadcastGrant: ApprovalConsumption
  submissionId: string
  expectedCommittedAt?: number
  expectedRecord?: Tm1PublicationRecoveryRecord
}): void {
  const {
    committedRecord,
    publicationId,
    expectedRevision,
    expectedOwnerEpoch,
    preparedReview,
    signedReview,
    signingGrant,
    broadcastGrant,
    submissionId,
    expectedCommittedAt,
    expectedRecord
  } = input

  if (committedRecord.publicationId !== publicationId) {
    throw new Error(
      `INVALID_DISPATCH_INTENT_RECORD: Publication ID mismatch (expected ${publicationId}, got ${committedRecord.publicationId})`
    )
  }
  if (committedRecord.revision !== expectedRevision) {
    throw new Error(
      `INVALID_DISPATCH_INTENT_RECORD: Revision mismatch (expected ${expectedRevision}, got ${committedRecord.revision})`
    )
  }
  if (committedRecord.ownerEpoch !== expectedOwnerEpoch) {
    throw new Error(
      `INVALID_DISPATCH_INTENT_RECORD: Owner epoch mismatch (expected ${expectedOwnerEpoch}, got ${committedRecord.ownerEpoch})`
    )
  }
  if (committedRecord.phase !== 'outcomeUnknown') {
    throw new Error(
      `INVALID_DISPATCH_INTENT_RECORD: Phase mismatch (expected 'outcomeUnknown', got '${committedRecord.phase}')`
    )
  }
  if (
    !committedRecord.prepared ||
    committedRecord.prepared.preparedId !== preparedReview.preparedId ||
    committedRecord.prepared.bindingHash !== preparedReview.bindingHash
  ) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Prepared evidence mismatch')
  }
  if (
    !committedRecord.signed ||
    committedRecord.signed.signedId !== signedReview.signedId ||
    committedRecord.signed.txid !== signedReview.txid ||
    committedRecord.signed.signedArtifactHash !== signedReview.signedArtifactHash
  ) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Signed evidence mismatch')
  }

  // Strict deep verification of signing authorization fields (Finding 3)
  if (
    !committedRecord.signingAuthorization ||
    committedRecord.signingAuthorization.capabilityId !== signingGrant.capabilityId ||
    committedRecord.signingAuthorization.operationId !== signingGrant.operationId ||
    committedRecord.signingAuthorization.preparedId !== preparedReview.preparedId ||
    committedRecord.signingAuthorization.bindingHash !== preparedReview.bindingHash ||
    committedRecord.signingAuthorization.contentHash !== signingGrant.contentHash ||
    committedRecord.signingAuthorization.expiresAt !== signingGrant.expiresAt ||
    committedRecord.signingAuthorization.consumedAt !== signingGrant.consumedAt
  ) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Signing authorization evidence mismatch')
  }
  const expectedSigningAuth = {
    operationId: signingGrant.operationId,
    capabilityId: signingGrant.capabilityId,
    contentHash: signingGrant.contentHash,
    expiresAt: signingGrant.expiresAt,
    consumedAt: signingGrant.consumedAt,
    preparedId: preparedReview.preparedId,
    bindingHash: preparedReview.bindingHash
  }
  if (!deepEqual(committedRecord.signingAuthorization, expectedSigningAuth)) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Signing authorization deep equality mismatch')
  }

  // Strict deep verification of broadcast authorization fields (Finding 3)
  if (
    !committedRecord.broadcastAuthorization ||
    committedRecord.broadcastAuthorization.capabilityId !== broadcastGrant.capabilityId ||
    committedRecord.broadcastAuthorization.operationId !== broadcastGrant.operationId ||
    committedRecord.broadcastAuthorization.signedId !== signedReview.signedId ||
    committedRecord.broadcastAuthorization.txid !== signedReview.txid ||
    committedRecord.broadcastAuthorization.signedArtifactHash !== signedReview.signedArtifactHash ||
    committedRecord.broadcastAuthorization.contentHash !== broadcastGrant.contentHash ||
    committedRecord.broadcastAuthorization.expiresAt !== broadcastGrant.expiresAt ||
    committedRecord.broadcastAuthorization.consumedAt !== broadcastGrant.consumedAt
  ) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Broadcast authorization evidence mismatch')
  }
  const expectedBroadcastAuth = {
    operationId: broadcastGrant.operationId,
    capabilityId: broadcastGrant.capabilityId,
    contentHash: broadcastGrant.contentHash,
    expiresAt: broadcastGrant.expiresAt,
    consumedAt: broadcastGrant.consumedAt,
    signedId: signedReview.signedId,
    txid: signedReview.txid,
    signedArtifactHash: signedReview.signedArtifactHash
  }
  if (!deepEqual(committedRecord.broadcastAuthorization, expectedBroadcastAuth)) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Broadcast authorization deep equality mismatch')
  }

  // Dispatch intent evidence and committedAt precision validation (Finding 3)
  if (
    !committedRecord.dispatchIntent ||
    committedRecord.dispatchIntent.submissionId !== submissionId ||
    committedRecord.dispatchIntent.txid !== signedReview.txid ||
    committedRecord.dispatchIntent.signedArtifactHash !== signedReview.signedArtifactHash ||
    committedRecord.dispatchIntent.broadcastCapabilityId !== broadcastGrant.capabilityId ||
    !Number.isSafeInteger(committedRecord.dispatchIntent.committedAt) ||
    committedRecord.dispatchIntent.committedAt <= 0
  ) {
    throw new Error('INVALID_DISPATCH_INTENT_RECORD: Dispatch intent evidence mismatch')
  }
  if (
    expectedCommittedAt !== undefined &&
    committedRecord.dispatchIntent.committedAt !== expectedCommittedAt
  ) {
    throw new Error(
      `INVALID_DISPATCH_INTENT_RECORD: Dispatch intent committedAt mismatch (expected ${expectedCommittedAt}, got ${committedRecord.dispatchIntent.committedAt})`
    )
  }

  if (
    expectedRecord !== undefined &&
    !deepEqual(committedRecord, expectedRecord)
  ) {
    throw new Error(
      'INVALID_DISPATCH_INTENT_RECORD: Committed record deep equality mismatch against expected record'
    )
  }
}

export class Tm1HarnessRecoveryStore implements Tm1PublicationRecoveryStore {
  readonly storeId: string
  readonly createdAt: number
  private readonly records = new Map<string, Tm1PublicationRecoveryRecord>()
  private readonly capabilityIds = new Set<string>()
  private witnessBinding: {
    slotId: string
    storeId: string
    generation: number
    logicalRoot: string
  } | null = null

  constructor(
    storeIdOrRecord?: string | Tm1PublicationRecoveryRecord,
    ...remainingRecords: readonly Tm1PublicationRecoveryRecord[]
  ) {
    this.createdAt = Date.now()
    if (typeof storeIdOrRecord === 'string') {
      this.storeId = storeIdOrRecord
      for (const record of remainingRecords) {
        this.insertInitial(record)
      }
    } else {
      this.storeId = `tm1-store:v1:${sha256Hex(`tm1-harness-recovery-store:${this.createdAt}`)}`
      if (storeIdOrRecord) {
        this.insertInitial(storeIdOrRecord)
      }
      for (const record of remainingRecords) {
        this.insertInitial(record)
      }
    }
  }

  getStoreId(): string {
    return this.storeId
  }

  getAllRecords(): readonly Tm1PublicationRecoveryRecord[] {
    return Object.freeze([...this.records.values()])
  }

  getAllCapabilityIds(): readonly string[] {
    return Object.freeze([...this.capabilityIds.values()])
  }

  inspectWitnessBinding(): {
    slotId: string
    storeId: string
    generation: number
    logicalRoot: string
  } | null {
    return this.witnessBinding ? { ...this.witnessBinding } : null
  }

  computeEnrollmentLogicalRoot(identity: {
    slotId: string
    storeId: string
  }): string {
    return computeCanonicalWholeStoreRoot({
      storeId: identity.storeId ?? this.storeId,
      slotId: identity.slotId,
      generation: 0,
      createdAt: this.createdAt,
      records: [...this.records.values()],
      capabilityIds: [...this.capabilityIds]
    })
  }

  enrollWitnessBinding(binding: {
    slotId: string
    storeId: string
    logicalRoot: string
  }): void {
    if (this.witnessBinding !== null) {
      throw new Error('ALREADY_ENROLLED: Witness binding already enrolled')
    }
    const expectedRoot = this.computeEnrollmentLogicalRoot(binding)
    if (binding.logicalRoot !== expectedRoot) {
      throw new Error(
        `ENROLLMENT_ROOT_MISMATCH: Provided logicalRoot ${binding.logicalRoot} does not match expected ${expectedRoot}`
      )
    }
    this.witnessBinding = Object.freeze({
      slotId: binding.slotId,
      storeId: binding.storeId,
      generation: 0,
      logicalRoot: binding.logicalRoot
    })
  }

  computeProjectedWitnessLogicalRoot(
    projectedRecord: Tm1PublicationRecoveryRecord,
    generation?: number
  ): string {
    const effectiveRecords = [
      ...[...this.records.values()].filter(
        r => r.publicationId !== projectedRecord.publicationId
      ),
      projectedRecord
    ]
    const storeCapabilities = [...this.capabilityIds]
    const recordCapabilities = effectiveRecords.flatMap(consumedCapabilityIds)
    const mergedCapabilities = [
      ...new Set([...storeCapabilities, ...recordCapabilities])
    ]
    const gen =
      typeof generation === 'number'
        ? generation
        : this.witnessBinding
          ? this.witnessBinding.generation + 1
          : 1

    return computeCanonicalWholeStoreRoot({
      storeId: this.storeId,
      slotId: deriveStoreSlotId(this.storeId),
      generation: gen,
      createdAt: this.createdAt,
      records: effectiveRecords,
      capabilityIds: mergedCapabilities
    })
  }

  computeWitnessLogicalRoot(generation: number): string {
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    ) {
      throw new Error(
        `INVALID_GENERATION: computeWitnessLogicalRoot expects non-negative safe integer generation, got ${typeof generation} (${generation})`
      )
    }
    return computeCanonicalWholeStoreRoot({
      storeId: this.storeId,
      slotId: deriveStoreSlotId(this.storeId),
      generation,
      createdAt: this.createdAt,
      records: [...this.records.values()],
      capabilityIds: [...this.capabilityIds]
    })
  }

  async load(publicationId: string): Promise<unknown | null> {
    return this.records.get(publicationId) ?? null
  }

  async listRecoverable(): Promise<unknown> {
    return [...this.records.values()]
  }

  async create(input: Tm1RecoveryStoreCreate): Promise<unknown> {
    const record = parseTm1PublicationRecoveryRecord(input.record)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
    return record
  }

  async commitExecutionEvidence(
    input: Tm1RecoveryStoreExecutionCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1ExecutionEvidenceTransition(current, next)
    const expectedNew = consumedCapabilityIds(next).filter(
      id => !consumedCapabilityIds(current).includes(id)
    )
    this.reserveCapabilities(expectedNew)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitDispatchIntent(
    input: Tm1RecoveryStoreDispatchIntentCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1DispatchIntentTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitTransportAcknowledgement(
    input: Tm1RecoveryStoreTransportAcknowledgementCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = createTm1TransportAcknowledgedRecord(
      current,
      input.acknowledgement
    )
    assertTm1TransportAcknowledgementTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async commitRecoveryTransition(
    input: Tm1RecoveryStoreRecoveryCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1RecoveryTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  async claimOwnership(
    input: Tm1RecoveryStoreOwnershipClaim
  ): Promise<unknown> {
    const current = this.current(input)
    if (
      !Number.isSafeInteger(input.nextOwnerEpoch) ||
      input.nextOwnerEpoch <= current.ownerEpoch
    ) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    const next = parseTm1PublicationRecoveryRecord({
      ...current,
      revision: current.revision + 1,
      ownerEpoch: input.nextOwnerEpoch
    })
    assertTm1OwnershipTransition(current, next)
    this.records.set(current.publicationId, next)
    return next
  }

  private insertInitial(recordValue: Tm1PublicationRecoveryRecord): void {
    const record = parseTm1PublicationRecoveryRecord(recordValue)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
  }

  private current(input: {
    publicationId: string
    expectedRevision: number
    expectedOwnerEpoch: number
  }): Tm1PublicationRecoveryRecord {
    const current = this.records.get(input.publicationId)
    if (!current) {
      throw new Tm1PublicationRecoveryStoreError('PUBLICATION_NOT_FOUND')
    }
    if (current.revision !== input.expectedRevision) {
      throw new Tm1PublicationRecoveryStoreError('REVISION_MISMATCH')
    }
    if (current.ownerEpoch !== input.expectedOwnerEpoch) {
      throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
    }
    return current
  }

  private reserveCapabilities(capabilityIds: readonly string[]): void {
    for (const capabilityId of capabilityIds) {
      if (this.capabilityIds.has(capabilityId)) {
        throw new Tm1PublicationRecoveryStoreError('DUPLICATE_CAPABILITY_CONSUMPTION')
      }
    }
    for (const capabilityId of capabilityIds) {
      this.capabilityIds.add(capabilityId)
    }
  }
}

export type Tm1ProgrammaticE2eOptions = Readonly<{
  alias?: string
  ownerAddress?: string
  message?: string
  maxFeeSats?: bigint
  verificationPort?: Tm1AliasOwnershipVerificationPort
  aliasAuthorizer?: Tm1AliasPublicationAuthorizer
  witness?: Tm1RollbackWitness
  recoveryStore?: Tm1PublicationRecoveryStore
  utxos?: readonly Tm1Draft02FreshUtxo[]
  activeLockingScriptHex?: string
  signingDecisionProvider?: Tm1RegtestAuthorizationDecisionProvider
  broadcastDecisionProvider?: Tm1RegtestBroadcastAuthorizationDecisionProvider
  deliveryTransport?: Tm1RegtestDeliveryTransport
  confirmationObserver?: Tm1ConfirmationObserverPort
  signal?: AbortSignal
}>

export type Tm1ProgrammaticE2eStepResults = Readonly<{
  verifiedAliasEvidenceToken: object
  verifiedAliasSnapshot: Tm1VerifiedAliasOwnershipSnapshot
  aliasPublicationAuthorization: Tm1AliasPublicationAuthorization
  memoPreview: Tm1Draft02PostPreview
  candidate: Tm1Draft02Candidate
  unsignedTransactionBytes: Uint8Array
  unsignedTransactionAudit: AuditedTm1Draft02UnsignedTransaction
  preparedReview: Tm1PreparedReview
  signingAuthorizationDecision: Tm1PublicationAuthorizationDecision
  signedReview: Tm1SignedReview
  witnessReservationSnapshot: Tm1RollbackWitnessSnapshot
  witnessFinalizedDispatchSnapshot?: Tm1RollbackWitnessSnapshot
  witnessAcknowledgementSnapshot?: Tm1RollbackWitnessSnapshot
  dispatchIntentRecord: Tm1PublicationRecoveryRecord
  submissionReceipt: Tm1SubmissionReceipt
  dispatchCount: number
  transportAcknowledgedRecord: Tm1PublicationRecoveryRecord
  finalOrchestratorState: Tm1PublicationState
  confirmedReceipt?: Tm1Confirmation
}>

export type Tm1ProgrammaticE2eResult = Readonly<{
  success: true
  alias: string
  ownerAddress: string
  txid: string
  submissionId: string
  steps: Tm1ProgrammaticE2eStepResults
}>

export class Tm1RegtestE2eHarness {
  readonly alias: string
  readonly ownerAddress: string
  readonly message: string
  readonly maxFeeSats: bigint
  readonly activeLockingScriptHex: string
  readonly utxos: readonly Tm1Draft02FreshUtxo[]
  readonly verificationPort: Tm1AliasOwnershipVerificationPort
  readonly aliasAuthorizer: Tm1AliasPublicationAuthorizer
  readonly witness: Tm1RollbackWitness
  readonly recoveryStore: Tm1PublicationRecoveryStore
  readonly deliveryTransport: Tm1RegtestDeliveryTransport
  readonly orchestrator: Tm1RegtestPublicationOrchestrator & {
    getSignedReview?(preparedId?: string): Tm1SignedReview | null
  }
  readonly ledger: Tm1HarnessApprovalLedger
  readonly broadcastAuthorizationPort: Tm1BroadcastAuthorizationPort
  private dispatchCalls = 0
  private plannedSubmissionId: string | null = null
  private cachedBroadcastDecision: Extract<
    Tm1BroadcastAuthorizationDecision,
    { status: 'approved' }
  > | null = null

  constructor(options: Tm1ProgrammaticE2eOptions = {}) {
    this.alias = options.alias ?? 'satoshi.xec'
    this.ownerAddress = options.ownerAddress ?? TM1_PROGRAMMATIC_E2E_FIXTURE_ADDRESS
    this.message = options.message ?? DEFAULT_TM1_PROGRAMMATIC_E2E_MESSAGE
    this.maxFeeSats = options.maxFeeSats ?? 10_000n
    this.activeLockingScriptHex =
      options.activeLockingScriptHex ?? TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
    this.utxos = options.utxos ?? createDefaultFixtureUtxos(this.activeLockingScriptHex)

    this.verificationPort =
      options.verificationPort ?? createTm1AliasOwnershipVerificationPort()
    this.aliasAuthorizer =
      options.aliasAuthorizer ?? createTm1AliasPublicationAuthorizer()
    this.witness = options.witness ?? new Tm1InMemoryRollbackWitness()
    this.recoveryStore = options.recoveryStore ?? new Tm1HarnessRecoveryStore()

    const rawTransport =
      options.deliveryTransport ?? new Tm1InMemoryDeliveryTransport()
    this.deliveryTransport = Object.freeze({
      attestNetwork: (sig?: AbortSignal) => rawTransport.attestNetwork(sig),
      submit: async (artifact: RegtestSignedTransaction, sig?: AbortSignal) => {
        this.dispatchCalls += 1
        return rawTransport.submit(artifact, sig)
      }
    })

    const lock = new Tm1HarnessOperationLock()
    const ledger = new Tm1HarnessApprovalLedger()
    this.ledger = ledger

    const signingDecisionProvider: Tm1RegtestAuthorizationDecisionProvider =
      options.signingDecisionProvider ?? {
        requestDecision: async (): Promise<Tm1RegtestAuthorizationProviderDecision> => ({
          status: 'approved'
        })
      }

    const broadcastDecisionProvider: Tm1RegtestBroadcastAuthorizationDecisionProvider =
      options.broadcastDecisionProvider ?? {
        requestDecision: async (): Promise<Tm1RegtestBroadcastAuthorizationProviderDecision> => ({
          status: 'approved'
        })
      }

    let opSeq = 0
    const dualPorts = createTm1RegtestDualAuthorizationPorts({
      core: {
        enabled: true,
        lock,
        approvalLedger: ledger
      },
      now: () => Date.now(),
      createOperationIdSuffix: () => `e2e-op-${++opSeq}`,
      signing: {
        decisionProvider: signingDecisionProvider,
        ttlMs: 300_000,
        requester: {
          declaredOrigin: 'https://wallet.tonalli.app',
          displayName: 'Tonalli Wallet E2E'
        }
      },
      broadcast: {
        decisionProvider: broadcastDecisionProvider,
        ttlMs: 300_000,
        requester: {
          declaredOrigin: 'https://wallet.tonalli.app',
          displayName: 'Tonalli Wallet E2E'
        }
      }
    })

    this.broadcastAuthorizationPort = dualPorts.broadcastAuthorization

    const clock: Tm1PublicationClock = {
      createId: (prefix: 'prepared' | 'signed' | 'submission') => {
        if (prefix === 'submission' && this.plannedSubmissionId !== null) {
          const id = this.plannedSubmissionId
          this.plannedSubmissionId = null
          return id
        }
        const uuid =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
        return `${prefix}-e2e-${uuid}`
      }
    }

    const confirmationObserver: Tm1ConfirmationObserverPort =
      options.confirmationObserver ?? {
        confirm: async ({ submissionId, txid, signal }) => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return {
            submissionId,
            txid,
            confirmations: 1,
            blockHeight: 800_001,
            confirmedAt: Date.now()
          }
        }
      }

    const orchestratorDeps: Tm1RegtestPublicationDependencies = {
      networkAttestation: {
        attest: async (signal?: AbortSignal): Promise<Tm1RegtestNetworkAttestation> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return this.deliveryTransport.attestNetwork(signal)
        }
      },
      utxoProvider: {
        readUtxos: async (
          signal?: AbortSignal
        ): Promise<readonly Tm1Draft02FundingUtxo[]> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return this.utxos
        }
      },
      signingAuthorization: dualPorts.signingAuthorization,
      signer: {
        sign: async (
          review: Tm1PreparedReview,
          signal?: AbortSignal
        ): Promise<RegtestSignedTransaction> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          return signTm1Draft02RegtestCandidate({
            candidate: review.candidate,
            signal
          })
        }
      },
      signedArtifactAudit: {
        auditSignedArtifact: async (input: Readonly<{
          review: Tm1PreparedReview
          signedArtifact: RegtestSignedTransaction
          signal?: AbortSignal
        }>): Promise<RegtestSignedTransaction> => {
          if (input.signal?.aborted) throw new Tm1PublicationError('ABORTED')
          auditTm1Draft02RegtestSignedTransaction({
            candidate: input.review.candidate,
            signedTransaction: Tx.fromHex(input.signedArtifact.rawTransactionHex)
          })
          return input.signedArtifact
        }
      },
      broadcastAuthorization: {
        requestBroadcastAuthorization: async (
          signedReview: Tm1SignedReview,
          signal?: AbortSignal
        ): Promise<Tm1BroadcastAuthorizationDecision> => {
          if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
          if (
            this.cachedBroadcastDecision &&
            this.cachedBroadcastDecision.signedId === signedReview.signedId &&
            this.cachedBroadcastDecision.txid === signedReview.txid &&
            this.cachedBroadcastDecision.signedArtifactHash === signedReview.signedArtifactHash
          ) {
            const decision = this.cachedBroadcastDecision
            this.cachedBroadcastDecision = null
            return decision
          }
          return this.broadcastAuthorizationPort.requestBroadcastAuthorization(
            signedReview,
            signal
          )
        }
      },
      deliveryTransport: {
        broadcast: async (
          artifact: RegtestSignedTransaction
        ): Promise<Tm1RegtestDeliveryReceipt> => {
          return this.deliveryTransport.submit(artifact)
        }
      },
      confirmationObserver,
      clock
    }

    const orchestratorImpl = new Tm1RegtestPublicationOrchestratorImpl(orchestratorDeps)
    this.orchestrator = Object.assign(orchestratorImpl, {
      getSignedReview: (preparedId?: string): Tm1SignedReview | null => {
        const state = orchestratorImpl.getState()
        if (state.status === 'signedReviewReady') {
          if (preparedId && state.signedReview.preparedId !== preparedId) {
            return null
          }
          return state.signedReview
        }
        return null
      }
    })
  }

  getDispatchCount(): number {
    return this.dispatchCalls
  }

  getStoreId(): string {
    return extractStoreId(this.recoveryStore)
  }

  getSlotId(): string {
    return deriveStoreSlotId(this.getStoreId())
  }

  async isStoreNonEmpty(): Promise<boolean> {
    return isStoreNonEmpty(this.recoveryStore)
  }

  async getStoreCapabilityIds(): Promise<string[]> {
    if (
      'getAllCapabilityIds' in this.recoveryStore &&
      typeof (this.recoveryStore as { getAllCapabilityIds?: unknown })
        .getAllCapabilityIds === 'function'
    ) {
      const caps = (
        this.recoveryStore as { getAllCapabilityIds: () => unknown }
      ).getAllCapabilityIds()
      if (Array.isArray(caps)) {
        return [...new Set(caps.filter((c): c is string => typeof c === 'string'))]
      }
    }
    const list = await this.recoveryStore.listRecoverable()
    if (Array.isArray(list)) {
      const parsed = list.map(r => parseTm1PublicationRecoveryRecord(r))
      return [...new Set(parsed.flatMap(consumedCapabilityIds))]
    }
    return []
  }

  async deriveStoreRoot(input: {
    slotId: string
    generation: number
    storeId: string
    projectedRecord?: Tm1PublicationRecoveryRecord
    projectedCapabilities?: readonly string[]
  }): Promise<string> {
    if (
      input.projectedRecord &&
      'computeProjectedWitnessLogicalRoot' in this.recoveryStore &&
      typeof (this.recoveryStore as { computeProjectedWitnessLogicalRoot?: unknown })
        .computeProjectedWitnessLogicalRoot === 'function'
    ) {
      return (
        this.recoveryStore as {
          computeProjectedWitnessLogicalRoot: (
            projectedRecord: Tm1PublicationRecoveryRecord,
            generation?: number
          ) => string
        }
      ).computeProjectedWitnessLogicalRoot(input.projectedRecord, input.generation)
    }

    if (
      !input.projectedRecord &&
      (!input.projectedCapabilities || input.projectedCapabilities.length === 0)
    ) {
      if (
        input.generation === 0 &&
        'computeEnrollmentLogicalRoot' in this.recoveryStore &&
        typeof (this.recoveryStore as { computeEnrollmentLogicalRoot?: unknown })
          .computeEnrollmentLogicalRoot === 'function' &&
        (!('inspectWitnessBinding' in this.recoveryStore) ||
          (this.recoveryStore as { inspectWitnessBinding?: () => unknown }).inspectWitnessBinding?.() === null)
      ) {
        return (
          this.recoveryStore as {
            computeEnrollmentLogicalRoot: (arg: { slotId: string; storeId: string }) => string
          }
        ).computeEnrollmentLogicalRoot({ slotId: input.slotId, storeId: input.storeId })
      }

      if (
        'computeWitnessLogicalRoot' in this.recoveryStore &&
        typeof (this.recoveryStore as { computeWitnessLogicalRoot?: unknown })
          .computeWitnessLogicalRoot === 'function'
      ) {
        return (
          this.recoveryStore as {
            computeWitnessLogicalRoot: (generation: number) => string
          }
        ).computeWitnessLogicalRoot(input.generation)
      }
    }
    const list = await this.recoveryStore.listRecoverable()
    const records = Array.isArray(list)
      ? list.map(r => parseTm1PublicationRecoveryRecord(r))
      : []
    const effectiveRecords = input.projectedRecord
      ? [
          ...records.filter(
            r => r.publicationId !== input.projectedRecord!.publicationId
          ),
          input.projectedRecord
        ]
      : records
    const storeCapabilities = await this.getStoreCapabilityIds()
    const recordCapabilities = effectiveRecords.flatMap(consumedCapabilityIds)
    const mergedCapabilities = [
      ...new Set([
        ...storeCapabilities,
        ...recordCapabilities,
        ...(input.projectedCapabilities ?? [])
      ])
    ]
    const createdAt =
      'createdAt' in this.recoveryStore &&
      typeof (this.recoveryStore as { createdAt?: unknown }).createdAt === 'number'
        ? (this.recoveryStore as { createdAt: number }).createdAt
        : 0
    return computeCanonicalWholeStoreRoot({
      storeId: input.storeId,
      slotId: input.slotId,
      generation: input.generation,
      createdAt,
      records: effectiveRecords,
      capabilityIds: mergedCapabilities
    })
  }

  /**
   * Step 1: Resolver un alias .xec simulado y observar el ownership a traves de tm1AliasOwnershipVerificationPort.
   */
  async executeStep1VerifyAlias(signal?: AbortSignal): Promise<object> {
    if (signal !== undefined) {
      return this.verificationPort.verify({
        alias: this.alias,
        ownerAddress: this.ownerAddress,
        signal
      })
    }
    return this.verificationPort.verify({
      alias: this.alias,
      ownerAddress: this.ownerAddress
    })
  }

  /**
   * Step 2: Producir la VerifiedAliasOwnershipEvidence.
   */
  executeStep2ProduceEvidence(evidenceToken: object): Tm1VerifiedAliasOwnershipSnapshot {
    const snapshot = lookupTm1VerifiedAliasOwnershipToken(evidenceToken)
    if (!snapshot) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_EVIDENCE_UNTRUSTED')
    }
    if (snapshot.alias !== this.alias) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_EVIDENCE_UNTRUSTED')
    }
    if (snapshot.address !== this.ownerAddress) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_EVIDENCE_UNTRUSTED')
    }
    return snapshot
  }

  /**
   * Step 3: Pasar la evidencia verificada al autorizador (tm1AliasPublicationAuthorization).
   */
  executeStep3AuthorizePublication(
    evidenceToken: object
  ): Tm1AliasPublicationAuthorization {
    return this.aliasAuthorizer.issue({
      alias: this.alias,
      ownerAddress: this.ownerAddress,
      evidence: evidenceToken
    })
  }

  /**
   * Step 4: Preparar el memo TM1 canonico y la transaccion sin firmar (unsigned tx).
   */
  async executeStep4PrepareMemoAndUnsignedTx(
    ownerAddressOrEvidence?:
      | string
      | Tm1VerifiedAliasOwnershipSnapshot
      | Tm1AliasPublicationAuthorization
      | AbortSignal,
    signal?: AbortSignal
  ): Promise<{
    memoPreview: Tm1Draft02PostPreview
    candidate: Tm1Draft02Candidate
    unsignedTransactionBytes: Uint8Array
    unsignedTransactionAudit: AuditedTm1Draft02UnsignedTransaction
    preparedReview: Tm1PreparedReview
  }> {
    let effectiveSignal: AbortSignal | undefined = signal
    let ownerInput:
      | string
      | Tm1VerifiedAliasOwnershipSnapshot
      | Tm1AliasPublicationAuthorization
      | undefined

    if (ownerAddressOrEvidence instanceof AbortSignal) {
      effectiveSignal = ownerAddressOrEvidence
      ownerInput = undefined
    } else {
      ownerInput = ownerAddressOrEvidence
    }

    let rawOwnerAddress: string
    if (typeof ownerInput === 'string') {
      rawOwnerAddress = ownerInput
    } else if (ownerInput && 'address' in ownerInput) {
      rawOwnerAddress = ownerInput.address
    } else if (ownerInput && 'ownerAddress' in ownerInput) {
      rawOwnerAddress = ownerInput.ownerAddress
    } else {
      rawOwnerAddress = this.ownerAddress
    }

    const canonicalOwner = canonicalizeEcashAddress(rawOwnerAddress)
    if (!canonicalOwner) {
      throw new Error(`INVALID_OWNER_ADDRESS: ${rawOwnerAddress}`)
    }

    let ownerScriptHex: string
    try {
      ownerScriptHex = parseCashAddr(canonicalOwner).toScriptHex()
    } catch (err) {
      throw new Error(`FAILED_TO_DERIVE_SCRIPT: ${String(err)}`)
    }

    if (ownerScriptHex !== this.activeLockingScriptHex) {
      throw new Error(
        `AUTHOR_OWNER_BINDING_MISMATCH: Verified owner address ${canonicalOwner} (script: ${ownerScriptHex}) does not match author locking script ${this.activeLockingScriptHex}`
      )
    }

    const memoPreview = encodeTm1Draft02Post({
      eventData: this.message,
      authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
    })

    const preparedReview = await this.orchestrator.prepare(
      {
        message: this.message,
        activeLockingScriptHex: this.activeLockingScriptHex,
        maxFeeSats: this.maxFeeSats
      },
      effectiveSignal
    )

    if (preparedReview.candidate.authorLockingScriptHex !== ownerScriptHex) {
      throw new Error(
        `AUTHOR_OWNER_BINDING_MISMATCH: Prepared candidate author locking script ${preparedReview.candidate.authorLockingScriptHex} does not match verified owner script ${ownerScriptHex}`
      )
    }

    const candidate = preparedReview.candidate
    const unsignedTransactionBytes = serializeTm1Draft02UnsignedTransaction(candidate)
    const unsignedTransactionAudit = auditTm1Draft02UnsignedTransaction({
      effectiveContent: preparedReview.effectiveContent,
      unsignedTransactionBytes
    })

    return {
      memoPreview,
      candidate,
      unsignedTransactionBytes,
      unsignedTransactionAudit,
      preparedReview
    }
  }

  /**
   * Step 5: Ejecutar la autorizacion dual (dual authorization).
   */
  async executeStep5DualAuthorizeAndSign(
    preparedReview: Tm1PreparedReview,
    signal?: AbortSignal
  ): Promise<{
    signedReview: Tm1SignedReview
    signingAuthorizationDecision: Tm1PublicationAuthorizationDecision
  }> {
    if (preparedReview.candidate.authorLockingScriptHex !== this.activeLockingScriptHex) {
      throw new Error(
        `AUTHOR_LOCKING_SCRIPT_MISMATCH: Candidate author locking script ${preparedReview.candidate.authorLockingScriptHex} does not match active locking script ${this.activeLockingScriptHex}`
      )
    }

    const signedReview = await this.orchestrator.authorizeAndSign(
      preparedReview.preparedId,
      signal
    )

    const signingAuthorizationDecision: Tm1PublicationAuthorizationDecision =
      Object.freeze({
        status: 'approved',
        authorizationId: signedReview.signingAuthorizationId,
        preparedId: preparedReview.preparedId,
        bindingHash: preparedReview.bindingHash
      })

    return {
      signedReview,
      signingAuthorizationDecision
    }
  }

  /**
   * Step 6: Ejecutar la reserva de recuperacion (recovery reservation), validar la respuesta,
   * asentar duraderamente el intent en el recoveryStore, validar el intent devuelto,
   * asentar (finalize) el checkpoint del witness ANTES de la llamada de transporte,
   * y realizar exactamente un despacho (exactly-once dispatch) a traves del Orquestador.
   */
  async executeStep6ReserveRecoveryAndDispatch(
    preparedReview: Tm1PreparedReview,
    signedReview: Tm1SignedReview,
    signal?: AbortSignal
  ): Promise<{
    witnessReservationSnapshot: Tm1RollbackWitnessSnapshot
    witnessFinalizedDispatchSnapshot: Tm1RollbackWitnessSnapshot
    dispatchIntentRecord: Tm1PublicationRecoveryRecord
    submissionReceipt: Tm1SubmissionReceipt
  }> {
    // 0. Bind Step 6 inputs: deep-compare signedReview with orchestrator internal signedReview (Finding 1)
    const orchState = this.orchestrator.getState()
    const internalSignedReview =
      typeof this.orchestrator.getSignedReview === 'function'
        ? this.orchestrator.getSignedReview(preparedReview.preparedId)
        : orchState.status === 'signedReviewReady' &&
          orchState.signedReview.preparedId === preparedReview.preparedId
          ? orchState.signedReview
          : null

    if (!internalSignedReview) {
      throw new Error(
        `SIGNED_REVIEW_MISMATCH: No active signed review found in orchestrator for preparedId ${preparedReview.preparedId}`
      )
    }

    if (signedReview.preparedId !== internalSignedReview.preparedId) {
      throw new Error(
        `SIGNED_REVIEW_MISMATCH: preparedId mismatch (expected ${internalSignedReview.preparedId}, got ${signedReview.preparedId})`
      )
    }
    if (signedReview.bindingHash !== internalSignedReview.bindingHash) {
      throw new Error(
        `SIGNED_REVIEW_MISMATCH: bindingHash mismatch (expected ${internalSignedReview.bindingHash}, got ${signedReview.bindingHash})`
      )
    }
    if (signedReview.signedArtifactHash !== internalSignedReview.signedArtifactHash) {
      throw new Error(
        `SIGNED_REVIEW_MISMATCH: signedArtifactHash mismatch (expected ${internalSignedReview.signedArtifactHash}, got ${signedReview.signedArtifactHash})`
      )
    }
    if (!deepEqual(signedReview, internalSignedReview)) {
      throw new Error(
        `SIGNED_REVIEW_MISMATCH: Provided signedReview does not match orchestrator internal signedReview`
      )
    }

    const slotId = this.getSlotId()
    const storeId = this.getStoreId()
    const operationId = `op:${signedReview.signedId}`

    // 1. Read witness slot; enroll if not enrolled
    let enrolledSnapshot: Tm1RollbackWitnessSnapshot
    const rawRead = await this.witness.read({
      slotId,
      signal
    })

    if (rawRead === null) {
      if (await this.isStoreNonEmpty()) {
        throw new Error(
          'UNENROLLED_NONEMPTY_STORE: Cannot enroll an existing non-empty store as generation 0 on a missing witness slot'
        )
      }
      if (
        'inspectWitnessBinding' in this.recoveryStore &&
        typeof (this.recoveryStore as { inspectWitnessBinding?: unknown }).inspectWitnessBinding === 'function' &&
        (this.recoveryStore as { inspectWitnessBinding: () => unknown }).inspectWitnessBinding() !== null
      ) {
        throw new Error(
          'UNENROLLED_NONEMPTY_STORE: Store is already enrolled in v2 but witness slot is missing'
        )
      }

      // SQLite enrollment-root path: computeEnrollmentLogicalRoot before witness enroll (Finding 2)
      let logicalRoot: string
      if (
        'computeEnrollmentLogicalRoot' in this.recoveryStore &&
        typeof (this.recoveryStore as { computeEnrollmentLogicalRoot?: unknown })
          .computeEnrollmentLogicalRoot === 'function'
      ) {
        logicalRoot = (
          this.recoveryStore as {
            computeEnrollmentLogicalRoot: (input: { slotId: string; storeId: string }) => string
          }
        ).computeEnrollmentLogicalRoot({ slotId, storeId })
      } else {
        logicalRoot = await this.deriveStoreRoot({
          slotId,
          storeId,
          generation: 0
        })
      }

      const operationId = `enroll:${slotId}`
      const enrollRequest: Tm1RollbackWitnessEnrollment = {
        slotId,
        storeId,
        logicalRoot,
        operationId,
        signal
      }
      const rawEnroll = await this.witness.enroll(enrollRequest)
      enrolledSnapshot = parseTm1RollbackWitnessSnapshot(rawEnroll)
      const isAuthentic = await this.witness.verifyRecord(enrolledSnapshot.stable)
      if (!isAuthentic) {
        throw new Error(
          'UNAUTHENTICATED_WITNESS_ENROLLMENT: Stable record signature/hash verification failed'
        )
      }
      assertWitnessEnrollmentBinding(enrolledSnapshot, {
        slotId,
        storeId,
        logicalRoot,
        operationId
      })

      // Commit enrollment into recovery store lifecycle: enrollWitnessBinding (v1 -> v2) (Finding 2)
      if (
        'enrollWitnessBinding' in this.recoveryStore &&
        typeof (this.recoveryStore as { enrollWitnessBinding?: unknown })
          .enrollWitnessBinding === 'function'
      ) {
        ;(
          this.recoveryStore as {
            enrollWitnessBinding: (input: {
              slotId: string
              storeId: string
              logicalRoot: string
            }) => unknown
          }
        ).enrollWitnessBinding({
          slotId,
          storeId,
          logicalRoot
        })
      }
    } else {
      enrolledSnapshot = parseTm1RollbackWitnessSnapshot(rawRead)
      const isAuthentic = await this.witness.verifyRecord(enrolledSnapshot.stable)
      if (!isAuthentic) {
        throw new Error(
          'UNAUTHENTICATED_WITNESS_READ: Stable record signature/hash verification failed'
        )
      }
      if (enrolledSnapshot.pending !== null) {
        const isPendingAuthentic = await this.witness.verifyRecord(
          enrolledSnapshot.pending
        )
        if (!isPendingAuthentic) {
          throw new Error(
            'UNAUTHENTICATED_WITNESS_READ: Pending record signature/hash verification failed'
          )
        }
      }

      // Verify store against stable head (Finding 2)
      const localStoreRoot = await this.deriveStoreRoot({
        slotId,
        storeId,
        generation: enrolledSnapshot.stable.generation
      })
      assertStoreConsistentWithWitnessStableHead(
        localStoreRoot,
        enrolledSnapshot.stable
      )
    }

    // 2. Request broadcast authorization before creating/reserving recovery intent
    const broadcastDecision =
      await this.broadcastAuthorizationPort.requestBroadcastAuthorization(
        signedReview,
        signal
      )

    if (broadcastDecision.status === 'rejected') {
      throw new Tm1PublicationError(
        'BROADCAST_REJECTED',
        broadcastDecision.reason ?? 'BROADCAST_REJECTED'
      )
    }
    if (broadcastDecision.status === 'expired') {
      throw new Tm1PublicationError(
        'BROADCAST_AUTHORIZATION_EXPIRED',
        broadcastDecision.reason ?? 'BROADCAST_AUTHORIZATION_EXPIRED'
      )
    }

    this.cachedBroadcastDecision = broadcastDecision

    const broadcastGrant = this.ledger.getConsumption(
      broadcastDecision.authorizationId
    )
    if (!broadcastGrant) {
      throw new Error('BROADCAST_GRANT_NOT_RECORDED_IN_LEDGER')
    }

    const signingGrant = this.ledger.getConsumption(
      signedReview.signingAuthorizationId
    )
    if (!signingGrant) {
      throw new Error('SIGNING_GRANT_NOT_RECORDED_IN_LEDGER')
    }

    const publicationId = `pub:${preparedReview.preparedId}`
    const submissionId = `submission:${signedReview.signedId}`
    const now = Date.now()

    const preDispatchRecord = parseTm1PublicationRecoveryRecord({
      schema: 'tonalli.tm1-publication-recovery',
      schemaVersion: 1,
      publicationId,
      revision: 1,
      ownerEpoch: 1,
      phase: 'preDispatch',
      preDispatchStage: 'broadcastAuthorizationConsumed',
      prepared: {
        preparedId: preparedReview.preparedId,
        bindingHash: preparedReview.bindingHash,
        preparedDigest: preparedReview.bindingHash
      },
      signed: {
        signedId: signedReview.signedId,
        txid: signedReview.txid,
        signedArtifactHash: signedReview.signedArtifactHash
      },
      signingAuthorization: {
        operationId: signingGrant.operationId,
        capabilityId: signingGrant.capabilityId,
        contentHash: signingGrant.contentHash,
        expiresAt: signingGrant.expiresAt,
        consumedAt: signingGrant.consumedAt,
        preparedId: preparedReview.preparedId,
        bindingHash: preparedReview.bindingHash
      },
      broadcastAuthorization: {
        operationId: broadcastGrant.operationId,
        capabilityId: broadcastGrant.capabilityId,
        contentHash: broadcastGrant.contentHash,
        expiresAt: broadcastGrant.expiresAt,
        consumedAt: broadcastGrant.consumedAt,
        signedId: signedReview.signedId,
        txid: signedReview.txid,
        signedArtifactHash: signedReview.signedArtifactHash
      },
      dispatchIntent: null,
      transportAcknowledgement: null,
      lastObservation: null,
      terminal: null
    })

    const outcomeUnknownRecord = parseTm1PublicationRecoveryRecord({
      ...preDispatchRecord,
      revision: 2,
      phase: 'outcomeUnknown',
      preDispatchStage: null,
      dispatchIntent: {
        submissionId,
        txid: signedReview.txid,
        signedArtifactHash: signedReview.signedArtifactHash,
        broadcastCapabilityId: broadcastGrant.capabilityId,
        committedAt: now
      }
    })

    // 3. Derive canonical whole-store root for the proposed dispatch intent checkpoint (Finding 1 & 2)
    const nextGeneration = enrolledSnapshot.stable.generation + 1
    const existingCapabilities = await this.getStoreCapabilityIds()
    const cumulativeCapabilities = [
      ...new Set([
        ...existingCapabilities,
        signingGrant.capabilityId,
        broadcastGrant.capabilityId
      ])
    ]
    const nextLogicalRoot = await this.deriveStoreRoot({
      slotId,
      storeId,
      generation: nextGeneration,
      projectedRecord: outcomeUnknownRecord,
      projectedCapabilities: cumulativeCapabilities
    })

    // 4. Reserve witness slot for dispatch intent
    const reservationRequest: Tm1RollbackWitnessReservation = {
      slotId,
      storeId,
      expectedStableGeneration: enrolledSnapshot.stable.generation,
      expectedStableLogicalRoot: enrolledSnapshot.stable.logicalRoot,
      expectedStableReceiptHash: enrolledSnapshot.stable.receiptHash,
      nextGeneration,
      nextLogicalRoot,
      operationId,
      signal
    }

    const rawReserve = await this.witness.reserve(reservationRequest)
    const witnessReservationSnapshot = parseTm1RollbackWitnessSnapshot(rawReserve)

    // Verify cryptographic authenticity of reservation snapshot
    const isReservationStableAuthentic = await this.witness.verifyRecord(
      witnessReservationSnapshot.stable
    )
    if (!isReservationStableAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS_RESERVATION: Stable record signature/hash verification failed'
      )
    }
    if (!witnessReservationSnapshot.pending) {
      throw new Error(
        'WITNESS_RESERVATION_MISSING_PENDING: Reservation snapshot must contain pending record'
      )
    }
    const isReservationPendingAuthentic = await this.witness.verifyRecord(
      witnessReservationSnapshot.pending
    )
    if (!isReservationPendingAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS_RESERVATION: Pending record signature/hash verification failed'
      )
    }

    // 5. Strict binding of reservation response to request (Finding 2)
    assertWitnessReservationResponseBinding(
      witnessReservationSnapshot,
      reservationRequest,
      enrolledSnapshot.stable
    )

    // 6. Persist preDispatch and outcomeUnknown records to recovery store
    await this.recoveryStore.create({ record: preDispatchRecord })

    const rawCommitted = await this.recoveryStore.commitDispatchIntent({
      publicationId,
      expectedRevision: 1,
      expectedOwnerEpoch: 1,
      nextRecord: outcomeUnknownRecord
    })

    // 7. Validate committed dispatch intent return value (Finding 3)
    let committedRecord: Tm1PublicationRecoveryRecord
    try {
      committedRecord = parseTm1PublicationRecoveryRecord(rawCommitted)
    } catch (error) {
      throw new Error(
        `INVALID_DISPATCH_INTENT_RECORD: Malformed recovery record (${error instanceof Error ? error.message : String(error)})`
      )
    }

    assertTm1CommittedDispatchIntentBinding({
      committedRecord,
      publicationId,
      expectedRevision: 2,
      expectedOwnerEpoch: 1,
      preparedReview,
      signedReview,
      signingGrant,
      broadcastGrant,
      submissionId,
      expectedCommittedAt: now,
      expectedRecord: outcomeUnknownRecord
    })

    // 8. Re-attest durable store before witness finalization (Finding 1)
    const storedRecordRaw = await this.recoveryStore.load(publicationId)
    if (!storedRecordRaw) {
      throw new Error(
        'DURABLE_STORE_PERSISTENCE_MISMATCH: Record missing from recovery store after commitDispatchIntent'
      )
    }
    let storedRecord: Tm1PublicationRecoveryRecord
    try {
      storedRecord = parseTm1PublicationRecoveryRecord(storedRecordRaw)
    } catch (error) {
      throw new Error(
        `DURABLE_STORE_PERSISTENCE_MISMATCH: Stored record is malformed (${error instanceof Error ? error.message : String(error)})`
      )
    }
    if (!deepEqual(storedRecord, committedRecord)) {
      throw new Error(
        'DURABLE_STORE_PERSISTENCE_MISMATCH: Persisted store record does not match committed dispatch intent record'
      )
    }

    const reAttestedStoreRoot = await this.deriveStoreRoot({
      slotId,
      storeId,
      generation: witnessReservationSnapshot.pending.generation
    })
    if (reAttestedStoreRoot !== witnessReservationSnapshot.pending.logicalRoot) {
      throw new Error(
        `DURABLE_STORE_PERSISTENCE_MISMATCH: Re-attested whole-store root mismatch (expected ${witnessReservationSnapshot.pending.logicalRoot}, got ${reAttestedStoreRoot})`
      )
    }

    // 9. Finalize witness checkpoint for dispatch intent BEFORE transport execution (Finding 4)
    const rawFinalizeDispatch = await this.witness.finalize({
      slotId,
      storeId,
      generation: witnessReservationSnapshot.pending.generation,
      logicalRoot: witnessReservationSnapshot.pending.logicalRoot,
      pendingReceiptHash: witnessReservationSnapshot.pending.receiptHash,
      operationId: witnessReservationSnapshot.pending.operationId,
      signal
    })
    const finalizedDispatchSnapshot =
      parseTm1RollbackWitnessSnapshot(rawFinalizeDispatch)
    const isFinalizedAuthentic = await this.witness.verifyRecord(
      finalizedDispatchSnapshot.stable
    )
    if (!isFinalizedAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS_FINALIZATION: Dispatch intent stable record signature/hash verification failed'
      )
    }

    // Bind finalization to receipt chain and pending reservation (Finding 2)
    assertWitnessFinalizationBinding(
      finalizedDispatchSnapshot,
      witnessReservationSnapshot.pending
    )

    if (finalizedDispatchSnapshot.stable.logicalRoot !== reAttestedStoreRoot) {
      throw new Error(
        'WITNESS_FINALIZATION_MISMATCH: Finalized dispatch intent root does not match actual store root'
      )
    }

    // 9. Execute transport call ONLY after witness checkpoint is stable
    const initialDispatchCount = this.dispatchCalls
    this.plannedSubmissionId = submissionId

    const submissionReceipt = await this.orchestrator.approveAndBroadcast(
      signedReview.signedId,
      signal
    )

    if (this.dispatchCalls !== initialDispatchCount + 1) {
      throw new Error(
        `Exactly-once dispatch violation: expected 1 dispatch, observed ${this.dispatchCalls - initialDispatchCount}`
      )
    }

    let duplicateAttemptBlocked = false
    try {
      await this.orchestrator.approveAndBroadcast(signedReview.signedId, signal)
    } catch (error) {
      if (error instanceof Tm1PublicationError && error.code === 'INVALID_STATE') {
        duplicateAttemptBlocked = true
      }
    }

    if (!duplicateAttemptBlocked) {
      throw new Error(
        'Exactly-once dispatch violation: secondary dispatch was not rejected with INVALID_STATE'
      )
    }

    return {
      witnessReservationSnapshot,
      witnessFinalizedDispatchSnapshot: finalizedDispatchSnapshot,
      dispatchIntentRecord: committedRecord,
      submissionReceipt
    }
  }

  /**
   * Step 7: Comprobar el estado final de exito y asentar duraderamente el checkpoint
   * separado de acknowledgement en el witness (nueva reserva + finalizacion).
   */
  async executeStep7VerifyFinalSuccess(
    preparedReview: Tm1PreparedReview,
    signedReview: Tm1SignedReview,
    submissionReceipt: Tm1SubmissionReceipt,
    _witnessReservationSnapshot?: Tm1RollbackWitnessSnapshot,
    signal?: AbortSignal
  ): Promise<{
    transportAcknowledgedRecord: Tm1PublicationRecoveryRecord
    finalOrchestratorState: Tm1PublicationState
    confirmedReceipt?: Tm1Confirmation
    witnessAcknowledgementSnapshot: Tm1RollbackWitnessSnapshot
  }> {
    const publicationId = `pub:${preparedReview.preparedId}`
    const storeId = this.getStoreId()
    const slotId = this.getSlotId()

    // 1. Read current stable head (from dispatch intent finalization) & verify store against stable head FIRST (Finding 2)
    const rawReadWitness = await this.witness.read({ slotId, signal })
    if (rawReadWitness === null) {
      if (await this.isStoreNonEmpty()) {
        throw new Error(
          'UNENROLLED_NONEMPTY_STORE: Cannot commit acknowledgement for an unenrolled non-empty store'
        )
      }
      throw new Error('WITNESS_NOT_ENROLLED: Cannot persist acknowledgement checkpoint')
    }
    const currentWitnessSnapshot = parseTm1RollbackWitnessSnapshot(rawReadWitness)
    const isCurrentStableAuthentic = await this.witness.verifyRecord(
      currentWitnessSnapshot.stable
    )
    if (!isCurrentStableAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS: Current stable record signature/hash verification failed'
      )
    }
    if (currentWitnessSnapshot.pending !== null) {
      throw new Error(
        'WITNESS_CONFLICT: Pending reservation already exists before acknowledgement checkpoint'
      )
    }

    // Verify store against stable head (Finding 2)
    const localStoreRootBeforeAck = await this.deriveStoreRoot({
      slotId,
      storeId,
      generation: currentWitnessSnapshot.stable.generation
    })
    assertStoreConsistentWithWitnessStableHead(
      localStoreRootBeforeAck,
      currentWitnessSnapshot.stable
    )

    // 2. Load current recovery record to validate pre-conditions and project acknowledgement
    const rawCurrentRecord = await this.recoveryStore.load(publicationId)
    if (!rawCurrentRecord) {
      throw new Error(
        `PUBLICATION_NOT_FOUND: Record for ${publicationId} not found in recovery store`
      )
    }
    const currentRecord = parseTm1PublicationRecoveryRecord(rawCurrentRecord)
    if (currentRecord.phase !== 'outcomeUnknown' || !currentRecord.dispatchIntent) {
      throw new Error(
        'INVALID_RECOVERY_STORE_STATE: Expected outcomeUnknown phase with dispatchIntent before acknowledgement'
      )
    }
    if (
      currentRecord.dispatchIntent.submissionId !== submissionReceipt.submissionId
    ) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Dispatch intent submission ID mismatch'
      )
    }
    if (currentRecord.dispatchIntent.txid !== submissionReceipt.txid) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Dispatch intent txid mismatch'
      )
    }
    if (
      currentRecord.dispatchIntent.signedArtifactHash !==
      signedReview.signedArtifactHash
    ) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Dispatch intent signed artifact hash mismatch'
      )
    }

    const acknowledgedAt = Date.now()
    const ackEvidence = {
      submissionId: submissionReceipt.submissionId,
      signedId: signedReview.signedId,
      txid: submissionReceipt.txid,
      signedArtifactHash: signedReview.signedArtifactHash,
      disposition: 'accepted' as const,
      acknowledgedAt
    }

    const projectedAckRecord = createTm1TransportAcknowledgedRecord(
      currentRecord,
      ackEvidence
    )

    // 3. Two-Phase Commit Phase 1 (Finding 3): Reserve acknowledgement checkpoint on witness FIRST
    const ackGeneration = currentWitnessSnapshot.stable.generation + 1
    const ackLogicalRoot = await this.deriveStoreRoot({
      slotId,
      storeId,
      generation: ackGeneration,
      projectedRecord: projectedAckRecord
    })

    const ackOperationId = `op:ack:${submissionReceipt.submissionId}`
    const ackReservationRequest: Tm1RollbackWitnessReservation = {
      slotId,
      storeId,
      expectedStableGeneration: currentWitnessSnapshot.stable.generation,
      expectedStableLogicalRoot: currentWitnessSnapshot.stable.logicalRoot,
      expectedStableReceiptHash: currentWitnessSnapshot.stable.receiptHash,
      nextGeneration: ackGeneration,
      nextLogicalRoot: ackLogicalRoot,
      operationId: ackOperationId,
      signal
    }

    const rawAckReserve = await this.witness.reserve(ackReservationRequest)
    const ackReservationSnapshot = parseTm1RollbackWitnessSnapshot(rawAckReserve)
    const isAckStableAuthentic = await this.witness.verifyRecord(
      ackReservationSnapshot.stable
    )
    if (!isAckStableAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS_RESERVATION: Acknowledgement stable record signature/hash verification failed'
      )
    }
    if (!ackReservationSnapshot.pending) {
      throw new Error(
        'WITNESS_RESERVATION_MISSING_PENDING: Acknowledgement reservation snapshot must contain pending record'
      )
    }
    const isAckPendingAuthentic = await this.witness.verifyRecord(
      ackReservationSnapshot.pending
    )
    if (!isAckPendingAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS_RESERVATION: Acknowledgement pending record signature/hash verification failed'
      )
    }

    // Strict binding of reservation response to request
    assertWitnessReservationResponseBinding(
      ackReservationSnapshot,
      ackReservationRequest,
      currentWitnessSnapshot.stable
    )

    // 4. Two-Phase Commit Phase 2 (Finding 3): Commit acknowledgement in local recovery store AFTER reservation
    const rawRecord = await this.recoveryStore.commitTransportAcknowledgement({
      publicationId,
      expectedRevision: 2,
      expectedOwnerEpoch: 1,
      acknowledgement: ackEvidence
    })

    let transportAcknowledgedRecord: Tm1PublicationRecoveryRecord
    try {
      transportAcknowledgedRecord = parseTm1PublicationRecoveryRecord(rawRecord)
    } catch (error) {
      throw new Error(
        `MALFORMED_RECOVERY_RECORD: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Revision & phase verification
    if (transportAcknowledgedRecord.phase !== 'submittedObserved') {
      throw new Error(
        `INVALID_ACKNOWLEDGEMENT_RECORD: Expected phase 'submittedObserved', got '${transportAcknowledgedRecord.phase}'`
      )
    }
    if (transportAcknowledgedRecord.revision !== 3) {
      throw new Error(
        `INVALID_ACKNOWLEDGEMENT_RECORD: Expected revision 3, got ${transportAcknowledgedRecord.revision}`
      )
    }
    if (transportAcknowledgedRecord.publicationId !== publicationId) {
      throw new Error(
        `INVALID_ACKNOWLEDGEMENT_RECORD: Publication ID mismatch (expected ${publicationId}, got ${transportAcknowledgedRecord.publicationId})`
      )
    }
    if (transportAcknowledgedRecord.ownerEpoch !== 1) {
      throw new Error(
        `INVALID_ACKNOWLEDGEMENT_RECORD: Owner epoch mismatch (expected 1, got ${transportAcknowledgedRecord.ownerEpoch})`
      )
    }

    // Identities verification
    if (
      transportAcknowledgedRecord.prepared?.preparedId !== preparedReview.preparedId
    ) {
      throw new Error('INVALID_ACKNOWLEDGEMENT_RECORD: Prepared ID mismatch')
    }
    if (transportAcknowledgedRecord.signed?.signedId !== signedReview.signedId) {
      throw new Error('INVALID_ACKNOWLEDGEMENT_RECORD: Signed ID mismatch')
    }
    if (transportAcknowledgedRecord.signed?.txid !== submissionReceipt.txid) {
      throw new Error('INVALID_ACKNOWLEDGEMENT_RECORD: Signed txid mismatch')
    }
    if (
      transportAcknowledgedRecord.signed?.signedArtifactHash !==
      signedReview.signedArtifactHash
    ) {
      throw new Error('INVALID_ACKNOWLEDGEMENT_RECORD: Signed artifact hash mismatch')
    }

    // Dispatch intent verification
    if (!transportAcknowledgedRecord.dispatchIntent) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Missing dispatch intent in acknowledgement record'
      )
    }
    if (
      transportAcknowledgedRecord.dispatchIntent.submissionId !==
      submissionReceipt.submissionId
    ) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Dispatch intent submission ID mismatch'
      )
    }
    if (
      transportAcknowledgedRecord.dispatchIntent.txid !== submissionReceipt.txid
    ) {
      throw new Error('INVALID_ACKNOWLEDGEMENT_RECORD: Dispatch intent txid mismatch')
    }
    if (
      transportAcknowledgedRecord.dispatchIntent.signedArtifactHash !==
      signedReview.signedArtifactHash
    ) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Dispatch intent signed artifact hash mismatch'
      )
    }

    // Transport receipt verification
    if (!transportAcknowledgedRecord.transportAcknowledgement) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Missing transport acknowledgement evidence'
      )
    }
    if (
      transportAcknowledgedRecord.transportAcknowledgement.txid !==
      submissionReceipt.txid
    ) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Transport acknowledgement txid mismatch'
      )
    }
    if (
      transportAcknowledgedRecord.transportAcknowledgement.disposition !== 'accepted'
    ) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Transport acknowledgement disposition not accepted'
      )
    }
    if (
      transportAcknowledgedRecord.transportAcknowledgement.acknowledgedAt !==
      acknowledgedAt
    ) {
      throw new Error(
        `INVALID_ACKNOWLEDGEMENT_RECORD: Transport acknowledgement acknowledgedAt mismatch (expected ${acknowledgedAt}, got ${transportAcknowledgedRecord.transportAcknowledgement.acknowledgedAt})`
      )
    }

    // Strict comparison between committed record and projectedAckRecord (Finding 3)
    if (!deepEqual(transportAcknowledgedRecord, projectedAckRecord)) {
      throw new Error(
        'INVALID_ACKNOWLEDGEMENT_RECORD: Committed acknowledgement record does not match projected record'
      )
    }

    // Re-attest durable store for acknowledgement: reload from store and recompute whole-store root (Finding 1 & 3)
    const storedAckRaw = await this.recoveryStore.load(publicationId)
    if (!storedAckRaw) {
      throw new Error(
        'DURABLE_STORE_PERSISTENCE_MISMATCH: Record missing from recovery store after commitTransportAcknowledgement'
      )
    }
    let storedAckRecord: Tm1PublicationRecoveryRecord
    try {
      storedAckRecord = parseTm1PublicationRecoveryRecord(storedAckRaw)
    } catch (error) {
      throw new Error(
        `DURABLE_STORE_PERSISTENCE_MISMATCH: Stored acknowledgement record is malformed (${error instanceof Error ? error.message : String(error)})`
      )
    }
    if (!deepEqual(storedAckRecord, projectedAckRecord)) {
      throw new Error(
        'DURABLE_STORE_PERSISTENCE_MISMATCH: Persisted store record does not match projected acknowledgement record'
      )
    }

    const reAttestedAckStoreRoot = await this.deriveStoreRoot({
      slotId,
      storeId,
      generation: ackReservationSnapshot.pending.generation
    })
    if (reAttestedAckStoreRoot !== ackReservationSnapshot.pending.logicalRoot) {
      throw new Error(
        `DURABLE_STORE_PERSISTENCE_MISMATCH: Re-attested whole-store root mismatch for acknowledgement (expected ${ackReservationSnapshot.pending.logicalRoot}, got ${reAttestedAckStoreRoot})`
      )
    }

    // 5. Two-Phase Commit Phase 3 (Finding 3): Finalize acknowledgement checkpoint on witness
    const rawAckFinalize = await this.witness.finalize({
      slotId,
      storeId,
      generation: ackReservationSnapshot.pending.generation,
      logicalRoot: ackReservationSnapshot.pending.logicalRoot,
      pendingReceiptHash: ackReservationSnapshot.pending.receiptHash,
      operationId: ackReservationSnapshot.pending.operationId,
      signal
    })
    const finalizedAckSnapshot = parseTm1RollbackWitnessSnapshot(rawAckFinalize)
    const isFinalizedAckAuthentic = await this.witness.verifyRecord(
      finalizedAckSnapshot.stable
    )
    if (!isFinalizedAckAuthentic) {
      throw new Error(
        'UNAUTHENTICATED_WITNESS_FINALIZATION: Acknowledgement stable record signature/hash verification failed'
      )
    }

    // Bind finalization to receipt chain and pending reservation (Finding 2)
    assertWitnessFinalizationBinding(
      finalizedAckSnapshot,
      ackReservationSnapshot.pending
    )

    if (finalizedAckSnapshot.stable.logicalRoot !== reAttestedAckStoreRoot) {
      throw new Error(
        'WITNESS_FINALIZATION_MISMATCH: Finalized acknowledgement root does not match actual store root'
      )
    }

    // 6. Orchestrator state verification
    const finalOrchestratorState = this.orchestrator.getState()
    if (finalOrchestratorState.status !== 'submitted') {
      throw new Error(
        `Final orchestrator state expected 'submitted', got '${finalOrchestratorState.status}'`
      )
    }

    if (finalOrchestratorState.receipt.txid !== submissionReceipt.txid) {
      throw new Error('Orchestrator receipt txid does not match submission receipt')
    }

    return {
      transportAcknowledgedRecord,
      finalOrchestratorState,
      witnessAcknowledgementSnapshot: finalizedAckSnapshot
    }
  }

  /**
   * Executes all 7 steps of the TM1 Programmatic E2E Pipeline in strict sequence.
   */
  async executePipeline(signal?: AbortSignal): Promise<Tm1ProgrammaticE2eResult> {
    // Step 1: Resolve simulated alias & observe ownership
    const evidenceToken = await this.executeStep1VerifyAlias(signal)

    // Step 2: Produce VerifiedAliasOwnershipEvidence
    const verifiedAliasSnapshot = this.executeStep2ProduceEvidence(evidenceToken)

    // Step 3: Pass verified evidence to authorizer
    const aliasPublicationAuthorization =
      this.executeStep3AuthorizePublication(evidenceToken)

    // Step 4: Prepare canonical TM1 memo & unsigned tx
    const {
      memoPreview,
      candidate,
      unsignedTransactionBytes,
      unsignedTransactionAudit,
      preparedReview
    } = await this.executeStep4PrepareMemoAndUnsignedTx(
      aliasPublicationAuthorization,
      signal
    )

    // Step 5: Execute dual authorization
    const { signedReview, signingAuthorizationDecision } =
      await this.executeStep5DualAuthorizeAndSign(preparedReview, signal)

    // Step 6: Recovery reservation, finalization of dispatch intent & exactly-once dispatch
    const {
      witnessReservationSnapshot,
      witnessFinalizedDispatchSnapshot,
      dispatchIntentRecord,
      submissionReceipt
    } = await this.executeStep6ReserveRecoveryAndDispatch(
      preparedReview,
      signedReview,
      signal
    )

    // Step 7: Final success verification & acknowledgement witness checkpoint
    const {
      transportAcknowledgedRecord,
      finalOrchestratorState,
      witnessAcknowledgementSnapshot
    } = await this.executeStep7VerifyFinalSuccess(
      preparedReview,
      signedReview,
      submissionReceipt,
      witnessReservationSnapshot,
      signal
    )

    return Object.freeze({
      success: true,
      alias: this.alias,
      ownerAddress: this.ownerAddress,
      txid: submissionReceipt.txid,
      submissionId: submissionReceipt.submissionId,
      steps: Object.freeze({
        verifiedAliasEvidenceToken: evidenceToken,
        verifiedAliasSnapshot,
        aliasPublicationAuthorization,
        memoPreview,
        candidate,
        unsignedTransactionBytes,
        unsignedTransactionAudit,
        preparedReview,
        signingAuthorizationDecision,
        signedReview,
        witnessReservationSnapshot,
        witnessFinalizedDispatchSnapshot,
        witnessAcknowledgementSnapshot,
        dispatchIntentRecord,
        submissionReceipt,
        dispatchCount: this.getDispatchCount(),
        transportAcknowledgedRecord,
        finalOrchestratorState
      })
    })
  }
}

export function createTm1RegtestE2eHarness(
  options: Tm1ProgrammaticE2eOptions = {}
): Tm1RegtestE2eHarness {
  return new Tm1RegtestE2eHarness(options)
}

export async function executeTm1ProgrammaticE2ePipeline(
  options: Tm1ProgrammaticE2eOptions = {}
): Promise<Tm1ProgrammaticE2eResult> {
  const harness = createTm1RegtestE2eHarness(options)
  return harness.executePipeline(options.signal)
}
