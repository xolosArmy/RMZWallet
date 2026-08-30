import {
  TM1_PUBLICATION_RECOVERY_SCHEMA,
  TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION,
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord,
  type Tm1RecoveryPreDispatchStage
} from '../../../src/integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const HASH_C = 'c'.repeat(64)
export const HASH_D = 'd'.repeat(64)

/**
 * Test-only seam for the pre-Gate-A physical-store regression corpus.
 * Security tests use unmodified stores, and production exposes no bypass.
 */
export function allowLegacyMutationInPhysicalStoreTest(store: object): void {
  Object.defineProperty(store, 'rejectLegacyMutation', {
    configurable: true,
    value: () => undefined
  })
}

export function restoreLegacyMutationGuardAfterTestSetup(store: object): void {
  Reflect.deleteProperty(store, 'rejectLegacyMutation')
}

export type Tm1RecoveryFixtureOptions = Readonly<{
  publicationId?: string
  signingCapabilityId?: string
  broadcastCapabilityId?: string
  ownerEpoch?: number
}>

export function preparedRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  return preDispatchRecord('prepared', options)
}

export function signingPendingRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  return preDispatchRecord('signAuthorizationPending', options)
}

export function signingConsumedRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  return preDispatchRecord('signAuthorizationConsumed', options)
}

export function signedAuditedRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  return preDispatchRecord('signedAudited', options)
}

export function broadcastPendingRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  return preDispatchRecord('broadcastAuthorizationPending', options)
}

export function broadcastConsumedRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  return preDispatchRecord('broadcastAuthorizationConsumed', options)
}

export function outcomeUnknownRecord(
  options: Tm1RecoveryFixtureOptions = {}
): Tm1PublicationRecoveryRecord {
  const previous = broadcastConsumedRecord(options)
  return parseTm1PublicationRecoveryRecord({
    ...previous,
    revision: previous.revision + 1,
    phase: 'outcomeUnknown',
    preDispatchStage: null,
    dispatchIntent: {
      submissionId: 'submission:one',
      txid: HASH_B,
      signedArtifactHash: HASH_C,
      broadcastCapabilityId: options.broadcastCapabilityId ?? 'capability:broadcast:one',
      committedAt: 2_600
    }
  })
}

export function absentObservationRecord(
  current: Tm1PublicationRecoveryRecord,
  observedAt = 3_000
): Tm1PublicationRecoveryRecord {
  return parseTm1PublicationRecoveryRecord({
    ...current,
    revision: current.revision + 1,
    lastObservation: {
      status: 'absent',
      txid: current.dispatchIntent?.txid,
      observedAt
    }
  })
}

export function abandonedRecord(
  current: Tm1PublicationRecoveryRecord,
  recordedAt = 3_000
): Tm1PublicationRecoveryRecord {
  return parseTm1PublicationRecoveryRecord({
    ...current,
    revision: current.revision + 1,
    phase: 'abandoned',
    preDispatchStage: null,
    terminal: {
      status: 'abandoned',
      stage: 'preDispatch',
      code: 'PROCESS_INTERRUPTED',
      recordedAt
    }
  })
}

function preDispatchRecord(
  stage: Tm1RecoveryPreDispatchStage,
  options: Tm1RecoveryFixtureOptions
): Tm1PublicationRecoveryRecord {
  const order = stageOrder(stage)
  return parseTm1PublicationRecoveryRecord({
    schema: TM1_PUBLICATION_RECOVERY_SCHEMA,
    schemaVersion: TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION,
    publicationId: options.publicationId ?? 'publication:one',
    revision: order,
    ownerEpoch: options.ownerEpoch ?? 0,
    phase: 'preDispatch',
    preDispatchStage: stage,
    prepared: {
      preparedId: 'prepared:one',
      bindingHash: HASH_A,
      preparedDigest: HASH_D
    },
    signed: order >= 3
      ? {
          signedId: 'signed:one',
          txid: HASH_B,
          signedArtifactHash: HASH_C
        }
      : null,
    signingAuthorization: order >= 2
      ? {
          operationId: 'operation:sign:one',
          capabilityId: options.signingCapabilityId ?? 'capability:sign:one',
          contentHash: `sha256:${HASH_A}`,
          expiresAt: 2_000,
          consumedAt: 1_000,
          preparedId: 'prepared:one',
          bindingHash: HASH_A
        }
      : null,
    broadcastAuthorization: order >= 5
      ? {
          operationId: 'operation:broadcast:one',
          capabilityId: options.broadcastCapabilityId ?? 'capability:broadcast:one',
          contentHash: `sha256:${HASH_C}`,
          expiresAt: 3_000,
          consumedAt: 2_500,
          signedId: 'signed:one',
          txid: HASH_B,
          signedArtifactHash: HASH_C
        }
      : null,
    dispatchIntent: null,
    transportAcknowledgement: null,
    lastObservation: null,
    terminal: null
  })
}

function stageOrder(stage: Tm1RecoveryPreDispatchStage): number {
  switch (stage) {
    case 'prepared': return 0
    case 'signAuthorizationPending': return 1
    case 'signAuthorizationConsumed': return 2
    case 'signedAudited': return 3
    case 'broadcastAuthorizationPending': return 4
    case 'broadcastAuthorizationConsumed': return 5
  }
}
