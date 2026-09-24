import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletCapabilityError } from '../../domain/walletCapabilities'
import { WALLET_LIFECYCLE } from '../../domain/walletLifecycle'

const wcMocks = vi.hoisted(() => ({
  approvePendingRequest: vi.fn(async () => undefined),
  rejectPendingRequest: vi.fn(async () => undefined)
}))

vi.mock('./WcWallet', () => ({
  wcWallet: wcMocks
}))

import {
  approveWalletConnectRequestIfAllowed,
  canUseWalletConnect,
  rejectDeniedWalletConnectRequest
} from './walletConnectCapability'

describe('WalletConnect operation-boundary capability', () => {
  beforeEach(() => {
    wcMocks.approvePendingRequest.mockClear()
    wcMocks.rejectPendingRequest.mockClear()
  })

  it('rejects approval, signing and broadcast for QUICK_START_UNBACKED', async () => {
    const wallet = {
      initialized: true,
      backupVerified: false,
      lifecycle: WALLET_LIFECYCLE.QUICK_START_UNBACKED,
      hasCapability: () => false
    }
    expect(canUseWalletConnect(wallet)).toBe(false)
    await expect(approveWalletConnectRequestIfAllowed(wallet)).rejects.toBeInstanceOf(WalletCapabilityError)
    expect(wcMocks.approvePendingRequest).not.toHaveBeenCalled()
    await expect(rejectDeniedWalletConnectRequest(wallet)).resolves.toBe(true)
    expect(wcMocks.rejectPendingRequest).toHaveBeenCalledOnce()
  })

  it('restores approval for BACKUP_VERIFIED', async () => {
    const wallet = {
      initialized: true,
      backupVerified: true,
      lifecycle: WALLET_LIFECYCLE.BACKUP_VERIFIED,
      hasCapability: () => true
    }
    expect(canUseWalletConnect(wallet)).toBe(true)
    await approveWalletConnectRequestIfAllowed(wallet)
    expect(wcMocks.approvePendingRequest).toHaveBeenCalledOnce()
    await expect(rejectDeniedWalletConnectRequest(wallet)).resolves.toBe(false)
    expect(wcMocks.rejectPendingRequest).not.toHaveBeenCalled()
  })
})
