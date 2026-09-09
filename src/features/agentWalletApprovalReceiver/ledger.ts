/**
 * @file ledger.ts
 *
 * Wallet Approval Ledger interface declarations.
 *
 * Invariants:
 * - Production REQUIRES explicit injection of a durable, transactional ledger.
 * - Enforces atomic uniqueness across requestId, approvalId, AND capabilityId.
 * - Test implementations live strictly in testUtils.ts.
 */

export type { WalletApprovalLedger, WalletApprovalLedgerRecord } from './types'
