/**
 * @file index.ts
 *
 * Public surface of the hardened Wallet Approval Receiver feature.
 * Strictly approval-only receiver/recording core for Gate 2B.
 *
 * INVARIANTS:
 * - Explicit exports only. No `export *`.
 * - ApprovalRecordCapability and InternalApprovalBinding are strictly internal.
 * - Presentation and opaque handle are the only review artifacts exposed to Wallet UI.
 */

export {
  prepareApprovalReview,
  recordWalletHumanDecision,
  WALLET_DECLARED_ORIGIN,
  WALLET_DISPLAY_NAME,
  WALLET_PROFILE_ID,
  _clearActiveReviewSessionsForTesting
} from './receiver'

export { formatSatsToExactXEC } from './format'

export {
  WalletApprovalReceiverError,
  type ApprovalReceiverLifecycleState,
  type WalletApprovalPresentation,
  type WalletApprovalReviewState,
  type WalletHumanSessionVerificationResult,
  type WalletHumanSessionVerifier,
  type WalletHumanAction,
  type WalletApprovalLedger,
  type WalletApprovalLedgerRecord,
  type WalletApprovalReceiverErrorCode,
  type PrepareApprovalReviewOptions,
  type RecordHumanDecisionOptions
} from './types'

export { InMemoryWalletApprovalLedger } from './ledger'
