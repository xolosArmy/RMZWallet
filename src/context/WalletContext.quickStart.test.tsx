// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletProvider } from './WalletContext'
import { useWallet } from './useWallet'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import {
  PENDING_IDENTITY_STATE,
  QuickStartUnavailableError,
  type PendingIdentityState
} from '../services/quickStartStorage'

const serviceMocks = vi.hoisted(() => ({
  getAddress: vi.fn(() => 'ecash:qquickstart'),
  getBalances: vi.fn(async () => ({
    xec: 0n,
    xecFormatted: '0.00',
    tokenUtxoSats: 0n,
    tokenUtxoXecFormatted: '0.00',
    rmzAtoms: 0n,
    rmzFormatted: '0',
    rmzDecimals: 0,
    firmaAtoms: 0n,
    firmaFormatted: '0',
    firmaDecimals: 4
  })),
  createQuickStartWallet: vi.fn(async () => ({
    address: 'ecash:qquickstart',
    profileId: 'ecash-standard-1899'
  })),
  createNewWallet: vi.fn(async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  restoreFromMnemonic: vi.fn(async () => ({
    status: 'restored' as const,
    selectedProfileId: 'ecash-standard-1899',
    notice: 'restored'
  })),
  activateQuickStartFromDevice: vi.fn(async () => ({
    address: 'ecash:qquickstart',
    profileId: 'ecash-standard-1899'
  })),
  persistVerifiedBackup: vi.fn(async () => undefined),
  discardQuickStartRecord: vi.fn(async () => undefined),
  hasQuickStartRecord: vi.fn(async () => false),
  loadFromStorage: vi.fn(async () => ({
    status: 'loaded' as const,
    selectedProfileId: 'ecash-standard-1899',
    notice: 'loaded'
  })),
  sendXEC: vi.fn(),
  sendRMZ: vi.fn(),
  sendFirma: vi.fn(),
  prepareFirmaSend: vi.fn(),
  getMnemonic: vi.fn(() => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  hasBackedWalletCiphertextOnDevice: vi.fn(() => false),
  getPendingIdentityState: vi.fn((): PendingIdentityState => 'NONE'),
  hasRecoverablePendingIdentity: vi.fn(() => false),
  hasPendingIdentityRecord: vi.fn(() => false),
  resumePendingIdentity: vi.fn(),
  abandonPendingIdentity: vi.fn(async () => undefined),
  abandonLegacyPendingIdentity: vi.fn(async () => undefined),
  reconcilePendingIdentity: vi.fn()
}))

vi.mock('../services/XolosWalletService', () => ({
  EXTENDED_GAP_LIMIT: 100,
  xolosWalletService: serviceMocks
}))

vi.mock('../services/ChronikClient', () => ({
  getChronik: () => ({
    address: () => ({ utxos: async () => ({ utxos: [] }) })
  })
}))

vi.mock('../services/aliasDiscovery', () => ({
  discoverAliasForAddress: async () => null
}))

function Harness({ onReady }: { onReady: (wallet: ReturnType<typeof useWallet>) => void }) {
  const wallet = useWallet()
  onReady(wallet)
  return <div>{wallet.lifecycle}</div>
}

describe('WalletContext Quick Start lifecycle', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  beforeEach(() => {
    localStorage.clear()
    serviceMocks.sendXEC.mockReset()
    serviceMocks.sendRMZ.mockReset()
    serviceMocks.persistVerifiedBackup.mockReset()
    serviceMocks.discardQuickStartRecord.mockReset()
    serviceMocks.persistVerifiedBackup.mockResolvedValue(undefined)
    serviceMocks.discardQuickStartRecord.mockResolvedValue(undefined)
    serviceMocks.hasQuickStartRecord.mockReset()
    serviceMocks.hasQuickStartRecord.mockResolvedValue(false)
    serviceMocks.createQuickStartWallet.mockClear()
    serviceMocks.createNewWallet.mockClear()
    serviceMocks.restoreFromMnemonic.mockClear()
    serviceMocks.activateQuickStartFromDevice.mockClear()
    serviceMocks.loadFromStorage.mockReset()
    serviceMocks.loadFromStorage.mockResolvedValue({
      status: 'loaded',
      selectedProfileId: 'ecash-standard-1899',
      notice: 'loaded'
    })
    serviceMocks.getBalances.mockReset()
    serviceMocks.getBalances.mockResolvedValue({
      xec: 0n,
      xecFormatted: '0.00',
      tokenUtxoSats: 0n,
      tokenUtxoXecFormatted: '0.00',
      rmzAtoms: 0n,
      rmzFormatted: '0',
      rmzDecimals: 0,
      firmaAtoms: 0n,
      firmaFormatted: '0',
      firmaDecimals: 4
    })
    serviceMocks.hasBackedWalletCiphertextOnDevice.mockReset()
    serviceMocks.hasBackedWalletCiphertextOnDevice.mockReturnValue(false)
    serviceMocks.getPendingIdentityState.mockReset()
    serviceMocks.getPendingIdentityState.mockReturnValue('NONE')
    serviceMocks.hasPendingIdentityRecord.mockReset()
    serviceMocks.hasPendingIdentityRecord.mockReturnValue(false)
    serviceMocks.resumePendingIdentity.mockReset()
    serviceMocks.abandonPendingIdentity.mockReset()
    serviceMocks.abandonLegacyPendingIdentity.mockReset()
  })

  it('returns local pending recovery success without waiting for balance/network hydration', async () => {
    serviceMocks.getPendingIdentityState.mockReturnValue('RECOVERABLE_PENDING')
    serviceMocks.resumePendingIdentity.mockResolvedValue({
      address: 'ecash:qoffline-recovered',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      reconciled: false
    })
    serviceMocks.getBalances.mockImplementation(() => new Promise(() => undefined))

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

    await expect(wallet!.resumePendingIdentity('offline-pin')).resolves.toEqual({
      address: 'ecash:qoffline-recovered',
      reconciled: false
    })
    await waitFor(() => expect(wallet!.initialized).toBe(true))
    expect(wallet!.backupVerified).toBe(false)
    expect(serviceMocks.getBalances).toHaveBeenCalled()
  })

  it('activates a limited wallet and blocks privileged sends until backup is verified', async () => {
    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('absent')
    })
    await wallet!.startQuickStartWallet()
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    })
    expect(wallet!.hasCapability(WALLET_CAPABILITY.RECEIVE_XEC)).toBe(true)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.WELCOME_XEC_CLAIM)).toBe(true)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.SEND_XEC)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.SEND_RMZ)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.NFT_OPERATIONS)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.WALLETCONNECT)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.X402)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.AGENT_WALLET_EXECUTION)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.EXTERNAL_SIGNING)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.AGORA_TRADING)).toBe(false)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.TM_COMM)).toBe(false)

    await expect(wallet!.sendXEC('ecash:qdest', 100)).rejects.toThrow(/respaldo/)
    expect(serviceMocks.sendXEC).not.toHaveBeenCalled()

    await wallet!.completeProgressiveBackup('123456')
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.BACKUP_VERIFIED)
    })
    expect(wallet!.hasCapability(WALLET_CAPABILITY.SEND_XEC)).toBe(true)
    expect(wallet!.hasCapability(WALLET_CAPABILITY.TM_COMM)).toBe(false)
    expect(serviceMocks.persistVerifiedBackup).toHaveBeenCalledWith('123456')
    expect(serviceMocks.discardQuickStartRecord).toHaveBeenCalled()
  })

  it('keeps the Quick Start copy if backup verification fails', async () => {
    serviceMocks.persistVerifiedBackup.mockRejectedValueOnce(new Error('QUICK_START_BACKUP_VERIFY_FAILED'))
    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('absent')
    })
    await wallet!.startQuickStartWallet()
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    })
    await expect(wallet!.completeProgressiveBackup('123456')).rejects.toThrow()
    expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    expect(serviceMocks.discardQuickStartRecord).not.toHaveBeenCalled()
  })

  it('IndexedDB unavailable -> PIN backup completes -> BACKUP_VERIFIED -> UI success -> no destructive replacement', async () => {
    serviceMocks.persistVerifiedBackup.mockResolvedValueOnce(undefined)
    serviceMocks.discardQuickStartRecord.mockRejectedValueOnce(
      new QuickStartUnavailableError('QUICK_START_STORAGE_UNAVAILABLE')
    )
    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('absent')
    })
    await wallet!.startQuickStartWallet()
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    })

    await expect(wallet!.completeProgressiveBackup('123456')).resolves.toBeUndefined()
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.BACKUP_VERIFIED)
    })
    expect(wallet!.error).toBeNull()
    expect(serviceMocks.persistVerifiedBackup).toHaveBeenCalledWith('123456')
    expect(serviceMocks.discardQuickStartRecord).toHaveBeenCalled()
    expect(localStorage.getItem('xoloswallet_backup_verified')).toBe('true')
    expect(serviceMocks.createNewWallet).not.toHaveBeenCalled()
  })

  it('does not create a second wallet when hydration is delayed and create is clicked', async () => {
    let resolveRecord: ((value: boolean) => void) | undefined
    serviceMocks.hasQuickStartRecord.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveRecord = resolve })
    )
    serviceMocks.activateQuickStartFromDevice.mockResolvedValue({
      address: 'ecash:qoriginal',
      profileId: 'ecash-standard-1899'
    })
    serviceMocks.getAddress.mockReturnValue('ecash:qoriginal')

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

    expect(wallet!.quickStartBootstrap).toBe('pending')
    await expect(wallet!.startQuickStartWallet()).rejects.toThrow('QUICK_START_BOOTSTRAP_PENDING')
    expect(serviceMocks.createQuickStartWallet).not.toHaveBeenCalled()

    resolveRecord?.(true)
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('recovered')
    })
    expect(wallet!.address).toBe('ecash:qoriginal')
    const again = await wallet!.startQuickStartWallet()
    expect(again.address).toBe('ecash:qoriginal')
    expect(serviceMocks.createQuickStartWallet).not.toHaveBeenCalled()
  })

  it('activates local identity when Chronik/balance refresh fails', async () => {
    serviceMocks.hasQuickStartRecord.mockResolvedValue(true)
    serviceMocks.activateQuickStartFromDevice.mockImplementation(async () => ({
      address: 'ecash:qoriginal',
      profileId: 'ecash-standard-1899'
    }))
    serviceMocks.getAddress.mockReturnValue('ecash:qoriginal')
    serviceMocks.getBalances.mockRejectedValue(new Error('CHRONIK_UNAVAILABLE'))

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

    await waitFor(() => {
      expect(wallet!.initialized).toBe(true)
    })
    expect(wallet!.address).toBe('ecash:qoriginal')
    expect(wallet!.quickStartBootstrap).toBe('recovered')
    expect(serviceMocks.createQuickStartWallet).not.toHaveBeenCalled()
  })

  it('fails closed when an existing Quick Start cannot be recovered and does not create a replacement', async () => {
    serviceMocks.hasQuickStartRecord.mockResolvedValue(true)
    serviceMocks.activateQuickStartFromDevice.mockRejectedValue(new Error('QUICK_START_DEVICE_KEY_MISSING'))

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('failed')
    })
    expect(wallet!.initialized).toBe(false)
    await expect(wallet!.startQuickStartWallet()).rejects.toThrow('QUICK_START_RECOVERY_FAILED')
    expect(serviceMocks.createQuickStartWallet).not.toHaveBeenCalled()
  })

  it('refuses createNewWallet while a recovered Quick Start exists', async () => {
    serviceMocks.hasQuickStartRecord.mockResolvedValue(true)
    serviceMocks.activateQuickStartFromDevice.mockResolvedValue({
      address: 'ecash:qoriginal',
      profileId: 'ecash-standard-1899'
    })
    serviceMocks.getAddress.mockReturnValue('ecash:qoriginal')

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('recovered')
    })
    await expect(wallet!.createNewWallet()).rejects.toThrow('QUICK_START_WALLET_EXISTS')
    expect(serviceMocks.createNewWallet).not.toHaveBeenCalled()
    expect(wallet!.address).toBe('ecash:qoriginal')
    expect(serviceMocks.discardQuickStartRecord).not.toHaveBeenCalled()
  })

  it('refuses createNewWallet when Quick Start recovery failed and does not delete ciphertext', async () => {
    serviceMocks.hasQuickStartRecord.mockResolvedValue(true)
    serviceMocks.activateQuickStartFromDevice.mockRejectedValue(new Error('QUICK_START_DEVICE_KEY_MISSING'))

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('failed')
    })
    await expect(wallet!.createNewWallet()).rejects.toThrow('QUICK_START_RECOVERY_FAILED')
    expect(serviceMocks.createNewWallet).not.toHaveBeenCalled()
    expect(serviceMocks.discardQuickStartRecord).not.toHaveBeenCalled()
  })

  it('refuses createNewWallet while bootstrap is pending', async () => {
    let resolveRecord: ((value: boolean) => void) | undefined
    serviceMocks.hasQuickStartRecord.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveRecord = resolve })
    )

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    expect(wallet!.quickStartBootstrap).toBe('pending')
    await expect(wallet!.createNewWallet()).rejects.toThrow('QUICK_START_BOOTSTRAP_PENDING')
    expect(serviceMocks.createNewWallet).not.toHaveBeenCalled()
    resolveRecord?.(false)
  })

  it('refuses startQuickStartWallet when an encrypted backed wallet exists and is not unlocked', async () => {
    serviceMocks.hasBackedWalletCiphertextOnDevice.mockReturnValue(true)

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('absent')
    })
    expect(wallet!.hasBackedWalletOnDevice).toBe(true)
    await expect(wallet!.startQuickStartWallet()).rejects.toThrow('BACKED_WALLET_EXISTS')
    expect(serviceMocks.createQuickStartWallet).not.toHaveBeenCalled()
    expect(wallet!.initialized).toBe(false)
  })

  it('refuses restoreWallet while a recovered Quick Start exists', async () => {
    serviceMocks.hasQuickStartRecord.mockResolvedValue(true)
    serviceMocks.activateQuickStartFromDevice.mockResolvedValue({
      address: 'ecash:qoriginal',
      profileId: 'ecash-standard-1899'
    })
    serviceMocks.getAddress.mockReturnValue('ecash:qoriginal')

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )
    await waitFor(() => {
      expect(wallet!.quickStartBootstrap).toBe('recovered')
    })
    await expect(wallet!.restoreWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
      .rejects.toThrow('QUICK_START_WALLET_EXISTS')
    expect(serviceMocks.restoreFromMnemonic).not.toHaveBeenCalled()
    expect(wallet!.address).toBe('ecash:qoriginal')
    expect(serviceMocks.discardQuickStartRecord).not.toHaveBeenCalled()
  })

  it('unlocks a backed-up Quick Start even when Chronik/balance never resolves', async () => {
    localStorage.setItem('xoloswallet_backup_verified', 'true')
    serviceMocks.getAddress.mockReturnValue('ecash:qbacked')
    serviceMocks.loadFromStorage.mockResolvedValue({
      status: 'loaded',
      selectedProfileId: 'ecash-standard-1899',
      notice: 'loaded'
    })
    serviceMocks.getBalances.mockImplementation(() => new Promise(() => {}))

    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

    const result = await wallet!.loadExistingWallet('123456')
    expect(result.status).toBe('loaded')
    await waitFor(() => {
      expect(wallet!.initialized).toBe(true)
      expect(wallet!.address).toBe('ecash:qbacked')
      expect(wallet!.backupVerified).toBe(true)
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.BACKUP_VERIFIED)
    })
  })

  describe('local-first onboarding completion before balance hydration (discussion_r4066507409)', () => {
    it('createNewWallet completes local onboarding, sets initialized, and blocks duplicates when balance hydration fails', async () => {
      serviceMocks.getAddress.mockReturnValue('ecash:qcreatedlocal')
      serviceMocks.createNewWallet.mockImplementation(async () => {
        // The service owns this authoritative reservation for the active session.
        serviceMocks.getPendingIdentityState.mockReturnValue(PENDING_IDENTITY_STATE.RECOVERABLE_PENDING)
        return 'test seed phrase returned from service'
      })
      serviceMocks.getBalances
        .mockRejectedValueOnce(new Error('CHRONIK_NETWORK_TIMEOUT'))
        .mockResolvedValue({
          xec: 100n,
          xecFormatted: '1.00',
          tokenUtxoSats: 0n,
          tokenUtxoXecFormatted: '0.00',
          rmzAtoms: 0n,
          rmzFormatted: '0',
          rmzDecimals: 0,
          firmaAtoms: 0n,
          firmaFormatted: '0',
          firmaDecimals: 4
        })

      let wallet: ReturnType<typeof useWallet> | null = null
      render(
        <WalletProvider>
          <Harness onReady={(value) => { wallet = value }} />
        </WalletProvider>
      )

      await waitFor(() => {
        expect(wallet!.initialized).toBe(false)
      })

      const mnemonic = await wallet!.createNewWallet('pin123456')
      expect(mnemonic).toBe('test seed phrase returned from service')

      await waitFor(() => {
        expect(wallet!.initialized).toBe(true)
        expect(wallet!.address).toBe('ecash:qcreatedlocal')
        expect(wallet!.backupVerified).toBe(false)
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBe('false')
        // The active tab hides its own pending workflow while the service reservation remains authoritative.
        expect(wallet!.hasPendingIdentity).toBe(false)
      })
      expect(serviceMocks.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.RECOVERABLE_PENDING)

      // Duplicate creation attempt in same tab is blocked by initialized state
      await expect(wallet!.createNewWallet('secondPin')).rejects.toThrow('WALLET_ALREADY_INITIALIZED')
      expect(serviceMocks.createNewWallet).toHaveBeenCalledTimes(1)

      // A later normal refresh hydrates balance without recreating/reactivating identity.
      await wallet!.refreshBalances()
      await waitFor(() => expect(wallet!.balance?.xec).toBe(100n))
      expect(serviceMocks.createNewWallet).toHaveBeenCalledTimes(1)
    })

    it('restoreWallet completes local onboarding, sets initialized, and blocks duplicates when balance hydration fails', async () => {
      serviceMocks.getAddress.mockReturnValue('ecash:qrestoredlocal')
      const restoredResult = {
        status: 'restored',
        selectedProfileId: 'ecash-standard-1899',
        notice: 'restored'
      } as const
      serviceMocks.restoreFromMnemonic.mockImplementation(async () => {
        serviceMocks.getPendingIdentityState.mockReturnValue(PENDING_IDENTITY_STATE.RECOVERABLE_PENDING)
        return restoredResult
      })
      serviceMocks.getBalances.mockRejectedValueOnce(new Error('CHRONIK_NETWORK_TIMEOUT'))

      let wallet: ReturnType<typeof useWallet> | null = null
      render(
        <WalletProvider>
          <Harness onReady={(value) => { wallet = value }} />
        </WalletProvider>
      )

      await waitFor(() => {
        expect(wallet!.initialized).toBe(false)
      })

      const result = await wallet!.restoreWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', undefined, 'pin123456')
      expect(result).toBe(restoredResult)

      await waitFor(() => {
        expect(wallet!.initialized).toBe(true)
        expect(wallet!.address).toBe('ecash:qrestoredlocal')
        expect(wallet!.backupVerified).toBe(false)
        expect(localStorage.getItem('xoloswallet_backup_verified')).toBe('false')
        expect(wallet!.hasPendingIdentity).toBe(false)
      })
      expect(serviceMocks.getPendingIdentityState()).toBe(PENDING_IDENTITY_STATE.RECOVERABLE_PENDING)

      // Duplicate restore attempt in same tab is blocked by initialized state
      await expect(
        wallet!.restoreWallet('another phrase words', undefined, 'secondPin')
      ).rejects.toThrow('WALLET_ALREADY_INITIALIZED')
      expect(serviceMocks.restoreFromMnemonic).toHaveBeenCalledTimes(1)
    })
  })
})
