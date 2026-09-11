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
  useEffect,
  useMemo,
  useRef,
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
  type WalletApprovalReviewState,
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
}

interface ActiveFlightState {
  handle: string
  isSettled: boolean
  resolve: (receipt: HumanApprovalV1) => void
  reject: (error: Error) => void
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
  const activeFlightRef = useRef<ActiveFlightState | null>(null)

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
          'MISSING_LEDGER_DEPENDENCY: Trusted WalletApprovalLedger must be provided to AgentWalletApprovalProvider. In-memory fallback in production is strictly forbidden.'
        )
      }
      if (!receiver) {
        throw new Error('RECEIVER_NOT_INITIALIZED: Approval receiver could not be initialized.')
      }

      // Single-flight guard: prevent concurrent handoffs
      if (activeFlightRef.current !== null) {
        throw new Error(
          'CONCURRENT_HANDOFF_BLOCKED: Another agent approval review is already in progress. Single-flight policy strictly enforced.'
        )
      }

      let flightResolve!: (receipt: HumanApprovalV1) => void
      let flightReject!: (error: Error) => void
      const flightPromise = new Promise<HumanApprovalV1>((res, rej) => {
        flightResolve = res
        flightReject = rej
      })

      const flightState: ActiveFlightState = {
        handle: '',
        isSettled: false,
        resolve: (receipt: HumanApprovalV1) => {
          if (flightState.isSettled) return
          flightState.isSettled = true
          activeFlightRef.current = null
          setPending(null)
          flightResolve(receipt)
        },
        reject: (error: Error) => {
          if (flightState.isSettled) return
          flightState.isSettled = true
          activeFlightRef.current = null
          setPending(null)
          flightReject(error)
        }
      }
      activeFlightRef.current = flightState

      let reviewState: WalletApprovalReviewState
      try {
        reviewState = await receiver.prepareHandoff(rawHandoffBytes)
      } catch (err) {
        activeFlightRef.current = null
        throw err
      }

      flightState.handle = reviewState.handle
      setPending({
        handle: reviewState.handle,
        presentation: reviewState.presentation
      })

      return flightPromise
    },
    [enabled, ledger, receiver]
  )

  const handleClose = useCallback(() => {
    const flight = activeFlightRef.current
    if (flight && !flight.isSettled && receiver) {
      if (flight.handle) {
        try {
          receiver.dismissHandle(flight.handle)
        } catch {
          // Ignore handle dismiss errors during cleanup
        }
      }
      flight.reject(new Error('USER_DISMISSED'))
    }
  }, [receiver])

  useEffect(() => {
    return () => {
      const flight = activeFlightRef.current
      if (flight && !flight.isSettled && receiver) {
        if (flight.handle) {
          try {
            receiver.dismissHandle(flight.handle)
          } catch {
            // Ignore handle dismiss errors during unmount cleanup
          }
        }
        flight.reject(new Error('PROVIDER_UNMOUNTED'))
      }
    }
  }, [receiver])

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
            activeFlightRef.current?.resolve(receipt)
          }}
          onRejectionSuccess={(receipt) => {
            activeFlightRef.current?.resolve(receipt)
          }}
          onError={(err) => {
            activeFlightRef.current?.reject(err)
          }}
          onClose={handleClose}
        />
      )}
    </AgentWalletApprovalContext.Provider>
  )
}
