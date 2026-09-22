// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ECASH_STANDARD_PROFILE_ID } from './derivationProfiles'
import {
  PENDING_IDENTITY_STATE,
  PENDING_IDENTITY_STORAGE_KEY,
  QUICK_START_MARKER_STORAGE_KEY,
  QuickStartUnavailableError,
  assertQuickStartStorageAvailable,
  clearQuickStartMarker,
  clearQuickStartMnemonic,
  getPendingIdentityRecord,
  getQuickStartRecordStatus,
  hasQuickStartMnemonic,
  inspectQuickStartMarker,
  inspectPendingIdentityAuthority,
  isWebLocksSupported,
  loadQuickStartMetadata,
  loadQuickStartMnemonic,
  setPendingIdentityRecord,
  setQuickStartCreationLockForTests,
  setQuickStartMarker,
  storeQuickStartMnemonic,
  withQuickStartCreationLock
} from './quickStartStorage'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

async function allStoreRecords() {
  const request = indexedDB.open('tonalli-quickstart-v1', 1)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const tx = db.transaction('wallet', 'readonly')
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const req = tx.objectStore('wallet').getAll()
    req.onsuccess = () => resolve(req.result as unknown[])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return records
}

describe('Quick Start encrypted storage', () => {
  beforeEach(async () => {
    await clearQuickStartMnemonic()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(async () => {
    setQuickStartCreationLockForTests(null)
    await clearQuickStartMnemonic()
  })

  test('ciphertext is not the plaintext mnemonic and the CryptoKey is non-extractable', async () => {
    await storeQuickStartMnemonic(MNEMONIC, {
      derivationProfileId: ECASH_STANDARD_PROFILE_ID,
      address: 'ecash:qtest'
    })
    const records = await allStoreRecords()
    const serialized = JSON.stringify(records, (_key, value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value).join(',')
      if (value instanceof Uint8Array) return Array.from(value).join(',')
      if (value instanceof CryptoKey) {
        return { type: value.type, extractable: value.extractable, algorithm: value.algorithm, usages: value.usages }
      }
      return value
    })
    expect(serialized).not.toContain(MNEMONIC)
    expect(localStorage.getItem('xoloswallet_encrypted_mnemonic')).toBeNull()
    expect(Object.values(localStorage)).not.toContain(MNEMONIC)
    expect(Object.values(sessionStorage)).not.toContain(MNEMONIC)

    const keyRecord = records.find((record) => (
      record && typeof record === 'object' && 'key' in record && (record as { key?: CryptoKey }).key instanceof CryptoKey
    )) as { key: CryptoKey } | undefined
    expect(keyRecord?.key.extractable).toBe(false)
    expect(keyRecord?.key.algorithm.name).toBe('AES-GCM')

    const loaded = await loadQuickStartMnemonic()
    expect(loaded).toBe(MNEMONIC)
    const metadata = await loadQuickStartMetadata()
    expect(metadata?.derivationProfileId).toBe(ECASH_STANDARD_PROFILE_ID)
    expect(metadata?.version).toBe(1)
  })

  test('missing device key fails closed', async () => {
    await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
    const request = indexedDB.open('tonalli-quickstart-v1', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wallet', 'readwrite')
      tx.objectStore('wallet').delete('device-key')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    await expect(loadQuickStartMnemonic()).rejects.toThrow('QUICK_START_DEVICE_KEY_MISSING')
    await expect(assertQuickStartStorageAvailable()).resolves.toBeUndefined()
    await expect(loadQuickStartMnemonic()).rejects.toThrow('QUICK_START_DEVICE_KEY_MISSING')
    await expect(storeQuickStartMnemonic(MNEMONIC, {
      derivationProfileId: ECASH_STANDARD_PROFILE_ID
    })).rejects.toThrow('QUICK_START_RECORD_EXISTS')
  })

  test('existing Quick Start + second availability check keeps the same key able to decrypt', async () => {
    await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
    await assertQuickStartStorageAvailable()
    await assertQuickStartStorageAvailable()
    expect(await loadQuickStartMnemonic()).toBe(MNEMONIC)
    const records = await allStoreRecords()
    expect(records.some((record) => (
      record && typeof record === 'object' && 'id' in record && (record as { id?: string }).id === 'device-key-probe'
    ))).toBe(false)
  })

  test('existing Quick Start record is never overwritten by a second store', async () => {
    await storeQuickStartMnemonic(MNEMONIC, {
      derivationProfileId: ECASH_STANDARD_PROFILE_ID,
      address: 'ecash:qoriginal'
    })
    await expect(storeQuickStartMnemonic(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
      { derivationProfileId: ECASH_STANDARD_PROFILE_ID, address: 'ecash:qother' }
    )).rejects.toThrow('QUICK_START_RECORD_EXISTS')
    expect(await loadQuickStartMnemonic()).toBe(MNEMONIC)
    expect((await loadQuickStartMetadata())?.address).toBe('ecash:qoriginal')
  })

  test('corrupt ciphertext fails closed', async () => {
    await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
    const request = indexedDB.open('tonalli-quickstart-v1', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wallet', 'readwrite')
      tx.objectStore('wallet').put({
        id: 'seed-ciphertext',
        version: 1,
        iv: new Uint8Array(12),
        ciphertext: 'not-cipher',
        derivationProfileId: ECASH_STANDARD_PROFILE_ID
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    await expect(loadQuickStartMnemonic()).rejects.toThrow('QUICK_START_STORAGE_CORRUPT')
  })

  test('fresh profile IndexedDB open rejection is unavailable, not recovery failure', async () => {
    const originalOpen = indexedDB.open.bind(indexedDB)
    indexedDB.open = (() => {
      throw new DOMException('denied', 'UnknownError')
    }) as typeof indexedDB.open
    try {
      await expect(assertQuickStartStorageAvailable()).rejects.toBeInstanceOf(QuickStartUnavailableError)
      await expect(hasQuickStartMnemonic()).resolves.toBe(false)
      await expect(storeQuickStartMnemonic(MNEMONIC, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID
      })).rejects.toBeInstanceOf(QuickStartUnavailableError)
    } finally {
      indexedDB.open = originalOpen
    }
    expect(await hasQuickStartMnemonic()).toBe(false)
  })

  test('fresh profile transaction rejection is unavailable and leaves no partial record', async () => {
    const originalTransaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function () {
      throw new DOMException('transaction unavailable', 'InvalidStateError')
    }
    try {
      await expect(storeQuickStartMnemonic(MNEMONIC, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID,
        address: 'ecash:qtest'
      })).rejects.toBeInstanceOf(QuickStartUnavailableError)
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction
    }
    expect(await hasQuickStartMnemonic()).toBe(false)
    expect(await allStoreRecords()).toEqual([])
  })

  test('CryptoKey structured-clone failure is unavailable and does not persist a seed', async () => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown) {
      if (value && typeof value === 'object' && 'key' in (value as { key?: unknown })) {
        throw new DOMException('could not clone CryptoKey', 'DataCloneError')
      }
      return originalPut.call(this, value)
    }
    try {
      await expect(storeQuickStartMnemonic(MNEMONIC, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID
      })).rejects.toBeInstanceOf(QuickStartUnavailableError)
      await expect(storeQuickStartMnemonic(MNEMONIC, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID
      })).rejects.toThrow('QUICK_START_DEVICE_KEY_NOT_PERSISTED')
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
    expect(await hasQuickStartMnemonic()).toBe(false)
  })

  test('existing seed with missing key stays a recovery failure, not availability', async () => {
    await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
    const request = indexedDB.open('tonalli-quickstart-v1', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wallet', 'readwrite')
      tx.objectStore('wallet').delete('device-key')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    await expect(loadQuickStartMnemonic()).rejects.toThrow('QUICK_START_DEVICE_KEY_MISSING')
    expect(await hasQuickStartMnemonic()).toBe(true)
    await expect(storeQuickStartMnemonic(MNEMONIC, {
      derivationProfileId: ECASH_STANDARD_PROFILE_ID
    })).rejects.toThrow('QUICK_START_RECORD_EXISTS')
  })

  test('two concurrent creators under an exclusive lock persist exactly one identity', async () => {
    let mutex = Promise.resolve()
    setQuickStartCreationLockForTests(async (operation) => {
      const previous = mutex
      let release!: () => void
      mutex = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        return await operation()
      } finally {
        release()
      }
    })
    const first = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const second = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
    const results = await Promise.allSettled([
      withQuickStartCreationLock(() => storeQuickStartMnemonic(first, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID,
        address: 'ecash:qone'
      })),
      withQuickStartCreationLock(() => storeQuickStartMnemonic(second, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID,
        address: 'ecash:qtwo'
      }))
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: 'QUICK_START_RECORD_EXISTS' })
    const loaded = await loadQuickStartMnemonic()
    const metadata = await loadQuickStartMetadata()
    expect(loaded === first || loaded === second).toBe(true)
    if (loaded === first) expect(metadata?.address).toBe('ecash:qone')
    else expect(metadata?.address).toBe('ecash:qtwo')
  })

  test('lock acquisition failure fail-closes without seed or key writes', async () => {
    setQuickStartCreationLockForTests(async () => {
      throw new QuickStartUnavailableError('QUICK_START_CREATION_LOCK_UNAVAILABLE')
    })
    await expect(withQuickStartCreationLock(() => storeQuickStartMnemonic(MNEMONIC, {
      derivationProfileId: ECASH_STANDARD_PROFILE_ID,
      address: 'ecash:qtest'
    }))).rejects.toBeInstanceOf(QuickStartUnavailableError)
    expect(await hasQuickStartMnemonic()).toBe(false)
    expect(await allStoreRecords()).toEqual([])
  })

  test('missing Web Locks fail-closes without persisting a Quick Start record', async () => {
    setQuickStartCreationLockForTests(null)
    const originalLocks = navigator.locks
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    try {
      await expect(withQuickStartCreationLock(async () => {
        await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
        return 'created'
      })).rejects.toThrow('QUICK_START_CREATION_LOCK_UNAVAILABLE')
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks })
    }
    expect(await hasQuickStartMnemonic()).toBe(false)
  })

  test('aborted persist transaction does not accept a mismatched key/ciphertext pair', async () => {
    const originalPut = IDBObjectStore.prototype.put
    let puts = 0
    IDBObjectStore.prototype.put = function (value: unknown) {
      puts += 1
      if (puts >= 2) {
        throw new DOMException('crash after first write', 'UnknownError')
      }
      return originalPut.call(this, value)
    }
    try {
      await expect(storeQuickStartMnemonic(MNEMONIC, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID,
        address: 'ecash:qcrash'
      })).rejects.toBeInstanceOf(QuickStartUnavailableError)
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
    expect(await hasQuickStartMnemonic()).toBe(false)
    const records = await allStoreRecords()
    expect(records.some((record) => (
      record && typeof record === 'object' && 'id' in record && (record as { id?: string }).id === 'seed-ciphertext'
    ))).toBe(false)
  })

  describe('Quick Start record status and fail-closed storage unavailable policy', () => {
    test.each([
      '{"version":1,"created',
      '{"version":2,"createdAt":1}',
      '{"version":1,"createdAt":null}',
      '{"version":1,"createdAt":1,"extra":true}'
    ])('malformed marker is CORRUPT_OR_UNKNOWN without read-time deletion: %s', (raw) => {
      localStorage.setItem(QUICK_START_MARKER_STORAGE_KEY, raw)
      expect(inspectQuickStartMarker()).toBe('CORRUPT_OR_UNKNOWN')
      expect(localStorage.getItem(QUICK_START_MARKER_STORAGE_KEY)).toBe(raw)
    })

    test('marker read denial is STORAGE_UNAVAILABLE, not absence', () => {
      const raw = JSON.stringify({ version: 1, createdAt: Date.now() })
      localStorage.setItem(QUICK_START_MARKER_STORAGE_KEY, raw)
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (key === QUICK_START_MARKER_STORAGE_KEY) throw new DOMException('Denied', 'SecurityError')
        return originalGetItem.call(this, key)
      })
      try {
        expect(inspectQuickStartMarker()).toBe('STORAGE_UNAVAILABLE')
      } finally {
        spy.mockRestore()
      }
      expect(localStorage.getItem(QUICK_START_MARKER_STORAGE_KEY)).toBe(raw)
    })

    test('marker storage denial plus inaccessible IndexedDB remains unknown', async () => {
      const originalGetItem = Storage.prototype.getItem
      const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (key === QUICK_START_MARKER_STORAGE_KEY) throw new DOMException('Denied', 'SecurityError')
        return originalGetItem.call(this, key)
      })
      const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        throw new DOMException('IndexedDB denied', 'SecurityError')
      })
      try {
        expect(await getQuickStartRecordStatus()).toBe('STORAGE_UNAVAILABLE_UNKNOWN')
      } finally {
        openSpy.mockRestore()
        getSpy.mockRestore()
      }
    })

    test('IndexedDB empty cannot prove absence while marker storage is unreadable', async () => {
      const originalGetItem = Storage.prototype.getItem
      const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (key === QUICK_START_MARKER_STORAGE_KEY) throw new DOMException('Denied', 'SecurityError')
        return originalGetItem.call(this, key)
      })
      try {
        expect(await loadQuickStartMetadata()).toBeNull()
        expect(await getQuickStartRecordStatus()).toBe('STORAGE_UNAVAILABLE_UNKNOWN')
      } finally {
        getSpy.mockRestore()
      }
    })

    test('valid IndexedDB metadata wins over a malformed marker without deleting evidence', async () => {
      await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
      const raw = '{"version":1,"created'
      localStorage.setItem(QUICK_START_MARKER_STORAGE_KEY, raw)
      expect(await getQuickStartRecordStatus()).toBe('PRESENT')
      expect(localStorage.getItem(QUICK_START_MARKER_STORAGE_KEY)).toBe(raw)
      expect(await loadQuickStartMnemonic()).toBe(MNEMONIC)
    })

    test('malformed marker is reconciled only after IndexedDB positively confirms empty', async () => {
      const raw = '{"version":1,"created'
      localStorage.setItem(QUICK_START_MARKER_STORAGE_KEY, raw)
      expect(await loadQuickStartMetadata()).toBeNull()
      expect(await getQuickStartRecordStatus()).toBe('ABSENT_CONFIRMED')
      expect(inspectQuickStartMarker()).toBe('ABSENT_CONFIRMED')
    })

    test('failed stale-marker deletion cannot claim ABSENT_CONFIRMED', async () => {
      const raw = '{"version":1,"created'
      localStorage.setItem(QUICK_START_MARKER_STORAGE_KEY, raw)
      const originalRemoveItem = Storage.prototype.removeItem
      const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
        if (key === QUICK_START_MARKER_STORAGE_KEY) return
        return originalRemoveItem.call(this, key)
      })
      try {
        expect(await getQuickStartRecordStatus()).toBe('STORAGE_UNAVAILABLE_UNKNOWN')
      } finally {
        spy.mockRestore()
      }
      expect(localStorage.getItem(QUICK_START_MARKER_STORAGE_KEY)).toBe(raw)
    })

    test('marker write read-back failure preserves the written evidence', () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (key === QUICK_START_MARKER_STORAGE_KEY && originalGetItem.call(this, key) !== null) return null
        return originalGetItem.call(this, key)
      })
      try {
        expect(() => setQuickStartMarker()).toThrow('QUICK_START_MARKER_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }
      expect(inspectQuickStartMarker()).toBe('PRESENT_VALID')
    })

    test('fresh profile + IndexedDB unavailable: status is ABSENT_CONFIRMED and hasQuickStartMnemonic is false', async () => {
      clearQuickStartMarker()
      const originalOpen = indexedDB.open
      indexedDB.open = () => {
        const req = {} as IDBOpenDBRequest
        setTimeout(() => {
          if (req.onerror) {
            Object.defineProperty(req, 'error', {
              configurable: true,
              value: new DOMException('IDB inaccessible', 'UnknownError')
            })
            req.onerror(new Event('error'))
          }
        }, 0)
        return req
      }

      try {
        const status = await getQuickStartRecordStatus()
        expect(status).toBe('ABSENT_CONFIRMED')
        expect(await hasQuickStartMnemonic()).toBe(false)
      } finally {
        indexedDB.open = originalOpen
      }
    })

    test('marker/evidence exists + DB unavailable: fails closed with STORAGE_UNAVAILABLE_UNKNOWN', async () => {
      setQuickStartMarker()
      expect(inspectQuickStartMarker()).toBe('PRESENT_VALID')

      const originalOpen = indexedDB.open
      indexedDB.open = () => {
        const req = {} as IDBOpenDBRequest
        setTimeout(() => {
          if (req.onerror) {
            Object.defineProperty(req, 'error', {
              configurable: true,
              value: new DOMException('IDB inaccessible', 'UnknownError')
            })
            req.onerror(new Event('error'))
          }
        }, 0)
        return req
      }

      try {
        const status = await getQuickStartRecordStatus()
        expect(status).toBe('STORAGE_UNAVAILABLE_UNKNOWN')
        await expect(hasQuickStartMnemonic()).rejects.toThrow('QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN')
      } finally {
        indexedDB.open = originalOpen
        clearQuickStartMarker()
      }
    })

    test('IndexedDB returns: original Quick Start recovered with same address and status PRESENT', async () => {
      await storeQuickStartMnemonic(MNEMONIC, {
        derivationProfileId: ECASH_STANDARD_PROFILE_ID,
        address: 'ecash:qoriginalrecover'
      })
      expect(inspectQuickStartMarker()).toBe('PRESENT_VALID')

      // Break IDB
      const originalOpen = indexedDB.open
      indexedDB.open = () => {
        const req = {} as IDBOpenDBRequest
        setTimeout(() => {
          if (req.onerror) {
            Object.defineProperty(req, 'error', {
              configurable: true,
              value: new DOMException('DB locked', 'UnknownError')
            })
            req.onerror(new Event('error'))
          }
        }, 0)
        return req
      }

      try {
        expect(await getQuickStartRecordStatus()).toBe('STORAGE_UNAVAILABLE_UNKNOWN')
      } finally {
        indexedDB.open = originalOpen
      }

      // IDB returns
      expect(await getQuickStartRecordStatus()).toBe('PRESENT')
      expect(await hasQuickStartMnemonic()).toBe(true)
      expect(await loadQuickStartMnemonic()).toBe(MNEMONIC)
      const meta = await loadQuickStartMetadata()
      expect(meta?.address).toBe('ecash:qoriginalrecover')
    })

    test('isWebLocksSupported detects Web Locks availability accurately', () => {
      setQuickStartCreationLockForTests(null)
      const originalLocks = navigator.locks
      try {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: { request: async () => {} }
        })
        expect(isWebLocksSupported()).toBe(true)

        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: undefined
        })
        expect(isWebLocksSupported()).toBe(false)
      } finally {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: originalLocks
        })
      }
    })
  })

  describe('Quick Start marker durable authority and reconciliation', () => {
    test('marker setItem throws -> storeQuickStartMnemonic fails and writes no seed', async () => {
      const originalSetItem = Storage.prototype.setItem
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
        if (key === QUICK_START_MARKER_STORAGE_KEY) {
          throw new Error('QuotaExceeded')
        }
        return originalSetItem.call(localStorage, key, val)
      })
      try {
        await expect(
          storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
        ).rejects.toThrow('QUICK_START_MARKER_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }
      expect(await hasQuickStartMnemonic()).toBe(false)
      expect(await loadQuickStartMetadata()).toBeNull()
    })

    test('marker read-back missing -> storeQuickStartMnemonic fails', async () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
        if (key === QUICK_START_MARKER_STORAGE_KEY) {
          return null
        }
        return originalGetItem.call(localStorage, key)
      })
      try {
        await expect(
          storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
        ).rejects.toThrow('QUICK_START_MARKER_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }
      expect(await hasQuickStartMnemonic()).toBe(false)
    })

    test('marker malformed/mismatched -> storeQuickStartMnemonic fails', async () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
        if (key === QUICK_START_MARKER_STORAGE_KEY) {
          return '{"version": 2}'
        }
        return originalGetItem.call(localStorage, key)
      })
      try {
        await expect(
          storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
        ).rejects.toThrow('QUICK_START_MARKER_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }
      expect(await hasQuickStartMnemonic()).toBe(false)
    })

    test('stale marker + IndexedDB accessible and positively empty -> safe reconciliation to ABSENT_CONFIRMED', async () => {
      setQuickStartMarker()
      expect(inspectQuickStartMarker()).toBe('PRESENT_VALID')
      expect(await loadQuickStartMetadata()).toBeNull()

      const status = await getQuickStartRecordStatus()
      expect(status).toBe('ABSENT_CONFIRMED')
      expect(inspectQuickStartMarker()).toBe('ABSENT_CONFIRMED')
      expect(await hasQuickStartMnemonic()).toBe(false)
    })
  })

  describe('Pending identity reservation strict persistence and durable authority', () => {
    test('reservation write throws -> setPendingIdentityRecord throws PENDING_IDENTITY_PERSIST_FAILED', () => {
      const originalSetItem = Storage.prototype.setItem
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
        if (key === PENDING_IDENTITY_STORAGE_KEY) {
          throw new Error('QuotaExceeded')
        }
        return originalSetItem.call(localStorage, key, val)
      })
      try {
        expect(() =>
          setPendingIdentityRecord({
            ownerToken: 'tok1',
            commitment: 'com1',
            address: 'ecash:qtest'
          })
        ).toThrow('QuotaExceeded')
      } finally {
        spy.mockRestore()
      }
      expect(getPendingIdentityRecord()).toBeNull()
    })

    test('reservation read-back missing -> setPendingIdentityRecord throws PENDING_IDENTITY_PERSIST_FAILED', () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
        if (key === PENDING_IDENTITY_STORAGE_KEY) {
          return null
        }
        return originalGetItem.call(localStorage, key)
      })
      try {
        expect(() =>
          setPendingIdentityRecord({
            ownerToken: 'tok1',
            commitment: 'com1',
            address: 'ecash:qtest'
          })
        ).toThrow('PENDING_IDENTITY_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }
      expect(getPendingIdentityRecord()).toBeNull()
    })

    test('reservation read-back differs -> setPendingIdentityRecord throws PENDING_IDENTITY_PERSIST_FAILED', () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
        if (key === PENDING_IDENTITY_STORAGE_KEY) {
          return JSON.stringify({
            version: 1,
            ownerToken: 'tampered',
            commitment: 'com1',
            address: 'ecash:qtest',
            createdAt: Date.now()
          })
        }
        return originalGetItem.call(localStorage, key)
      })
      try {
        expect(() =>
          setPendingIdentityRecord({
            ownerToken: 'tok1',
            commitment: 'com1',
            address: 'ecash:qtest'
          })
        ).toThrow('PENDING_IDENTITY_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }
      expect(getPendingIdentityRecord()).toBeNull()
    })

    test('inspectPendingIdentityAuthority: absent key returns ABSENT_CONFIRMED', () => {
      localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
      const auth = inspectPendingIdentityAuthority()
      expect(auth.status).toBe(PENDING_IDENTITY_STATE.ABSENT_CONFIRMED)
    })

    test('inspectPendingIdentityAuthority: truncated or malformed JSON returns CORRUPT_OR_UNKNOWN_PENDING without deleting', () => {
      const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
      localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, '{"version":1,"ownerToken":"tok')
      try {
        const auth = inspectPendingIdentityAuthority()
        expect(auth.status).toBe(PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING)
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe('{"version":1,"ownerToken":"tok')
        expect(removeSpy).not.toHaveBeenCalled()
        expect(getPendingIdentityRecord()).toBeNull()
      } finally {
        removeSpy.mockRestore()
      }
    })

    test('inspectPendingIdentityAuthority: missing required fields returns CORRUPT_OR_UNKNOWN_PENDING without deleting', () => {
      const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
      // missing address and commitment
      localStorage.setItem(
        PENDING_IDENTITY_STORAGE_KEY,
        JSON.stringify({ version: 1, ownerToken: 'tok1', createdAt: Date.now() })
      )
      try {
        const auth = inspectPendingIdentityAuthority()
        expect(auth.status).toBe(PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING)
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).not.toBeNull()
        expect(removeSpy).not.toHaveBeenCalled()
        expect(getPendingIdentityRecord()).toBeNull()
      } finally {
        removeSpy.mockRestore()
      }
    })

    test('inspectPendingIdentityAuthority: storage getItem throwing returns STORAGE_UNAVAILABLE without destroying data', () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
        if (key === PENDING_IDENTITY_STORAGE_KEY) {
          throw new DOMException('Access denied', 'SecurityError')
        }
        return originalGetItem.call(localStorage, key)
      })
      try {
        const auth = inspectPendingIdentityAuthority()
        expect(auth.status).toBe(PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE)
        if (auth.status === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
          expect(auth.error).toBeDefined()
        }
      } finally {
        spy.mockRestore()
      }
    })

    test('inspectPendingIdentityAuthority: valid record classifies into RECOVERABLE_PENDING', () => {
      setPendingIdentityRecord({
        ownerToken: 'tok1',
        commitment: 'com1',
        address: 'ecash:qtest',
        derivationProfileId: ECASH_STANDARD_PROFILE_ID,
        state: 'PENDING_BACKUP',
        ciphertext: 'ct1'
      })
      const auth = inspectPendingIdentityAuthority()
      expect(auth.status).toBe(PENDING_IDENTITY_STATE.RECOVERABLE_PENDING)
      if (auth.status === PENDING_IDENTITY_STATE.RECOVERABLE_PENDING) {
        expect(auth.record.ownerToken).toBe('tok1')
      }
    })

    test('inspectPendingIdentityAuthority: valid record without derivationProfileId classifies into LEGACY_UNRECOVERABLE_PENDING', () => {
      setPendingIdentityRecord({
        ownerToken: 'tok2',
        commitment: 'com2',
        address: 'ecash:qtest',
        state: 'PENDING_BACKUP',
        ciphertext: 'ct2'
      })
      const auth = inspectPendingIdentityAuthority()
      expect(auth.status).toBe(PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING)
    })
  })
})
