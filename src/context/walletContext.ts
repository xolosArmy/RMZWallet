import { createContext } from 'react'
import type { WalletBalance, WalletRescanOptions } from '../services/XolosWalletService'

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
  encryptAndStore: (password: string) => void
  refreshBalances: () => Promise<void>
  rescanWallet: (options?: WalletRescanOptions) => Promise<void>
  sendRMZ: (to: string, amount: string) => Promise<string>
  sendXEC: (to: string, amountInSats: number, message?: string) => Promise<string>
  estimateXecSend: (amountInSats: number, message?: string) => Promise<{ networkFeeSats: number; totalCostSats: number }>
  getMnemonic: () => string | null
  unlockEncryptedWallet: (password: string) => Promise<void>
  setBackupVerified?: (value: boolean) => void
}

export const WalletContext = createContext<WalletContextValue | undefined>(undefined)
