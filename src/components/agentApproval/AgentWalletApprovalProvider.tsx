/**
 * @file AgentWalletApprovalProvider.tsx
 *
 * CANONICAL WALLET-OWNED AGENT APPROVAL PROVIDER (Gate 2B)
 *
 * Security Invariants:
 * - Feature-flagged: disabled by default (AGENT_APPROVAL_ENABLED).
 * - Creates exactly ONE receiver instance.
 * - Accepts ONLY Uint8Array handoff bytes; never raw objects from outside.
 * - Keeps receiver and sessionVerifier strictly inside Wallet ownership;
 *   agents have zero access to receiver internals.
 * - Fails closed if no explicit ledger is provided.
 * - Never imports testUtils.ts in production.
 */

import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type ReactElement
} from 'react'
import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import {
  createAgentWalletApprovalReceiver,
  type AgentWalletApprovalReceiver,
  type WalletApprovalLedger,
  type WalletApprovalPresentation,
  type WalletHumanSessionVerifier
} from '../../features/agentWalletApprovalReceiver'
import { AgentApprovalModal } from './AgentWalletApprovalModal'
import { AGENT_APPROVAL_ENABLED } from '../../config/agentApprovalFeature'
import { xolosWalletService } from '../../services/XolosWalletService'
import {
  AgentWalletApprovalContext,
  type AgentWalletApprovalContextValue
} from './AgentWalletApprovalContext'

export interface AgentWalletApprovalProviderProps {
  readonly children: ReactNode
  readonly ledger?: WalletApprovalLedger
  readonly sessionVerifier?: WalletHumanSessionVerifier
  readonly declaredOrigin?: string
  readonly enabled?: boolean
  readonly clock?: () => number
  readonly idGenerator?: () => string
}

interface PendingApprovalState {
  readonly handle: string
  readonly presentation: WalletApprovalPresentation
  readonly resolve: (receipt: HumanApprovalV1) => void
  readonly reject: (error: Error) => void
}

export function AgentWalletApprovalProvider({
  children,
  ledger,
  sessionVerifier: customSessionVerifier,
  declaredOrigin,
  enabled = AGENT_APPROVAL_ENABLED,
  clock,
  idGenerator
}: AgentWalletApprovalProviderProps): ReactElement {
  const [pending, setPending] = useState<PendingApprovalState | null>(null)

  // Wallet-owned session verifier enforcing active authenticated wallet address
  const defaultSessionVerifier = useMemo<WalletHumanSessionVerifier>(() => ({
    async verifyActiveSession() {
      const activeAddress = xolosWalletService.getAddress()
      if (!activeAddress) {
        return {
          authenticated: false,
          error: 'Wallet is locked or no active address found.'
        }
      }
      return {
        authenticated: true,
        activeAddress
      }
    }
  }), [])

  const activeSessionVerifier = customSessionVerifier ?? defaultSessionVerifier

  // Single receiver instance created once
  const receiver = useMemo<AgentWalletApprovalReceiver | null>(() => {
    if (!enabled || !ledger) {
      return null
    }
    return createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier: activeSessionVerifier,
      declaredOrigin: declaredOrigin ?? (typeof window !== 'undefined' ? window.location.origin : undefined),
      clock,
      idGenerator
    })
  }, [enabled, ledger, activeSessionVerifier, declaredOrigin, clock, idGenerator])

  const requestHandoffApproval = useCallback(
    async (rawHandoffBytes: Uint8Array): Promise<HumanApprovalV1> => {
      if (!enabled) {
        throw new Error('AGENT_APPROVAL_DISABLED: Agent wallet approval feature is disabled.')
      }
      if (!ledger) {
        throw new Error(
          'MISSING_LEDGER_DEPENDENCY: Trusted WalletApprovalLedger must be provided to AgentWalletApprovalProvider.'
        )
      }
      if (!receiver) {
        throw new Error('RECEIVER_NOT_INITIALIZED: Approval receiver could not be initialized.')
      }

      const reviewState = await receiver.prepareHandoff(rawHandoffBytes)

      return new Promise<HumanApprovalV1>((resolve, reject) => {
        setPending({
          handle: reviewState.handle,
          presentation: reviewState.presentation,
          resolve,
          reject
        })
      })
    },
    [enabled, ledger, receiver]
  )

  const handleClose = useCallback(() => {
    if (pending && receiver) {
      receiver.dismissHandle(pending.handle)
      pending.reject(new Error('USER_DISMISSED'))
      setPending(null)
    }
  }, [pending, receiver])

  const contextValue = useMemo<AgentWalletApprovalContextValue>(
    () => ({
      requestHandoffApproval
    }),
    [requestHandoffApproval]
  )

  return (
    <AgentWalletApprovalContext.Provider value={contextValue}>
      {children}
      {pending && receiver && (
        <AgentApprovalModal
          isOpen={true}
          handle={pending.handle}
          presentation={pending.presentation}
          receiver={receiver}
          onApprovalSuccess={(receipt) => {
            pending.resolve(receipt)
            setPending(null)
          }}
          onRejectionSuccess={(receipt) => {
            pending.resolve(receipt)
            setPending(null)
          }}
          onError={(err) => {
            pending.reject(err)
            setPending(null)
          }}
          onClose={handleClose}
        />
      )}
    </AgentWalletApprovalContext.Provider>
  )
}
