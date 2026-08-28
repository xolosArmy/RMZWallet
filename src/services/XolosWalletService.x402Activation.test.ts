// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  X402StoredWalletActivationError,
  isCanonicalX402WalletAccount,
  xolosWalletService
} from './XolosWalletService'
import type { WalletLoadResult } from './XolosWalletService'
import type { DecryptPasswordResult } from './crypto'
import {
  ECASH_STANDARD_PROFILE_ID,
  serializeStoredDerivationProfileMetadata
} from './derivationProfiles'

const require = createRequire(import.meta.url)
const MinimalXECWallet = require('minimal-xec-wallet') as {
  prototype: {
    initialize(): Promise<void>
  }
}

const ACCOUNT = Object.freeze({
  address: 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv',
  publicKey: '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
})
const DECRYPTED = Object.freeze({
  plainText: 'decrypted mnemonic',
  migratedCipherText: null
}) satisfies DecryptPasswordResult
const PROFILE_STORAGE_KEY = 'xoloswallet_derivation_profile_v1'
const MNEMONIC_STORAGE_KEY = 'xoloswallet_encrypted_mnemonic'
const DEFAULT_CIPHERTEXT = 'opaque-encrypted-wallet-container'
const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CASHTAB_ACCOUNT = Object.freeze({
  address: 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg',
  publicKey: '03ee1364cd7af3a9ffbbbd886388776a6f92a7b8dd986f6a8578885e4b856f7bfb'
})

type ActivationInternals = {
  wallet: unknown
  isReady: boolean
  encryptedMnemonic: string | null
  decryptedMnemonic: string | null
  scanCache: unknown
  scanPromise: Promise<unknown> | null
  scanPromiseGapLimit: number | null
  hdAddressCache: unknown[]
  activeProfileId: string
  activeAccountState: unknown
  walletActivationInFlight: boolean
  decryptStoredMnemonic(password: string): Promise<DecryptPasswordResult>
  persistMigratedStoredMnemonic(migratedCipherText: string | null): void
  activateDecryptedStoredMnemonic(plainText: string): Promise<WalletLoadResult>
}

const internals = xolosWalletService as unknown as ActivationInternals
const originalState = {
  wallet: internals.wallet,
  isReady: internals.isReady,
  encryptedMnemonic: internals.encryptedMnemonic,
  decryptedMnemonic: internals.decryptedMnemonic,
  scanCache: internals.scanCache,
  scanPromise: internals.scanPromise,
  scanPromiseGapLimit: internals.scanPromiseGapLimit,
  hdAddressCache: internals.hdAddressCache,
  activeProfileId: internals.activeProfileId,
  activeAccountState: internals.activeAccountState,
  walletActivationInFlight: internals.walletActivationInFlight
}

beforeEach(() => {
  internals.encryptedMnemonic = DEFAULT_CIPHERTEXT
  internals.activeProfileId = ECASH_STANDARD_PROFILE_ID
  localStorage.setItem(MNEMONIC_STORAGE_KEY, DEFAULT_CIPHERTEXT)
  localStorage.setItem(
    PROFILE_STORAGE_KEY,
    serializeStoredDerivationProfileMetadata(ECASH_STANDARD_PROFILE_ID)
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(internals, originalState)
  localStorage.clear()
})

describe('X402 stored-wallet activation boundary', () => {
  test('wallet-exists primitive exposes only a boolean derived from private service state', () => {
    internals.encryptedMnemonic = null
    localStorage.removeItem(MNEMONIC_STORAGE_KEY)
    expect(xolosWalletService.hasEncryptedWalletOnDevice()).toBe(false)

    internals.encryptedMnemonic = DEFAULT_CIPHERTEXT
    localStorage.setItem(MNEMONIC_STORAGE_KEY, DEFAULT_CIPHERTEXT)
    expect(xolosWalletService.hasEncryptedWalletOnDevice()).toBe(true)
    expect(typeof xolosWalletService.hasEncryptedWalletOnDevice()).toBe('boolean')

    localStorage.setItem(MNEMONIC_STORAGE_KEY, 'replacement-from-another-tab')
    expect(xolosWalletService.hasEncryptedWalletOnDevice()).toBe(false)
  })

  test('full X402 activation reuses canonical stored activation and returns only the bound public account', async () => {
    const decrypt = vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
    const migrate = vi.spyOn(internals, 'persistMigratedStoredMnemonic')
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockResolvedValue({
      status: 'loaded',
      selectedProfileId: 'ecash-standard-1899',
      notice: 'loaded'
    })
    vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockReturnValue(ACCOUNT)

    await expect(xolosWalletService.activateStoredWalletForX402('local-password')).resolves.toEqual({
      status: 'active',
      account: ACCOUNT
    })
    expect(decrypt).toHaveBeenCalledTimes(1)
    expect(decrypt).toHaveBeenCalledWith('local-password')
    expect(migrate).toHaveBeenCalledWith(null)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith('decrypted mnemonic')
  })

  test('cold-start activation establishes all real readiness fields and the canonical receive/0 account', async () => {
    Object.assign(internals, {
      wallet: null,
      isReady: false,
      decryptedMnemonic: null,
      scanCache: null,
      scanPromise: null,
      scanPromiseGapLimit: null,
      hdAddressCache: [],
      activeAccountState: null
    })
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      serializeStoredDerivationProfileMetadata(ECASH_STANDARD_PROFILE_ID)
    )
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue({
      plainText: PUBLIC_TEST_MNEMONIC,
      migratedCipherText: null
    })
    const initialize = vi.spyOn(MinimalXECWallet.prototype, 'initialize').mockResolvedValue()

    await expect(
      xolosWalletService.activateStoredWalletForX402('correct-password')
    ).resolves.toEqual({ status: 'active', account: CASHTAB_ACCOUNT })

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(internals.wallet).not.toBeNull()
    expect(internals.isReady).toBe(true)
    expect(internals.decryptedMnemonic).toBe(PUBLIC_TEST_MNEMONIC)
    expect(internals.activeAccountState).not.toBeNull()
    expect(xolosWalletService.getX402ActiveAccount()).toEqual(CASHTAB_ACCOUNT)
  })

  test('choice-required is returned without selecting a profile or exposing discovery details', async () => {
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
    vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockResolvedValue({
      status: 'choice-required',
      detection: {
        kind: 'choice-required',
        reason: 'multi-activity',
        profiles: {} as never
      },
      notice: 'choose'
    })
    const account = vi.spyOn(xolosWalletService, 'getX402ActiveAccount')

    await expect(xolosWalletService.activateStoredWalletForX402('local-password')).resolves.toEqual({
      status: 'choice-required'
    })
    expect(account).not.toHaveBeenCalled()
  })

  test('wrong password is the only failure mapped to the retryable unlock-failed boundary', async () => {
    vi.spyOn(internals, 'decryptStoredMnemonic').mockRejectedValue(new Error('private detail'))
    const migrate = vi.spyOn(internals, 'persistMigratedStoredMnemonic')
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')

    await expect(xolosWalletService.activateStoredWalletForX402('wrong-password')).rejects.toMatchObject({
      name: 'X402StoredWalletActivationError',
      message: 'X402_STORED_WALLET_ACTIVATION_FAILED',
      reason: 'unlock-failed'
    })
    expect(migrate).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  test('a legacy-cipher migration storage failure after decryption is terminal activation-failed', async () => {
    internals.encryptedMnemonic = 'legacy-ciphertext'
    localStorage.setItem(MNEMONIC_STORAGE_KEY, 'legacy-ciphertext')
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue({
      plainText: 'decrypted mnemonic',
      migratedCipherText: 'migrated-v2-ciphertext'
    })
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === MNEMONIC_STORAGE_KEY) throw new Error('storage unavailable')
    })

    await expect(xolosWalletService.activateStoredWalletForX402('correct-password')).rejects.toMatchObject({
      name: 'X402StoredWalletActivationError',
      reason: 'activation-failed'
    })
    expect(activate).not.toHaveBeenCalled()
    expect(internals.encryptedMnemonic).toBe('legacy-ciphertext')
  })

  test('failure after successful decryption atomically restores all wallet identity state', async () => {
    const priorState = {
      wallet: { marker: 'prior-wallet' },
      isReady: true,
      decryptedMnemonic: 'prior mnemonic',
      scanCache: { marker: 'prior-scan' },
      scanPromise: Promise.resolve({ marker: 'prior-promise' }),
      scanPromiseGapLimit: 42,
      hdAddressCache: [{ marker: 'prior-owner' }],
      activeProfileId: 'ecash-standard-1899',
      activeAccountState: { marker: 'prior-account' }
    }
    Object.assign(internals, priorState)
    const priorProfileMetadata = serializeStoredDerivationProfileMetadata(
      ECASH_STANDARD_PROFILE_ID
    )
    localStorage.setItem(PROFILE_STORAGE_KEY, priorProfileMetadata)
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
    vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockImplementation(async () => {
      Object.assign(internals, {
        wallet: { marker: 'partial-wallet' },
        isReady: false,
        decryptedMnemonic: 'new sensitive mnemonic',
        scanCache: { marker: 'partial-scan' },
        scanPromise: Promise.resolve({ marker: 'partial-promise' }),
        scanPromiseGapLimit: 7,
        hdAddressCache: [{ marker: 'partial-owner' }],
        activeProfileId: 'tonalli-legacy-899',
        activeAccountState: { marker: 'partial-account' }
      })
      throw new Error('network or wallet initialization failure')
    })

    await expect(xolosWalletService.activateStoredWalletForX402('correct-password')).rejects.toMatchObject({
      name: 'X402StoredWalletActivationError',
      reason: 'activation-failed'
    })
    expect(internals).toMatchObject(priorState)
    expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBe(priorProfileMetadata)
    expect(internals.walletActivationInFlight).toBe(false)
  })

  test.each([
    ['missing account', null],
    ['whitespace address', { ...ACCOUNT, address: ` ${ACCOUNT.address}` }],
    ['uppercase address', { ...ACCOUNT, address: ACCOUNT.address.toUpperCase() }],
    ['invalid address', { ...ACCOUNT, address: 'ecash:invalid' }],
    ['P2SH address', { ...ACCOUNT, address: 'ecash:ppumqqygwcnt999fz3gp5nxjy66ckg6esv3ca5vmy3' }],
    ['address from another key', { ...ACCOUNT, address: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq' }],
    ['off-curve compressed public key', {
      address: 'ecash:qzklee2022djz48rcdsmhclh6swmqc6hzuqf9vutqh',
      publicKey: `02${'11'.repeat(32)}`
    }],
    ['uppercase public key', { ...ACCOUNT, publicKey: ACCOUNT.publicKey.toUpperCase() }],
    ['uncompressed public key', { ...ACCOUNT, publicKey: `04${'11'.repeat(64)}` }]
  ] as const)(
    'a loaded result with %s fails the mandatory public-account postcondition',
    async (_label, account) => {
      vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
      vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockResolvedValue({
        status: 'loaded',
        notice: 'loaded'
      })
      vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockReturnValue(account)

      await expect(xolosWalletService.activateStoredWalletForX402('local-password')).rejects.toMatchObject({
        name: 'X402StoredWalletActivationError',
        reason: 'activation-failed'
      })
    }
  )

  test('the exact valid P2PKH address/public-key pair passes curve and binding validation', () => {
    expect(isCanonicalX402WalletAccount(ACCOUNT)).toBe(true)
  })

  test('an active-account invariant exception after activation fails terminally', async () => {
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
    vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockResolvedValue({
      status: 'loaded',
      notice: 'loaded'
    })
    vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockImplementation(() => {
      throw new Error('private invariant detail')
    })

    await expect(xolosWalletService.activateStoredWalletForX402('local-password')).rejects.toMatchObject({
      name: 'X402StoredWalletActivationError',
      reason: 'activation-failed'
    })
  })

  test('overlapping full X402 activations are serialized fail-closed', async () => {
    let resolveDecrypt: ((value: DecryptPasswordResult) => void) | undefined
    const pendingDecrypt = new Promise<DecryptPasswordResult>((resolve) => {
      resolveDecrypt = resolve
    })
    vi.spyOn(internals, 'decryptStoredMnemonic').mockImplementation(() => pendingDecrypt)
    vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockResolvedValue({
      status: 'loaded',
      notice: 'loaded'
    })
    vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockReturnValue(ACCOUNT)

    const first = xolosWalletService.activateStoredWalletForX402('first-password')
    const second = xolosWalletService.activateStoredWalletForX402('second-password')
    await expect(second).rejects.toEqual(
      new X402StoredWalletActivationError('activation-failed')
    )

    resolveDecrypt?.(DECRYPTED)
    await expect(first).resolves.toEqual({ status: 'active', account: ACCOUNT })
  })

  test('ordinary stored-wallet activation holds the same mutex until its async activation settles', async () => {
    let resolveActivation: ((value: WalletLoadResult) => void) | undefined
    const pendingActivation = new Promise<WalletLoadResult>((resolve) => {
      resolveActivation = resolve
    })
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
    vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockImplementation(
      () => pendingActivation
    )

    const ordinaryLoad = xolosWalletService.loadFromStorage('normal-wallet-password')
    await Promise.resolve()
    await expect(
      xolosWalletService.activateStoredWalletForX402('h3b-password')
    ).rejects.toEqual(new X402StoredWalletActivationError('activation-failed'))
    expect(() => xolosWalletService.clearStoredWallet()).toThrow('WALLET_ACTIVATION_IN_PROGRESS')

    resolveActivation?.({ status: 'loaded', notice: 'loaded' })
    await expect(ordinaryLoad).resolves.toEqual({ status: 'loaded', notice: 'loaded' })
    expect(internals.walletActivationInFlight).toBe(false)
  })

  test('stored-wallet replacement during decryption fails before activation and is never overwritten', async () => {
    let resolveDecrypt: ((value: DecryptPasswordResult) => void) | undefined
    const pendingDecrypt = new Promise<DecryptPasswordResult>((resolve) => {
      resolveDecrypt = resolve
    })
    vi.spyOn(internals, 'decryptStoredMnemonic').mockImplementation(() => pendingDecrypt)
    const activate = vi.spyOn(internals, 'activateDecryptedStoredMnemonic')

    const pending = xolosWalletService.activateStoredWalletForX402('correct-password')
    await Promise.resolve()
    localStorage.setItem(MNEMONIC_STORAGE_KEY, 'replacement-from-another-tab')
    resolveDecrypt?.(DECRYPTED)

    await expect(pending).rejects.toMatchObject({ reason: 'activation-failed' })
    expect(activate).not.toHaveBeenCalled()
    expect(localStorage.getItem(MNEMONIC_STORAGE_KEY)).toBe('replacement-from-another-tab')
  })

  test('rollback does not clobber replacement-wallet profile metadata after a ciphertext race', async () => {
    localStorage.removeItem(PROFILE_STORAGE_KEY)
    const expectedRecoveredProfile = serializeStoredDerivationProfileMetadata(
      ECASH_STANDARD_PROFILE_ID
    )
    let resolveActivation: ((value: WalletLoadResult) => void) | undefined
    const pendingActivation = new Promise<WalletLoadResult>((resolve) => {
      resolveActivation = resolve
    })
    vi.spyOn(internals, 'decryptStoredMnemonic').mockResolvedValue(DECRYPTED)
    vi.spyOn(internals, 'activateDecryptedStoredMnemonic').mockImplementation(() => {
      localStorage.setItem(PROFILE_STORAGE_KEY, expectedRecoveredProfile)
      return pendingActivation
    })

    const pending = xolosWalletService.activateStoredWalletForX402('correct-password')
    await Promise.resolve()
    localStorage.setItem(MNEMONIC_STORAGE_KEY, 'replacement-from-another-tab')
    localStorage.setItem(PROFILE_STORAGE_KEY, expectedRecoveredProfile)
    resolveActivation?.({ status: 'loaded', notice: 'loaded' })

    await expect(pending).rejects.toMatchObject({ reason: 'activation-failed' })
    expect(localStorage.getItem(MNEMONIC_STORAGE_KEY)).toBe('replacement-from-another-tab')
    expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBe(expectedRecoveredProfile)
  })

  test('the complete dedicated activation call chain contains no payment, transaction, selection or broadcast primitive', () => {
    const source = readFileSync('src/services/XolosWalletService.ts', 'utf8')
    const x402Boundary = source.slice(
      source.indexOf('async activateStoredWalletForX402('),
      source.indexOf('async encryptAndStoreMnemonic(')
    )
    const storedActivationBoundary = source.slice(
      source.indexOf('private async activateDecryptedStoredMnemonic('),
      source.indexOf('async unlockEncryptedWallet(')
    )
    const canonicalActivationBoundary = source.slice(
      source.indexOf('private async activateMnemonic('),
      source.indexOf('private ensureReady(')
    )
    const completeBoundary = [
      x402Boundary,
      storedActivationBoundary,
      canonicalActivationBoundary
    ].join('\n')

    expect(x402Boundary).toContain('this.activateDecryptedStoredMnemonic(decrypted.plainText)')
    expect(storedActivationBoundary).toContain('await this.activateMnemonic(')
    expect(canonicalActivationBoundary).toContain('await wallet.initialize()')
    expect(completeBoundary).not.toMatch(/\b(?:select\w*Utxos|TxBuilder|signTransaction|broadcastTx|sendXec|sendToken)\b/u)
    expect(completeBoundary).not.toContain('PAYMENT-SIGNATURE')
  })
})
