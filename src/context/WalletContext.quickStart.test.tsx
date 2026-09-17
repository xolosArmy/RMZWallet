// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletProvider } from './WalletContext'
import { useWallet } from './useWallet'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'

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
  activateQuickStartFromDevice: vi.fn(async () => ({
    address: 'ecash:qquickstart',
    profileId: 'ecash-standard-1899'
  })),
  persistVerifiedBackup: vi.fn(async () => undefined),
  discardQuickStartRecord: vi.fn(async () => undefined),
  sendXEC: vi.fn(),
  sendRMZ: vi.fn(),
  sendFirma: vi.fn(),
  prepareFirmaSend: vi.fn(),
  getMnemonic: vi.fn(() => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
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
  })

  it('activates a limited wallet and blocks privileged sends until backup is verified', async () => {
    let wallet: ReturnType<typeof useWallet> | null = null
    render(
      <WalletProvider>
        <Harness onReady={(value) => { wallet = value }} />
      </WalletProvider>
    )

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

    await expect(wallet!.sendXEC('ecash:qdest', 100)).rejects.toThrow(/respaldo/)
    expect(serviceMocks.sendXEC).not.toHaveBeenCalled()

    await wallet!.completeProgressiveBackup('123456')
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.BACKUP_VERIFIED)
    })
    expect(wallet!.hasCapability(WALLET_CAPABILITY.SEND_XEC)).toBe(true)
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
    await wallet!.startQuickStartWallet()
    await waitFor(() => {
      expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    })
    await expect(wallet!.completeProgressiveBackup('123456')).rejects.toThrow()
    expect(wallet!.lifecycle).toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    expect(serviceMocks.discardQuickStartRecord).not.toHaveBeenCalled()
  })
})
