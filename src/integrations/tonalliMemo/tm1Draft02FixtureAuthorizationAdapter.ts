import type {
  UniversalAuthorizationAdapter,
  UniversalReviewSnapshot,
  UniversalSignedResult
} from '../../features/externalSign/adapters'
import type { UniversalContentHash } from '../../features/externalSign/contentHash'
import type { UniversalAuthorizationEnvelopeV1 } from '../../features/externalSign/contract'
import {
  revalidateTm1Draft02Candidate,
  type Tm1Draft02Candidate,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  auditTm1Draft02UnsignedTransaction,
  decodeTm1Draft02CandidateEffectiveContent,
  serializeTm1Draft02UnsignedTransaction
} from './tm1Draft02UnsignedTransaction'
import {
  TM1_DRAFT_02_FIXTURE_SIGNED_FORMAT,
  auditTm1Draft02FixtureSignedTransaction
} from './tm1Draft02FixtureSignedTransaction'

export const TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID =
  'tonalli.tm1-draft02.fixture-authorization.v1'

export type Tm1Draft02FixtureOutpoint = Readonly<{
  txid: string
  outIdx: number
}>

export interface Tm1Draft02FixtureEffectiveContentSource {
  readEffectiveContent(
    envelope: UniversalAuthorizationEnvelopeV1,
    signal: AbortSignal
  ): Promise<Uint8Array>
}

export interface Tm1Draft02FixtureStateProvider {
  readFreshUtxos(
    outpoints: readonly Tm1Draft02FixtureOutpoint[],
    signal: AbortSignal
  ): Promise<readonly Tm1Draft02FreshUtxo[]>
}

export interface Tm1Draft02FixtureSigner {
  signFixtureTransaction(input: Readonly<{
    candidate: Tm1Draft02Candidate
    unsignedTransactionBytes: Uint8Array
    contentHash: UniversalContentHash
    signal: AbortSignal
  }>): Promise<Uint8Array>
}

export type Tm1Draft02FixtureAuthorizationAdapterDependencies = Readonly<{
  effectiveContentSource: Tm1Draft02FixtureEffectiveContentSource
  stateProvider: Tm1Draft02FixtureStateProvider
  signer: Tm1Draft02FixtureSigner
}>

export class Tm1Draft02FixtureAuthorizationAdapter
implements UniversalAuthorizationAdapter {
  readonly profileId = TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID
  private readonly dependencies: Tm1Draft02FixtureAuthorizationAdapterDependencies

  constructor(dependencies: Tm1Draft02FixtureAuthorizationAdapterDependencies) {
    this.dependencies = dependencies
  }

  async prepareReview(
    envelope: UniversalAuthorizationEnvelopeV1,
    signal: AbortSignal
  ): Promise<UniversalReviewSnapshot> {
    assertNotAborted(signal)
    const effectiveContent = await this.dependencies.effectiveContentSource.readEffectiveContent(
      envelope,
      signal
    )
    assertNotAborted(signal)
    return buildReview(new Uint8Array(effectiveContent))
  }

  async revalidateReview(
    _envelope: UniversalAuthorizationEnvelopeV1,
    approvedReview: UniversalReviewSnapshot,
    signal: AbortSignal
  ): Promise<UniversalReviewSnapshot> {
    assertNotAborted(signal)
    const candidate = decodeTm1Draft02CandidateEffectiveContent(
      approvedReview.effectiveContent
    )
    const outpoints = Object.freeze(candidate.inputs.map(input => Object.freeze({
      txid: input.txid,
      outIdx: input.outIdx
    })))
    const freshUtxos = await this.dependencies.stateProvider.readFreshUtxos(
      outpoints,
      signal
    )
    assertNotAborted(signal)
    revalidateTm1Draft02Candidate(candidate, freshUtxos)
    return buildReview(new Uint8Array(approvedReview.effectiveContent))
  }

  async signApprovedContent(input: Readonly<{
    envelope: UniversalAuthorizationEnvelopeV1
    effectiveContent: Uint8Array
    contentHash: UniversalContentHash
    signal: AbortSignal
  }>): Promise<UniversalSignedResult> {
    assertNotAborted(input.signal)
    const candidate = decodeTm1Draft02CandidateEffectiveContent(input.effectiveContent)
    const unsignedTransactionBytes = serializeTm1Draft02UnsignedTransaction(candidate)
    auditTm1Draft02UnsignedTransaction({
      effectiveContent: input.effectiveContent,
      unsignedTransactionBytes
    })

    const signedTransactionBytes = await this.dependencies.signer.signFixtureTransaction(
      Object.freeze({
        candidate,
        unsignedTransactionBytes: new Uint8Array(unsignedTransactionBytes),
        contentHash: input.contentHash,
        signal: input.signal
      })
    )
    assertNotAborted(input.signal)
    const audited = auditTm1Draft02FixtureSignedTransaction({
      candidate,
      contentHash: input.contentHash,
      signedTransactionBytes
    })

    return Object.freeze({
      format: TM1_DRAFT_02_FIXTURE_SIGNED_FORMAT,
      bytes: new Uint8Array(audited.signedTransactionBytes),
      contentHash: input.contentHash
    })
  }
}

function buildReview(effectiveContent: Uint8Array): UniversalReviewSnapshot {
  const candidate = decodeTm1Draft02CandidateEffectiveContent(effectiveContent)
  const unsignedTransactionBytes = serializeTm1Draft02UnsignedTransaction(candidate)
  const audited = auditTm1Draft02UnsignedTransaction({
    effectiveContent,
    unsignedTransactionBytes
  })

  return Object.freeze({
    fields: Object.freeze([
      Object.freeze({ label: 'Profile', value: TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID }),
      Object.freeze({ label: 'Environment', value: candidate.environment }),
      Object.freeze({ label: 'Author input', value: candidate.authorInputIndex.toString() }),
      Object.freeze({ label: 'Inputs', value: candidate.inputs.length.toString() }),
      Object.freeze({ label: 'Outputs', value: candidate.outputs.length.toString() }),
      Object.freeze({ label: 'Fee sats', value: audited.feeSats.toString() }),
      Object.freeze({ label: 'Maximum fee sats', value: candidate.feePolicy.maxFeeSats.toString() }),
      Object.freeze({ label: 'Unsigned bytes', value: unsignedTransactionBytes.length.toString() }),
      Object.freeze({ label: 'Sighash policy', value: candidate.sighashPolicy }),
      Object.freeze({ label: 'Delivery', value: 'fixture-only; no broadcast' })
    ]),
    effectiveContent: new Uint8Array(effectiveContent)
  })
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('OPERATION_ABORTED')
}
