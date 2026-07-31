import { ExternalSignApprovalCapabilityV1 } from './approval'
import { calculateExternalSignContentHash, equalContentHashes, type ExternalSignContentHash } from './contentHash'
import { ExternalSignError, type ExternalSignWireRequestV1, type OriginContextV1 } from './contract'
import type { ExternalSignReplayStore } from './replayStore'
import { terminalTombstone } from './replayStore'
import type { ExternalSignTxReviewV1 } from './review'
import { signExternalTransactionOnly, type ExternalSignResponseV1, type ExternalSignSignerDependencies } from './signOnly'

export type FinalizeExternalSignDependencies = Readonly<{
  reviewAgain: () => Promise<ExternalSignTxReviewV1>
  replayStore: ExternalSignReplayStore
  signer: ExternalSignSignerDependencies
  crypto?: Pick<Crypto, 'subtle'>
  now?: () => number
}>

export async function finalizeApprovedExternalSign(
  request: ExternalSignWireRequestV1,
  origin: OriginContextV1,
  approvedReview: ExternalSignTxReviewV1,
  approvedHash: ExternalSignContentHash,
  capability: ExternalSignApprovalCapabilityV1,
  dependencies: FinalizeExternalSignDependencies
): Promise<ExternalSignResponseV1> {
  const now = dependencies.now ?? Date.now
  if (now() >= request.expiresAt) {
    capability.invalidate()
    throw new ExternalSignError('REQUEST_EXPIRED')
  }
  let finalReview: ExternalSignTxReviewV1
  try {
    finalReview = await dependencies.reviewAgain()
  } catch (error) {
    capability.invalidate()
    throw error
  }
  const finalHash = await calculateExternalSignContentHash(request, origin, finalReview, dependencies.crypto)
  const finalNow = now()
  if (finalNow >= request.expiresAt) {
    capability.invalidate()
    throw new ExternalSignError('REQUEST_EXPIRED')
  }
  if (
    capability.requestId !== request.requestId ||
    !equalContentHashes(capability.contentHash, approvedHash) ||
    !equalContentHashes(finalHash, approvedHash) ||
    JSON.stringify(finalReview) !== JSON.stringify(approvedReview)
  ) {
    capability.invalidate()
    throw new ExternalSignError('CONTENT_HASH_MISMATCH')
  }
  await capability.consume(dependencies.replayStore, request.expiresAt, finalNow)
  if (capability.state !== 'consumed') throw new ExternalSignError('APPROVAL_NOT_CONSUMED')
  return signExternalTransactionOnly(request, finalReview, finalHash, dependencies.signer)
}

export async function terminateExternalSignRequest(
  request: ExternalSignWireRequestV1,
  replayStore: ExternalSignReplayStore,
  state: 'rejected' | 'cancelled' | 'expired',
  now = Date.now(),
  contentHash: ExternalSignContentHash | null = null
): Promise<void> {
  await replayStore.record(terminalTombstone(request.requestId, request.expiresAt, state, now, contentHash))
}
