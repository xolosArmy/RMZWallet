/**
 * @file index.ts
 *
 * CANONICAL WALLET APPROVAL RECEIVER PUBLIC API (Gate 2B)
 *
 * Invariants & Boundaries:
 * - Built once via trusted bootstrap: createAgentWalletApprovalReceiver(deps).
 * - UI only interacts with opaque handles and immutable presentations.
 * - Capabilities, tokens, and bindings are strictly module-private closures.
 * - Test-only in-memory ledgers are NOT exported from this production entrypoint.
 * - Zero access to private keys, transaction signing, Chronik, or broadcast.
 */

export { createAgentWalletApprovalReceiver } from './receiver'

export {
  WalletApprovalReceiverError,
  type WalletApprovalReceiverErrorCode,
  type ApprovalReceiverLifecycleState,
  type WalletApprovalPresentation,
  type WalletApprovalReviewState,
  type WalletHumanSessionVerifier,
  type WalletHumanSessionVerificationResult,
  type WalletApprovalLedger,
  type WalletApprovalLedgerRecord,
  type AgentWalletApprovalReceiverDependencies,
  type AgentWalletApprovalReceiver
} from './types'

export { formatSatsToExactXEC } from './format'

