import { createContext } from 'react'
import type {
  AliasRegistrationBroadcastResult,
  AliasRegistrationEstimate,
  AliasRegistrationRawTxDebug,
  AliasReservedUtxo,
  WalletBalance,
  WalletLoadResult,
  WalletRescanOptions,
  WalletRestoreResult
} from '../services/XolosWalletService'
import type { DerivationProfileId } from '../services/derivationProfiles'
import type { AliasRegistrationData } from '@xolosarmy/tonalli-core'
import type { FirmaSendPreview } from '../services/firmaAlphaSend'
import type { WalletCapability } from '../domain/walletCapabilities'
import type { WalletLifecycle } from '../domain/walletLifecycle'

export type QuickStartBootstrapStatus = 'pending' | 'absent' | 'recovered' | 'failed'

export interface WalletContextValue {
  address: string | null
  alias?: string | null
  balance: WalletBalance | null
  loading: boolean
  error: string | null
  initialized: boolean
  backupVerified: boolean
  lifecycle: WalletLifecycle
  quickStartBootstrap: QuickStartBootstrapStatus
  hasBackedWalletOnDevice: boolean
  hasCapability: (capability: WalletCapability) => boolean
  setAlias?: (alias: string | null) => void
  startQuickStartWallet: () => Promise<{ address: string }>
  activateQuickStartFromDevice: () => Promise<{ address: string } | null>
  completeProgressiveBackup: (password: string) => Promise<void>
  createNewWallet: (password?: string) => Promise<string>
  restoreWallet: (
    mnemonic: string,
    selectedProfileId?: DerivationProfileId,
    password?: string
  ) => Promise<WalletRestoreResult>
  hasPendingIdentity: boolean
  resumePendingIdentity: (password: string) => Promise<{ address: string }>
  abandonPendingIdentity: () => void
  loadExistingWallet: (
    password: string,
    selectedProfileId?: DerivationProfileId
  ) => Promise<WalletLoadResult>
  encryptAndStore: (password: string) => Promise<void>
  refreshBalances: () => Promise<void>
  rescanWallet: (options?: WalletRescanOptions) => Promise<void>
  sendRMZ: (to: string, amount: string, excludedUtxos?: AliasReservedUtxo[]) => Promise<string>
  prepareFirmaSend: (to: string, amount: string) => Promise<FirmaSendPreview>
  sendFirma: (preview: FirmaSendPreview) => Promise<string>
  sendXEC: (to: string, amountInSats: number, message?: string) => Promise<string>
  estimateAliasRegistration: (registration: AliasRegistrationData) => Promise<AliasRegistrationEstimate>
  reserveAliasRegistrationUtxos: (registration: AliasRegistrationData) => Promise<AliasReservedUtxo[]>
  buildAliasRegistrationRawTx: (registration: AliasRegistrationData, reservedUtxos?: AliasReservedUtxo[]) => Promise<AliasRegistrationRawTxDebug>
  registerAliasOnChain: (registration: AliasRegistrationData, reservedUtxos?: AliasReservedUtxo[], rmzTxid?: string | null) => Promise<AliasRegistrationBroadcastResult>
  estimateXecSend: (amountInSats: number, message?: string) => Promise<{ networkFeeSats: number; totalCostSats: number }>
  getMnemonic: () => string | null
  unlockEncryptedWallet: (password: string) => Promise<void>
  setBackupVerified?: (value: boolean) => void
}

export const WalletContext = createContext<WalletContextValue | undefined>(undefined)
