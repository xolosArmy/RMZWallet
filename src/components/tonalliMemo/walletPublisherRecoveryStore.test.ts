/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  Tm1ProductionRecoveryStore
} from './walletPublisherRecoveryStore'
import {
  TM1_PUBLICATION_RECOVERY_SCHEMA,
  TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION,
  parseTm1PublicationRecoveryRecord,
  type Tm1PublicationRecoveryRecord
} from '../../integrations/tonalliMemo/recovery/tm1PublicationRecoveryModel'

function createSamplePreDispatchRecord(
  publicationId: string
): Tm1PublicationRecoveryRecord {
  const now = Date.now()
  const hash = 'a'.repeat(64)
  return parseTm1PublicationRecoveryRecord({
    schema: TM1_PUBLICATION_RECOVERY_SCHEMA,
    schemaVersion: TM1_PUBLICATION_RECOVERY_SCHEMA_VERSION,
    publicationId,
    revision: 1,
    ownerEpoch: 1,
    phase: 'preDispatch',
    preDispatchStage: 'broadcastAuthorizationConsumed',
    prepared: {
      preparedId: publicationId,
      bindingHash: hash,
      preparedDigest: hash
    },
    signed: {
      signedId: `signed:${publicationId}`,
      txid: hash,
      signedArtifactHash: hash
    },
    signingAuthorization: {
      operationId: `op:sign:${publicationId}`,
      capabilityId: `cap:sign:${publicationId}`,
      contentHash: `sha256:${hash}`,
      expiresAt: now + 3600000,
      consumedAt: now,
      preparedId: publicationId,
      bindingHash: hash
    },
    broadcastAuthorization: {
      operationId: `op:broadcast:${publicationId}`,
      capabilityId: `cap:broadcast:${publicationId}`,
      contentHash: `sha256:${hash}`,
      expiresAt: now + 3600000,
      consumedAt: now,
      signedId: `signed:${publicationId}`,
      txid: hash,
      signedArtifactHash: hash
    },
    dispatchIntent: null,
    transportAcknowledgement: null,
    lastObservation: null,
    terminal: null
  })
}

function createSampleOutcomeUnknownRecord(
  preDispatch: Tm1PublicationRecoveryRecord
): Tm1PublicationRecoveryRecord {
  return parseTm1PublicationRecoveryRecord({
    ...preDispatch,
    revision: 2,
    phase: 'outcomeUnknown',
    preDispatchStage: null,
    dispatchIntent: {
      submissionId: `sub:${preDispatch.publicationId}`,
      txid: preDispatch.signed!.txid,
      signedArtifactHash: preDispatch.signed!.signedArtifactHash,
      broadcastCapabilityId: preDispatch.broadcastAuthorization!.capabilityId,
      committedAt: preDispatch.broadcastAuthorization!.consumedAt + 10
    }
  })
}

describe('Tm1WebStoragePublicationRecoveryStore durability and error propagation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('propagates QuotaExceeded when window.localStorage.setItem throws and keeps in-memory state unaltered', async () => {
    const testAddress = 'ecash:qzlocaluser'
    const pubId = 'pub-localstorage-quota'
    const initialRecord = createSamplePreDispatchRecord(pubId)

    // Store is initialized with initialRecord successfully
    const store = new Tm1ProductionRecoveryStore({
      address: testAddress,
      storage: window.localStorage,
      initialRecords: [initialRecord]
    })

    const initialLoaded = (await store.load(pubId)) as Tm1PublicationRecoveryRecord
    expect(initialLoaded).toBeDefined()
    expect(initialLoaded.phase).toBe('preDispatch')
    expect(initialLoaded.revision).toBe(1)
    expect(initialLoaded.dispatchIntent).toBeNull()

    // Intercept localStorage.setItem to force a QuotaExceeded error
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })

    const nextRecord = createSampleOutcomeUnknownRecord(initialRecord)

    // commitDispatchIntent MUST fail by throwing the QuotaExceeded error
    await expect(
      store.commitDispatchIntent({
        publicationId: pubId,
        expectedRevision: 1,
        expectedOwnerEpoch: 1,
        nextRecord
      })
    ).rejects.toThrow('QuotaExceeded')

    // Verify in-memory state was NOT mutated
    const loadedAfterFailure = (await store.load(pubId)) as Tm1PublicationRecoveryRecord
    expect(loadedAfterFailure).toBeDefined()
    expect(loadedAfterFailure.phase).toBe('preDispatch')
    expect(loadedAfterFailure.revision).toBe(1)
    expect(loadedAfterFailure.dispatchIntent).toBeNull()

    // Verify getAllRecords returns pristine in-memory snapshot
    const allRecords = store.getAllRecords()
    expect(allRecords).toHaveLength(1)
    expect(allRecords[0].phase).toBe('preDispatch')
    expect(allRecords[0].revision).toBe(1)
    expect(allRecords[0].dispatchIntent).toBeNull()

    setItemSpy.mockRestore()
  })

  it('propagates QuotaExceeded when custom mock storage.setItem throws during commitDispatchIntent', async () => {
    const storageMap = new Map<string, string>()
    const mockStorage: Storage = {
      getItem: vi.fn((k: string) => storageMap.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        storageMap.set(k, v)
      }),
      removeItem: vi.fn((k: string) => {
        storageMap.delete(k)
      }),
      clear: vi.fn(() => {
        storageMap.clear()
      }),
      key: vi.fn((i: number) => [...storageMap.keys()][i] ?? null),
      length: 0
    }

    const testAddress = 'ecash:qzmockuser'
    const pubId = 'pub-custom-mock-quota'
    const initialRecord = createSamplePreDispatchRecord(pubId)

    const store = new Tm1ProductionRecoveryStore({
      address: testAddress,
      storage: mockStorage,
      initialRecords: [initialRecord]
    })

    // Now force setItem to throw QuotaExceeded
    vi.mocked(mockStorage.setItem).mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })

    const nextRecord = createSampleOutcomeUnknownRecord(initialRecord)

    await expect(
      store.commitDispatchIntent({
        publicationId: pubId,
        expectedRevision: 1,
        expectedOwnerEpoch: 1,
        nextRecord
      })
    ).rejects.toThrow('QuotaExceeded')

    // In-memory record must remain at revision 1 and phase preDispatch
    const loaded = (await store.load(pubId)) as Tm1PublicationRecoveryRecord
    expect(loaded.phase).toBe('preDispatch')
    expect(loaded.revision).toBe(1)
    expect(loaded.dispatchIntent).toBeNull()
  })

  it('fails atomically on create when storage.setItem throws without creating in-memory record', async () => {
    const storageMap = new Map<string, string>()
    const mockStorage: Storage = {
      getItem: vi.fn((k: string) => storageMap.get(k) ?? null),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceeded')
      }),
      removeItem: vi.fn((k: string) => {
        storageMap.delete(k)
      }),
      clear: vi.fn(() => {
        storageMap.clear()
      }),
      key: vi.fn((i: number) => [...storageMap.keys()][i] ?? null),
      length: 0
    }

    const store = new Tm1ProductionRecoveryStore({
      address: 'ecash:qzatomiccreate',
      storage: mockStorage
    })

    const newRecord = createSamplePreDispatchRecord('pub-atomic-1')

    await expect(store.create({ record: newRecord })).rejects.toThrow('QuotaExceeded')

    // Record should not exist in memory
    expect(await store.load('pub-atomic-1')).toBeNull()
    expect(store.getAllRecords()).toHaveLength(0)
    expect(store.getAllCapabilityIds()).toHaveLength(0)
  })

  it('filters recoverable publications by address and returns all recoverable if no address query provided', async () => {
    const storeA = new Tm1ProductionRecoveryStore({
      address: 'ecash:qzaddressA',
      storage: window.localStorage
    })

    const preA = createSamplePreDispatchRecord('pub-a')
    const recA = createSampleOutcomeUnknownRecord(preA)

    await storeA.create({ record: preA })
    await storeA.commitDispatchIntent({
      publicationId: 'pub-a',
      expectedRevision: 1,
      expectedOwnerEpoch: 1,
      nextRecord: recA
    })

    // Filter by matching address A
    const listMatching = (await storeA.listRecoverable({ address: 'ecash:qzaddressA' })) as Tm1PublicationRecoveryRecord[]
    expect(listMatching).toHaveLength(1)
    expect(listMatching[0].publicationId).toBe('pub-a')

    // Filter by mismatching address B returns empty
    const listMismatch = (await storeA.listRecoverable({ address: 'ecash:qzaddressB' })) as Tm1PublicationRecoveryRecord[]
    expect(listMismatch).toHaveLength(0)

    // Query without address filter returns all
    const listAll = (await storeA.listRecoverable()) as Tm1PublicationRecoveryRecord[]
    expect(listAll).toHaveLength(1)
  })

  it('fails closed and throws Durable storage unavailable on any mutation when storage is null', async () => {
    const store = new Tm1ProductionRecoveryStore({
      address: 'ecash:qznullstorage',
      storage: null
    })

    const record = createSamplePreDispatchRecord('pub-fail-closed')

    // create() must fail closed
    await expect(store.create({ record })).rejects.toThrow('Durable storage unavailable')

    // commitDispatchIntent() must fail closed
    await expect(
      store.commitDispatchIntent({
        publicationId: 'pub-fail-closed',
        expectedRevision: 1,
        expectedOwnerEpoch: 1,
        nextRecord: record
      })
    ).rejects.toThrow('Durable storage unavailable')

    // remove() must fail closed
    await expect(store.remove('pub-fail-closed')).rejects.toThrow('Durable storage unavailable')

    // clear() must fail closed
    await expect(store.clear()).rejects.toThrow('Durable storage unavailable')

    // In-memory state must remain completely unaltered and empty
    expect(await store.load('pub-fail-closed')).toBeNull()
    expect(store.getAllRecords()).toHaveLength(0)
    expect(store.getAllCapabilityIds()).toHaveLength(0)
  })

  it('serializes cross-tab updates using Read-Modify-Write to avoid overwriting concurrent tab records', async () => {
    const testAddress = 'ecash:qztabuser'
    // Tab A initializes its store
    const storeTabA = new Tm1ProductionRecoveryStore({
      address: testAddress,
      storage: window.localStorage
    })
    const storageKey = storeTabA.getStorageKey()

    // Simulate Tab B writing a publication record directly into localStorage concurrently
    const recordFromTabB = createSamplePreDispatchRecord('pub-from-tab-b')
    window.localStorage.setItem(storageKey, JSON.stringify([recordFromTabB]))

    // Tab A creates its own publication record 'pub-from-tab-a'
    const recordFromTabA = createSamplePreDispatchRecord('pub-from-tab-a')
    await storeTabA.create({ record: recordFromTabA })

    // Verify localStorage contains BOTH records (Tab B was not clobbered by Tab A)
    const rawStorage = window.localStorage.getItem(storageKey)
    expect(rawStorage).toBeDefined()
    const storedRecords = JSON.parse(rawStorage!)
    expect(storedRecords).toHaveLength(2)

    const storedIds = storedRecords.map((r: any) => r.publicationId).sort()
    expect(storedIds).toEqual(['pub-from-tab-a', 'pub-from-tab-b'])

    // Verify Tab A's store can also load Tab B's record seamlessly
    expect(await storeTabA.load('pub-from-tab-b')).toBeDefined()
    expect(await storeTabA.load('pub-from-tab-a')).toBeDefined()
  })

  it('allows removing and clearing records with durable persistence', async () => {
    const storageMap = new Map<string, string>()
    const mockStorage: Storage = {
      getItem: vi.fn((k: string) => storageMap.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        storageMap.set(k, v)
      }),
      removeItem: vi.fn((k: string) => {
        storageMap.delete(k)
      }),
      clear: vi.fn(() => {
        storageMap.clear()
      }),
      key: vi.fn((i: number) => [...storageMap.keys()][i] ?? null),
      length: 0
    }

    const initial = createSamplePreDispatchRecord('pub-remove')
    const store = new Tm1ProductionRecoveryStore({
      address: 'ecash:qzremove',
      storage: mockStorage,
      initialRecords: [initial]
    })

    expect(await store.load('pub-remove')).toBeDefined()

    const removed = await store.remove('pub-remove')
    expect(removed).toBe(true)
    expect(await store.load('pub-remove')).toBeNull()

    // Second removal of non-existent record returns false
    expect(await store.remove('pub-remove')).toBe(false)
  })
})
