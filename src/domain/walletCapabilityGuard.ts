import {
  assertCapability,
  isCapabilityAllowed,
  type WalletCapability
} from './walletCapabilities'
import { resolveWalletLifecycle, type WalletLifecycle } from './walletLifecycle'

export type WalletCapabilityHost = {
  hasCapability?: (capability: WalletCapability) => boolean
  lifecycle?: WalletLifecycle
  initialized?: boolean
  backupVerified?: boolean
}

function lifecycleOf(wallet: WalletCapabilityHost): WalletLifecycle {
  return wallet.lifecycle ?? resolveWalletLifecycle({
    initialized: Boolean(wallet.initialized),
    backupVerified: Boolean(wallet.backupVerified)
  })
}

export function isWalletCapabilityEnabled(
  wallet: WalletCapabilityHost,
  capability: WalletCapability
): boolean {
  if (typeof wallet.hasCapability === 'function') {
    return wallet.hasCapability(capability) === true
  }
  return isCapabilityAllowed(lifecycleOf(wallet), capability)
}

export function assertWalletCapabilityEnabled(
  wallet: WalletCapabilityHost,
  capability: WalletCapability
): void {
  if (isWalletCapabilityEnabled(wallet, capability)) return
  assertCapability(lifecycleOf(wallet), capability)
}
