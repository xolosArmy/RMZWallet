// @vitest-environment jsdom

import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { xolosWalletService } from './XolosWalletService'
import type { WalletLoadResult } from './XolosWalletService'
import type { DecryptPasswordResult } from './crypto'
import { encryptWithPassword } from './crypto'
import {
  ECASH_STANDARD_PROFILE_ID,
  serializeStoredDerivationProfileMetadata
} from './derivationProfiles'

const require = createRequire(import.meta.url)
const MinimalXECWallet = require('minimal-xec-wallet') as {
  prototype: { initialize(): Promise<void> }
}
const STORAGE_KEY = 'xoloswallet_encrypted_mnemonic'
const PROFILE_KEY = 'xoloswallet_derivation_profile_v1'
const PIN = 'correct-pin-123'
const MNEMONIC_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDRESS_B = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const STALE_A = 'stale-ciphertext-A'
const EXTERNAL_C = 'new-ciphertext-C'
const MIGRATED_B = 'migrated-ciphertext-B-prime'

type UnlockInternals = {
  wallet: unknown
  isReady: boolean
  encryptedMnemonic: string | null
  decryptedMnemonic: string | null
  activeProfileId: string
  activeAccountState: unknown
  walletActivationInFlight: boolean
  decryptStoredMnemonic(password: string, ciphertext?: string): Promise<DecryptPasswordResult>
  activateDecryptedStoredMnemonic(plainText: string): Promise<WalletLoadResult>
  persistMigratedStoredMnemonic(ciphertext: string | null, expected: string): void
}

const internals = xolosWalletService as unknown as UnlockInternals
const originalState = {
  wallet: internals.wallet,
  isReady: internals.isReady,
  encryptedMnemonic: internals.encryptedMnemonic,
  decryptedMnemonic: internals.decryptedMnemonic,
  activeProfileId: internals.activeProfileId,
  activeAccountState: internals.activeAccountState,
  walletActivationInFlight: internals.walletActivationInFlight
}
let ciphertextB: string

beforeAll(async () => {
  ciphertextB = await encryptWithPassword(MNEMONIC_B, PIN)
})

beforeEach(() => {
  localStorage.clear()
  Object.assign(internals, {
    wallet: null,
    isReady: false,
    encryptedMnemonic: null,
    decryptedMnemonic: null,
    activeProfileId: ECASH_STANDARD_PROFILE_ID,
    activeAccountState: null,
    walletActivationInFlight: false
  })
  localStorage.setItem(PROFILE_KEY, serializeStoredDerivationProfileMetadata(ECASH_STANDARD_PROFILE_ID))
  vi.spyOn(MinimalXECWallet.prototype, 'initialize').mockResolvedValue()
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(internals, originalState)
  localStorage.clear()
})

describe('normal stored-wallet unlock follows durable cross-tab ciphertext', () => {
  test.each([
    ['empty cache', null],
    ['stale A cache', STALE_A]
  ])('%s: loadFromStorage decrypts current B and recovers its address without reload', async (_case, staleCache) => {
    internals.encryptedMnemonic = staleCache
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    expect(xolosWalletService.hasEncryptedWalletOnDevice()).toBe(false)

    await expect(xolosWalletService.loadFromStorage(PIN)).resolves.toMatchObject({ status: 'loaded' })
    expect(xolosWalletService.getMnemonic()).toBe(MNEMONIC_B)
    expect(xolosWalletService.getAddress()).toBe(ADDRESS_B)
    expect(internals.encryptedMnemonic).toBe(ciphertextB)
    expect(xolosWalletService.hasEncryptedWalletOnDevice()).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ciphertextB)
  }, 30000)

  test('unlockEncryptedWallet also decrypts B, not stale cached A', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)

    await xolosWalletService.unlockEncryptedWallet(PIN)
    expect(internals.encryptedMnemonic).toBe(ciphertextB)
    expect(internals.decryptedMnemonic).toBe(MNEMONIC_B)
    expect(internals.wallet).toBeNull()
  }, 30000)

  test('wrong PIN never commits B to cache or activates a wallet', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)

    await expect(xolosWalletService.loadFromStorage('wrong-pin')).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ciphertextB)
    expect(internals.encryptedMnemonic).toBe(STALE_A)
    expect(internals.decryptedMnemonic).toBeNull()
    expect(internals.wallet).toBeNull()
  }, 30000)

  test('confirmed storage absence does not fall back to cached A', async () => {
    internals.encryptedMnemonic = STALE_A
    await expect(xolosWalletService.loadFromStorage(PIN)).rejects.toThrow('No existe una semilla cifrada')
    expect(internals.encryptedMnemonic).toBe(STALE_A)
    expect(internals.wallet).toBeNull()
  })

  test('B replaced by C during decrypt aborts before cache commit or activation', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    let finishDecrypt!: (result: DecryptPasswordResult) => void
    const decrypt = vi.spyOn(internals, 'decryptStoredMnemonic').mockImplementation(
      () => new Promise(resolve => { finishDecrypt = resolve })
    )
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')

    const unlocking = xolosWalletService.loadFromStorage(PIN)
    expect(decrypt).toHaveBeenCalledWith(PIN, ciphertextB)
    localStorage.setItem(STORAGE_KEY, EXTERNAL_C)
    finishDecrypt({ plainText: MNEMONIC_B, migratedCipherText: null })

    await expect(unlocking).rejects.toThrow('STORED_WALLET_CHANGED')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(EXTERNAL_C)
    expect(internals.encryptedMnemonic).toBe(STALE_A)
    expect(internals.decryptedMnemonic).toBeNull()
    expect(activate).not.toHaveBeenCalled()
  })

  test('legacy B migration never overwrites C committed during decrypt', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    let finishDecrypt!: (result: DecryptPasswordResult) => void
    vi.spyOn(internals, 'decryptStoredMnemonic').mockImplementation(
      () => new Promise(resolve => { finishDecrypt = resolve })
    )
    const migration = vi.spyOn(internals, 'persistMigratedStoredMnemonic')
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')
    const writes = vi.spyOn(Storage.prototype, 'setItem')

    const unlocking = xolosWalletService.loadFromStorage(PIN)
    localStorage.setItem(STORAGE_KEY, EXTERNAL_C)
    finishDecrypt({ plainText: MNEMONIC_B, migratedCipherText: MIGRATED_B })

    await expect(unlocking).rejects.toThrow('STORED_WALLET_CHANGED')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(EXTERNAL_C)
    expect(writes.mock.calls.filter(([key, value]) => key === STORAGE_KEY && value === MIGRATED_B)).toEqual([])
    expect(migration).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    expect(internals.encryptedMnemonic).toBe(STALE_A)
  })

  test('migration compare-before-write catches C after the first post-decrypt recheck', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue({
      plainText: MNEMONIC_B,
      migratedCipherText: MIGRATED_B
    })
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')
    const originalGetItem = Storage.prototype.getItem
    const originalSetItem = Storage.prototype.setItem
    let ciphertextReads = 0
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      const value = originalGetItem.call(this, key)
      if (key === STORAGE_KEY && ++ciphertextReads === 2) {
        originalSetItem.call(this, STORAGE_KEY, EXTERNAL_C)
      }
      return value
    })
    const writes = vi.spyOn(Storage.prototype, 'setItem')

    await expect(xolosWalletService.loadFromStorage(PIN)).rejects.toThrow('STORED_WALLET_CHANGED')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(EXTERNAL_C)
    expect(writes.mock.calls.filter(([key, value]) => key === STORAGE_KEY && value === MIGRATED_B)).toEqual([])
    expect(internals.encryptedMnemonic).toBe(STALE_A)
    expect(activate).not.toHaveBeenCalled()
  })

  test('stable legacy B migrates with compare, exact read-back, then cache commit', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue({
      plainText: MNEMONIC_B,
      migratedCipherText: MIGRATED_B
    })
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockResolvedValue({
      status: 'loaded', notice: 'loaded'
    })

    await xolosWalletService.loadFromStorage(PIN)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(MIGRATED_B)
    expect(internals.encryptedMnemonic).toBe(MIGRATED_B)
    expect(activate).toHaveBeenCalledWith(MNEMONIC_B, undefined)
  })

  test.each(['write throws', 'read-back differs'] as const)('%s: failed migration cannot activate or commit cache', async (failure) => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue({
      plainText: MNEMONIC_B,
      migratedCipherText: MIGRATED_B
    })
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === STORAGE_KEY && value === MIGRATED_B) {
        if (failure === 'write throws') throw new Error('storage unavailable')
        return
      }
      return originalSetItem.call(this, key, value)
    })

    await expect(xolosWalletService.loadFromStorage(PIN)).rejects.toThrow('STORED_WALLET_MIGRATION_PERSIST_FAILED')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ciphertextB)
    expect(internals.encryptedMnemonic).toBe(STALE_A)
    expect(activate).not.toHaveBeenCalled()
  })

  test('X402 still rejects cache A versus durable B without synchronizing or signing', async () => {
    internals.encryptedMnemonic = STALE_A
    localStorage.setItem(STORAGE_KEY, ciphertextB)
    const decrypt = vi.spyOn(internals, 'decryptStoredMnemonic')
    const account = vi.spyOn(xolosWalletService, 'getX402ActiveAccount')

    await expect(xolosWalletService.activateStoredWalletForX402(PIN)).rejects.toMatchObject({
      reason: 'activation-failed'
    })
    expect(decrypt).not.toHaveBeenCalled()
    expect(account).not.toHaveBeenCalled()
    expect(internals.encryptedMnemonic).toBe(STALE_A)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ciphertextB)
  })
})
