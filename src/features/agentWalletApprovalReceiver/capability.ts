/**
 * @file capability.ts
 *
 * PACKAGE-INTERNAL Approval Record Capability.
 *
 * SECURITY INVARIANTS:
 * - Strictly package-internal: NOT exported from index.ts.
 * - Non-constructible outside this package (guarded by non-exported token).
 * - Non-serializable: toJSON() throws unconditionally.
 * - One-shot linear state machine: fresh -> recording -> recorded / invalidated.
 * - Bound cryptographically to H(E,C) contentHash.
 */

import { WalletApprovalReceiverError } from './types'
import type { InternalApprovalBinding } from './types'

export type ApprovalCapabilityState = 'fresh' | 'recording' | 'recorded' | 'invalidated'

export const INTERNAL_CAPABILITY_TOKEN = Symbol('INTERNAL_APPROVAL_CAPABILITY_TOKEN')

export class ApprovalRecordCapability {
  readonly capabilityId: string
  readonly binding: InternalApprovalBinding
  readonly contentHash: string
  readonly effectiveExpiresAt: number

  private _state: ApprovalCapabilityState = 'fresh'

  constructor(
    internalToken: symbol,
    capabilityId: string,
    binding: InternalApprovalBinding
  ) {
    if (internalToken !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletApprovalReceiverError(
        'CAPABILITY_NOT_FRESH',
        'Direct unauthorized instantiation of ApprovalRecordCapability is prohibited.'
      )
    }
    this.capabilityId = capabilityId
    this.binding = Object.freeze({ ...binding })
    this.contentHash = binding.contentHash
    this.effectiveExpiresAt = binding.effectiveExpiresAt
  }

  get state(): ApprovalCapabilityState {
    return this._state
  }

  transition(internalToken: symbol, nextState: ApprovalCapabilityState): void {
    if (internalToken !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletApprovalReceiverError(
        'CAPABILITY_NOT_FRESH',
        'Unauthorized state transition attempt on ApprovalRecordCapability.'
      )
    }

    if (this._state === 'recorded' || this._state === 'invalidated') {
      throw new WalletApprovalReceiverError(
        'CAPABILITY_NOT_FRESH',
        `Terminal capability state cannot be transitioned: ${this._state} -> ${nextState}`
      )
    }

    if (this._state === 'fresh' && (nextState === 'recording' || nextState === 'invalidated')) {
      this._state = nextState
      return
    }

    if (this._state === 'recording' && (nextState === 'recorded' || nextState === 'invalidated')) {
      this._state = nextState
      return
    }

    throw new WalletApprovalReceiverError(
      'CAPABILITY_NOT_FRESH',
      `Illegal capability transition: ${this._state} -> ${nextState}`
    )
  }

  toJSON(): never {
    throw new WalletApprovalReceiverError(
      'CAPABILITY_NOT_FRESH',
      'ApprovalRecordCapability is strictly Wallet-local and non-serializable.'
    )
  }
}

export function createApprovalCapabilityInternal(
  capabilityId: string,
  binding: InternalApprovalBinding
): ApprovalRecordCapability {
  return new ApprovalRecordCapability(INTERNAL_CAPABILITY_TOKEN, capabilityId, binding)
}
