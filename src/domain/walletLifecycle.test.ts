import { describe, expect, test } from 'vitest'
import {
  TRANSIENT_WALLET_UI_STATES,
  WALLET_LIFECYCLE,
  isTransientWalletUiState,
  isWalletLifecycle,
  resolveWalletLifecycle
} from './walletLifecycle'

describe('wallet lifecycle', () => {
  test('resolves a single source of truth from initialized + backupVerified', () => {
    expect(resolveWalletLifecycle({ initialized: false, backupVerified: false }))
      .toBe(WALLET_LIFECYCLE.UNINITIALIZED)
    expect(resolveWalletLifecycle({ initialized: false, backupVerified: true }))
      .toBe(WALLET_LIFECYCLE.UNINITIALIZED)
    expect(resolveWalletLifecycle({ initialized: true, backupVerified: false }))
      .toBe(WALLET_LIFECYCLE.QUICK_START_UNBACKED)
    expect(resolveWalletLifecycle({ initialized: true, backupVerified: true }))
      .toBe(WALLET_LIFECYCLE.BACKUP_VERIFIED)
  })

  test('transient UI states are never canonical lifecycle values', () => {
    for (const state of TRANSIENT_WALLET_UI_STATES) {
      expect(isTransientWalletUiState(state)).toBe(true)
      expect(isWalletLifecycle(state)).toBe(false)
    }
    expect(isWalletLifecycle(WALLET_LIFECYCLE.QUICK_START_UNBACKED)).toBe(true)
  })
})
