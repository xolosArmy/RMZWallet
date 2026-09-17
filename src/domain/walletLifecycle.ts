export const WALLET_LIFECYCLE = {
  UNINITIALIZED: 'UNINITIALIZED',
  QUICK_START_UNBACKED: 'QUICK_START_UNBACKED',
  BACKUP_VERIFIED: 'BACKUP_VERIFIED'
} as const

export type WalletLifecycle = (typeof WALLET_LIFECYCLE)[keyof typeof WALLET_LIFECYCLE]

export const TRANSIENT_WALLET_UI_STATES = [
  'creating',
  'hydrating',
  'claiming',
  'backing_up'
] as const

export type TransientWalletUiState = (typeof TRANSIENT_WALLET_UI_STATES)[number]

export type WalletLifecycleEvidence = Readonly<{
  initialized: boolean
  backupVerified: boolean
}>

export function isWalletLifecycle(value: unknown): value is WalletLifecycle {
  return value === WALLET_LIFECYCLE.UNINITIALIZED
    || value === WALLET_LIFECYCLE.QUICK_START_UNBACKED
    || value === WALLET_LIFECYCLE.BACKUP_VERIFIED
}

export function isTransientWalletUiState(value: unknown): value is TransientWalletUiState {
  return TRANSIENT_WALLET_UI_STATES.includes(value as TransientWalletUiState)
}

export function resolveWalletLifecycle(evidence: WalletLifecycleEvidence): WalletLifecycle {
  if (evidence.initialized && evidence.backupVerified) {
    return WALLET_LIFECYCLE.BACKUP_VERIFIED
  }
  if (evidence.initialized) {
    return WALLET_LIFECYCLE.QUICK_START_UNBACKED
  }
  return WALLET_LIFECYCLE.UNINITIALIZED
}
