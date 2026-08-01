import type { UniversalContentHash } from './contentHash'
import { UniversalAuthorizationError } from './contract'

export type ApprovalCapabilityState = 'fresh' | 'consuming' | 'consumed' | 'invalidated'

export type ApprovalConsumption = Readonly<{
  operationId: string
  capabilityId: string
  contentHash: UniversalContentHash
  expiresAt: number
  consumedAt: number
}>

export interface ApprovalConsumptionLedger {
  consume(consumption: ApprovalConsumption, signal: AbortSignal): Promise<void>
}

export class InMemoryApprovalCapability {
  readonly operationId: string
  readonly capabilityId: string
  readonly contentHash: UniversalContentHash
  readonly expiresAt: number
  private currentState: ApprovalCapabilityState = 'fresh'

  constructor(
    operationId: string,
    capabilityId: string,
    contentHash: UniversalContentHash,
    expiresAt: number
  ) {
    this.operationId = operationId
    this.capabilityId = capabilityId
    this.contentHash = contentHash
    this.expiresAt = expiresAt
  }

  get state(): ApprovalCapabilityState {
    return this.currentState
  }

  invalidate(): void {
    if (this.currentState !== 'consumed') this.currentState = 'invalidated'
  }

  async consume(
    ledger: ApprovalConsumptionLedger,
    signal: AbortSignal,
    now: number
  ): Promise<void> {
    if (this.currentState !== 'fresh') throw new UniversalAuthorizationError('APPROVAL_NOT_FRESH')
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    if (now >= this.expiresAt) {
      this.currentState = 'invalidated'
      throw new UniversalAuthorizationError('APPROVAL_EXPIRED')
    }
    this.currentState = 'consuming'
    try {
      await ledger.consume(Object.freeze({
        operationId: this.operationId,
        capabilityId: this.capabilityId,
        contentHash: this.contentHash,
        expiresAt: this.expiresAt,
        consumedAt: now
      }), signal)
      if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
      this.currentState = 'consumed'
    } catch (error) {
      this.currentState = 'invalidated'
      throw error
    }
  }
}
