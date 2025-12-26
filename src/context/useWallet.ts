import { useContext } from 'react'
import type { WalletContextValue } from './walletContext'
import { WalletContext } from './walletContext'

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet debe usarse dentro de WalletProvider')
  }
  return context
}
