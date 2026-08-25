import type {
  Tm1PublicationRecoveryRecord,
  Tm1TransportAcknowledgementCommitEvidence
} from './tm1PublicationRecoveryModel'

export type Tm1PublicationRecoveryStoreErrorCode =
  | 'DUPLICATE_CAPABILITY_CONSUMPTION'
  | 'DUPLICATE_PUBLICATION_ID'
  | 'PUBLICATION_NOT_FOUND'
  | 'RECOVERY_STORE_FAILED'
  | 'REVISION_MISMATCH'
  | 'ROLLBACK_WITNESS_REQUIRED'
  | 'WITNESS_RESERVATION_FENCE_MISMATCH'
  | 'WITNESS_RESERVATION_GRANT_REQUIRED'
  | 'STALE_OWNER_EPOCH'

export class Tm1PublicationRecoveryStoreError extends Error {
  readonly code: Tm1PublicationRecoveryStoreErrorCode

  constructor(code: Tm1PublicationRecoveryStoreErrorCode) {
    super(code)
    this.name = 'Tm1PublicationRecoveryStoreError'
    this.code = code
  }
}

export type Tm1RecoveryStoreCreate = Readonly<{
  record: Tm1PublicationRecoveryRecord
}>

export type Tm1RecoveryStoreExpectedVersion = Readonly<{
  publicationId: string
  expectedRevision: number
  expectedOwnerEpoch: number
}>

export type Tm1RecoveryStoreExecutionCommit = Readonly<
  Tm1RecoveryStoreExpectedVersion & {
    nextRecord: Tm1PublicationRecoveryRecord
    newlyConsumedCapabilityIds: readonly string[]
  }
>

export type Tm1RecoveryStoreDispatchIntentCommit = Readonly<
  Tm1RecoveryStoreExpectedVersion & {
    /**
     * This record must atomically enter outcomeUnknown and contain the exact
     * dispatchIntent. The commit must finish durably before the closed runtime
     * is ever allowed to enter its existing transport call.
     */
    nextRecord: Tm1PublicationRecoveryRecord
  }
>

export type Tm1RecoveryStoreTransportAcknowledgementCommit = Readonly<
  Tm1RecoveryStoreExpectedVersion & {
    /**
     * Positive evidence returned by the one dispatch already represented by
     * the durable dispatch intent. This data is identity, not authority: the
     * store must verify every field against its current record and must never
     * invoke a transport while committing it. Implementations must apply
     * `createTm1TransportAcknowledgedRecord` or equivalent validation.
     */
    acknowledgement: Tm1TransportAcknowledgementCommitEvidence
  }
>

export type Tm1RecoveryStoreRecoveryCommit = Readonly<
  Tm1RecoveryStoreExpectedVersion & {
    /** Recovery commits are observation/abandonment only. */
    nextRecord: Tm1PublicationRecoveryRecord
  }
>

export type Tm1RecoveryStoreOwnershipClaim = Readonly<
  Tm1RecoveryStoreExpectedVersion & {
    nextOwnerEpoch: number
  }
>

/**
 * Persistence contract for Phase 6-I conservative recovery.
 *
 * A concrete store must provide transactional durability, schema validation,
 * publication/revision/owner CAS, globally unique capability consumption and
 * monotonic transitions. `commitRecoveryTransition` must reject any attempt
 * to add or mutate a dispatch intent. `commitDispatchIntent` is the only store
 * operation that may atomically add that evidence, and it grants no transport
 * capability by itself. `commitTransportAcknowledgement` may only persist a
 * positive result returned by that exact, already-executed dispatch; repeated
 * acknowledgement commits are rejected by CAS or transition validation.
 *
 * All return values are `unknown` deliberately: callers re-validate and clone
 * the persistence boundary instead of trusting an implementation's objects.
 */
export interface Tm1PublicationRecoveryStore {
  load(publicationId: string): Promise<unknown | null>
  listRecoverable(): Promise<unknown>
  create(input: Tm1RecoveryStoreCreate): Promise<unknown>
  commitExecutionEvidence(input: Tm1RecoveryStoreExecutionCommit): Promise<unknown>
  commitDispatchIntent(input: Tm1RecoveryStoreDispatchIntentCommit): Promise<unknown>
  commitTransportAcknowledgement(
    input: Tm1RecoveryStoreTransportAcknowledgementCommit
  ): Promise<unknown>
  commitRecoveryTransition(input: Tm1RecoveryStoreRecoveryCommit): Promise<unknown>
  claimOwnership(input: Tm1RecoveryStoreOwnershipClaim): Promise<unknown>
}
