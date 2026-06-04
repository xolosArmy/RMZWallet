import { createContext } from 'react'
import type {
  AliasRegistrationBroadcastResult,
  AliasRegistrationEstimate,
  AliasRegistrationRawTxDebug,
  AliasReservedUtxo,
  WalletBalance,
  WalletRescanOptions
} from '../services/XolosWalletService'
import type { AliasRegistrationData } from '@xolosarmy/tonalli-core'

export interface WalletContextValue {
  address: string | null
  balance: WalletBalance | null
  loading: boolean
  error: string | null
  initialized: boolean
  backupVerified: boolean
  createNewWallet: () => Promise<string>
  restoreWallet: (mnemonic: string) => Promise<void>
  loadExistingWallet: (password: string) => Promise<void>
  encryptAndStore: (password: string) => Promise<void>
  refreshBalances: () => Promise<void>
  rescanWallet: (options?: WalletRescanOptions) => Promise<void>
  sendRMZ: (to: string, amount: string, excludedUtxos?: AliasReservedUtxo[]) => Promise<string>
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
