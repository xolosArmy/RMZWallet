import type { UniversalContentHash } from './contentHash'
import type { UniversalAuthorizationEnvelopeV1 } from './contract'

export type UniversalReviewField = Readonly<{
  label: string
  value: string
}>

export type UniversalReviewSnapshot = Readonly<{
  fields: readonly UniversalReviewField[]
  effectiveContent: Uint8Array
}>

export type UniversalSignedResult = Readonly<{
  format: string
  bytes: Uint8Array
  contentHash: UniversalContentHash
}>

export interface PrepareReviewAdapter {
  prepareReview(
    envelope: UniversalAuthorizationEnvelopeV1,
    signal: AbortSignal
  ): Promise<UniversalReviewSnapshot>
}

export interface RevalidateReviewAdapter {
  revalidateReview(
    envelope: UniversalAuthorizationEnvelopeV1,
    approvedReview: UniversalReviewSnapshot,
    signal: AbortSignal
  ): Promise<UniversalReviewSnapshot>
}

export interface SignApprovedContentAdapter {
  signApprovedContent(input: Readonly<{
    envelope: UniversalAuthorizationEnvelopeV1
    effectiveContent: Uint8Array
    contentHash: UniversalContentHash
    signal: AbortSignal
  }>): Promise<UniversalSignedResult>
}

export type UniversalReviewAuthorizationAdapter = Readonly<{ profileId: string }> &
  PrepareReviewAdapter &
  RevalidateReviewAdapter

export type UniversalAuthorizationAdapter = UniversalReviewAuthorizationAdapter &
  SignApprovedContentAdapter
