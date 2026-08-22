export const TM1_PUBLICATION_RECOVERY_SCHEMA =
  'tonalli.tm1-publication-recovery'

export const TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION = 1

const CANONICAL_HASH = /^[0-9a-f]{64}$/
const UNIVERSAL_CONTENT_HASH = /^sha256:[0-9a-f]{64}$/
const MAX_IDENTIFIER_LENGTH = 256
const MAX_RECORD_DEPTH = 16

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'abortsignal',
  'authorizationcapability',
  'capabilityobject',
  'chronikclient',
  'privatekey',
  'privatekeyhex',
  'providerpromise',
  'runtime',
  'secretkey',
  'secretkeyhex',
  'signer',
  'signerhandle',
  'transport',
  'wif'
])

export type Tm1PublicationRecoveryErrorCode =
  | 'FORBIDDEN_AUTHORITY_FIELD'
  | 'INVALID_PUBLICATION_ID'
  | 'INVALID_RECOVERY_TRANSITION'
  | 'MALFORMED_RECOVERY_RECORD'
  | 'UNSUPPORTED_RECOVERY_SCHEMA'

export class Tm1PublicationRecoveryError extends Error {
  readonly code: Tm1PublicationRecoveryErrorCode

  constructor(code: Tm1PublicationRecoveryErrorCode) {
    super(code)
    this.name = 'Tm1PublicationRecoveryError'
    this.code = code
  }
}

export type Tm1RecoveryPreDispatchStage =
  | 'prepared'
  | 'signAuthorizationPending'
  | 'signAuthorizationConsumed'
  | 'signedAudited'
  | 'broadcastAuthorizationPending'
  | 'broadcastAuthorizationConsumed'

export type Tm1PublicationRecoveryPhase =
  | 'preDispatch'
  | 'abandoned'
  | 'outcomeUnknown'
  | 'submittedObserved'
  | 'confirmedObserved'
  | 'failedTerminal'

export type Tm1PreparedRecoveryEvidence = Readonly<{
  preparedId: string
  bindingHash: string
  preparedDigest: string
}>

export type Tm1SignedRecoveryEvidence = Readonly<{
  signedId: string
  txid: string
  signedArtifactHash: string
}>

export type Tm1ConsumedSigningAuthorizationEvidence = Readonly<{
  operationId: string
  capabilityId: string
  contentHash: `sha256:${string}`
  expiresAt: number
  consumedAt: number
  preparedId: string
  bindingHash: string
}>

export type Tm1ConsumedBroadcastAuthorizationEvidence = Readonly<{
  operationId: string
  capabilityId: string
  contentHash: `sha256:${string}`
  expiresAt: number
  consumedAt: number
  signedId: string
  txid: string
  signedArtifactHash: string
}>

export type Tm1DispatchIntentEvidence = Readonly<{
  submissionId: string
  txid: string
  signedArtifactHash: string
  broadcastCapabilityId: string
  committedAt: number
}>

export type Tm1TransportAcknowledgementEvidence = Readonly<{
  txid: string
  disposition: 'accepted'
  acknowledgedAt: number
}>

export type Tm1TransportAcknowledgementCommitEvidence = Readonly<{
  submissionId: string
  signedId: string
  txid: string
  signedArtifactHash: string
  disposition: 'accepted'
  acknowledgedAt: number
}>

export type Tm1RecoveryObservationEvidence = Readonly<
  | {
    status: 'absent' | 'mempool'
    txid: string
    observedAt: number
  }
  | {
    status: 'confirmed'
    txid: string
    observedAt: number
    confirmations: number
    blockHash: string
    blockHeight: number
  }
>

export type Tm1RecoveryTerminalEvidence = Readonly<{
  status: 'abandoned' | 'rejected' | 'expired' | 'failed'
  stage: 'preDispatch' | 'signing' | 'broadcast' | 'recovery'
  code: string
  recordedAt: number
}>

export type Tm1PublicationRecoveryRecord = Readonly<{
  schema: typeof TM1_PUBLICATION_RECOVERY_SCHEMA
  schemaVersion: typeof TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION
  publicationId: string
  revision: number
  ownerEpoch: number
  phase: Tm1PublicationRecoveryPhase
  preDispatchStage: Tm1RecoveryPreDispatchStage | null
  prepared: Tm1PreparedRecoveryEvidence | null
  signed: Tm1SignedRecoveryEvidence | null
  signingAuthorization: Tm1ConsumedSigningAuthorizationEvidence | null
  broadcastAuthorization: Tm1ConsumedBroadcastAuthorizationEvidence | null
  dispatchIntent: Tm1DispatchIntentEvidence | null
  transportAcknowledgement: Tm1TransportAcknowledgementEvidence | null
  lastObservation: Tm1RecoveryObservationEvidence | null
  terminal: Tm1RecoveryTerminalEvidence | null
}>

const RECORD_KEYS = [
  'schema',
  'schemaVersion',
  'publicationId',
  'revision',
  'ownerEpoch',
  'phase',
  'preDispatchStage',
  'prepared',
  'signed',
  'signingAuthorization',
  'broadcastAuthorization',
  'dispatchIntent',
  'transportAcknowledgement',
  'lastObservation',
  'terminal'
] as const

export function parseTm1PublicationRecoveryRecord(
  value: unknown
): Tm1PublicationRecoveryRecord {
  assertNoForbiddenAuthorityFields(value)
  const record = exactRecord(value, RECORD_KEYS)
  const schema = dataValue(record, 'schema')
  const schemaVersion = dataValue(record, 'schemaVersion')
  if (
    schema !== TM1_PUBLICATION_RECOVERY_SCHEMA ||
    schemaVersion !== TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION
  ) {
    throw new Tm1PublicationRecoveryError('UNSUPPORTED_RECOVERY_SCHEMA')
  }

  const snapshot: Tm1PublicationRecoveryRecord = Object.freeze({
    schema,
    schemaVersion,
    publicationId: requireIdentifier(dataValue(record, 'publicationId'), 'INVALID_PUBLICATION_ID'),
    revision: requireNonNegativeSafeInteger(dataValue(record, 'revision')),
    ownerEpoch: requireNonNegativeSafeInteger(dataValue(record, 'ownerEpoch')),
    phase: requirePhase(dataValue(record, 'phase')),
    preDispatchStage: parseNullable(
      dataValue(record, 'preDispatchStage'),
      requirePreDispatchStage
    ),
    prepared: parseNullable(dataValue(record, 'prepared'), parsePreparedEvidence),
    signed: parseNullable(dataValue(record, 'signed'), parseSignedEvidence),
    signingAuthorization: parseNullable(
      dataValue(record, 'signingAuthorization'),
      parseSigningAuthorizationEvidence
    ),
    broadcastAuthorization: parseNullable(
      dataValue(record, 'broadcastAuthorization'),
      parseBroadcastAuthorizationEvidence
    ),
    dispatchIntent: parseNullable(
      dataValue(record, 'dispatchIntent'),
      parseDispatchIntentEvidence
    ),
    transportAcknowledgement: parseNullable(
      dataValue(record, 'transportAcknowledgement'),
      parseTransportAcknowledgement
    ),
    lastObservation: parseNullable(
      dataValue(record, 'lastObservation'),
      parseObservationEvidence
    ),
    terminal: parseNullable(dataValue(record, 'terminal'), parseTerminalEvidence)
  })

  assertRecordInvariants(snapshot)
  return snapshot
}

export function consumedCapabilityIds(
  record: Tm1PublicationRecoveryRecord
): readonly string[] {
  return Object.freeze([
    ...(record.signingAuthorization === null
      ? []
      : [record.signingAuthorization.capabilityId]),
    ...(record.broadcastAuthorization === null
      ? []
      : [record.broadcastAuthorization.capabilityId])
  ])
}

export function isRecoverablePhase(phase: Tm1PublicationRecoveryPhase): boolean {
  return phase === 'preDispatch' ||
    phase === 'outcomeUnknown' ||
    phase === 'submittedObserved'
}

export function assertTm1RecoveryTransition(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  assertTransitionIdentity(previous, next)
  assertDurableEvidenceUnchanged(previous, next)

  if (previous.phase === 'preDispatch' && next.phase === 'abandoned') {
    if (
      previous.dispatchIntent !== null ||
      next.dispatchIntent !== null ||
      next.preDispatchStage !== null ||
      next.terminal?.status !== 'abandoned'
    ) failTransition()
    return
  }

  if (previous.phase === 'outcomeUnknown') {
    if (
      next.phase !== 'outcomeUnknown' &&
      next.phase !== 'submittedObserved' &&
      next.phase !== 'confirmedObserved'
    ) failTransition()
    if (
      (next.phase === 'outcomeUnknown' && next.lastObservation?.status !== 'absent') ||
      (next.phase === 'submittedObserved' && next.lastObservation?.status !== 'mempool') ||
      (next.phase === 'confirmedObserved' && next.lastObservation?.status !== 'confirmed')
    ) failTransition()
    return
  }

  if (previous.phase === 'submittedObserved') {
    if (next.phase !== 'submittedObserved' && next.phase !== 'confirmedObserved') {
      failTransition()
    }
    if (
      next.phase === 'submittedObserved' &&
      next.lastObservation?.status !== 'absent' &&
      next.lastObservation?.status !== 'mempool'
    ) failTransition()
    if (
      next.phase === 'confirmedObserved' &&
      next.lastObservation?.status !== 'confirmed'
    ) failTransition()
    return
  }

  failTransition()
}

export function assertTm1DispatchIntentTransition(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  assertTransitionIdentity(previous, next)
  if (
    previous.phase !== 'preDispatch' ||
    previous.preDispatchStage !== 'broadcastAuthorizationConsumed' ||
    previous.dispatchIntent !== null ||
    previous.broadcastAuthorization === null ||
    previous.signed === null ||
    next.phase !== 'outcomeUnknown' ||
    next.preDispatchStage !== null ||
    next.dispatchIntent === null ||
    next.transportAcknowledgement !== null ||
    next.lastObservation !== null ||
    next.terminal !== null
  ) failTransition()

  assertStableEvidence(previous.prepared, next.prepared)
  assertStableEvidence(previous.signed, next.signed)
  assertStableEvidence(previous.signingAuthorization, next.signingAuthorization)
  assertStableEvidence(previous.broadcastAuthorization, next.broadcastAuthorization)
}

export function createTm1TransportAcknowledgedRecord(
  previousValue: unknown,
  acknowledgementValue: unknown
): Tm1PublicationRecoveryRecord {
  const previous = parseTm1PublicationRecoveryRecord(previousValue)
  const acknowledgement = parseTm1TransportAcknowledgementCommitEvidence(
    acknowledgementValue
  )
  if (
    previous.phase !== 'outcomeUnknown' ||
    previous.dispatchIntent === null ||
    previous.signed === null ||
    previous.transportAcknowledgement !== null ||
    acknowledgement.submissionId !== previous.dispatchIntent.submissionId ||
    acknowledgement.signedId !== previous.signed.signedId ||
    acknowledgement.txid !== previous.dispatchIntent.txid ||
    acknowledgement.txid !== previous.signed.txid ||
    acknowledgement.signedArtifactHash !== previous.dispatchIntent.signedArtifactHash ||
    acknowledgement.signedArtifactHash !== previous.signed.signedArtifactHash ||
    acknowledgement.acknowledgedAt < previous.dispatchIntent.committedAt
  ) failTransition()

  const next = parseTm1PublicationRecoveryRecord({
    ...previous,
    revision: previous.revision + 1,
    phase: 'submittedObserved',
    transportAcknowledgement: {
      txid: acknowledgement.txid,
      disposition: acknowledgement.disposition,
      acknowledgedAt: acknowledgement.acknowledgedAt
    }
  })
  assertTm1TransportAcknowledgementTransition(previous, next)
  return next
}

export function assertTm1TransportAcknowledgementTransition(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  assertTransitionIdentity(previous, next)
  if (
    previous.phase !== 'outcomeUnknown' ||
    previous.dispatchIntent === null ||
    previous.signed === null ||
    previous.transportAcknowledgement !== null ||
    next.phase !== 'submittedObserved' ||
    next.transportAcknowledgement === null ||
    next.transportAcknowledgement.disposition !== 'accepted' ||
    next.transportAcknowledgement.txid !== previous.dispatchIntent.txid ||
    next.transportAcknowledgement.acknowledgedAt < previous.dispatchIntent.committedAt
  ) failTransition()

  assertStableEvidence(previous.prepared, next.prepared)
  assertStableEvidence(previous.signed, next.signed)
  assertStableEvidence(previous.signingAuthorization, next.signingAuthorization)
  assertStableEvidence(previous.broadcastAuthorization, next.broadcastAuthorization)
  assertStableEvidence(previous.dispatchIntent, next.dispatchIntent)
  assertStableEvidence(previous.lastObservation, next.lastObservation)
  assertStableEvidence(previous.terminal, next.terminal)
}

export function assertTm1ExecutionEvidenceTransition(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  assertTransitionIdentity(previous, next)
  if (previous.phase !== 'preDispatch' || next.phase !== 'preDispatch') {
    failTransition()
  }
  const previousOrder = preDispatchStageOrder(previous.preDispatchStage)
  const nextOrder = preDispatchStageOrder(next.preDispatchStage)
  if (nextOrder !== previousOrder + 1) failTransition()
  if (
    next.dispatchIntent !== null ||
    next.transportAcknowledgement !== null ||
    next.lastObservation !== null ||
    next.terminal !== null
  ) failTransition()
  assertStableOrAddedEvidence(previous.prepared, next.prepared)
  assertStableOrAddedEvidence(previous.signed, next.signed)
  assertStableOrAddedEvidence(previous.signingAuthorization, next.signingAuthorization)
  assertStableOrAddedEvidence(previous.broadcastAuthorization, next.broadcastAuthorization)
}

export function assertTm1OwnershipTransition(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  if (
    previous.schema !== next.schema ||
    previous.schemaVersion !== next.schemaVersion ||
    previous.publicationId !== next.publicationId ||
    next.revision !== previous.revision + 1 ||
    next.ownerEpoch <= previous.ownerEpoch
  ) failTransition()
  const expected = parseTm1PublicationRecoveryRecord({
    ...previous,
    revision: next.revision,
    ownerEpoch: next.ownerEpoch
  })
  if (JSON.stringify(expected) !== JSON.stringify(next)) failTransition()
}

function parsePreparedEvidence(value: unknown): Tm1PreparedRecoveryEvidence {
  const record = exactRecord(value, ['preparedId', 'bindingHash', 'preparedDigest'])
  return Object.freeze({
    preparedId: requireIdentifier(dataValue(record, 'preparedId')),
    bindingHash: requireCanonicalHash(dataValue(record, 'bindingHash')),
    preparedDigest: requireCanonicalHash(dataValue(record, 'preparedDigest'))
  })
}

function parseSignedEvidence(value: unknown): Tm1SignedRecoveryEvidence {
  const record = exactRecord(value, ['signedId', 'txid', 'signedArtifactHash'])
  return Object.freeze({
    signedId: requireIdentifier(dataValue(record, 'signedId')),
    txid: requireCanonicalHash(dataValue(record, 'txid')),
    signedArtifactHash: requireCanonicalHash(dataValue(record, 'signedArtifactHash'))
  })
}

function parseSigningAuthorizationEvidence(
  value: unknown
): Tm1ConsumedSigningAuthorizationEvidence {
  const record = exactRecord(value, [
    'operationId',
    'capabilityId',
    'contentHash',
    'expiresAt',
    'consumedAt',
    'preparedId',
    'bindingHash'
  ])
  const expiresAt = requireNonNegativeSafeInteger(dataValue(record, 'expiresAt'))
  const consumedAt = requireNonNegativeSafeInteger(dataValue(record, 'consumedAt'))
  if (consumedAt >= expiresAt) malformed()
  return Object.freeze({
    operationId: requireIdentifier(dataValue(record, 'operationId')),
    capabilityId: requireIdentifier(dataValue(record, 'capabilityId')),
    contentHash: requireUniversalContentHash(dataValue(record, 'contentHash')),
    expiresAt,
    consumedAt,
    preparedId: requireIdentifier(dataValue(record, 'preparedId')),
    bindingHash: requireCanonicalHash(dataValue(record, 'bindingHash'))
  })
}

function parseBroadcastAuthorizationEvidence(
  value: unknown
): Tm1ConsumedBroadcastAuthorizationEvidence {
  const record = exactRecord(value, [
    'operationId',
    'capabilityId',
    'contentHash',
    'expiresAt',
    'consumedAt',
    'signedId',
    'txid',
    'signedArtifactHash'
  ])
  const expiresAt = requireNonNegativeSafeInteger(dataValue(record, 'expiresAt'))
  const consumedAt = requireNonNegativeSafeInteger(dataValue(record, 'consumedAt'))
  if (consumedAt >= expiresAt) malformed()
  return Object.freeze({
    operationId: requireIdentifier(dataValue(record, 'operationId')),
    capabilityId: requireIdentifier(dataValue(record, 'capabilityId')),
    contentHash: requireUniversalContentHash(dataValue(record, 'contentHash')),
    expiresAt,
    consumedAt,
    signedId: requireIdentifier(dataValue(record, 'signedId')),
    txid: requireCanonicalHash(dataValue(record, 'txid')),
    signedArtifactHash: requireCanonicalHash(dataValue(record, 'signedArtifactHash'))
  })
}

function parseDispatchIntentEvidence(value: unknown): Tm1DispatchIntentEvidence {
  const record = exactRecord(value, [
    'submissionId',
    'txid',
    'signedArtifactHash',
    'broadcastCapabilityId',
    'committedAt'
  ])
  return Object.freeze({
    submissionId: requireIdentifier(dataValue(record, 'submissionId')),
    txid: requireCanonicalHash(dataValue(record, 'txid')),
    signedArtifactHash: requireCanonicalHash(dataValue(record, 'signedArtifactHash')),
    broadcastCapabilityId: requireIdentifier(dataValue(record, 'broadcastCapabilityId')),
    committedAt: requireNonNegativeSafeInteger(dataValue(record, 'committedAt'))
  })
}

function parseTransportAcknowledgement(
  value: unknown
): Tm1TransportAcknowledgementEvidence {
  const record = exactRecord(value, ['txid', 'disposition', 'acknowledgedAt'])
  if (dataValue(record, 'disposition') !== 'accepted') malformed()
  return Object.freeze({
    txid: requireCanonicalHash(dataValue(record, 'txid')),
    disposition: 'accepted',
    acknowledgedAt: requireNonNegativeSafeInteger(dataValue(record, 'acknowledgedAt'))
  })
}

export function parseTm1TransportAcknowledgementCommitEvidence(
  value: unknown
): Tm1TransportAcknowledgementCommitEvidence {
  assertNoForbiddenAuthorityFields(value)
  const record = exactRecord(value, [
    'submissionId',
    'signedId',
    'txid',
    'signedArtifactHash',
    'disposition',
    'acknowledgedAt'
  ])
  if (dataValue(record, 'disposition') !== 'accepted') malformed()
  return Object.freeze({
    submissionId: requireIdentifier(dataValue(record, 'submissionId')),
    signedId: requireIdentifier(dataValue(record, 'signedId')),
    txid: requireCanonicalHash(dataValue(record, 'txid')),
    signedArtifactHash: requireCanonicalHash(dataValue(record, 'signedArtifactHash')),
    disposition: 'accepted',
    acknowledgedAt: requireNonNegativeSafeInteger(dataValue(record, 'acknowledgedAt'))
  })
}

function parseObservationEvidence(value: unknown): Tm1RecoveryObservationEvidence {
  const status = readDiscriminator(value, 'status')
  if (status === 'absent' || status === 'mempool') {
    const record = exactRecord(value, ['status', 'txid', 'observedAt'])
    return Object.freeze({
      status,
      txid: requireCanonicalHash(dataValue(record, 'txid')),
      observedAt: requireNonNegativeSafeInteger(dataValue(record, 'observedAt'))
    })
  }
  if (status === 'confirmed') {
    const record = exactRecord(value, [
      'status',
      'txid',
      'observedAt',
      'confirmations',
      'blockHash',
      'blockHeight'
    ])
    const confirmations = requireNonNegativeSafeInteger(dataValue(record, 'confirmations'))
    if (confirmations <= 0) malformed()
    return Object.freeze({
      status,
      txid: requireCanonicalHash(dataValue(record, 'txid')),
      observedAt: requireNonNegativeSafeInteger(dataValue(record, 'observedAt')),
      confirmations,
      blockHash: requireCanonicalHash(dataValue(record, 'blockHash')),
      blockHeight: requireNonNegativeSafeInteger(dataValue(record, 'blockHeight'))
    })
  }
  return malformed()
}

function parseTerminalEvidence(value: unknown): Tm1RecoveryTerminalEvidence {
  const record = exactRecord(value, ['status', 'stage', 'code', 'recordedAt'])
  const status = dataValue(record, 'status')
  const stage = dataValue(record, 'stage')
  if (
    status !== 'abandoned' &&
    status !== 'rejected' &&
    status !== 'expired' &&
    status !== 'failed'
  ) malformed()
  if (
    stage !== 'preDispatch' &&
    stage !== 'signing' &&
    stage !== 'broadcast' &&
    stage !== 'recovery'
  ) malformed()
  return Object.freeze({
    status,
    stage,
    code: requireIdentifier(dataValue(record, 'code')),
    recordedAt: requireNonNegativeSafeInteger(dataValue(record, 'recordedAt'))
  })
}

function assertRecordInvariants(record: Tm1PublicationRecoveryRecord): void {
  assertAuthorizationBindings(record)
  assertDispatchBindings(record)
  assertObservationBindings(record)

  if (record.phase === 'preDispatch') {
    if (
      record.preDispatchStage === null ||
      record.prepared === null ||
      record.dispatchIntent !== null ||
      record.transportAcknowledgement !== null ||
      record.lastObservation !== null ||
      record.terminal !== null
    ) malformed()
    assertPreDispatchEvidence(record)
    return
  }

  if (record.preDispatchStage !== null) malformed()

  if (record.phase === 'abandoned') {
    if (
      record.dispatchIntent !== null ||
      record.transportAcknowledgement !== null ||
      record.lastObservation !== null ||
      record.terminal?.status !== 'abandoned' ||
      record.terminal.stage !== 'preDispatch'
    ) malformed()
    return
  }

  if (record.phase === 'failedTerminal') {
    if (
      record.dispatchIntent !== null ||
      record.transportAcknowledgement !== null ||
      record.lastObservation !== null ||
      record.terminal === null ||
      record.terminal.status === 'abandoned'
    ) malformed()
    return
  }

  if (
    record.dispatchIntent === null ||
    record.prepared === null ||
    record.signed === null ||
    record.signingAuthorization === null ||
    record.broadcastAuthorization === null ||
    record.terminal !== null
  ) malformed()

  if (record.phase === 'outcomeUnknown') {
    if (
      record.transportAcknowledgement !== null ||
      (record.lastObservation !== null && record.lastObservation.status !== 'absent')
    ) malformed()
    return
  }

  if (record.phase === 'submittedObserved') {
    if (
      record.transportAcknowledgement === null &&
      record.lastObservation === null
    ) malformed()
    if (record.lastObservation?.status === 'confirmed') malformed()
    return
  }

  if (
    record.phase !== 'confirmedObserved' ||
    record.lastObservation?.status !== 'confirmed'
  ) malformed()
}

function assertPreDispatchEvidence(record: Tm1PublicationRecoveryRecord): void {
  const stage = record.preDispatchStage
  const order = preDispatchStageOrder(stage)
  if (order < 0) malformed()
  if (order < 2 && record.signingAuthorization !== null) malformed()
  if (order >= 2 && record.signingAuthorization === null) malformed()
  if (order < 3 && record.signed !== null) malformed()
  if (order >= 3 && record.signed === null) malformed()
  if (order < 5 && record.broadcastAuthorization !== null) malformed()
  if (order >= 5 && record.broadcastAuthorization === null) malformed()
}

function assertAuthorizationBindings(record: Tm1PublicationRecoveryRecord): void {
  if (record.signingAuthorization !== null) {
    if (
      record.prepared === null ||
      record.signingAuthorization.preparedId !== record.prepared.preparedId ||
      record.signingAuthorization.bindingHash !== record.prepared.bindingHash
    ) malformed()
  }
  if (record.broadcastAuthorization !== null) {
    if (
      record.signed === null ||
      record.broadcastAuthorization.signedId !== record.signed.signedId ||
      record.broadcastAuthorization.txid !== record.signed.txid ||
      record.broadcastAuthorization.signedArtifactHash !== record.signed.signedArtifactHash
    ) malformed()
  }
  if (
    record.signingAuthorization !== null &&
    record.broadcastAuthorization !== null &&
    record.signingAuthorization.capabilityId === record.broadcastAuthorization.capabilityId
  ) malformed()
}

function assertDispatchBindings(record: Tm1PublicationRecoveryRecord): void {
  if (record.dispatchIntent === null) return
  if (
    record.signed === null ||
    record.broadcastAuthorization === null ||
    record.dispatchIntent.txid !== record.signed.txid ||
    record.dispatchIntent.signedArtifactHash !== record.signed.signedArtifactHash ||
    record.dispatchIntent.broadcastCapabilityId !== record.broadcastAuthorization.capabilityId ||
    record.dispatchIntent.committedAt < record.broadcastAuthorization.consumedAt
  ) malformed()
  if (
    record.transportAcknowledgement !== null &&
    (
      record.transportAcknowledgement.txid !== record.dispatchIntent.txid ||
      record.transportAcknowledgement.acknowledgedAt < record.dispatchIntent.committedAt
    )
  ) malformed()
}

function assertObservationBindings(record: Tm1PublicationRecoveryRecord): void {
  if (record.lastObservation === null) return
  if (
    record.dispatchIntent === null ||
    record.lastObservation.txid !== record.dispatchIntent.txid
  ) malformed()
}

function assertTransitionIdentity(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  if (
    previous.schema !== next.schema ||
    previous.schemaVersion !== next.schemaVersion ||
    previous.publicationId !== next.publicationId ||
    next.revision !== previous.revision + 1 ||
    next.ownerEpoch !== previous.ownerEpoch ||
    !hasValidDispatchAuthorizationOrdering(previous) ||
    !hasValidDispatchAuthorizationOrdering(next)
  ) failTransition()
}

function hasValidDispatchAuthorizationOrdering(
  record: Tm1PublicationRecoveryRecord
): boolean {
  if (record.dispatchIntent === null) return true
  return record.broadcastAuthorization !== null &&
    record.dispatchIntent.committedAt >= record.broadcastAuthorization.consumedAt
}

function assertDurableEvidenceUnchanged(
  previous: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord
): void {
  assertStableEvidence(previous.prepared, next.prepared)
  assertStableEvidence(previous.signed, next.signed)
  assertStableEvidence(previous.signingAuthorization, next.signingAuthorization)
  assertStableEvidence(previous.broadcastAuthorization, next.broadcastAuthorization)
  assertStableEvidence(previous.dispatchIntent, next.dispatchIntent)
  assertStableEvidence(previous.transportAcknowledgement, next.transportAcknowledgement)
}

function assertStableEvidence(left: unknown, right: unknown): void {
  if (!equalPlainEvidence(left, right)) failTransition()
}

function assertStableOrAddedEvidence(left: unknown, right: unknown): void {
  if (left !== null && !equalPlainEvidence(left, right)) failTransition()
}

function equalPlainEvidence(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => rightKeys.includes(key) && leftRecord[key] === rightRecord[key])
}

function preDispatchStageOrder(stage: Tm1RecoveryPreDispatchStage | null): number {
  switch (stage) {
    case 'prepared': return 0
    case 'signAuthorizationPending': return 1
    case 'signAuthorizationConsumed': return 2
    case 'signedAudited': return 3
    case 'broadcastAuthorizationPending': return 4
    case 'broadcastAuthorizationConsumed': return 5
    case null: return -1
  }
}

function requirePhase(value: unknown): Tm1PublicationRecoveryPhase {
  if (
    value !== 'preDispatch' &&
    value !== 'abandoned' &&
    value !== 'outcomeUnknown' &&
    value !== 'submittedObserved' &&
    value !== 'confirmedObserved' &&
    value !== 'failedTerminal'
  ) return malformed()
  return value
}

function requirePreDispatchStage(value: unknown): Tm1RecoveryPreDispatchStage {
  if (
    value !== 'prepared' &&
    value !== 'signAuthorizationPending' &&
    value !== 'signAuthorizationConsumed' &&
    value !== 'signedAudited' &&
    value !== 'broadcastAuthorizationPending' &&
    value !== 'broadcastAuthorizationConsumed'
  ) return malformed()
  return value
}

function requireIdentifier(
  value: unknown,
  code: Tm1PublicationRecoveryErrorCode = 'MALFORMED_RECOVERY_RECORD'
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) throw new Tm1PublicationRecoveryError(code)
  return value
}

function requireCanonicalHash(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_HASH.test(value)) return malformed()
  return value
}

function requireUniversalContentHash(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !UNIVERSAL_CONTENT_HASH.test(value)) return malformed()
  return value as `sha256:${string}`
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return malformed()
  }
  return value
}

function parseNullable<T>(value: unknown, parser: (candidate: unknown) => T): T | null {
  return value === null ? null : parser(value)
}

function readDiscriminator(value: unknown, key: string): unknown {
  const record = plainRecord(value)
  return dataValue(record, key)
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
    return malformed()
  }
  if (
    keys.some(key => typeof key !== 'string') ||
    keys.length !== expectedKeys.length ||
    expectedKeys.some(key => !keys.includes(key))
  ) return malformed()
  return record
}

function plainRecord(value: unknown): Record<PropertyKey, unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return malformed()
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    return malformed()
  }
  if (prototype !== Object.prototype && prototype !== null) return malformed()
  return value as Record<PropertyKey, unknown>
}

function dataValue(record: Record<PropertyKey, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key)
  } catch {
    return malformed()
  }
  if (!descriptor || !('value' in descriptor)) return malformed()
  return descriptor.value
}

function assertNoForbiddenAuthorityFields(value: unknown): void {
  const seen = new WeakSet<object>()
  const visit = (candidate: unknown, depth: number): void => {
    if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) {
      return
    }
    if (depth > MAX_RECORD_DEPTH || seen.has(candidate)) return malformed()
    seen.add(candidate)
    let keys: readonly PropertyKey[]
    try {
      keys = Reflect.ownKeys(candidate)
    } catch {
      return malformed()
    }
    for (const key of keys) {
      if (typeof key !== 'string') return malformed()
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (FORBIDDEN_AUTHORITY_FIELDS.has(normalizedKey)) {
        throw new Tm1PublicationRecoveryError('FORBIDDEN_AUTHORITY_FIELD')
      }
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key)
      } catch {
        return malformed()
      }
      if (!descriptor || !('value' in descriptor)) return malformed()
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
}

function failTransition(): never {
  throw new Tm1PublicationRecoveryError('INVALID_RECOVERY_TRANSITION')
}

function malformed(): never {
  throw new Tm1PublicationRecoveryError('MALFORMED_RECOVERY_RECORD')
}
