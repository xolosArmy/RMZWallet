/**
 * @file errors.ts
 *
 * CANONICAL ERROR MODEL FOR WALLET EXECUTION (Gate C2)
 *
 * Strongly-typed error hierarchy for Wallet-owned prepared transaction execution.
 * Ensures security violations fail closed and emit predictable machine-readable error codes.
 */

export type WalletExecutionErrorCode =
  | 'INVALID_RECEIPT'
  | 'RECEIPT_NOT_APPROVED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_FORGED'
  | 'APPROVAL_FIELD_MISMATCH'
  | 'DUPLICATE_EXECUTION'
  | 'EXECUTION_ALREADY_RESERVED'
  | 'SESSION_REVALIDATION_FAILED'
  | 'SESSION_ADDRESS_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'UTXO_SELECTION_STALE'
  | 'OUTPUT_INVARIANT_VIOLATION'
  | 'FEE_POLICY_VIOLATION'
  | 'TOCTOU_DETECTED'
  | 'PLAN_HASH_MISMATCH'
  | 'SIGNING_UNCERTAIN'
  | 'SIGNING_FAILED'
  | 'EXECUTION_LOCKED'
  | 'CONCURRENT_EXECUTION_ACTIVE'
  | 'INVALID_STATE_TRANSITION'

export class WalletExecutionError extends Error {
  readonly code: WalletExecutionErrorCode
  readonly details?: unknown

  constructor(code: WalletExecutionErrorCode, message: string, details?: unknown) {
    super(`[WalletExecution] ${code}: ${message}`)
    this.name = 'WalletExecutionError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, new.target.prototype)
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof Error &&
      instance.name === 'WalletExecutionError' &&
      typeof (instance as any).code === 'string'
    )
  }
}
