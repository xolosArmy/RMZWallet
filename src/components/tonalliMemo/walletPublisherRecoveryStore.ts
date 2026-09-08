import { sha256, toHex } from 'ecash-lib'
import {
  parseTm1PublicationRecoveryRecord,
  assertTm1ExecutionEvidenceTransition,
  assertTm1DispatchIntentTransition,
  createTm1TransportAcknowledgedRecord,
  assertTm1TransportAcknowledgementTransition,
  assertTm1RecoveryTransition,
  assertTm1OwnershipTransition,
  consumedCapabilityIds,
  type Tm1PublicationRecoveryRecord
} from '../../integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'
import {
  Tm1PublicationRecoveryStoreError,
  type Tm1PublicationRecoveryStore,
  type Tm1RecoveryStoreCreate,
  type Tm1RecoveryStoreExecutionCommit,
  type Tm1RecoveryStoreDispatchIntentCommit,
  type Tm1RecoveryStoreTransportAcknowledgementCommit,
  type Tm1RecoveryStoreRecoveryCommit,
  type Tm1RecoveryStoreOwnershipClaim
} from '../../integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'

export interface Tm1ProductionRecoveryStoreOptions {
  address?: string | null
  storageKey?: string
  storage?: Storage | null
  initialRecords?: readonly Tm1PublicationRecoveryRecord[]
}

const DEFAULT_STORAGE_KEY_PREFIX = 'rmzwallet_tm1_recovery'

function getSafeStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

function sha256Hex(data: string | Uint8Array): string {
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
  const compareStringsCodeUnit = (a: string, b: string): number => {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }

  const sortedRecords = [...input.records].sort((a, b) =>
    compareStringsCodeUnit(a.publicationId, b.publicationId)
  )

  const publications = sortedRecords.map((record) => {
    const recordJson = JSON.stringify(record)
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
  const uniqueCapabilities = [...new Set(rawCapabilities)].sort(compareStringsCodeUnit)
  const sortedCapabilities = uniqueCapabilities.map((id) =>
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

  return sha256Hex(JSON.stringify(logicalState))
}

/**
 * Production-ready durable publication recovery store for browser wallet environments.
 * Persists records atomically to web storage (localStorage) keyed per address while
 * enforcing monotonic transitions, schema validation, and CAS revisions.
 */
export class Tm1WebStoragePublicationRecoveryStore implements Tm1PublicationRecoveryStore {
  readonly storeId: string
  readonly createdAt: number
  private readonly storage: Storage | null
  private readonly storageKey: string
  private readonly records = new Map<string, Tm1PublicationRecoveryRecord>()
  private readonly capabilityIds = new Set<string>()
  private witnessBinding: {
    slotId: string
    storeId: string
    generation: number
    logicalRoot: string
  } | null = null

  constructor(options: Tm1ProductionRecoveryStoreOptions = {}) {
    this.createdAt = Date.now()
    this.storage = options.storage !== undefined ? options.storage : getSafeStorage()

    const sanitizedAddress = options.address
      ? options.address.toLowerCase().replace(/^ecash:/, '').replace(/[^a-z0-9]/g, '')
      : ''
    this.storageKey =
      options.storageKey ??
      (sanitizedAddress
        ? `${DEFAULT_STORAGE_KEY_PREFIX}_${sanitizedAddress}`
        : `${DEFAULT_STORAGE_KEY_PREFIX}_global`)

    this.storeId = `tm1-store:v1:${sha256Hex(`tm1-production-store:${this.storageKey}:${this.createdAt}`)}`

    // Load persisted records from storage if present
    this.loadFromStorage()

    // Insert any initial records passed in options
    if (options.initialRecords) {
      for (const rec of options.initialRecords) {
        this.insertInitial(rec)
      }
      this.persist()
    }
  }

  private loadFromStorage(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(this.storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          try {
            const record = parseTm1PublicationRecoveryRecord(item)
            this.records.set(record.publicationId, record)
            for (const capId of consumedCapabilityIds(record)) {
              this.capabilityIds.add(capId)
            }
          } catch {
            // ignore malformed record entry
          }
        }
      }
    } catch {
      // safe fallback if storage read fails
    }
  }

  private persist(): void {
    if (!this.storage) return
    try {
      const allRecords = [...this.records.values()]
      this.storage.setItem(this.storageKey, JSON.stringify(allRecords))
    } catch {
      // safe fallback on quota or storage write failure
    }
  }

  getStoreId(): string {
    return this.storeId
  }

  getAllRecords(): readonly Tm1PublicationRecoveryRecord[] {
    return Object.freeze([...this.records.values()].map((r) => deepClone(r)))
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
  }): { slotId: string; storeId: string; generation: number; logicalRoot: string } {
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
    return this.witnessBinding
  }

  computeProjectedWitnessLogicalRoot(
    projectedRecord: unknown,
    generation?: number
  ): string {
    const parsed = parseTm1PublicationRecoveryRecord(projectedRecord)
    const effectiveRecords = [
      ...[...this.records.values()].filter(
        (r) => r.publicationId !== parsed.publicationId
      ),
      parsed
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
      slotId: `slot:${this.storeId}`,
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
      slotId: `slot:${this.storeId}`,
      generation,
      createdAt: this.createdAt,
      records: [...this.records.values()],
      capabilityIds: [...this.capabilityIds]
    })
  }

  async load(publicationId: string): Promise<unknown | null> {
    const record = this.records.get(publicationId)
    return record ? deepClone(record) : null
  }

  async listRecoverable(): Promise<unknown> {
    return [...this.records.values()].map((r) => deepClone(r))
  }

  async create(input: Tm1RecoveryStoreCreate): Promise<unknown> {
    const record = parseTm1PublicationRecoveryRecord(input.record)
    if (this.records.has(record.publicationId)) {
      throw new Tm1PublicationRecoveryStoreError('DUPLICATE_PUBLICATION_ID')
    }
    this.reserveCapabilities(consumedCapabilityIds(record))
    this.records.set(record.publicationId, record)
    this.persist()
    return deepClone(record)
  }

  async commitExecutionEvidence(
    input: Tm1RecoveryStoreExecutionCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1ExecutionEvidenceTransition(current, next)
    const expectedNew = consumedCapabilityIds(next).filter(
      (id) => !consumedCapabilityIds(current).includes(id)
    )
    this.reserveCapabilities(expectedNew)
    this.records.set(current.publicationId, next)
    this.persist()
    return deepClone(next)
  }

  async commitDispatchIntent(
    input: Tm1RecoveryStoreDispatchIntentCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1DispatchIntentTransition(current, next)
    this.records.set(current.publicationId, next)
    this.persist()
    return deepClone(next)
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
    this.persist()
    return deepClone(next)
  }

  async commitRecoveryTransition(
    input: Tm1RecoveryStoreRecoveryCommit
  ): Promise<unknown> {
    const current = this.current(input)
    const next = parseTm1PublicationRecoveryRecord(input.nextRecord)
    assertTm1RecoveryTransition(current, next)
    this.records.set(current.publicationId, next)
    this.persist()
    return deepClone(next)
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
    this.persist()
    return deepClone(next)
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

export const Tm1ProductionRecoveryStore = Tm1WebStoragePublicationRecoveryStore
export type Tm1ProductionRecoveryStore = Tm1WebStoragePublicationRecoveryStore
export const Tm1SqlitePublicationRecoveryStore = Tm1WebStoragePublicationRecoveryStore
export type Tm1SqlitePublicationRecoveryStore = Tm1WebStoragePublicationRecoveryStore

export function createTm1ProductionRecoveryStore(
  options: Tm1ProductionRecoveryStoreOptions = {}
): Tm1ProductionRecoveryStore {
  return new Tm1ProductionRecoveryStore(options)
}
