// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { xolosWalletService } from './XolosWalletService'
import {
  QuickStartUnavailableError,
  clearQuickStartMnemonic,
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
  })
})
