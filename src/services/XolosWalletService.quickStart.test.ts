// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { xolosWalletService } from './XolosWalletService'
import {
  PENDING_IDENTITY_STORAGE_KEY,
  QUICK_START_MARKER_STORAGE_KEY,
  QuickStartUnavailableError,
  clearQuickStartMnemonic,
  getPendingIdentityRecord,
  hasQuickStartMnemonic,
  loadQuickStartMnemonic,
  setQuickStartCreationLockForTests
} from './quickStartStorage'

const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'
const ORIGINAL_CIPHERTEXT = 'pin-backed-ciphertext-original'

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

describe('Quick Start backed-wallet and creation-lock boundaries', () => {
  beforeEach(async () => {
    localStorage.clear()
    internals.encryptedMnemonic = null
    internals.decryptedMnemonic = null
    internals.wallet = null
    internals.isReady = false
    internals.activeAccountState = null
    setQuickStartCreationLockForTests(async (operation) => operation())
    await clearQuickStartMnemonic()
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
  })
})


