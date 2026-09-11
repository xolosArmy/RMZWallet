/**
 * @file AgentWalletApprovalContext.ts
 *
 * Context and hook for Wallet-owned Agent Approval.
 */

import { createContext, useContext } from 'react'
import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'

export interface AgentWalletApprovalContextValue {
  readonly requestHandoffApproval: (rawHandoffBytes: Uint8Array) => Promise<HumanApprovalV1>
}

export const AgentWalletApprovalContext = createContext<AgentWalletApprovalContextValue | null>(null)

export function useAgentWalletApproval(): AgentWalletApprovalContextValue {
  const context = useContext(AgentWalletApprovalContext)
  if (!context) {
    throw new Error('useAgentWalletApproval must be used within an AgentWalletApprovalProvider')
  }
  return context
}
