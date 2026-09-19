import {
  claimWelcomeXec,
  getWelcomeClaimStatus,
  getWelcomeFaucetConfig,
  isWelcomeFaucetConfigured,
  type WelcomeClaimResponse,
  type WelcomeFaucetConfig
} from './welcomeFaucet'

export type WelcomeClaimAction = 'claim' | 'idle' | 'reconcile'

export function shouldAttemptWelcomeClaim(status: WelcomeClaimResponse['status'] | undefined): boolean {
  return status === 'available' || status === 'retryable'
}

export function nextWelcomeClaimAction(status: WelcomeClaimResponse['status'] | undefined): WelcomeClaimAction {
  if (status === 'available' || status === 'retryable') return 'claim'
  if (status === 'pending_review' || status === 'completed' || status === 'already_claimed') return 'reconcile'
  return 'idle'
}

export async function loadWelcomeClaimSurface(
  address: string,
  signal?: AbortSignal
): Promise<{ config: WelcomeFaucetConfig; status: WelcomeClaimResponse }> {
  if (!isWelcomeFaucetConfigured()) {
    throw new Error('WELCOME_FAUCET_NOT_CONFIGURED')
  }
  const config = await getWelcomeFaucetConfig(signal)
  const status = await getWelcomeClaimStatus(address, signal)
  return { config, status }
}

export async function requestWelcomeClaim(
  address: string,
  currentStatus?: WelcomeClaimResponse['status']
): Promise<WelcomeClaimResponse> {
  if (!address) throw new Error('WELCOME_CLAIM_ADDRESS_REQUIRED')
  if (currentStatus && !shouldAttemptWelcomeClaim(currentStatus)) {
    return getWelcomeClaimStatus(address)
  }
  return claimWelcomeXec(address)
}
