import { EXTERNAL_SIGN_APPROVAL_TTL_MS } from './config'
import type { ExternalSignContentHash } from './contentHash'
import { ExternalSignError } from './contract'
import type { ExternalSignReplayStore } from './replayStore'
import { terminalTombstone } from './replayStore'

export type ExternalSignApprovalState = 'fresh' | 'consuming' | 'consumed' | 'invalidated'

export class ExternalSignApprovalCapabilityV1 {
  readonly requestId: string
  readonly contentHash: ExternalSignContentHash
  readonly capabilityId: string
  readonly issuedAt: number
  readonly expiresAt: number
  private currentState: ExternalSignApprovalState = 'fresh'

  constructor(
    requestId: string,
    contentHash: ExternalSignContentHash,
    requestExpiresAt: number,
    now: number,
    cryptoRef: Pick<Crypto, 'getRandomValues'> = globalThis.crypto
  ) {
    this.requestId = requestId
    this.contentHash = contentHash
    const random = cryptoRef.getRandomValues(new Uint8Array(32))
    let binary = ''
    for (const byte of random) binary += String.fromCharCode(byte)
    this.capabilityId = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    this.issuedAt = now
    this.expiresAt = Math.min(requestExpiresAt, now + EXTERNAL_SIGN_APPROVAL_TTL_MS)
  }

  get state(): ExternalSignApprovalState {
    return this.currentState
  }

  invalidate(): void {
    if (this.currentState !== 'consumed') this.currentState = 'invalidated'
  }

  async consume(replayStore: ExternalSignReplayStore, requestExpiresAt: number, now: number): Promise<void> {
    if (this.currentState !== 'fresh') throw new ExternalSignError('APPROVAL_NOT_FRESH')
    if (now >= this.expiresAt) {
      this.currentState = 'invalidated'
      throw new ExternalSignError('APPROVAL_EXPIRED')
    }
    this.currentState = 'consuming'
    try {
      await replayStore.record(terminalTombstone(
        this.requestId,
        requestExpiresAt,
        'consumed',
        now,
        this.contentHash
      ))
      this.currentState = 'consumed'
    } catch (error) {
      this.currentState = 'invalidated'
      throw error
    }
  }
}
