/**
 * @file TrustedGate2bToC2Bridge.tsx
 *
 * Trusted Wallet application-shell bridge:
 *   Gate 2B HumanApprovalV1 APPROVED
 *   → shared durable WalletApprovalLedger
 *   → C2 publicEngine.prepareExecution
 *   → review modal / local confirm / offline signing
 *   → SIGNED / READY_FOR_SETTLEMENT
 *   → STOP
 *
 * x402-XEC C1 callers still receive only HumanApprovalV1. This bridge never
 * returns signing capability, raw tx, controller, or settlement artifacts.
 */

import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react'
import {
  AgentWalletApprovalContext,
  useAgentWalletApproval,
  type AgentWalletApprovalContextValue
} from '../../components/agentApproval/AgentWalletApprovalContext'
import { useTrustedWalletExecution } from './TrustedWalletExecutionContext'

export function TrustedGate2bToC2Bridge({ children }: { readonly children: ReactNode }): ReactElement {
  const approval = useAgentWalletApproval()
  const { publicEngine } = useTrustedWalletExecution()

  const requestHandoffApproval = useCallback<AgentWalletApprovalContextValue['requestHandoffApproval']>(
    async rawHandoffBytes => {
      const receipt = await approval.requestHandoffApproval(rawHandoffBytes)
      if (receipt.status === 'approved' && publicEngine) {
        try {
          await publicEngine.prepareExecution(receipt)
        } catch (err) {
          console.error('Gate C2 prepareExecution after approved Gate 2B receipt failed:', err)
        }
      }
      return receipt
    },
    [approval, publicEngine]
  )

  const contextValue = useMemo<AgentWalletApprovalContextValue>(
    () => ({ requestHandoffApproval }),
    [requestHandoffApproval]
  )

  return (
    <AgentWalletApprovalContext.Provider value={contextValue}>
      {children}
    </AgentWalletApprovalContext.Provider>
  )
}
