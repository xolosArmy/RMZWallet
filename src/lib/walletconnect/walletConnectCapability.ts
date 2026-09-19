import { WALLET_CAPABILITY } from '../../domain/walletCapabilities'
import {
  assertWalletCapabilityEnabled,
  isWalletCapabilityEnabled,
  type WalletCapabilityHost
} from '../../domain/walletCapabilityGuard'
import { wcWallet } from './WcWallet'

export function canUseWalletConnect(wallet: WalletCapabilityHost): boolean {
  return isWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT)
}

export async function approveWalletConnectRequestIfAllowed(
  wallet: WalletCapabilityHost
): Promise<void> {
  assertWalletCapabilityEnabled(wallet, WALLET_CAPABILITY.WALLETCONNECT)
  await wcWallet.approvePendingRequest()
}

export async function rejectDeniedWalletConnectRequest(
  wallet: WalletCapabilityHost
): Promise<boolean> {
  if (canUseWalletConnect(wallet)) return false
  await wcWallet.rejectPendingRequest()
  return true
}
