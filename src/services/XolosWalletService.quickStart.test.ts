// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { xolosWalletService } from './XolosWalletService'
import {
  QuickStartUnavailableError,
  clearQuickStartMnemonic,
  hasQuickStartMnemonic,
  setQuickStartCreationLockForTests
} from './quickStartStorage'

const STORAGE_KEY_MNEMONIC = 'xoloswallet_encrypted_mnemonic'
const ORIGINAL_CIPHERTEXT = 'pin-backed-ciphertext-original'

type QuickStartInternals = {
  encryptedMnemonic: string | null
  decryptedMnemonic: string | null
  wallet: unknown
  isReady: boolean
}

const internals = xolosWalletService as unknown as QuickStartInternals

describe('Quick Start backed-wallet and creation-lock boundaries', () => {
  beforeEach(async () => {
    localStorage.clear()
    internals.encryptedMnemonic = null
    internals.decryptedMnemonic = null
    internals.wallet = null
    internals.isReady = false
    setQuickStartCreationLockForTests(async (operation) => operation())
    await clearQuickStartMnemonic()
  })

  afterEach(async () => {
    setQuickStartCreationLockForTests(null)
    localStorage.clear()
    internals.encryptedMnemonic = null
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
})
