/**
 * @file capability.ts
 *
 * Wallet-local one-shot ApprovalRecordCapability.
 *
 * Security Properties:
 * - Wallet-local: Lives strictly in Wallet memory.
 * - Opaque & non-serializable: Throws on JSON serialization.
 * - Non-constructible by Agents: Guarded by package-internal token.
 * - One-shot: Transitions state fresh -> recording -> recorded. Fails closed on replay.
 * - Bound to contentHash: Cryptographically bound to H(E,C).
 * - Invalid after effectiveExpiresAt: Immediate failure and invalidation if expired.
 */

import type {
  ApprovalCapabilityState,
  WalletApprovalPresentation,
  WalletLocalApprovalBinding
} from './types'
import { WalletApprovalReceiverError } from './types'
import type { UniversalContentHash } from '../externalSign/contentHash'

export const INTERNAL_CAPABILITY_TOKEN = Symbol('WalletApprovalReceiver.CapabilityToken')

export class ApprovalRecordCapability {
  readonly capabilityId: string
  readonly requestId: string
  readonly contentHash: UniversalContentHash
  readonly effectiveExpiresAt: number
  readonly binding: WalletLocalApprovalBinding
  readonly presentation: WalletApprovalPresentation
  private currentState: ApprovalCapabilityState = 'fresh'

  constructor(
    token: symbol,
    capabilityId: string,
    binding: WalletLocalApprovalBinding,
    presentation: WalletApprovalPresentation
  ) {
    if (token !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletApprovalReceiverError(
        'INVALID_CAPABILITY_SOURCE',
        'ApprovalRecordCapability cannot be constructed externally. It is Wallet-local and requires fresh revalidation.'
      )
    }

    this.capabilityId = capabilityId
    this.requestId = binding.requestId
    this.contentHash = binding.contentHash
    this.effectiveExpiresAt = binding.effectiveExpiresAt
    this.binding = Object.freeze({ ...binding })
    this.presentation = Object.freeze({ ...presentation })
  }

  get state(): ApprovalCapabilityState {
    return this.currentState
  }

  /**
   * Guard preventing JSON serialization of the capability.
   */
  toJSON(): never {
    throw new WalletApprovalReceiverError(
      'INVALID_CAPABILITY_SOURCE',
      'ApprovalRecordCapability is strictly Wallet-local and non-serializable.'
    )
  }

  /**
   * Internal state transition helper, token-guarded.
   */
  transition(token: symbol, newState: ApprovalCapabilityState): void {
    if (token !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletApprovalReceiverError(
        'INVALID_CAPABILITY_SOURCE',
        'Unauthorized attempt to mutate ApprovalRecordCapability state.'
      )
    }
    this.currentState = newState
  }
}

export function createApprovalCapabilityInternal(
  capabilityId: string,
  binding: WalletLocalApprovalBinding,
  presentation: WalletApprovalPresentation
): ApprovalRecordCapability {
  return new ApprovalRecordCapability(
    INTERNAL_CAPABILITY_TOKEN,
    capabilityId,
    binding,
    presentation
  )
}
