import { sha256d, toHex } from 'ecash-lib'
import { XEC_DUST_SATS } from '../../config/xecFees'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  createTm1Draft02Candidate,
  encodeTm1Draft02CandidateEffectiveContent,
  revalidateTm1Draft02Candidate,
  type Tm1Draft02Candidate,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
  planTm1Draft02Post,
  type Tm1Draft02FundingUtxo
} from './tm1Draft02Plan'
import type { RegtestSignedTransaction } from './tm1Draft02RegtestP2pkhSigner'
import type {
  Tm1RegtestDeliveryReceipt,
  Tm1RegtestNetworkAttestation
} from './tm1RegtestDeliveryTransport'

const DEFAULT_MAX_FEE_SATS = 10_000n

export type Tm1PublicationErrorCode =
  | 'INVALID_STATE'
  | 'PUBLICATION_ALREADY_ACTIVE'
  | 'STALE_PREPARED_REVIEW'
  | 'STALE_SIGNED_REVIEW'
  | 'SIGNING_REJECTED'
  | 'SIGNING_AUTHORIZATION_EXPIRED'
  | 'CANDIDATE_REVALIDATION_FAILED'
  | 'SIGNING_FAILED'
  | 'SIGNED_ARTIFACT_INVALID'
  | 'BROADCAST_REJECTED'
  | 'BROADCAST_AUTHORIZATION_EXPIRED'
  | 'BROADCAST_FAILED'
  | 'TXID_MISMATCH'
  | 'CONFIRMATION_FAILED'
  | 'ABORTED'

export class Tm1PublicationError extends Error {
  readonly code: Tm1PublicationErrorCode
  readonly cause?: unknown

  constructor(code: Tm1PublicationErrorCode, message: string = code, cause?: unknown) {
    super(message)
    this.name = 'Tm1PublicationError'
    this.code = code
    this.cause = cause
  }
}

export type Tm1PublicationRequest = Readonly<{
  message: string
  activeLockingScriptHex: string
  maxFeeSats?: bigint
}>

export type Tm1PublicationAuthorizationDecision = Readonly<
  | { status: 'approved'; authorizationId: string }
  | { status: 'rejected'; reason?: string }
  | { status: 'expired'; reason?: string }
>

export type Tm1SubmissionReceipt = Readonly<{
  submissionId: string
  signedId: string
  preparedId: string
  txid: string
  deliveryReceipt: Tm1RegtestDeliveryReceipt
}>

export type Tm1Confirmation = Readonly<{
  submissionId: string
  txid: string
  confirmations: number
  blockHash?: string
  blockHeight?: number
}>

export type Tm1PreparedReview = Readonly<{
  preparedId: string
  message: string
  network: Tm1RegtestNetworkAttestation
  candidate: Tm1Draft02Candidate
  effectiveContent: Uint8Array
  bindingHash: string
  orderedInputs: readonly Tm1PublicationInput[]
  orderedOutputs: readonly Tm1PublicationOutput[]
  feeSats: bigint
}>

export type Tm1SignedReview = Readonly<{
  preparedId: string
  signedId: string
  txid: string
  signedArtifactHash: string
  signedArtifact: RegtestSignedTransaction
  feeSats: bigint
  orderedOutputs: readonly Tm1PublicationOutput[]
  bindingHash: string
  signingAuthorizationId: string
}>

export type Tm1PublicationInput = Readonly<{
  index: number
  role: 'author' | 'funding'
  txid: string
  outIdx: number
  sats: bigint
  lockingScriptHex: string
}>

export type Tm1PublicationOutput = Readonly<{
  index: number
  role: 'tm1_op_return' | 'change'
  sats: bigint
  scriptHex: string
}>

export type Tm1PublicationState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'attesting'; message: string }>
  | Readonly<{ status: 'preparing'; message: string; network: Tm1RegtestNetworkAttestation }>
  | Readonly<{ status: 'reviewReady'; review: Tm1PreparedReview }>
  | Readonly<{ status: 'authorizing'; review: Tm1PreparedReview }>
  | Readonly<{ status: 'revalidating'; review: Tm1PreparedReview; signingAuthorizationId: string }>
  | Readonly<{ status: 'signing'; review: Tm1PreparedReview; signingAuthorizationId: string }>
  | Readonly<{ status: 'signedReviewReady'; review: Tm1PreparedReview; signedReview: Tm1SignedReview }>
  | Readonly<{ status: 'approvingBroadcast'; signedReview: Tm1SignedReview }>
  | Readonly<{ status: 'broadcasting'; signedReview: Tm1SignedReview; broadcastAuthorizationId: string }>
  | Readonly<{ status: 'submitted'; signedReview: Tm1SignedReview; receipt: Tm1SubmissionReceipt }>
  | Readonly<{ status: 'confirming'; receipt: Tm1SubmissionReceipt }>
  | Readonly<{ status: 'confirmed'; receipt: Tm1SubmissionReceipt; confirmation: Tm1Confirmation }>
  | Readonly<{ status: 'rejected'; stage: 'signing' | 'broadcast'; reason?: string }>
  | Readonly<{ status: 'aborted'; stage: Tm1PublicationNonTerminalStatus }>
  | Readonly<{ status: 'expired'; stage: 'signing' | 'broadcast'; reason?: string }>
  | Readonly<{ status: 'failed'; stage: Tm1PublicationNonTerminalStatus; error: Tm1PublicationError }>

export type Tm1PublicationNonTerminalStatus = Exclude<
  Tm1PublicationState['status'],
  'idle' | 'rejected' | 'aborted' | 'expired' | 'failed' | 'confirmed'
>

export type Tm1RegtestPublicationDependencies = Readonly<{
  networkAttestation: Tm1NetworkAttestationPort
  utxoProvider: Tm1UtxoProviderPort
  signingAuthorization: Tm1SigningAuthorizationPort
  signer: Tm1SignerPort
  signedArtifactAudit: Tm1SignedArtifactAuditPort
  broadcastAuthorization: Tm1BroadcastAuthorizationPort
  deliveryTransport: Tm1DeliveryTransportPort
  confirmationObserver: Tm1ConfirmationObserverPort
  clock?: Tm1PublicationClock
}>

export interface Tm1NetworkAttestationPort {
  attest(signal?: AbortSignal): Promise<Tm1RegtestNetworkAttestation>
}

export interface Tm1UtxoProviderPort {
  readUtxos(signal?: AbortSignal): Promise<readonly Tm1Draft02FundingUtxo[]>
}

export interface Tm1SigningAuthorizationPort {
  requestSigningAuthorization(
    review: Tm1PreparedReview,
    signal?: AbortSignal
  ): Promise<Tm1PublicationAuthorizationDecision>
}

export interface Tm1SignerPort {
  sign(review: Tm1PreparedReview, signal?: AbortSignal): Promise<RegtestSignedTransaction>
}

export interface Tm1SignedArtifactAuditPort {
  auditSignedArtifact(input: Readonly<{
    review: Tm1PreparedReview
    signedArtifact: RegtestSignedTransaction
  }>): Promise<RegtestSignedTransaction>
}

export interface Tm1BroadcastAuthorizationPort {
  requestBroadcastAuthorization(
    signedReview: Tm1SignedReview,
    signal?: AbortSignal
  ): Promise<Tm1PublicationAuthorizationDecision>
}

export interface Tm1DeliveryTransportPort {
  broadcast(signedArtifact: RegtestSignedTransaction): Promise<Tm1RegtestDeliveryReceipt>
}

export interface Tm1ConfirmationObserverPort {
  confirm(input: Readonly<{
    submissionId: string
    txid: string
    signal?: AbortSignal
  }>): Promise<Tm1Confirmation>
}

export type Tm1PublicationClock = Readonly<{
  createId: (prefix: 'prepared' | 'signed' | 'submission') => string
}>

export interface Tm1RegtestPublicationOrchestrator {
  getState(): Tm1PublicationState
  subscribe(listener: (state: Tm1PublicationState) => void): () => void
  prepare(request: Tm1PublicationRequest, signal?: AbortSignal): Promise<Tm1PreparedReview>
  authorizeAndSign(preparedId: string, signal?: AbortSignal): Promise<Tm1SignedReview>
  approveAndBroadcast(signedId: string, signal?: AbortSignal): Promise<Tm1SubmissionReceipt>
  confirm(submissionId: string, signal?: AbortSignal): Promise<Tm1Confirmation>
  reset(): void
}

export class Tm1RegtestPublicationOrchestratorImpl
implements Tm1RegtestPublicationOrchestrator {
  private readonly dependencies: Tm1RegtestPublicationDependencies
  private readonly clock: Tm1PublicationClock
  private readonly listeners = new Set<(state: Tm1PublicationState) => void>()
  private state: Tm1PublicationState = Object.freeze({ status: 'idle' })

  constructor(dependencies: Tm1RegtestPublicationDependencies) {
    this.dependencies = dependencies
    this.clock = dependencies.clock ?? monotonicClock()
  }

  getState(): Tm1PublicationState {
    return cloneState(this.state)
  }

  subscribe(listener: (state: Tm1PublicationState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  async prepare(
    request: Tm1PublicationRequest,
    signal?: AbortSignal
  ): Promise<Tm1PreparedReview> {
    if (this.state.status !== 'idle') {
      throw new Tm1PublicationError('PUBLICATION_ALREADY_ACTIVE')
    }

    try {
      assertNotAborted(signal)
      this.transition({ status: 'attesting', message: request.message })
      const network = await this.dependencies.networkAttestation.attest(signal)
      assertNotAborted(signal)
      this.transition({ status: 'preparing', message: request.message, network })

      const utxos = await this.dependencies.utxoProvider.readUtxos(signal)
      assertNotAborted(signal)
      const preview = encodeTm1Draft02Post({
        eventData: request.message,
        authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
      })
      const plan = planTm1Draft02Post({
        preview,
        utxos,
        activeLockingScriptHex: request.activeLockingScriptHex
      })
      const candidate = createTm1Draft02Candidate({
        environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
        transactionVersion: TM1_DRAFT_02_TX_VERSION,
        locktime: TM1_DRAFT_02_LOCKTIME,
        authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
        authorLockingScriptHex: request.activeLockingScriptHex,
        inputs: plan.inputs.map(input => ({
          txid: input.txid,
          outIdx: input.outIdx,
          sequence: TM1_DRAFT_02_SEQUENCE,
          sats: input.sats,
          lockingScriptHex: input.lockingScriptHex
        })),
        outputs: plan.outputs.map(output => ({
          sats: output.sats,
          scriptHex: output.scriptHex
        })),
        dustSats: BigInt(XEC_DUST_SATS),
        maxFeeSats: request.maxFeeSats ?? DEFAULT_MAX_FEE_SATS,
        sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY
      })
      const effectiveContent = encodeTm1Draft02CandidateEffectiveContent(candidate)
      const review = freezePreparedReview({
        preparedId: this.clock.createId('prepared'),
        message: preview.eventData,
        network,
        candidate,
        effectiveContent,
        bindingHash: hashBytes(effectiveContent),
        orderedInputs: candidate.inputs.map(input => ({
          index: input.index,
          role: input.role,
          txid: input.txid,
          outIdx: input.outIdx,
          sats: input.sats,
          lockingScriptHex: input.lockingScriptHex
        })),
        orderedOutputs: candidate.outputs.map(output => ({
          index: output.index,
          role: output.role,
          sats: output.sats,
          scriptHex: output.scriptHex
        })),
        feeSats: candidate.feePolicy.feeSats
      })

      this.transition({ status: 'reviewReady', review })
      return freezePreparedReview(review)
    } catch (error) {
      throw this.enterFailureOrAbort(error)
    }
  }

  async authorizeAndSign(
    preparedId: string,
    signal?: AbortSignal
  ): Promise<Tm1SignedReview> {
    if (this.state.status !== 'reviewReady') throw new Tm1PublicationError('INVALID_STATE')
    const review = this.state.review
    if (preparedId !== review.preparedId) throw new Tm1PublicationError('STALE_PREPARED_REVIEW')

    try {
      assertNotAborted(signal)
      this.transition({ status: 'authorizing', review })
      const decision = await this.dependencies.signingAuthorization.requestSigningAuthorization(
        freezePreparedReview(review),
        signal
      )
      if (decision.status === 'rejected') {
        this.transition(rejectedState('signing', decision.reason))
        throw new Tm1PublicationError('SIGNING_REJECTED', decision.reason ?? 'SIGNING_REJECTED')
      }
      if (decision.status === 'expired') {
        this.transition(expiredState('signing', decision.reason))
        throw new Tm1PublicationError(
          'SIGNING_AUTHORIZATION_EXPIRED',
          decision.reason ?? 'SIGNING_AUTHORIZATION_EXPIRED'
        )
      }

      assertNotAborted(signal)
      this.transition({
        status: 'revalidating',
        review,
        signingAuthorizationId: decision.authorizationId
      })
      const freshNetwork = await this.dependencies.networkAttestation.attest(signal)
      if (
        freshNetwork.environment !== review.network.environment ||
        freshNetwork.chainIdentity !== review.network.chainIdentity
      ) {
        throw new Tm1PublicationError('CANDIDATE_REVALIDATION_FAILED')
      }
      const freshUtxos = await this.dependencies.utxoProvider.readUtxos(signal)
      assertCandidateStillValid(review, freshUtxos)
      assertBindingUnchanged(review)
      assertNotAborted(signal)

      this.transition({
        status: 'signing',
        review,
        signingAuthorizationId: decision.authorizationId
      })
      let signedArtifact: RegtestSignedTransaction
      try {
        signedArtifact = await this.dependencies.signer.sign(
          freezePreparedReview(review),
          signal
        )
      } catch (error) {
        if (isAbortLike(error)) throw error
        throw new Tm1PublicationError('SIGNING_FAILED', 'SIGNING_FAILED', error)
      }
      let auditedArtifact: RegtestSignedTransaction
      try {
        auditedArtifact = await this.dependencies.signedArtifactAudit.auditSignedArtifact({
          review: freezePreparedReview(review),
          signedArtifact
        })
      } catch (error) {
        throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID', 'SIGNED_ARTIFACT_INVALID', error)
      }
      const signedReview = freezeSignedReview({
        preparedId: review.preparedId,
        signedId: this.clock.createId('signed'),
        txid: auditedArtifact.txid,
        signedArtifactHash: hashBytes(auditedArtifact.rawTransactionBytes),
        signedArtifact: auditedArtifact,
        feeSats: review.feeSats,
        orderedOutputs: review.orderedOutputs,
        bindingHash: review.bindingHash,
        signingAuthorizationId: decision.authorizationId
      })

      this.transition({ status: 'signedReviewReady', review, signedReview })
      return freezeSignedReview(signedReview)
    } catch (error) {
      throw this.enterFailureOrAbort(error)
    }
  }

  async approveAndBroadcast(
    signedId: string,
    signal?: AbortSignal
  ): Promise<Tm1SubmissionReceipt> {
    if (this.state.status !== 'signedReviewReady') throw new Tm1PublicationError('INVALID_STATE')
    const signedReview = this.state.signedReview
    const review = this.state.review
    if (signedId !== signedReview.signedId) throw new Tm1PublicationError('STALE_SIGNED_REVIEW')

    try {
      assertNotAborted(signal)
      this.transition({ status: 'approvingBroadcast', signedReview })
      const decision = await this.dependencies.broadcastAuthorization.requestBroadcastAuthorization(
        freezeSignedReview(signedReview),
        signal
      )
      if (decision.status === 'rejected') {
        this.transition(rejectedState('broadcast', decision.reason))
        throw new Tm1PublicationError('BROADCAST_REJECTED', decision.reason ?? 'BROADCAST_REJECTED')
      }
      if (decision.status === 'expired') {
        this.transition(expiredState('broadcast', decision.reason))
        throw new Tm1PublicationError(
          'BROADCAST_AUTHORIZATION_EXPIRED',
          decision.reason ?? 'BROADCAST_AUTHORIZATION_EXPIRED'
        )
      }

      let auditedArtifact: RegtestSignedTransaction
      try {
        auditedArtifact = await this.dependencies.signedArtifactAudit.auditSignedArtifact({
          review: freezePreparedReview(review),
          signedArtifact: signedReview.signedArtifact
        })
      } catch (error) {
        throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID', 'SIGNED_ARTIFACT_INVALID', error)
      }
      if (
        auditedArtifact.txid !== signedReview.txid ||
        hashBytes(auditedArtifact.rawTransactionBytes) !== signedReview.signedArtifactHash
      ) {
        throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID')
      }
      assertNotAborted(signal)
      this.transition({
        status: 'broadcasting',
        signedReview,
        broadcastAuthorizationId: decision.authorizationId
      })

      let deliveryReceipt: Tm1RegtestDeliveryReceipt
      try {
        deliveryReceipt = await this.dependencies.deliveryTransport.broadcast(
          signedReview.signedArtifact
        )
      } catch (error) {
        throw new Tm1PublicationError('BROADCAST_FAILED', 'BROADCAST_FAILED', error)
      }
      if (deliveryReceipt.txid !== signedReview.txid) {
        throw new Tm1PublicationError('TXID_MISMATCH')
      }
      const receipt = Object.freeze({
        submissionId: this.clock.createId('submission'),
        signedId: signedReview.signedId,
        preparedId: signedReview.preparedId,
        txid: signedReview.txid,
        deliveryReceipt
      })
      this.transition({ status: 'submitted', signedReview, receipt })
      return receipt
    } catch (error) {
      throw this.enterFailureOrAbort(error)
    }
  }

  async confirm(submissionId: string, signal?: AbortSignal): Promise<Tm1Confirmation> {
    if (this.state.status !== 'submitted') throw new Tm1PublicationError('INVALID_STATE')
    const receipt = this.state.receipt
    if (submissionId !== receipt.submissionId) throw new Tm1PublicationError('STALE_SIGNED_REVIEW')

    try {
      assertNotAborted(signal)
      this.transition({ status: 'confirming', receipt })
      const confirmation = await this.dependencies.confirmationObserver.confirm({
        submissionId,
        txid: receipt.txid,
        signal
      })
      if (confirmation.submissionId !== submissionId || confirmation.txid !== receipt.txid) {
        throw new Tm1PublicationError('TXID_MISMATCH')
      }
      this.transition({ status: 'confirmed', receipt, confirmation: freezeConfirmation(confirmation) })
      return freezeConfirmation(confirmation)
    } catch (error) {
      throw this.enterFailureOrAbort(error, 'CONFIRMATION_FAILED')
    }
  }

  reset(): void {
    if (
      this.state.status !== 'idle' &&
      this.state.status !== 'reviewReady' &&
      this.state.status !== 'signedReviewReady' &&
      this.state.status !== 'rejected' &&
      this.state.status !== 'aborted' &&
      this.state.status !== 'expired' &&
      this.state.status !== 'failed' &&
      this.state.status !== 'confirmed'
    ) {
      throw new Tm1PublicationError('INVALID_STATE')
    }
    this.transition({ status: 'idle' })
  }

  private transition(state: Tm1PublicationState): void {
    this.state = cloneState(state)
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }

  private enterFailureOrAbort(
    error: unknown,
    defaultCode: Tm1PublicationErrorCode = 'INVALID_STATE'
  ): Tm1PublicationError {
    const stage = toNonTerminalStatus(this.state.status)
    if (isAbortError(error)) {
      const publicationError = new Tm1PublicationError('ABORTED', 'ABORTED', error)
      this.transition({ status: 'aborted', stage })
      return publicationError
    }
    if (error instanceof Tm1PublicationError && isNonFailureDomainError(error.code)) {
      return error
    }
    const code = mapUnknownFailure(error, defaultCode)
    if (code === 'ABORTED') {
      const publicationError = new Tm1PublicationError('ABORTED', 'ABORTED', error)
      this.transition({ status: 'aborted', stage })
      return publicationError
    }
    const publicationError = new Tm1PublicationError(code, code, error)
    this.transition({ status: 'failed', stage, error: publicationError })
    return publicationError
  }
}

function rejectedState(
  stage: 'signing' | 'broadcast',
  reason: string | undefined
): Tm1PublicationState {
  return reason === undefined
    ? Object.freeze({ status: 'rejected', stage })
    : Object.freeze({ status: 'rejected', stage, reason })
}

function expiredState(
  stage: 'signing' | 'broadcast',
  reason: string | undefined
): Tm1PublicationState {
  return reason === undefined
    ? Object.freeze({ status: 'expired', stage })
    : Object.freeze({ status: 'expired', stage, reason })
}

function assertCandidateStillValid(
  review: Tm1PreparedReview,
  freshUtxos: readonly Tm1Draft02FreshUtxo[]
): void {
  try {
    revalidateTm1Draft02Candidate(review.candidate, freshUtxos)
  } catch (error) {
    throw new Tm1PublicationError('CANDIDATE_REVALIDATION_FAILED', 'CANDIDATE_REVALIDATION_FAILED', error)
  }
}

function assertBindingUnchanged(review: Tm1PreparedReview): void {
  if (hashBytes(encodeTm1Draft02CandidateEffectiveContent(review.candidate)) !== review.bindingHash) {
    throw new Tm1PublicationError('CANDIDATE_REVALIDATION_FAILED')
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Tm1PublicationError && error.code === 'ABORTED'
}

function isAbortLike(error: unknown): boolean {
  return isAbortError(error) ||
    (error instanceof Error && 'code' in error && error.code === 'OPERATION_ABORTED')
}

function isNonFailureDomainError(code: Tm1PublicationErrorCode): boolean {
  return code === 'INVALID_STATE' ||
    code === 'PUBLICATION_ALREADY_ACTIVE' ||
    code === 'STALE_PREPARED_REVIEW' ||
    code === 'STALE_SIGNED_REVIEW' ||
    code === 'SIGNING_REJECTED' ||
    code === 'SIGNING_AUTHORIZATION_EXPIRED' ||
    code === 'BROADCAST_REJECTED' ||
    code === 'BROADCAST_AUTHORIZATION_EXPIRED'
}

function mapUnknownFailure(error: unknown, defaultCode: Tm1PublicationErrorCode): Tm1PublicationErrorCode {
  if (error instanceof Tm1PublicationError) return error.code
  if (error instanceof Error && 'code' in error && error.code === 'OPERATION_ABORTED') {
    return 'ABORTED'
  }
  if (defaultCode === 'CONFIRMATION_FAILED') return 'CONFIRMATION_FAILED'
  return defaultCode
}

function toNonTerminalStatus(status: Tm1PublicationState['status']): Tm1PublicationNonTerminalStatus {
  if (
    status === 'idle' ||
    status === 'rejected' ||
    status === 'aborted' ||
    status === 'expired' ||
    status === 'failed' ||
    status === 'confirmed'
  ) {
    return 'reviewReady'
  }
  return status
}

function cloneState(state: Tm1PublicationState): Tm1PublicationState {
  switch (state.status) {
    case 'idle':
      return Object.freeze({ status: 'idle' })
    case 'attesting':
      return Object.freeze({ status: 'attesting', message: state.message })
    case 'preparing':
      return Object.freeze({
        status: 'preparing',
        message: state.message,
        network: freezeNetwork(state.network)
      })
    case 'reviewReady':
      return Object.freeze({ status: 'reviewReady', review: freezePreparedReview(state.review) })
    case 'authorizing':
      return Object.freeze({ status: 'authorizing', review: freezePreparedReview(state.review) })
    case 'revalidating':
      return Object.freeze({
        status: 'revalidating',
        review: freezePreparedReview(state.review),
        signingAuthorizationId: state.signingAuthorizationId
      })
    case 'signing':
      return Object.freeze({
        status: 'signing',
        review: freezePreparedReview(state.review),
        signingAuthorizationId: state.signingAuthorizationId
      })
    case 'signedReviewReady':
      return Object.freeze({
        status: 'signedReviewReady',
        review: freezePreparedReview(state.review),
        signedReview: freezeSignedReview(state.signedReview)
      })
    case 'approvingBroadcast':
      return Object.freeze({ status: 'approvingBroadcast', signedReview: freezeSignedReview(state.signedReview) })
    case 'broadcasting':
      return Object.freeze({
        status: 'broadcasting',
        signedReview: freezeSignedReview(state.signedReview),
        broadcastAuthorizationId: state.broadcastAuthorizationId
      })
    case 'submitted':
      return Object.freeze({
        status: 'submitted',
        signedReview: freezeSignedReview(state.signedReview),
        receipt: freezeReceipt(state.receipt)
      })
    case 'confirming':
      return Object.freeze({ status: 'confirming', receipt: freezeReceipt(state.receipt) })
    case 'confirmed':
      return Object.freeze({
        status: 'confirmed',
        receipt: freezeReceipt(state.receipt),
        confirmation: freezeConfirmation(state.confirmation)
      })
    case 'rejected':
      return Object.freeze({ status: 'rejected', stage: state.stage, reason: state.reason })
    case 'aborted':
      return Object.freeze({ status: 'aborted', stage: state.stage })
    case 'expired':
      return Object.freeze({ status: 'expired', stage: state.stage, reason: state.reason })
    case 'failed':
      return Object.freeze({ status: 'failed', stage: state.stage, error: state.error })
  }
}

function freezePreparedReview(review: Tm1PreparedReview): Tm1PreparedReview {
  return Object.freeze({
    preparedId: review.preparedId,
    message: review.message,
    network: freezeNetwork(review.network),
    candidate: review.candidate,
    effectiveContent: new Uint8Array(review.effectiveContent),
    bindingHash: review.bindingHash,
    orderedInputs: Object.freeze(review.orderedInputs.map(input => Object.freeze({ ...input }))),
    orderedOutputs: Object.freeze(review.orderedOutputs.map(output => Object.freeze({ ...output }))),
    feeSats: review.feeSats
  })
}

function freezeSignedReview(review: Tm1SignedReview): Tm1SignedReview {
  return Object.freeze({
    preparedId: review.preparedId,
    signedId: review.signedId,
    txid: review.txid,
    signedArtifactHash: review.signedArtifactHash,
    signedArtifact: freezeSignedArtifact(review.signedArtifact),
    feeSats: review.feeSats,
    orderedOutputs: Object.freeze(review.orderedOutputs.map(output => Object.freeze({ ...output }))),
    bindingHash: review.bindingHash,
    signingAuthorizationId: review.signingAuthorizationId
  })
}

function freezeSignedArtifact(artifact: RegtestSignedTransaction): RegtestSignedTransaction {
  return Object.freeze({
    ...artifact,
    rawTransactionBytes: new Uint8Array(artifact.rawTransactionBytes)
  })
}

function freezeReceipt(receipt: Tm1SubmissionReceipt): Tm1SubmissionReceipt {
  return Object.freeze({
    submissionId: receipt.submissionId,
    signedId: receipt.signedId,
    preparedId: receipt.preparedId,
    txid: receipt.txid,
    deliveryReceipt: Object.freeze({ ...receipt.deliveryReceipt })
  })
}

function freezeConfirmation(confirmation: Tm1Confirmation): Tm1Confirmation {
  return Object.freeze({ ...confirmation })
}

function freezeNetwork(network: Tm1RegtestNetworkAttestation): Tm1RegtestNetworkAttestation {
  return Object.freeze({ ...network })
}

function hashBytes(bytes: Uint8Array): string {
  return toHex(sha256d(bytes))
}

function monotonicClock(): Tm1PublicationClock {
  let counter = 0
  return Object.freeze({
    createId: (prefix) => {
      counter += 1
      return `tm1-regtest:${prefix}:${counter}`
    }
  })
}
