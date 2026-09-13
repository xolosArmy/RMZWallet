/**
 * Public, non-authority integration surface for Gate C2.
 * Exposes ONLY publicEngine. Never walletUIHost, controller, or settlement store.
 */

import { createContext, useContext } from 'react'
import type { AgentWalletExecutionEngine } from '../../features/agentWalletExecution/types'

export interface TrustedWalletExecutionContextValue {
  readonly publicEngine: AgentWalletExecutionEngine | null
}

export const TrustedWalletExecutionContext = createContext<TrustedWalletExecutionContextValue | null>(
  null
)

export function useTrustedWalletExecution(): TrustedWalletExecutionContextValue {
  const context = useContext(TrustedWalletExecutionContext)
  if (!context) {
    throw new Error('useTrustedWalletExecution must be used within TrustedWalletExecutionProvider')
  }
  return context
}
