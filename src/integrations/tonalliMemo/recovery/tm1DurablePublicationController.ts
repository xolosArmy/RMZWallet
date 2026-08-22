import type {
  Tm1PublicationApplicationPort,
  Tm1RecoveryCommandVersion
} from './tm1PublicationApplicationPort'
import {
  Tm1RecoveryObservationError,
  parseTm1RecoveryObservation,
  type Tm1ChronikRecoveryObserver,
  type Tm1RecoveryObservation
} from './tm1ChronikRecoveryObserver'
import {
  Tm1PublicationRecoveryError,
  assertTm1RecoveryTransition,
  isRecoverablePhase,
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord,
  type Tm1RecoveryObservationEvidence
} from './tm1PublicationRecoveryModel'
import {
  Tm1PublicationRecoveryStoreError,
  type Tm1PublicationRecoveryStore
} from './tm1PublicationRecoveryStore'

const MAX_IDENTIFIER_LENGTH = 256

export type Tm1DurablePublicationControllerErrorCode =
  | 'INVALID_CONTROLLER_CONFIGURATION'
  | 'INVALID_RECOVERY_COMMAND'
  | 'INVALID_RECOVERY_STATE'
  | 'INVALID_RECOVERY_OBSERVATION'
  | 'OBSERVATION_UNAVAILABLE'
  | 'OPERATION_ABORTED'
  | 'PUBLICATION_NOT_FOUND'
  | 'RECOVERY_STORE_FAILED'

export class Tm1DurablePublicationControllerError extends Error {
  readonly code: Tm1DurablePublicationControllerErrorCode

  constructor(code: Tm1DurablePublicationControllerErrorCode) {
    super(code)
    this.name = 'Tm1DurablePublicationControllerError'
    this.code = code
  }
}

export type Tm1DurablePublicationControllerDependencies = Readonly<{
  store: Tm1PublicationRecoveryStore
  observer: Tm1ChronikRecoveryObserver
  now?: () => number
}>

export function createTm1DurablePublicationController(
  dependencies: Tm1DurablePublicationControllerDependencies
): Tm1PublicationApplicationPort {
  const bindings = snapshotDependencies(dependencies)

  const getPublication = async (
    publicationId: string
  ): Promise<Tm1PublicationRecoveryRecord> => loadRecord(bindings, publicationId)

  const listRecoverablePublications = async (): Promise<readonly Tm1PublicationRecoveryRecord[]> => {
    let result: unknown
    try {
      result = await bindings.listRecoverable()
    } catch (error) {
      throw normalizeStoreError(error)
    }
    const records = snapshotUnknownList(result).map(parseTm1PublicationRecoveryRecord)
    const publicationIds = new Set(records.map(record => record.publicationId))
    if (publicationIds.size !== records.length) fail('RECOVERY_STORE_FAILED')
    return Object.freeze(records.filter(record => isRecoverablePhase(record.phase)))
  }

  const abandonInterruptedPublication = async (
    commandValue: Tm1RecoveryCommandVersion
  ): Promise<Tm1PublicationRecoveryRecord> => {
    const command = snapshotCommand(commandValue)
    assertNotAborted(command.signal)
    const current = await loadRecord(bindings, command.publicationId)
    assertCommandVersion(current, command)
    if (current.phase !== 'preDispatch' || current.dispatchIntent !== null) {
      fail('INVALID_RECOVERY_STATE')
    }
    const next = parseTm1PublicationRecoveryRecord({
      ...current,
      revision: current.revision + 1,
      phase: 'abandoned',
      preDispatchStage: null,
      terminal: Object.freeze({
        status: 'abandoned',
        stage: 'preDispatch',
        code: 'PROCESS_INTERRUPTED',
        recordedAt: readNow(bindings.now)
      })
    })
    assertNotAborted(command.signal)
    return commitRecoveryTransition(bindings, current, next, command)
  }

  const reconcile = async (
    commandValue: Tm1RecoveryCommandVersion
  ): Promise<Tm1PublicationRecoveryRecord> => {
    const command = snapshotCommand(commandValue)
    assertNotAborted(command.signal)
    const current = await loadRecord(bindings, command.publicationId)
    assertCommandVersion(current, command)
    if (current.phase !== 'outcomeUnknown') fail('INVALID_RECOVERY_STATE')
    return observeAndCommit(bindings, current, command)
  }

  const observeConfirmation = async (
    commandValue: Tm1RecoveryCommandVersion
  ): Promise<Tm1PublicationRecoveryRecord> => {
    const command = snapshotCommand(commandValue)
    assertNotAborted(command.signal)
    const current = await loadRecord(bindings, command.publicationId)
    assertCommandVersion(current, command)
    if (current.phase !== 'submittedObserved') fail('INVALID_RECOVERY_STATE')
    return observeAndCommit(bindings, current, command)
  }

  return Object.freeze({
    getPublication,
    listRecoverablePublications,
    abandonInterruptedPublication,
    reconcile,
    observeConfirmation
  })
}

type SafeDependencies = Readonly<{
  load: Tm1PublicationRecoveryStore['load']
  listRecoverable: Tm1PublicationRecoveryStore['listRecoverable']
  commitRecoveryTransition: Tm1PublicationRecoveryStore['commitRecoveryTransition']
  observe: Tm1ChronikRecoveryObserver['observe']
  now: () => number
}>

function snapshotDependencies(
  dependencies: Tm1DurablePublicationControllerDependencies
): SafeDependencies {
  if (!dependencies || typeof dependencies !== 'object') {
    fail('INVALID_CONTROLLER_CONFIGURATION')
  }
  const store = dependencies.store
  const observer = dependencies.observer
  if (
    !store ||
    typeof store.load !== 'function' ||
    typeof store.listRecoverable !== 'function' ||
    typeof store.commitRecoveryTransition !== 'function' ||
    !observer ||
    typeof observer.observe !== 'function' ||
    dependencies.now !== undefined && typeof dependencies.now !== 'function'
  ) fail('INVALID_CONTROLLER_CONFIGURATION')
  return Object.freeze({
    load: store.load.bind(store),
    listRecoverable: store.listRecoverable.bind(store),
    commitRecoveryTransition: store.commitRecoveryTransition.bind(store),
    observe: observer.observe.bind(observer),
    now: dependencies.now ?? Date.now
  })
}

async function loadRecord(
  dependencies: SafeDependencies,
  publicationIdValue: unknown
): Promise<Tm1PublicationRecoveryRecord> {
  const publicationId = requireIdentifier(publicationIdValue)
  let value: unknown | null
  try {
    value = await dependencies.load(publicationId)
  } catch (error) {
    throw normalizeStoreError(error)
  }
  if (value === null) fail('PUBLICATION_NOT_FOUND')
  const record = parseTm1PublicationRecoveryRecord(value)
  if (record.publicationId !== publicationId) fail('RECOVERY_STORE_FAILED')
  return record
}

async function observeAndCommit(
  dependencies: SafeDependencies,
  current: Tm1PublicationRecoveryRecord,
  command: Tm1RecoveryCommandVersion
): Promise<Tm1PublicationRecoveryRecord> {
  assertNotAborted(command.signal)
  const dispatchIntent = current.dispatchIntent
  if (dispatchIntent === null) fail('INVALID_RECOVERY_STATE')
  let observationResult: unknown
  try {
    observationResult = await dependencies.observe(Object.freeze({
      txid: dispatchIntent.txid,
      ...(command.signal === undefined ? {} : { signal: command.signal })
    }))
  } catch (error) {
    throw normalizeObservationError(error, command.signal)
  }
  assertNotAborted(command.signal)
  let observation: Tm1RecoveryObservation
  try {
    observation = parseTm1RecoveryObservation(observationResult, dispatchIntent.txid)
  } catch (error) {
    throw normalizeObservationError(error, command.signal)
  }
  const observedAt = readNow(dependencies.now)
  const observationEvidence = snapshotObservation(observation, observedAt)
  const phase = observation.status === 'confirmed'
    ? 'confirmedObserved'
    : observation.status === 'mempool'
      ? 'submittedObserved'
      : current.phase
  const next = parseTm1PublicationRecoveryRecord({
    ...current,
    revision: current.revision + 1,
    phase,
    lastObservation: observationEvidence
  })
  assertNotAborted(command.signal)
  return commitRecoveryTransition(dependencies, current, next, command)
}

async function commitRecoveryTransition(
  dependencies: SafeDependencies,
  current: Tm1PublicationRecoveryRecord,
  next: Tm1PublicationRecoveryRecord,
  command: Tm1RecoveryCommandVersion
): Promise<Tm1PublicationRecoveryRecord> {
  assertTm1RecoveryTransition(current, next)
  let committed: unknown
  try {
    committed = await dependencies.commitRecoveryTransition(Object.freeze({
      publicationId: current.publicationId,
      expectedRevision: command.expectedRevision,
      expectedOwnerEpoch: command.expectedOwnerEpoch,
      nextRecord: next
    }))
  } catch (error) {
    throw normalizeStoreError(error)
  }
  const snapshot = parseTm1PublicationRecoveryRecord(committed)
  assertTm1RecoveryTransition(current, snapshot)
  if (JSON.stringify(snapshot) !== JSON.stringify(next)) {
    fail('RECOVERY_STORE_FAILED')
  }
  return snapshot
}

function snapshotObservation(
  observation: Tm1RecoveryObservation,
  observedAt: number
): Tm1RecoveryObservationEvidence {
  if (observation.status === 'confirmed') {
    return Object.freeze({
      status: observation.status,
      txid: observation.txid,
      observedAt,
      confirmations: observation.confirmations,
      blockHash: observation.blockHash,
      blockHeight: observation.blockHeight
    })
  }
  return Object.freeze({
    status: observation.status,
    txid: observation.txid,
    observedAt
  })
}

function snapshotCommand(value: unknown): Tm1RecoveryCommandVersion {
  const record = plainRecord(value)
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(record)
  } catch {
    return fail('INVALID_RECOVERY_COMMAND')
  }
  if (
    keys.some(key => typeof key !== 'string') ||
    keys.some(key => ![
      'publicationId',
      'expectedRevision',
      'expectedOwnerEpoch',
      'signal'
    ].includes(key as string)) ||
    !keys.includes('publicationId') ||
    !keys.includes('expectedRevision') ||
    !keys.includes('expectedOwnerEpoch')
  ) fail('INVALID_RECOVERY_COMMAND')
  const signal = keys.includes('signal') ? dataValue(record, 'signal') : undefined
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail('INVALID_RECOVERY_COMMAND')
  }
  return Object.freeze({
    publicationId: requireIdentifier(dataValue(record, 'publicationId')),
    expectedRevision: requireNonNegativeSafeInteger(dataValue(record, 'expectedRevision')),
    expectedOwnerEpoch: requireNonNegativeSafeInteger(dataValue(record, 'expectedOwnerEpoch')),
    ...(signal === undefined ? {} : { signal })
  })
}

function assertCommandVersion(
  record: Tm1PublicationRecoveryRecord,
  command: Tm1RecoveryCommandVersion
): void {
  if (record.revision !== command.expectedRevision) {
    throw new Tm1PublicationRecoveryStoreError('REVISION_MISMATCH')
  }
  if (record.ownerEpoch !== command.expectedOwnerEpoch) {
    throw new Tm1PublicationRecoveryStoreError('STALE_OWNER_EPOCH')
  }
  assertNotAborted(command.signal)
}

function snapshotUnknownList(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail('RECOVERY_STORE_FAILED')
  let length: number
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!descriptor || !('value' in descriptor)) fail('RECOVERY_STORE_FAILED')
    length = descriptor.value as number
  } catch (error) {
    if (error instanceof Tm1DurablePublicationControllerError) throw error
    return fail('RECOVERY_STORE_FAILED')
  }
  if (!Number.isSafeInteger(length) || length < 0) fail('RECOVERY_STORE_FAILED')
  const snapshot: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    snapshot.push(dataValue(value as unknown as Record<PropertyKey, unknown>, String(index)))
  }
  return Object.freeze(snapshot)
}

function normalizeStoreError(error: unknown): Error {
  if (
    error instanceof Tm1PublicationRecoveryStoreError ||
    error instanceof Tm1PublicationRecoveryError ||
    error instanceof Tm1DurablePublicationControllerError
  ) return error
  return new Tm1DurablePublicationControllerError('RECOVERY_STORE_FAILED')
}

function normalizeObservationError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) {
    return new Tm1DurablePublicationControllerError('OPERATION_ABORTED')
  }
  if (error instanceof Tm1RecoveryObservationError) {
    if (error.code === 'OPERATION_ABORTED') {
      return new Tm1DurablePublicationControllerError('OPERATION_ABORTED')
    }
    if (error.code === 'INVALID_RECOVERY_OBSERVATION') {
      return new Tm1DurablePublicationControllerError('INVALID_RECOVERY_OBSERVATION')
    }
  }
  return new Tm1DurablePublicationControllerError('OBSERVATION_UNAVAILABLE')
}

function readNow(now: () => number): number {
  let value: unknown
  try {
    value = now()
  } catch {
    return fail('INVALID_CONTROLLER_CONFIGURATION')
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('INVALID_CONTROLLER_CONFIGURATION')
  }
  return value
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('OPERATION_ABORTED')
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) return fail('INVALID_RECOVERY_COMMAND')
  return value
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('INVALID_RECOVERY_COMMAND')
  }
  return value
}

function plainRecord(value: unknown): Record<PropertyKey, unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return fail('INVALID_RECOVERY_COMMAND')
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    return fail('INVALID_RECOVERY_COMMAND')
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('INVALID_RECOVERY_COMMAND')
  }
  return value as Record<PropertyKey, unknown>
}

function dataValue(record: Record<PropertyKey, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key)
  } catch {
    return fail('INVALID_RECOVERY_COMMAND')
  }
  if (!descriptor || !('value' in descriptor)) fail('INVALID_RECOVERY_COMMAND')
  return descriptor.value
}

function fail(code: Tm1DurablePublicationControllerErrorCode): never {
  throw new Tm1DurablePublicationControllerError(code)
}
