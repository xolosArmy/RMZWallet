/**
 * @file types.ts (src/internal/agentWalletExecutionHost/types.ts)
 *
 * TRUSTED WALLET INTERNAL UI EXECUTION HOST TYPES (Gate C2)
 *
 * Confined strictly to trusted internal Wallet application composition.
 * NEVER exported from features/agentWalletExecution.
 */

import type {
  AgentWalletExecutionEngine,
  SignedExecutionHandle,
  WalletExecutionReviewSession
} from '../../features/agentWalletExecution'

/**
 * Internal local confirmation controller delivered exclusively to the trusted Wallet UI host.
 * Capable of initiating cryptographic signing upon explicit human confirmation.
 */
export interface WalletLocalConfirmationController {
  readonly executionId: string
  confirm(): Promise<SignedExecutionHandle>
  reject(reason?: string): Promise<void>
  dismiss(): Promise<void>
}

/**
 * Wallet UI Host interface for binding the local review UI to the active execution session.
 * Exclusively provided to the Wallet application container (never to external agents).
 */
export interface WalletExecutionUIHost {
  onSessionPrepared(
    handler: (
      session: WalletExecutionReviewSession,
      localController: WalletLocalConfirmationController
    ) => void
  ): () => void
  getActiveController(): WalletLocalConfirmationController | undefined
}

/**
 * Full Wallet Execution Composition combining the public engine with the internal UI host.
 */
export interface WalletExecutionComposition {
  readonly publicEngine: AgentWalletExecutionEngine
  readonly walletUIHost: WalletExecutionUIHost
}
