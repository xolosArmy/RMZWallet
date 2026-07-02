import { createContext, useContext } from 'react'
import type { WalletApprovalRequest, WalletApprovalResponse } from '@x402-xec/payments'

export type TonalliX402ApprovalContextValue = {
  requestApproval: (request: Readonly<WalletApprovalRequest>) => Promise<WalletApprovalResponse>
}

export const TonalliX402ApprovalContext =
  createContext<TonalliX402ApprovalContextValue | null>(null)

export function useTonalliX402ApprovalHandler() {
  const context = useContext(TonalliX402ApprovalContext)
  if (!context) {
    throw new Error('useTonalliX402ApprovalHandler must be used within TonalliX402ApprovalProvider')
  }
  return context.requestApproval
}
