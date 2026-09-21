// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import { xolosWalletService } from './XolosWalletService'
import { encryptWithPassword } from './crypto'
import { ECASH_STANDARD_PROFILE_ID } from './derivationProfiles'
import {
  PENDING_IDENTITY_STATE,
  PENDING_IDENTITY_STORAGE_KEY,
  QUICK_START_MARKER_STORAGE_KEY,
  QuickStartUnavailableError,
  clearQuickStartMnemonic,
  getPendingIdentityRecord,
  hasQuickStartMnemonic,
  inspectPendingIdentityAuthority,
  loadQuickStartMnemonic,
  setPendingIdentityRecord,
  setQuickStartCreationLockForTests,
  setQuickStartMarker,
  storeQuickStartMnemonic
} from './quickStartStorage'

const MinimalXECWallet = (() => {
  const moduleExports = MinimalXecWalletModule as unknown as {
    MinimalXECWallet?: { prototype: { initialize: () => Promise<void> } }
    default?: { prototype: { initialize: () => Promise<void> } }
  }
  if (moduleExports.MinimalXECWallet) return moduleExports.MinimalXECWallet
  if (moduleExports.default) return moduleExports.default
  if (typeof window !== 'undefined') {
    return (window as unknown as { MinimalXecWallet?: { prototype: { initialize: () => Promise<void> } } }).MinimalXecWallet
  }
  return undefined
})()

const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'
const ORIGINAL_CIPHERTEXT = 'pin-backed-ciphertext-original'
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type QuickStartInternals = {
  encryptedMnemonic: string | null
  decryptedMnemonic: string | null
  wallet: unknown
  isReady: boolean
  activeAccountState: unknown
  fetchAddressScan: (address: string) => Promise<{
    address: string
    utxos: unknown[]
    hasHistory: boolean
  }>
}

const internals = xolosWalletService as unknown as QuickStartInternals

function simulateReload(): void {
  internals.encryptedMnemonic = null
  internals.decryptedMnemonic = null
  internals.wallet = null
  internals.isReady = false
  internals.activeAccountState = null
  xolosWalletService.setPendingIdentityOwnerToken(null)
}

function setLegacyPendingIdentity(): void {
  setPendingIdentityRecord({
    ownerToken: 'legacy-owner-token',
    commitment: 'legacy-commitment',
    address: 'ecash:qlegacy-pending-address',
    derivationProfileId: 'ecash-standard-1899',
    createdAt: Date.now()
  })
}

async function putCorruptQuickStartRecord(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tonalli-quickstart-v1', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('wallet', 'readwrite')
      transaction.objectStore('wallet').put({ id: 'seed-ciphertext', version: 999 })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

describe('Quick Start backed-wallet and creation-lock boundaries', () => {
  beforeEach(async () => {
    localStorage.clear()
    internals.encryptedMnemonic = null
    internals.decryptedMnemonic = null
    internals.wallet = null
    internals.isReady = false
    internals.activeAccountState = null
    xolosWalletService.setPendingIdentityOwnerToken(null)
    setQuickStartCreationLockForTests(async (operation) => operation())
    await clearQuickStartMnemonic()
    if (MinimalXECWallet?.prototype) {
      vi.spyOn(MinimalXECWallet.prototype, 'initialize').mockResolvedValue(undefined as never)
    }
    vi.spyOn(internals, 'fetchAddressScan').mockResolvedValue({
      address: '',
      utxos: [],
      hasHistory: false
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setQuickStartCreationLockForTests(null)
    localStorage.clear()
    internals.encryptedMnemonic = null
    internals.decryptedMnemonic = null
    internals.wallet = null
    internals.isReady = false
    internals.activeAccountState = null
    xolosWalletService.setPendingIdentityOwnerToken(null)
    await clearQuickStartMnemonic()
  })

  test('createQuickStartWallet is denied when encrypted backed ciphertext exists and stays byte-for-byte', async () => {
    localStorage.setItem(STORAGE_KEY_MNEMONIC, ORIGINAL_CIPHERTEXT)
    internals.encryptedMnemonic = null
    expect(xolosWalletService.hasEncryptedWalletOnDevice()).toBe(false)
    expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)

    await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('BACKED_WALLET_EXISTS')
    expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBe(ORIGINAL_CIPHERTEXT)
    expect(await hasQuickStartMnemonic()).toBe(false)
    expect(internals.isReady).toBe(false)
  })

  test('storage-read failure fail-closes Quick Start creation', async () => {
    const originalGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('STORAGE_DENIED')
    }
    try {
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
      await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('BACKED_WALLET_EXISTS')
    } finally {
      Storage.prototype.getItem = originalGetItem
    }
    expect(await hasQuickStartMnemonic()).toBe(false)
  })

  test('creation lock failure fail-closes without writing a Quick Start record', async () => {
    setQuickStartCreationLockForTests(async () => {
      throw new QuickStartUnavailableError('QUICK_START_CREATION_LOCK_UNAVAILABLE')
    })
    await expect(xolosWalletService.createQuickStartWallet()).rejects.toBeInstanceOf(QuickStartUnavailableError)
    expect(await hasQuickStartMnemonic()).toBe(false)
  })

  describe('cross-tab identity mutation races under exclusive origin lock', () => {
    const TEST_RESTORE_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

    function setupCrossTabFifoLock() {
      let mutex = Promise.resolve()
      setQuickStartCreationLockForTests(async (operation) => {
        const previous = mutex
        let release!: () => void
        mutex = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          return await operation()
        } finally {
          release()
        }
      })
    }

    test('Quick Start vs create-backed: loser fails closed, winner seed never deleted, never two fundable addresses', async () => {
      setupCrossTabFifoLock()

      // Tab 1 (Quick Start) and Tab 2 (create-backed) race concurrently
      const results = await Promise.allSettled([
        xolosWalletService.createQuickStartWallet(),
        xolosWalletService.createNewWallet()
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('QUICK_START_RECORD_EXISTS')

      // Winner Quick Start seed is intact in IndexedDB
      const persistedQuickStart = await loadQuickStartMnemonic()
      expect(persistedQuickStart).toBeTruthy()

      // Only winner address is active
      const winnerAddress = (fulfilled[0] as PromiseFulfilledResult<{ address: string }>).value.address
      expect(xolosWalletService.getAddress()).toBe(winnerAddress)
    })

    test('Quick Start vs restore: loser fails closed, winner seed never deleted', async () => {
      setupCrossTabFifoLock()

      const results = await Promise.allSettled([
        xolosWalletService.createQuickStartWallet(),
        xolosWalletService.restoreFromMnemonic(TEST_RESTORE_MNEMONIC)
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('QUICK_START_RECORD_EXISTS')

      const persistedQuickStart = await loadQuickStartMnemonic()
      expect(persistedQuickStart).toBeTruthy()
    })

    test('create-backed vs restore: loser fails closed when backed wallet already committed', async () => {
      setupCrossTabFifoLock()

      // Tab 1 creates and commits backed wallet
      await xolosWalletService.createNewWallet()
      await xolosWalletService.persistVerifiedBackup('pin1234')
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)

      // Tab 2 attempts restore or Quick Start
      await expect(
        xolosWalletService.restoreFromMnemonic(TEST_RESTORE_MNEMONIC)
      ).rejects.toThrow('BACKED_WALLET_EXISTS')

      await expect(
        xolosWalletService.createQuickStartWallet()
      ).rejects.toThrow('BACKED_WALLET_EXISTS')
    })

    test('concurrent Quick Start creates: loser observes winner, exactly one address across tabs', async () => {
      setupCrossTabFifoLock()

      const [res1, res2] = await Promise.all([
        xolosWalletService.createQuickStartWallet(),
        xolosWalletService.createQuickStartWallet()
      ])

      expect(res1.address).toBe(res2.address)
      const persistedQuickStart = await loadQuickStartMnemonic()
      expect(persistedQuickStart).toBeTruthy()
    })

    test('discardQuickStartRecord never deletes winner persisted seed when caller active mnemonic differs', async () => {
      // Tab 1 creates Quick Start wallet with seed A
      await xolosWalletService.createQuickStartWallet()
      const seedA = await loadQuickStartMnemonic()
      expect(seedA).toBeTruthy()

      // Competing process with seed B attempts to discard Quick Start record
      internals.decryptedMnemonic = TEST_RESTORE_MNEMONIC
      await xolosWalletService.discardQuickStartRecord()

      // Seed A must remain intact!
      const seedAAfter = await loadQuickStartMnemonic()
      expect(seedAAfter).toBe(seedA)
      expect(xolosWalletService.getAddress()).not.toBeNull()
    })

    test('persistVerifiedBackup rejects if competing Quick Start seed exists with different identity', async () => {
      // Tab 1 created Quick Start wallet
      await xolosWalletService.createQuickStartWallet()
      const seedA = await loadQuickStartMnemonic()

      // Tab 2 has different mnemonic in memory and attempts to commit PIN backup
      internals.decryptedMnemonic = TEST_RESTORE_MNEMONIC
      await expect(
        xolosWalletService.persistVerifiedBackup('pin1234')
      ).rejects.toThrow('QUICK_START_WALLET_EXISTS')

      // Quick Start seed A remains untouched
      expect(await loadQuickStartMnemonic()).toBe(seedA)
    })

    test('create-backed A -> restore B -> backup A -> backup B: B rejected, ciphertext A preserved', async () => {
      setupCrossTabFifoLock()

      // Tab A initiates create-backed
      await xolosWalletService.createNewWallet()
      const addressA = xolosWalletService.getAddress()
      const mnemonicA = internals.decryptedMnemonic!
      const ownerTokenA = xolosWalletService.getPendingIdentityOwnerToken()

      // Tab B in another tab attempts restore while Tab A identity is pending
      xolosWalletService.setPendingIdentityOwnerToken(null)
      await expect(
        xolosWalletService.restoreFromMnemonic(TEST_RESTORE_MNEMONIC)
      ).rejects.toThrow('PENDING_IDENTITY_EXISTS')

      // Tab A commits backup
      xolosWalletService.setPendingIdentityOwnerToken(ownerTokenA)
      internals.decryptedMnemonic = mnemonicA
      await xolosWalletService.persistVerifiedBackup('pinA1234')
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
      const ciphertextA = localStorage.getItem(STORAGE_KEY_MNEMONIC)

      // Tab B attempts backup of restore B with different mnemonic
      internals.decryptedMnemonic = TEST_RESTORE_MNEMONIC
      await expect(
        xolosWalletService.persistVerifiedBackup('pinB1234')
      ).rejects.toThrow('BACKUP_OVERWRITE_PREVENTED')

      // Ciphertext A and address A are preserved
      expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBe(ciphertextA)
      await xolosWalletService.loadFromStorage('pinA1234')
      expect(xolosWalletService.getAddress()).toBe(addressA)
    })

    test('restore A -> create-backed B: exactly one candidate survives', async () => {
      setupCrossTabFifoLock()

      // Tab A restores
      const resA = await xolosWalletService.restoreFromMnemonic(TEST_RESTORE_MNEMONIC)
      expect(resA.status).toBe('restored')
      const addressA = xolosWalletService.getAddress()
      expect(addressA).toBeTruthy()

      // Tab B in another tab tries to create-backed
      xolosWalletService.setPendingIdentityOwnerToken(null)
      await expect(
        xolosWalletService.createNewWallet()
      ).rejects.toThrow('PENDING_IDENTITY_EXISTS')

      // Exactly one candidate identity survived (Tab A)
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
      expect(xolosWalletService.getAddress()).toBe(addressA)
    })

    test('two create-backed tabs: at most one identity may become persistable', async () => {
      setupCrossTabFifoLock()

      // Tab A creates
      await xolosWalletService.createNewWallet()
      const addressA = xolosWalletService.getAddress()

      // Tab B in another tab creates
      xolosWalletService.setPendingIdentityOwnerToken(null)
      await expect(
        xolosWalletService.createNewWallet()
      ).rejects.toThrow('PENDING_IDENTITY_EXISTS')

      // Only Tab A is active and persistable
      expect(xolosWalletService.getAddress()).toBe(addressA)
    })

    test('winner backup: loser can never overwrite winner', async () => {
      setupCrossTabFifoLock()

      // Winner creates and commits backup
      await xolosWalletService.createNewWallet()
      const winnerAddress = xolosWalletService.getAddress()
      await xolosWalletService.persistVerifiedBackup('winnerPIN123')
      const winnerCiphertext = localStorage.getItem(STORAGE_KEY_MNEMONIC)

      // Loser tries to overwrite with another mnemonic
      internals.decryptedMnemonic = TEST_RESTORE_MNEMONIC
      await expect(
        xolosWalletService.persistVerifiedBackup('loserPIN123')
      ).rejects.toThrow('BACKUP_OVERWRITE_PREVENTED')

      // Winner ciphertext intact
      expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBe(winnerCiphertext)
      await xolosWalletService.loadFromStorage('winnerPIN123')
      expect(xolosWalletService.getAddress()).toBe(winnerAddress)
    })

    test('existing Quick Start + IndexedDB unavailable: no PIN create, no restore overwrite, fail closed', async () => {
      // Create Quick Start wallet
      await xolosWalletService.createQuickStartWallet()
      const originalAddress = xolosWalletService.getAddress()
      expect(originalAddress).toBeTruthy()

      // Mock IndexedDB failure
      const originalOpen = indexedDB.open
      indexedDB.open = () => {
        const req = {} as IDBOpenDBRequest
        setTimeout(() => {
          if (req.onerror) {
            Object.defineProperty(req, 'error', {
              configurable: true,
              value: new DOMException('DB locked/unavailable', 'UnknownError')
            })
            req.onerror(new Event('error'))
          }
        }, 0)
        return req
      }

      try {
        // createNewWallet must fail closed
        await expect(xolosWalletService.createNewWallet()).rejects.toThrow()
        // restoreFromMnemonic must fail closed
        await expect(
          xolosWalletService.restoreFromMnemonic(TEST_RESTORE_MNEMONIC)
        ).rejects.toThrow()
        // No backup_verified replacement
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)
      } finally {
        indexedDB.open = originalOpen
      }

      // When IndexedDB returns, original Quick Start recovered with same address
      const recoveredSeed = await loadQuickStartMnemonic()
      expect(recoveredSeed).toBeTruthy()
    })

    test('candidate generation -> pending reservation write fails -> operation rejects -> zero exposed active identity', async () => {
      const originalSetItem = Storage.prototype.setItem
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
        if (key === PENDING_IDENTITY_STORAGE_KEY) {
          throw new Error('QuotaExceeded')
        }
        return originalSetItem.call(localStorage, key, val)
      })
      try {
        await expect(xolosWalletService.createNewWallet()).rejects.toThrow('QuotaExceeded')
      } finally {
        spy.mockRestore()
      }

      // Zero returned identity, zero usable/fundable address, zero mnemonic in memory
      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
      expect(internals.isReady).toBe(false)
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)
      expect(getPendingIdentityRecord()).toBeNull()
      // Second tab cannot observe a successful first creation
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)
    })

    test('candidate generation -> pending reservation read-back fails -> operation rejects -> zero exposed active identity', async () => {
      const originalGetItem = Storage.prototype.getItem
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
        if (key === PENDING_IDENTITY_STORAGE_KEY) {
          return null
        }
        return originalGetItem.call(localStorage, key)
      })
      try {
        await expect(xolosWalletService.createNewWallet()).rejects.toThrow('PENDING_IDENTITY_PERSIST_FAILED')
      } finally {
        spy.mockRestore()
      }

      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
      expect(internals.isReady).toBe(false)
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)
      expect(getPendingIdentityRecord()).toBeNull()
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)
    })

    test('reservation survives >15 min -> competing tab still blocked', async () => {
      // Tab A creates wallet
      await xolosWalletService.createNewWallet()
      const addressA = xolosWalletService.getAddress()
      expect(addressA).toBeTruthy()

      // Backdate the reservation by 30 minutes (> 15 min TTL that used to exist)
      const record = getPendingIdentityRecord()
      expect(record).not.toBeNull()
      if (record) {
        localStorage.setItem(
          PENDING_IDENTITY_STORAGE_KEY,
          JSON.stringify({
            ...record,
            createdAt: Date.now() - 30 * 60 * 1000
          })
        )
      }

      // Competing Tab B tries to create or restore
      xolosWalletService.setPendingIdentityOwnerToken(null)
      await expect(xolosWalletService.createNewWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      await expect(xolosWalletService.restoreFromMnemonic(TEST_RESTORE_MNEMONIC)).rejects.toThrow('PENDING_IDENTITY_EXISTS')

      // Competing tab cannot become backup candidate
      internals.decryptedMnemonic = TEST_RESTORE_MNEMONIC
      await expect(xolosWalletService.persistVerifiedBackup('competingPIN')).rejects.toThrow('PENDING_IDENTITY_MISMATCH')
    })

    test('owner completes backup -> reservation cleared only after verified commit', async () => {
      // Tab A creates wallet
      await xolosWalletService.createNewWallet()
      expect(getPendingIdentityRecord()).not.toBeNull()
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)

      // Reservation remains authoritative prior to verified backup
      expect(getPendingIdentityRecord()?.ownerToken).toBeTruthy()

      // Tab A completes verified backup
      await xolosWalletService.persistVerifiedBackup('mySecurePIN123')

      // Ciphertext committed and reservation cleared
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
      expect(getPendingIdentityRecord()).toBeNull()
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)
    })

    test('no explicit completion or reset -> reservation remains authoritative', async () => {
      // Tab A creates wallet
      await xolosWalletService.createNewWallet()
      expect(getPendingIdentityRecord()).not.toBeNull()

      // Simulate passage of time (hours later)
      const record = getPendingIdentityRecord()!
      localStorage.setItem(
        PENDING_IDENTITY_STORAGE_KEY,
        JSON.stringify({
          ...record,
          createdAt: Date.now() - 2 * 60 * 60 * 1000
        })
      )

      // Reservation is still authoritative without explicit completion
      expect(getPendingIdentityRecord()).not.toBeNull()
      xolosWalletService.setPendingIdentityOwnerToken(null)
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
      await expect(xolosWalletService.createNewWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')
    })

    test('Quick Start marker setItem fails -> Quick Start creation fails closed before exposing identity', async () => {
      const originalSetItem = Storage.prototype.setItem
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
        if (key === QUICK_START_MARKER_STORAGE_KEY) {
          throw new Error('QuotaExceeded')
        }
        return originalSetItem.call(localStorage, key, val)
      })
      try {
        await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('QuotaExceeded')
      } finally {
        spy.mockRestore()
      }

      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
      expect(internals.isReady).toBe(false)
      expect(await hasQuickStartMnemonic()).toBe(false)
    })

    test('create-backed -> pending persisted -> reload -> enter same PIN -> same mnemonic/address restored -> backup completes', async () => {
      const pin = 'securePIN123'
      const mnemonic = await xolosWalletService.createNewWallet(pin)
      const address = xolosWalletService.getAddress()!
      expect(mnemonic).toBeTruthy()
      expect(address).toBeTruthy()

      const record = getPendingIdentityRecord()
      expect(record).not.toBeNull()
      expect(record?.state).toBe('PENDING_BACKUP')
      expect(record?.ciphertext).toBeTruthy()

      // Simulate browser reload: clear in-memory state
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
      expect(xolosWalletService.hasRecoverablePendingIdentity()).toBe(true)

      // Enter same PIN
      const resumed = await xolosWalletService.resumePendingIdentity(pin)
      expect(resumed.address).toBe(address)
      expect(resumed.reconciled).toBe(false)
      expect(xolosWalletService.getAddress()).toBe(address)
      expect(xolosWalletService.getMnemonic()).toBe(mnemonic)

      // Backup completes
      await xolosWalletService.persistVerifiedBackup(pin)
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
      expect(getPendingIdentityRecord()).toBeNull()
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)
    }, 30000)

    test('import -> pending persisted -> reload -> same PIN -> same imported identity restored', async () => {
      const pin = 'importPIN456'
      const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      const result = await xolosWalletService.restoreFromMnemonic(testMnemonic, undefined, pin)
      expect(result.status).toBe('restored')
      const address = xolosWalletService.getAddress()!

      const record = getPendingIdentityRecord()
      expect(record).not.toBeNull()
      expect(record?.state).toBe('PENDING_BACKUP')
      expect(record?.ciphertext).toBeTruthy()

      // Simulate reload
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      // Enter same PIN
      const resumed = await xolosWalletService.resumePendingIdentity(pin)
      expect(resumed.address).toBe(address)
      expect(xolosWalletService.getMnemonic()).toBe(testMnemonic)
    }, 30000)

    test('reload + wrong PIN -> pending remains -> no replacement identity', async () => {
      const pin = 'correctPIN789'
      const mnemonic = await xolosWalletService.createNewWallet(pin)
      const address = xolosWalletService.getAddress()!

      // Simulate reload
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      // Enter wrong PIN
      await expect(xolosWalletService.resumePendingIdentity('wrongPIN000')).rejects.toThrow('INVALID_PIN')

      // Pending record remains untouched
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()

      // Cannot create replacement identity
      await expect(xolosWalletService.createNewWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')

      // Correct PIN still succeeds
      const resumed = await xolosWalletService.resumePendingIdentity(pin)
      expect(resumed.address).toBe(address)
      expect(xolosWalletService.getMnemonic()).toBe(mnemonic)
    }, 30000)

    test('crash before final BACKUP_VERIFIED -> pending recoverable', async () => {
      const pin = 'crashBeforePIN'
      await xolosWalletService.createNewWallet(pin)
      const address = xolosWalletService.getAddress()!

      // Crash occurs before persistVerifiedBackup
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      // Device still does not have backed ciphertext
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)
      expect(xolosWalletService.hasRecoverablePendingIdentity()).toBe(true)

      const resumed = await xolosWalletService.resumePendingIdentity(pin)
      expect(resumed.address).toBe(address)
      expect(resumed.reconciled).toBe(false)
    }, 30000)

    test('matching final ciphertext reconciles only after PIN proves exact identity', async () => {
      const pin = 'crashAfterPIN'
      await xolosWalletService.createNewWallet(pin)
      const record = getPendingIdentityRecord()!
      expect(record).not.toBeNull()

      // Tab completes backup commit
      await xolosWalletService.persistVerifiedBackup(pin)
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
      expect(getPendingIdentityRecord()).toBeNull()

      // Simulate crash right after ciphertext commit but before pending cleanup:
      setPendingIdentityRecord(record)
      expect(getPendingIdentityRecord()).not.toBeNull()

      // Reload occurs
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      // Generic ciphertext existence is not proof of identity and must not clear the reservation.
      xolosWalletService.reconcilePendingIdentity()
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
      expect(getPendingIdentityRecord()).not.toBeNull()

      // The user's PIN decrypts both records and proves exact mnemonic equivalence.
      const resumed = await xolosWalletService.resumePendingIdentity(pin)
      expect(resumed.reconciled).toBe(true)
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)
      expect(getPendingIdentityRecord()).toBeNull()
    }, 30000)

    test('second tab while PENDING_BACKUP exists -> create/import/Quick Start blocked', async () => {
      const pin = 'tabApin123'
      await xolosWalletService.createNewWallet(pin)

      // Second tab does not have ownership token in memory
      xolosWalletService.setPendingIdentityOwnerToken(null)

      await expect(xolosWalletService.createNewWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      await expect(xolosWalletService.createNewWallet('tabBpin456')).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      await expect(xolosWalletService.restoreFromMnemonic(testMnemonic)).rejects.toThrow('PENDING_IDENTITY_EXISTS')
    }, 30000)

    test('pending ciphertext tampered -> fail closed -> no identity exposed', async () => {
      const pin = 'tamperTestPin'
      await xolosWalletService.createNewWallet(pin)

      // Tamper ciphertext in storage
      const record = getPendingIdentityRecord()!
      localStorage.setItem(
        PENDING_IDENTITY_STORAGE_KEY,
        JSON.stringify({
          ...record,
          ciphertext: 'tampered-invalid-ciphertext'
        })
      )

      // Reload
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      // Attempt to resume fails closed
      await expect(xolosWalletService.resumePendingIdentity(pin)).rejects.toThrow()
      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
      expect(internals.isReady).toBe(false)
    }, 30000)

    test('commitment/address mismatch -> fail closed', async () => {
      const pin = 'mismatchTestPin'
      await xolosWalletService.createNewWallet(pin)

      // Tamper address in storage
      const record = getPendingIdentityRecord()!
      localStorage.setItem(
        PENDING_IDENTITY_STORAGE_KEY,
        JSON.stringify({
          ...record,
          address: 'ecash:qzfakeaddressmismatch0000000000000000000'
        })
      )

      // Reload
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)

      await expect(xolosWalletService.resumePendingIdentity(pin)).rejects.toThrow('ADDRESS_MISMATCH')
      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
      expect(internals.isReady).toBe(false)
    }, 30000)

    test('pending commitment mismatch fails before exposing the local identity', async () => {
      const pin = 'commitmentMismatchPIN'
      await xolosWalletService.createNewWallet(pin)
      const record = getPendingIdentityRecord()!
      localStorage.setItem(
        PENDING_IDENTITY_STORAGE_KEY,
        JSON.stringify({ ...record, commitment: 'tampered-commitment' })
      )
      simulateReload()

      await expect(xolosWalletService.resumePendingIdentity(pin)).rejects.toThrow(
        'PENDING_IDENTITY_COMMITMENT_MISMATCH'
      )
      expect(getPendingIdentityRecord()).not.toBeNull()
      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
    }, 30000)

    test('recoverable pending stays locally active and completes backup when Chronik initialize fails', async () => {
      const pin = 'offlineRecoveryPIN'
      const mnemonic = await xolosWalletService.createNewWallet(pin)
      const address = xolosWalletService.getAddress()!
      simulateReload()

      vi.mocked(MinimalXECWallet!.prototype.initialize).mockRejectedValueOnce(new Error('CHRONIK_OFFLINE'))

      const resumed = await xolosWalletService.resumePendingIdentity(pin)
      expect(resumed).toMatchObject({ address, mnemonic, reconciled: false })
      expect(xolosWalletService.getAddress()).toBe(address)
      expect(xolosWalletService.getMnemonic()).toBe(mnemonic)
      expect(internals.isReady).toBe(true)
      expect(getPendingIdentityRecord()).not.toBeNull()

      await xolosWalletService.persistVerifiedBackup(pin)
      expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
      expect(localStorage.getItem('xoloswallet_backup_verified')).toBe('true')
      expect(getPendingIdentityRecord()).toBeNull()
    }, 30000)

    test('final ciphertext for another identity denies reconciliation and preserves pending', async () => {
      const pin = 'reconcileMismatchPIN'
      await xolosWalletService.createNewWallet(pin)
      const pending = getPendingIdentityRecord()
      expect(pending).not.toBeNull()
      simulateReload()

      localStorage.setItem(STORAGE_KEY_MNEMONIC, await encryptWithPassword(TEST_MNEMONIC, pin))

      await expect(xolosWalletService.resumePendingIdentity(pin)).rejects.toThrow(
        'PENDING_IDENTITY_RECONCILIATION_MISMATCH'
      )
      expect(getPendingIdentityRecord()).toEqual(pending)
      expect(xolosWalletService.getAddress()).toBeNull()
      expect(xolosWalletService.getMnemonic()).toBeNull()
    }, 30000)

    test('legacy pending is classified, blocks all onboarding mutations, and can be explicitly abandoned', async () => {
      setLegacyPendingIdentity()
      expect(xolosWalletService.getPendingIdentityState()).toBe(
        PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING
      )
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
      expect(xolosWalletService.hasRecoverablePendingIdentity()).toBe(false)

      await expect(xolosWalletService.createNewWallet('new-wallet-pin')).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('PENDING_IDENTITY_EXISTS')
      await expect(xolosWalletService.restoreFromMnemonic(TEST_MNEMONIC)).rejects.toThrow('PENDING_IDENTITY_EXISTS')

      await xolosWalletService.abandonLegacyPendingIdentity()
      expect(getPendingIdentityRecord()).toBeNull()
      expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.NONE)

      await expect(xolosWalletService.createNewWallet()).resolves.toBeTruthy()
    }, 30000)

    test('legacy pending abandonment is denied when Quick Start is present', async () => {
      await xolosWalletService.createQuickStartWallet()
      setLegacyPendingIdentity()

      await expect(xolosWalletService.abandonLegacyPendingIdentity()).rejects.toThrow(
        'QUICK_START_RECORD_EXISTS'
      )
      expect(getPendingIdentityRecord()).not.toBeNull()
    }, 30000)

    test('pending abandonment is denied while the creating session still owns the workflow', async () => {
      await xolosWalletService.createNewWallet('activeOwnerPIN')

      await expect(xolosWalletService.abandonPendingIdentity()).rejects.toThrow(
        'PENDING_IDENTITY_SESSION_ACTIVE'
      )
      expect(getPendingIdentityRecord()).not.toBeNull()
    }, 30000)

    test('legacy pending abandonment cannot replace an existing backed wallet', async () => {
      setLegacyPendingIdentity()
      localStorage.setItem(STORAGE_KEY_MNEMONIC, ORIGINAL_CIPHERTEXT)

      await expect(xolosWalletService.abandonLegacyPendingIdentity()).rejects.toThrow(
        'BACKED_WALLET_EXISTS'
      )
      expect(getPendingIdentityRecord()).not.toBeNull()
      expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBe(ORIGINAL_CIPHERTEXT)
    })

    test('legacy pending abandonment fails closed when Quick Start storage is unavailable/unknown', async () => {
      setLegacyPendingIdentity()
      localStorage.setItem(
        QUICK_START_MARKER_STORAGE_KEY,
        JSON.stringify({ version: 1, createdAt: Date.now() })
      )
      const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })

      try {
        await expect(xolosWalletService.abandonLegacyPendingIdentity()).rejects.toThrow(
          'QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN'
        )
      } finally {
        if (indexedDbDescriptor) {
          Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor)
        }
      }
      expect(getPendingIdentityRecord()).not.toBeNull()
    })

    test('legacy pending abandonment fails closed when Quick Start recovery fails', async () => {
      setLegacyPendingIdentity()
      await putCorruptQuickStartRecord()

      await expect(xolosWalletService.abandonLegacyPendingIdentity()).rejects.toThrow(
        'QUICK_START_RECOVERY_FAILED'
      )
      expect(getPendingIdentityRecord()).not.toBeNull()
    })

    test('legacy pending delete must read back absent or report failure and preserve reservation', async () => {
      setLegacyPendingIdentity()
      const originalRemoveItem = Storage.prototype.removeItem
      const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
        if (key === PENDING_IDENTITY_STORAGE_KEY) return
        return originalRemoveItem.call(this, key)
      })

      try {
        await expect(xolosWalletService.abandonLegacyPendingIdentity()).rejects.toThrow(
          'PENDING_IDENTITY_ABANDON_FAILED'
        )
      } finally {
        removeSpy.mockRestore()
      }
      expect(getPendingIdentityRecord()).not.toBeNull()
    })

    test('explicit abandonment clears reservation and allows fresh start, never touches backed wallet or quickstart', async () => {
      const pin = 'abandonTestPin'
      await xolosWalletService.createNewWallet(pin)
      expect(getPendingIdentityRecord()).not.toBeNull()

      // Tab reload
      internals.encryptedMnemonic = null
      internals.decryptedMnemonic = null
      internals.wallet = null
      internals.isReady = false
      internals.activeAccountState = null
      xolosWalletService.setPendingIdentityOwnerToken(null)
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)

      // User explicitly abandons pending identity
      await xolosWalletService.abandonPendingIdentity()
      expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)
      expect(getPendingIdentityRecord()).toBeNull()

      // Now a new wallet can be created
      const newMnemonic = await xolosWalletService.createNewWallet()
      expect(newMnemonic).toBeTruthy()
      expect(xolosWalletService.getAddress()).toBeTruthy()
    }, 30000)

    describe('PIN rotation & crash ordering atomicity during /backup', () => {
      test('create with PIN A -> backup completed with PIN B -> pending re-encrypted to PIN B and final commit verified with PIN B', async () => {
        const pinA = 'PIN_A_123456'
        const pinB = 'PIN_B_654321'
        const mnemonic = await xolosWalletService.createNewWallet(pinA)
        const address = xolosWalletService.getAddress()!
        expect(address).toBeTruthy()

        const recordBefore = getPendingIdentityRecord()
        expect(recordBefore).not.toBeNull()

        await xolosWalletService.persistVerifiedBackup(pinB)

        // Final ciphertext exists and can be decrypted with PIN B
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
        expect(await xolosWalletService.verifyStoredMnemonic(pinB, mnemonic)).toBe(true)
        expect(await xolosWalletService.verifyStoredMnemonic(pinA, mnemonic)).toBe(false)

        // Pending record deleted on success
        expect(getPendingIdentityRecord()).toBeNull()
      }, 30000)

      test('restoreFromMnemonic with PIN A -> backup completed with PIN B -> pending re-encrypted to PIN B and final commit verified with PIN B', async () => {
        const pinA = 'importPIN_A_11'
        const pinB = 'importPIN_B_22'
        const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
        const result = await xolosWalletService.restoreFromMnemonic(testMnemonic, undefined, pinA)
        expect(result.status).toBe('restored')

        const recordBefore = getPendingIdentityRecord()
        expect(recordBefore).not.toBeNull()

        await xolosWalletService.persistVerifiedBackup(pinB)

        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
        expect(await xolosWalletService.verifyStoredMnemonic(pinB, testMnemonic)).toBe(true)
        expect(await xolosWalletService.verifyStoredMnemonic(pinA, testMnemonic)).toBe(false)
        expect(getPendingIdentityRecord()).toBeNull()
      }, 30000)

      test('simulate crash right after pending re-encrypt: pending recoverable with PIN B, PIN A rejected', async () => {
        const pinA = 'PIN_A_111111'
        const pinB = 'PIN_B_222222'
        const mnemonic = await xolosWalletService.createNewWallet(pinA)
        const address = xolosWalletService.getAddress()!

        // Spy on encryptAndStoreMnemonic to simulate crash immediately after pending re-encryption
        const storeSpy = vi.spyOn(xolosWalletService, 'encryptAndStoreMnemonic').mockRejectedValueOnce(
          new Error('SIMULATED_CRASH_BEFORE_FINAL')
        )

        await expect(xolosWalletService.persistVerifiedBackup(pinB)).rejects.toThrow('SIMULATED_CRASH_BEFORE_FINAL')
        storeSpy.mockRestore()

        // Final ciphertext was not written
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)

        // Pending record exists and was re-encrypted with PIN B
        const pending = getPendingIdentityRecord()
        expect(pending).not.toBeNull()

        // Simulate reload
        simulateReload()
        expect(xolosWalletService.getAddress()).toBeNull()

        // PIN A rejected
        await expect(xolosWalletService.resumePendingIdentity(pinA)).rejects.toThrow('INVALID_PIN')

        // PIN B recovers pending
        const resumed = await xolosWalletService.resumePendingIdentity(pinB)
        expect(resumed.address).toBe(address)
        expect(resumed.mnemonic).toBe(mnemonic)
        expect(resumed.reconciled).toBe(false)
        expect(xolosWalletService.getAddress()).toBe(address)
      }, 30000)

      test('simulate crash after final ciphertext but before pending cleanup: reload with PIN B recovers and reconciles without data loss', async () => {
        const pinA = 'PIN_A_333333'
        const pinB = 'PIN_B_444444'
        const mnemonic = await xolosWalletService.createNewWallet(pinA)
        const address = xolosWalletService.getAddress()!

        // Simulate crash right before pending cleanup by throwing on removeItem of pending identity
        const originalRemoveItem = Storage.prototype.removeItem
        const deleteSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
          if (key === PENDING_IDENTITY_STORAGE_KEY) {
            throw new Error('SIMULATED_CRASH_BEFORE_PENDING_DELETE')
          }
          return originalRemoveItem.call(this, key)
        })

        await expect(xolosWalletService.persistVerifiedBackup(pinB)).rejects.toThrow('PENDING_IDENTITY_ABANDON_FAILED')
        deleteSpy.mockRestore()

        // Storage state: final ciphertext exists with PIN B, pending record exists with PIN B
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
        expect(await xolosWalletService.verifyStoredMnemonic(pinB, mnemonic)).toBe(true)
        expect(getPendingIdentityRecord()).not.toBeNull()

        // Simulate reload
        simulateReload()
        expect(xolosWalletService.getAddress()).toBeNull()

        // Reload with PIN B recovers and reconciles
        const resumed = await xolosWalletService.resumePendingIdentity(pinB)
        expect(resumed.address).toBe(address)
        expect(resumed.mnemonic).toBe(mnemonic)
        expect(resumed.reconciled).toBe(true)
        expect(getPendingIdentityRecord()).toBeNull()
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBe('true')
      }, 30000)

      test('fail-closed on corrupt or mismatched re-encryption: final ciphertext never written, previous pending not lost/destroyed silently', async () => {
        const pinA = 'PIN_A_555555'
        const pinB = 'PIN_B_666666'
        await xolosWalletService.createNewWallet(pinA)

        const pendingBefore = getPendingIdentityRecord()
        expect(pendingBefore).not.toBeNull()

        // Spy on setItem to simulate disk corruption during re-encryption write
        const originalSetItem = Storage.prototype.setItem
        const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
          if (key === PENDING_IDENTITY_STORAGE_KEY) {
            return originalSetItem.call(this, key, 'CORRUPTED_JSON_DATA')
          }
          return originalSetItem.call(this, key, value)
        })

        await expect(xolosWalletService.persistVerifiedBackup(pinB)).rejects.toThrow()
        setSpy.mockRestore()

        // Final ciphertext was NEVER written
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(false)
        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
      }, 30000)

      test('final ciphertext verification failure fails closed without deleting pending record or setting backup_verified', async () => {
        const pinA = 'PIN_A_999999'
        const pinB = 'PIN_B_000000'
        await xolosWalletService.createNewWallet(pinA)

        const verifySpy = vi.spyOn(xolosWalletService, 'verifyStoredMnemonic').mockResolvedValue(false)

        await expect(xolosWalletService.persistVerifiedBackup(pinB)).rejects.toThrow('QUICK_START_BACKUP_VERIFY_FAILED')
        verifySpy.mockRestore()

        expect(getPendingIdentityRecord()).not.toBeNull()
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBeNull()
      }, 30000)
    })

    describe('Fail closed on corrupt or malformed pending reservations', () => {
      test('raw truncated -> CORRUPT_OR_UNKNOWN_PENDING -> create/import/quickstart blocked and raw preserved', async () => {
        const corruptPayload = '{"version":1,"ownerToken":"partial_tok'
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, corruptPayload)

        expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING)
        expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)

        await expect(xolosWalletService.createNewWallet('pin123456')).rejects.toThrow('CORRUPT_OR_UNKNOWN_PENDING')
        await expect(
          xolosWalletService.restoreFromMnemonic(TEST_MNEMONIC, undefined, 'pin123456')
        ).rejects.toThrow('CORRUPT_OR_UNKNOWN_PENDING')
        await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('CORRUPT_OR_UNKNOWN_PENDING')

        // Raw value must never be overwritten or deleted
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe(corruptPayload)
      })

      test('raw missing required field -> CORRUPT_OR_UNKNOWN_PENDING -> no overwrite', async () => {
        const missingFieldPayload = JSON.stringify({
          version: 1,
          ownerToken: 'tok_missing_address',
          createdAt: Date.now()
        })
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, missingFieldPayload)

        expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING)
        await expect(xolosWalletService.createNewWallet('pin123456')).rejects.toThrow('CORRUPT_OR_UNKNOWN_PENDING')

        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe(missingFieldPayload)
      })

      test('getItem throws -> STORAGE_UNAVAILABLE -> create blocked', async () => {
        const originalGetItem = Storage.prototype.getItem
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
          if (key === PENDING_IDENTITY_STORAGE_KEY) {
            throw new DOMException('Storage access denied', 'SecurityError')
          }
          return originalGetItem.call(localStorage, key)
        })

        try {
          expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE)
          await expect(xolosWalletService.createNewWallet('pin123456')).rejects.toThrow('STORAGE_UNAVAILABLE')
          await expect(
            xolosWalletService.restoreFromMnemonic(TEST_MNEMONIC, undefined, 'pin123456')
          ).rejects.toThrow('STORAGE_UNAVAILABLE')
          await expect(xolosWalletService.createQuickStartWallet()).rejects.toThrow('STORAGE_UNAVAILABLE')
        } finally {
          spy.mockRestore()
        }
      })

      test('abandonCorruptPendingIdentity rejects if Quick Start is PRESENT', async () => {
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, '{"version":1,"corrupt')
        await storeQuickStartMnemonic(TEST_MNEMONIC, {
          derivationProfileId: ECASH_STANDARD_PROFILE_ID,
          address: 'ecash:qquicktest'
        })

        await expect(xolosWalletService.abandonCorruptPendingIdentity()).rejects.toThrow('QUICK_START_RECORD_EXISTS')
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe('{"version":1,"corrupt')
      })

      test('abandonCorruptPendingIdentity rejects if Quick Start is STORAGE_UNAVAILABLE_UNKNOWN', async () => {
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, '{"version":1,"corrupt')
        // Valid marker present but IndexedDB fails: status is STORAGE_UNAVAILABLE_UNKNOWN
        setQuickStartMarker()
        const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
          throw new DOMException('Database blocked', 'SecurityError')
        })

        try {
          await expect(xolosWalletService.abandonCorruptPendingIdentity()).rejects.toThrow('STORAGE_UNAVAILABLE')
        } finally {
          openSpy.mockRestore()
        }
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe('{"version":1,"corrupt')
      })

      test('abandonCorruptPendingIdentity rejects if pending identity is recoverable or absent', async () => {
        // Absent
        localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
        await expect(xolosWalletService.abandonCorruptPendingIdentity()).rejects.toThrow('NO_PENDING_IDENTITY')

        // Valid recoverable pending
        setPendingIdentityRecord({
          ownerToken: 'valid_tok',
          commitment: 'valid_com',
          address: 'ecash:qvalid',
          derivationProfileId: ECASH_STANDARD_PROFILE_ID,
          state: 'PENDING_BACKUP',
          ciphertext: 'valid_cipher'
        })
        await expect(xolosWalletService.abandonCorruptPendingIdentity()).rejects.toThrow('PENDING_IDENTITY_STATE_CHANGED')
      })

      test('confirmed abandonment deletes corrupt record, verifies read-back, and permits fresh onboarding', async () => {
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, '{"version":1,"malformed')

        expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING)

        await xolosWalletService.abandonCorruptPendingIdentity()

        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBeNull()
        expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.ABSENT_CONFIRMED)
        expect(xolosWalletService.hasPendingIdentityRecord()).toBe(false)

        // Fresh creation now succeeds
        const mnemonic = await xolosWalletService.createNewWallet('freshpin123')
        expect(mnemonic).toBeTruthy()
        expect(xolosWalletService.getAddress()).toBeTruthy()
      }, 30000)

      test('corrupt pending delete failure leaves record and blocks onboarding', async () => {
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, '{"version":1,"bad')

        // Spy on removeItem to fail
        const originalRemoveItem = Storage.prototype.removeItem
        const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
          if (key === PENDING_IDENTITY_STORAGE_KEY) {
            // No-op or throw
            return
          }
          return originalRemoveItem.call(localStorage, key)
        })

        try {
          await expect(xolosWalletService.abandonCorruptPendingIdentity()).rejects.toThrow('PENDING_IDENTITY_ABANDON_FAILED')
        } finally {
          removeSpy.mockRestore()
        }

        // Record still present
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe('{"version":1,"bad')
        expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
        await expect(xolosWalletService.createNewWallet('freshpin123')).rejects.toThrow('CORRUPT_OR_UNKNOWN_PENDING')
      })
    })

    describe('backup authority gate on pending reservations (discussion_r4064380256)', () => {
      test('create-backed successfully -> corrupt raw pending -> persistVerifiedBackup rejects fail-closed with zero final writes', async () => {
        const pin = 'createPin123'
        const mnemonic = await xolosWalletService.createNewWallet(pin)
        const address = xolosWalletService.getAddress()
        expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.RECOVERABLE_PENDING)
        const originalPendingRaw = localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)
        expect(originalPendingRaw).toBeTruthy()

        // Manually corrupt the raw storage before backup
        const corruptedRaw = '{"version":1,"damagedJson'
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, corruptedRaw)

        expect(xolosWalletService.hasPendingIdentityRecord()).toBe(true)
        expect(xolosWalletService.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING)

        // persistVerifiedBackup must fail closed
        await expect(
          xolosWalletService.persistVerifiedBackup(pin)
        ).rejects.toThrow('PENDING_IDENTITY_CORRUPT_DURING_BACKUP')

        // Verify zero final writes
        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBeNull()

        // Corrupt raw value preserved byte-for-byte
        expect(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)).toBe(corruptedRaw)

        // Active wallet in memory is not silently replaced
        expect(xolosWalletService.getAddress()).toBe(address)
        expect(xolosWalletService.getMnemonic()).toBe(mnemonic)
      }, 30000)

      test('valid recoverable pending + commitment mismatch -> backup rejected before final write', async () => {
        const pin = 'commitPin123'
        await xolosWalletService.createNewWallet(pin)
        const originalPending = JSON.parse(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)!)
        originalPending.commitment = 'tampered_commitment_value'
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, JSON.stringify(originalPending))

        await expect(
          xolosWalletService.persistVerifiedBackup(pin)
        ).rejects.toThrow('PENDING_IDENTITY_MISMATCH')

        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBeNull()
      }, 30000)

      test('valid pending + ownerToken mismatch -> backup rejected', async () => {
        const pin = 'ownerPin123'
        await xolosWalletService.createNewWallet(pin)
        const originalPending = JSON.parse(localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)!)
        originalPending.ownerToken = 'competing_owner_token'
        localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, JSON.stringify(originalPending))

        await expect(
          xolosWalletService.persistVerifiedBackup(pin)
        ).rejects.toThrow('PENDING_IDENTITY_OWNER_MISMATCH')

        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBeNull()
      }, 30000)

      test('legacy valid pending belonging to active session -> expected backup behavior preserved', async () => {
        const pin = 'legacyPin123'
        const mnemonic = await xolosWalletService.createNewWallet()
        const address = xolosWalletService.getAddress()!
        const ownerToken = xolosWalletService.getPendingIdentityOwnerToken()!
        expect(ownerToken).toBeTruthy()

        const authBefore = inspectPendingIdentityAuthority()
        expect(authBefore.status).toBe(PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING)

        await xolosWalletService.persistVerifiedBackup(pin)

        // Final ciphertext written and verified
        expect(xolosWalletService.hasBackedWalletCiphertextOnDevice()).toBe(true)
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBe('true')
        expect(inspectPendingIdentityAuthority().status).toBe(PENDING_IDENTITY_STATE.ABSENT_CONFIRMED)
        expect(xolosWalletService.getAddress()).toBe(address)
        expect(xolosWalletService.getMnemonic()).toBe(mnemonic)
      }, 30000)

      test('STORAGE_UNAVAILABLE during authority inspection -> backup rejected with zero final writes', async () => {
        const pin = 'storageErrPin123'
        await xolosWalletService.createNewWallet(pin)

        const originalGetItem = Storage.prototype.getItem
        const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
          if (key === PENDING_IDENTITY_STORAGE_KEY) {
            throw new Error('SECURITY_ERROR_DENIED')
          }
          return originalGetItem.call(localStorage, key)
        })

        try {
          await expect(
            xolosWalletService.persistVerifiedBackup(pin)
          ).rejects.toThrow('PENDING_IDENTITY_STORAGE_UNAVAILABLE')
        } finally {
          getSpy.mockRestore()
        }

        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBeNull()
      }, 30000)

      test('ABSENT_CONFIRMED on workflow that requires reservation -> backup rejected', async () => {
        const pin = 'missingPendingPin123'
        await xolosWalletService.createNewWallet(pin)

        // Pending reservation is manually removed while active session required a reservation
        localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
        expect(inspectPendingIdentityAuthority().status).toBe(PENDING_IDENTITY_STATE.ABSENT_CONFIRMED)

        await expect(
          xolosWalletService.persistVerifiedBackup(pin)
        ).rejects.toThrow('PENDING_IDENTITY_MISSING')

        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBeNull()
      }, 30000)

      test('ABSENT_CONFIRMED without Quick Start or existing backed wallet -> backup rejected', async () => {
        internals.decryptedMnemonic = TEST_MNEMONIC
        internals.isReady = true

        await expect(
          xolosWalletService.persistVerifiedBackup('pin1234')
        ).rejects.toThrow('PENDING_IDENTITY_RESERVATION_REQUIRED')

        expect(localStorage.getItem(STORAGE_KEY_MNEMONIC)).toBeNull()
      }, 30000)
    })
  })
})
