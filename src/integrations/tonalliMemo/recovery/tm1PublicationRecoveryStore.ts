import type {
  Tm1PublicationRecoveryRecord
} from './tm1PublicationRecoveryModel'

export type Tm1PublicationRecoveryStoreErrorCode =
  | 'DUPLICATE_CAPABILITY_CONSUMPTION'
  | 'DUPLICATE_PUBLICATION_ID'
  | 'PUBLICATION_NOT_FOUND'
  | 'RECOVERY_STORE_FAILED'
  | 'REVISION_MISMATCH'
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
 * capability by itself.
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
  commitRecoveryTransition(input: Tm1RecoveryStoreRecoveryCommit): Promise<unknown>
  claimOwnership(input: Tm1RecoveryStoreOwnershipClaim): Promise<unknown>
}
