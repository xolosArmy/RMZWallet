/**
 * @file TrustedWalletExecutionProvider.tsx
 *
 * TRUSTED WALLET APPLICATION-SHELL BOOTSTRAP (Gate C2)
 *
 * Owns:
 * - private settlement persistence (never Agent-injectable)
 * - walletUIHost / WalletLocalConfirmationController
 * - review session + matching controller
 * - AgentExecutionReviewModal
 *
 * Exposes ONLY publicEngine through TrustedWalletExecutionContext.
 *
 * StrictMode: composition is retained across remount via a module-level slot
 * so we do not create duplicate signing compositions or orphan heartbeats.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { AgentExecutionReviewModal } from '../../components/agentExecution/AgentExecutionReviewModal'
import { WalletExecutionError } from '../../features/agentWalletExecution'
import type {
  AgentWalletExecutionEngineConfig,
  WalletExecutionReviewSession
} from '../../features/agentWalletExecution'
import { xolosWalletService } from '../../services/XolosWalletService'
import { createWalletExecutionComposition } from './index'
import type { WalletExecutionTrustedOptions } from '../../features/agentWalletExecution/types'
import type { WalletExecutionComposition, WalletLocalConfirmationController } from './types'
import {
  TrustedWalletExecutionContext,
  type TrustedWalletExecutionContextValue
} from './TrustedWalletExecutionContext'

export interface TrustedWalletExecutionProviderProps {
  readonly children: ReactNode
  readonly approvalLedger?: AgentWalletExecutionEngineConfig['approvalLedger']
  readonly executionLedger?: AgentWalletExecutionEngineConfig['executionLedger']
  readonly sessionVerifier?: AgentWalletExecutionEngineConfig['sessionVerifier']
  readonly utxoProvider?: AgentWalletExecutionEngineConfig['utxoProvider']
  readonly signatoryProvider?: AgentWalletExecutionEngineConfig['signatoryProvider']
  readonly feePolicy?: AgentWalletExecutionEngineConfig['feePolicy']
  readonly lockCoordinator?: AgentWalletExecutionEngineConfig['lockCoordinator']
  readonly clock?: AgentWalletExecutionEngineConfig['clock']
  readonly idGenerator?: AgentWalletExecutionEngineConfig['idGenerator']
  /**
   * Public execution-ledger Storage only. NEVER used for raw signed transactions.
   */
  readonly ledgerStorage?: Storage
  /**
   * Trusted-bootstrap-only settlement persistence. Not part of AgentWalletExecutionEngineConfig.
   */
  readonly trustedSettlementStorage?: Storage
  readonly reviewLeaseTtlSeconds?: number
  readonly reviewHeartbeatMs?: number
}

interface ShellSlot {
  composition: WalletExecutionComposition
  refs: number
}

let shellSlot: ShellSlot | null = null

export function resetTrustedExecutionShellForTests(): void {
  shellSlot = null
}

function failClosedSignatory() {
  return {
    async getSignatory(): Promise<never> {
      throw new WalletExecutionError(
        'SIGNING_FAILED',
        'Wallet signatory is not bound until a trusted Wallet session is unlocked.'
      )
    }
  }
}

function productionSessionVerifier(): AgentWalletExecutionEngineConfig['sessionVerifier'] {
  return {
    async verifyActiveSession() {
      const activeAddress = xolosWalletService.getAddress()
      if (!activeAddress) {
        return { authenticated: false, error: 'Wallet is locked or no active address found.' }
      }
      return { authenticated: true, activeAddress }
    }
  }
}

function getOrCreateShell(
  publicConfig: AgentWalletExecutionEngineConfig,
  trusted: WalletExecutionTrustedOptions
): WalletExecutionComposition {
  if (!shellSlot) {
    shellSlot = {
      composition: createWalletExecutionComposition(publicConfig, trusted),
      refs: 0
    }
  }
  return shellSlot.composition
}

function releaseShell(): void {
  if (!shellSlot) return
  shellSlot.refs -= 1
  if (shellSlot.refs <= 0) {
    shellSlot = null
  }
}

export function TrustedWalletExecutionProvider({
  children,
  approvalLedger,
  executionLedger,
  sessionVerifier,
  utxoProvider,
  signatoryProvider,
  feePolicy,
  lockCoordinator,
  clock,
  idGenerator,
  ledgerStorage,
  trustedSettlementStorage,
  reviewLeaseTtlSeconds,
  reviewHeartbeatMs
}: TrustedWalletExecutionProviderProps): ReactElement {
  const settlementStorageRef = useRef<Storage | undefined>(
    trustedSettlementStorage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  )
  const compositionRef = useRef<WalletExecutionComposition | null>(null)
  if (compositionRef.current === null) {
    compositionRef.current = getOrCreateShell(
      {
        approvalLedger: approvalLedger ?? {
          async get() {
            return undefined
          }
        },
        executionLedger,
        sessionVerifier: sessionVerifier ?? productionSessionVerifier(),
        utxoProvider: utxoProvider ?? {
          async getSpendableUtxos() {
            return []
          }
        },
        signatoryProvider: signatoryProvider ?? failClosedSignatory(),
        feePolicy,
        storage: ledgerStorage,
        lockCoordinator,
        clock,
        idGenerator
      },
      {
        privateSettlementStorage: settlementStorageRef.current,
        reviewLeaseTtlSeconds,
        reviewHeartbeatMs
      }
    )
  }
  const composition = compositionRef.current

  const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)

  useEffect(() => {
    if (shellSlot) {
      shellSlot.refs += 1
    }
    const unsubscribe = composition.walletUIHost.onSessionPrepared((nextSession, nextController) => {
      setSession(nextSession)
      setController(nextController)
    })
    return () => {
      unsubscribe()
      releaseShell()
    }
  }, [composition])

  const clearActiveReview = () => {
    setSession(null)
    setController(null)
  }

  const contextValue = useMemo<TrustedWalletExecutionContextValue>(
    () => ({
      publicEngine: composition.publicEngine
    }),
    [composition]
  )

  const bound =
    session !== null && controller !== null && controller.executionId === session.executionId

  return (
    <TrustedWalletExecutionContext.Provider value={contextValue}>
      {children}
      {bound && session && controller ? (
        <AgentExecutionReviewModal
          session={session}
          controller={controller}
          isOpen={true}
          onExecutionSuccess={clearActiveReview}
          onExecutionRejected={clearActiveReview}
          onClose={clearActiveReview}
        />
      ) : null}
    </TrustedWalletExecutionContext.Provider>
  )
}
