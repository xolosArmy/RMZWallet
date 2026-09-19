import { describe, expect, it } from 'vitest'
import { WALLET_CAPABILITY, WalletCapabilityError } from './walletCapabilities'
import { WALLET_LIFECYCLE } from './walletLifecycle'
import {
  assertWalletCapabilityEnabled,
  isWalletCapabilityEnabled
} from './walletCapabilityGuard'

describe('wallet capability operation guard', () => {
  it('fails closed for QUICK_START_UNBACKED privileged operations', () => {
    const wallet = {
      initialized: true,
      backupVerified: false,
      lifecycle: WALLET_LIFECYCLE.QUICK_START_UNBACKED
    }
    expect(isWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT)).toBe(false)
    expect(isWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.EXTERNAL_SIGNING)).toBe(false)
    expect(isWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.ARBITRARY_BROADCAST)).toBe(false)
    expect(() => assertWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT))
      .toThrow(WalletCapabilityError)
  })

  it('restores privileged operations for BACKUP_VERIFIED', () => {
    const wallet = {
      initialized: true,
      backupVerified: true,
      lifecycle: WALLET_LIFECYCLE.BACKUP_VERIFIED
    }
    expect(isWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT)).toBe(true)
    expect(() => assertWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT)).not.toThrow()
  })

  it('fails closed when hasCapability is missing and backup is unverified', () => {
    expect(isWalletCapabilityEnabled(
      { initialized: true },
      WALLET_CAPABILITY.WALLETCONNECT
    )).toBe(false)
  })
})
