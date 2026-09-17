import { describe, expect, test } from 'vitest'
import { WALLET_LIFECYCLE } from './walletLifecycle'
import {
  QUICK_START_ALLOWED_CAPABILITIES,
  QUICK_START_BLOCKED_CAPABILITIES,
  WALLET_CAPABILITY,
  WalletCapabilityError,
  assertCapability,
  isCapabilityAllowed
} from './walletCapabilities'

describe('wallet capability policy', () => {
  test('QUICK_START_UNBACKED allows only the low-risk set', () => {
    for (const capability of QUICK_START_ALLOWED_CAPABILITIES) {
      expect(isCapabilityAllowed(WALLET_LIFECYCLE.QUICK_START_UNBACKED, capability)).toBe(true)
    }
  })

  test('QUICK_START_UNBACKED blocks privileged financial capabilities including future TM_COMM', () => {
    for (const capability of QUICK_START_BLOCKED_CAPABILITIES) {
      expect(isCapabilityAllowed(WALLET_LIFECYCLE.QUICK_START_UNBACKED, capability)).toBe(false)
      expect(() => assertCapability(WALLET_LIFECYCLE.QUICK_START_UNBACKED, capability))
        .toThrow(WalletCapabilityError)
    }
  })

  test('BACKUP_VERIFIED restores existing full-wallet capabilities', () => {
    const privileged = [
      WALLET_CAPABILITY.SEND_XEC,
      WALLET_CAPABILITY.SEND_RMZ,
      WALLET_CAPABILITY.SEND_FIRMA,
      WALLET_CAPABILITY.NFT_OPERATIONS,
      WALLET_CAPABILITY.AGORA_TRADING,
      WALLET_CAPABILITY.WALLETCONNECT,
      WALLET_CAPABILITY.X402,
      WALLET_CAPABILITY.EXTERNAL_SIGNING,
      WALLET_CAPABILITY.AGENT_WALLET_EXECUTION,
      WALLET_CAPABILITY.ARBITRARY_BROADCAST
    ]
    for (const capability of privileged) {
      expect(isCapabilityAllowed(WALLET_LIFECYCLE.BACKUP_VERIFIED, capability)).toBe(true)
      expect(() => assertCapability(WALLET_LIFECYCLE.BACKUP_VERIFIED, capability)).not.toThrow()
    }
  })

  test('UNINITIALIZED cannot use wallet features', () => {
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.UNINITIALIZED, WALLET_CAPABILITY.VIEW_BALANCE)).toBe(false)
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.UNINITIALIZED, WALLET_CAPABILITY.SEND_XEC)).toBe(false)
  })

  test('TM_COMM stays unauthorized for every current lifecycle until M1 defines policy', () => {
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.UNINITIALIZED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.QUICK_START_UNBACKED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
    expect(isCapabilityAllowed(WALLET_LIFECYCLE.BACKUP_VERIFIED, WALLET_CAPABILITY.TM_COMM)).toBe(false)
  })
})
