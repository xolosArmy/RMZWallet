import { vi } from 'vitest'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { isCapabilityAllowed } from '../domain/walletCapabilities'
import type { WalletContextValue } from '../context/walletContext'

export function walletContextFixture(
  overrides: Partial<WalletContextValue> = {}
): WalletContextValue {
  const initialized = overrides.initialized ?? false
  const backupVerified = overrides.backupVerified ?? false
  const lifecycle = overrides.lifecycle ?? (
    initialized && backupVerified
      ? WALLET_LIFECYCLE.BACKUP_VERIFIED
      : initialized
        ? WALLET_LIFECYCLE.QUICK_START_UNBACKED
        : WALLET_LIFECYCLE.UNINITIALIZED
  )
  return {
    address: null,
    balance: null,
    loading: false,
    error: null,
    initialized,
    backupVerified,
    lifecycle,
    quickStartBootstrap: overrides.quickStartBootstrap ?? 'absent',
    hasBackedWalletOnDevice: overrides.hasBackedWalletOnDevice ?? false,
    hasCapability: (capability) => isCapabilityAllowed(lifecycle, capability),
    startQuickStartWallet: vi.fn(),
    activateQuickStartFromDevice: vi.fn(),
    completeProgressiveBackup: vi.fn(),
    createNewWallet: vi.fn(),
    restoreWallet: vi.fn(),
    loadExistingWallet: vi.fn(),
    encryptAndStore: vi.fn(),
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn(),
    sendRMZ: vi.fn(),
    prepareFirmaSend: vi.fn(),
    sendFirma: vi.fn(),
    sendXEC: vi.fn(),
    estimateAliasRegistration: vi.fn(),
    reserveAliasRegistrationUtxos: vi.fn(),
    buildAliasRegistrationRawTx: vi.fn(),
    registerAliasOnChain: vi.fn(),
    estimateXecSend: vi.fn(),
    getMnemonic: vi.fn(),
    unlockEncryptedWallet: vi.fn(),
    ...overrides
  }
}
