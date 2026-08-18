import { Tx, sha256d, toHex } from 'ecash-lib'
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
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX,
  TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION,
  TM1_REGTEST_SIGNED_TRANSACTION_FORMAT,
  auditTm1Draft02RegtestSignedTransaction,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
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
  | 'STALE_SUBMISSION'
  | 'PREPARATION_FAILED'
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
    this.cause = cloneErrorCause(cause)
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

export type Tm1BroadcastAuthorizationDecision = Readonly<
  | {
    status: 'approved'
    authorizationId: string
    signedId: string
    txid: string
    signedArtifactHash: string
  }
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

export type Tm1BroadcastUncertainty = Readonly<{
  submissionId: string
  preparedId: string
  signedId: string
  txid: string
  signedArtifact: RegtestSignedTransaction
  signedArtifactHash: string
  broadcastAuthorizationId: string
  error: Tm1PublicationError
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
  | Readonly<{ status: 'broadcastUncertain'; signedReview: Tm1SignedReview; uncertainty: Tm1BroadcastUncertainty }>
  | Readonly<{ status: 'submitted'; signedReview: Tm1SignedReview; receipt: Tm1SubmissionReceipt }>
  | Readonly<{ status: 'confirming'; receipt: Tm1SubmissionReceipt }>
  | Readonly<{ status: 'reconciling'; signedReview: Tm1SignedReview; uncertainty: Tm1BroadcastUncertainty }>
  | Readonly<{ status: 'confirmed'; receipt: Tm1SubmissionReceipt; confirmation: Tm1Confirmation }>
  | Readonly<{ status: 'rejected'; stage: 'signing' | 'broadcast'; reason?: string }>
  | Readonly<{ status: 'aborted'; stage: Tm1PublicationNonTerminalStatus }>
  | Readonly<{ status: 'expired'; stage: 'signing' | 'broadcast'; reason?: string }>
  | Readonly<{ status: 'failed'; stage: Tm1PublicationNonTerminalStatus; error: Tm1PublicationError }>

export type Tm1PublicationNonTerminalStatus = Exclude<
  Tm1PublicationState['status'],
  'rejected' | 'aborted' | 'expired' | 'failed' | 'confirmed'
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

type Tm1RegtestPublicationDependencyBindings = Readonly<
  Required<Tm1RegtestPublicationDependencies>
>

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
    signal?: AbortSignal
  }>): Promise<RegtestSignedTransaction>
}

export interface Tm1BroadcastAuthorizationPort {
  requestBroadcastAuthorization(
    signedReview: Tm1SignedReview,
    signal?: AbortSignal
  ): Promise<Tm1BroadcastAuthorizationDecision>
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

type Tm1ActivePublicationOperation =
  | 'prepare'
  | 'authorizeAndSign'
  | 'approveAndBroadcast'
  | 'confirm'
  | 'reconcile'
  | 'reset'
  | null

export interface Tm1RegtestPublicationOrchestrator {
  getState(): Tm1PublicationState
  subscribe(listener: (state: Tm1PublicationState) => void): () => void
  prepare(request: Tm1PublicationRequest, signal?: AbortSignal): Promise<Tm1PreparedReview>
  authorizeAndSign(preparedId: string, signal?: AbortSignal): Promise<Tm1SignedReview>
  approveAndBroadcast(signedId: string, signal?: AbortSignal): Promise<Tm1SubmissionReceipt>
  reconcile(signal?: AbortSignal): Promise<Tm1Confirmation>
  confirm(submissionId: string, signal?: AbortSignal): Promise<Tm1Confirmation>
  reset(): void
}

export class Tm1RegtestPublicationOrchestratorImpl
implements Tm1RegtestPublicationOrchestrator {
  private readonly dependencies: Tm1RegtestPublicationDependencyBindings
  private readonly clock: Tm1PublicationClock
  private readonly listeners = new Set<(state: Tm1PublicationState) => void>()
  private state: Tm1PublicationState = Object.freeze({ status: 'idle' })
  private activeOperation: Tm1ActivePublicationOperation = null

  constructor(dependencies: Tm1RegtestPublicationDependencies) {
    const clock = dependencies.clock ?? monotonicClock()
    this.dependencies = Object.freeze({
      networkAttestation: dependencies.networkAttestation,
      utxoProvider: dependencies.utxoProvider,
      signingAuthorization: dependencies.signingAuthorization,
      signer: dependencies.signer,
      signedArtifactAudit: dependencies.signedArtifactAudit,
      broadcastAuthorization: dependencies.broadcastAuthorization,
      deliveryTransport: dependencies.deliveryTransport,
      confirmationObserver: dependencies.confirmationObserver,
      clock
    })
    this.clock = clock
  }

  getState(): Tm1PublicationState {
    return cloneState(this.state)
  }

  subscribe(listener: (state: Tm1PublicationState) => void): () => void {
    this.listeners.add(listener)
    this.notifyListener(listener, this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  async prepare(
    request: Tm1PublicationRequest,
    signal?: AbortSignal
  ): Promise<Tm1PreparedReview> {
    this.beginOperation('prepare')

    try {
      if (this.state.status !== 'idle') throw new Tm1PublicationError('INVALID_STATE')
      const requestSnapshot = freezePublicationRequest(request)
      assertNotAborted(signal)
      this.transition({ status: 'attesting', message: requestSnapshot.message })
      assertNotAborted(signal)
      let attestationResult: unknown
      try {
        attestationResult = await this.dependencies.networkAttestation.attest(signal)
      } catch (externalError) {
        throw trapSafePublicationError(
          isAbortLike(externalError) ? 'ABORTED' : 'PREPARATION_FAILED',
          externalError
        )
      }
      assertNotAborted(signal)
      const network = snapshotNetworkAttestation(attestationResult)
      this.transition({ status: 'preparing', message: requestSnapshot.message, network })
      assertNotAborted(signal)

      let utxos: readonly Tm1Draft02FreshUtxo[]
      try {
        utxos = await this.dependencies.utxoProvider.readUtxos(signal)
      } catch (externalError) {
        throw trapSafePublicationError(
          isAbortLike(externalError) ? 'ABORTED' : 'PREPARATION_FAILED',
          externalError
        )
      }
      assertNotAborted(signal)
      const preview = encodeTm1Draft02Post({
        eventData: requestSnapshot.message,
        authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
      })
      const plan = planTm1Draft02Post({
        preview,
        utxos,
        activeLockingScriptHex: requestSnapshot.activeLockingScriptHex
      })
      const candidate = createTm1Draft02Candidate({
        environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
        transactionVersion: TM1_DRAFT_02_TX_VERSION,
        locktime: TM1_DRAFT_02_LOCKTIME,
        authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
        authorLockingScriptHex: requestSnapshot.activeLockingScriptHex,
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
        maxFeeSats: requestSnapshot.maxFeeSats ?? DEFAULT_MAX_FEE_SATS,
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
      throw this.enterFailureOrAbort(error, 'PREPARATION_FAILED')
    } finally {
      this.endOperation('prepare')
    }
  }

  async authorizeAndSign(
    preparedId: string,
    signal?: AbortSignal
  ): Promise<Tm1SignedReview> {
    this.beginOperation('authorizeAndSign')

    try {
      if (this.state.status !== 'reviewReady') throw new Tm1PublicationError('INVALID_STATE')
      const review = this.state.review
      if (preparedId !== review.preparedId) throw new Tm1PublicationError('STALE_PREPARED_REVIEW')

      assertNotAborted(signal)
      this.transition({ status: 'authorizing', review })
      assertNotAborted(signal)
      let decision: Tm1PublicationAuthorizationDecision
      try {
        const authorizationResult = await this.dependencies.signingAuthorization.requestSigningAuthorization(
          freezePreparedReview(review),
          signal
        )
        assertNotAborted(signal)
        decision = snapshotSigningAuthorizationDecision(authorizationResult)
      } catch (error) {
        if (isAbortLike(error)) throw error
        throw new Tm1PublicationError('SIGNING_FAILED', 'SIGNING_FAILED', error)
      }
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

      const signingAuthorizationId = decision.authorizationId

      assertNotAborted(signal)
      this.transition({
        status: 'revalidating',
        review,
        signingAuthorizationId
      })
      assertNotAborted(signal)
      let attestationResult: unknown
      try {
        attestationResult = await this.dependencies.networkAttestation.attest(signal)
      } catch (error) {
        throw trapSafePublicationError(
          isAbortLike(error) ? 'ABORTED' : 'CANDIDATE_REVALIDATION_FAILED',
          error
        )
      }
      assertNotAborted(signal)
      let freshNetwork: Tm1RegtestNetworkAttestation
      try {
        freshNetwork = snapshotNetworkAttestation(attestationResult)
      } catch (validationError) {
        throw trapSafePublicationError(
          'CANDIDATE_REVALIDATION_FAILED',
          validationError
        )
      }
      if (
        freshNetwork.environment !== review.network.environment ||
        freshNetwork.chainIdentity !== review.network.chainIdentity
      ) {
        throw new Tm1PublicationError('CANDIDATE_REVALIDATION_FAILED')
      }
      let freshUtxos: readonly Tm1Draft02FreshUtxo[]
      try {
        freshUtxos = await this.dependencies.utxoProvider.readUtxos(signal)
      } catch (error) {
        throw trapSafePublicationError(
          isAbortLike(error) ? 'ABORTED' : 'CANDIDATE_REVALIDATION_FAILED',
          error
        )
      }
      assertNotAborted(signal)
      assertCandidateStillValid(review, freshUtxos)
      assertBindingUnchanged(review)
      assertNotAborted(signal)

      this.transition({
        status: 'signing',
        review,
        signingAuthorizationId
      })
      assertNotAborted(signal)
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
      assertNotAborted(signal)
      const audited = await auditSignedArtifact({
        auditPort: this.dependencies.signedArtifactAudit,
        review,
        signedArtifact,
        signal
      })
      const signedReview = freezeSignedReview({
        preparedId: review.preparedId,
        signedId: this.clock.createId('signed'),
        txid: audited.artifact.txid,
        signedArtifactHash: audited.artifactHash,
        signedArtifact: audited.artifact,
        feeSats: review.feeSats,
        orderedOutputs: review.orderedOutputs,
        bindingHash: review.bindingHash,
        signingAuthorizationId
      })

      this.transition({ status: 'signedReviewReady', review, signedReview })
      return freezeSignedReview(signedReview)
    } catch (error) {
      throw this.enterFailureOrAbort(error)
    } finally {
      this.endOperation('authorizeAndSign')
    }
  }

  async approveAndBroadcast(
    signedId: string,
    signal?: AbortSignal
  ): Promise<Tm1SubmissionReceipt> {
    this.beginOperation('approveAndBroadcast')

    try {
      if (this.state.status !== 'signedReviewReady') throw new Tm1PublicationError('INVALID_STATE')
      const signedReview = this.state.signedReview
      const review = this.state.review
      if (signedId !== signedReview.signedId) throw new Tm1PublicationError('STALE_SIGNED_REVIEW')

      assertNotAborted(signal)
      this.transition({ status: 'approvingBroadcast', signedReview })
      assertNotAborted(signal)
      let decision: Tm1BroadcastAuthorizationDecision
      try {
        const authorizationResult = await this.dependencies.broadcastAuthorization.requestBroadcastAuthorization(
          freezeSignedReview(signedReview),
          signal
        )
        assertNotAborted(signal)
        decision = snapshotBroadcastAuthorizationDecision(authorizationResult)
      } catch (error) {
        if (isAbortLike(error)) throw error
        throw new Tm1PublicationError('BROADCAST_FAILED', 'BROADCAST_FAILED', error)
      }
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
      if (!isBroadcastAuthorizationBound(decision, signedReview)) {
        this.transition(rejectedState('broadcast', 'BROADCAST_REJECTED'))
        throw new Tm1PublicationError('BROADCAST_REJECTED', 'BROADCAST_REJECTED')
      }
      const broadcastAuthorizationId = decision.authorizationId

      await auditSignedArtifact({
        auditPort: this.dependencies.signedArtifactAudit,
        review,
        signedArtifact: cloneSignedArtifact(signedReview.signedArtifact),
        signal,
        expectedTxid: signedReview.txid,
        expectedArtifactHash: signedReview.signedArtifactHash
      })
      const submissionId = this.clock.createId('submission')
      this.transition({
        status: 'broadcasting',
        signedReview,
        broadcastAuthorizationId
      })
      assertNotAborted(signal)
      const transportArtifact = cloneSignedArtifact(signedReview.signedArtifact)

      try {
        const deliveryReceiptResult = await this.dependencies.deliveryTransport.broadcast(
          transportArtifact
        )
        const deliveryReceipt = snapshotValidatedDeliveryReceipt(
          deliveryReceiptResult,
          signedReview.txid
        )
        const receipt = freezeReceipt({
          submissionId,
          signedId: signedReview.signedId,
          preparedId: signedReview.preparedId,
          txid: signedReview.txid,
          deliveryReceipt
        })
        this.transition({ status: 'submitted', signedReview, receipt })
        return receipt
      } catch (error) {
        // Dispatch may already have happened. Persist reconciliation evidence before
        // inspecting an arbitrary rejection value, including a hostile Proxy.
        const fallbackError = new Tm1PublicationError('BROADCAST_FAILED')
        this.transition({
          status: 'broadcastUncertain',
          signedReview,
          uncertainty: freezeUncertainty({
            submissionId,
            preparedId: signedReview.preparedId,
            signedId: signedReview.signedId,
            txid: signedReview.txid,
            signedArtifact: signedReview.signedArtifact,
            signedArtifactHash: signedReview.signedArtifactHash,
            broadcastAuthorizationId,
            error: fallbackError
          })
        })

        const publicationError = safeBroadcastRejectionDiagnostic(error, fallbackError)
        this.tryEnrichBroadcastUncertainty(publicationError, fallbackError)
        throw publicationError
      }
    } catch (error) {
      throw this.enterFailureOrAbort(error)
    } finally {
      this.endOperation('approveAndBroadcast')
    }
  }

  async reconcile(signal?: AbortSignal): Promise<Tm1Confirmation> {
    this.beginOperation('reconcile')

    try {
      if (this.state.status !== 'broadcastUncertain') throw new Tm1PublicationError('INVALID_STATE')
      const signedReview = this.state.signedReview
      const uncertainty = this.state.uncertainty

      assertNotAborted(signal)
      this.transition({ status: 'reconciling', signedReview, uncertainty })
      assertNotAborted(signal)
      const confirmationResult: unknown = await this.dependencies.confirmationObserver.confirm({
        submissionId: uncertainty.submissionId,
        txid: uncertainty.txid,
        signal
      })
      assertNotAborted(signal)
      const confirmation = snapshotValidatedConfirmation(
        confirmationResult,
        uncertainty.submissionId,
        uncertainty.txid
      )
      const receipt = freezeReceipt({
        submissionId: uncertainty.submissionId,
        signedId: uncertainty.signedId,
        preparedId: uncertainty.preparedId,
        txid: uncertainty.txid,
        deliveryReceipt: Object.freeze({ txid: uncertainty.txid, disposition: 'accepted' as const })
      })
      this.transition({ status: 'confirmed', receipt, confirmation })
      return confirmation
    } catch (error) {
      const state = this.state
      if (state.status !== 'reconciling') {
        throw this.enterFailureOrAbort(error, 'CONFIRMATION_FAILED')
      }
      const signedReview = state.signedReview
      const uncertainty = state.uncertainty
      this.transition({ status: 'broadcastUncertain', signedReview, uncertainty })
      if (isAbortLike(error)) {
        throw trapSafePublicationError('ABORTED', error)
      }
      if (safeOwnDataStringProperty(error, 'code') === 'TXID_MISMATCH') {
        throw trapSafePublicationError('TXID_MISMATCH', error)
      }
      throw trapSafePublicationError('CONFIRMATION_FAILED', error)
    } finally {
      this.endOperation('reconcile')
    }
  }

  async confirm(submissionId: string, signal?: AbortSignal): Promise<Tm1Confirmation> {
    this.beginOperation('confirm')
    let submittedSnapshot: Extract<Tm1PublicationState, { status: 'submitted' }> | null = null

    try {
      if (this.state.status !== 'submitted') throw new Tm1PublicationError('INVALID_STATE')
      submittedSnapshot = this.state
      const receipt = submittedSnapshot.receipt
      if (submissionId !== receipt.submissionId) throw new Tm1PublicationError('STALE_SUBMISSION')

      assertNotAborted(signal)
      this.transition({ status: 'confirming', receipt })
      assertNotAborted(signal)
      const confirmationResult: unknown = await this.dependencies.confirmationObserver.confirm({
        submissionId,
        txid: receipt.txid,
        signal
      })
      assertNotAborted(signal)
      const confirmation = snapshotValidatedConfirmation(
        confirmationResult,
        submissionId,
        receipt.txid
      )
      this.transition({ status: 'confirmed', receipt, confirmation })
      return confirmation
    } catch (error) {
      const state = this.state
      if (state.status !== 'confirming') {
        if (submittedSnapshot !== null && isAbortLike(error)) {
          this.transition({
            status: 'submitted',
            signedReview: submittedSnapshot.signedReview,
            receipt: submittedSnapshot.receipt
          })
          throw new Tm1PublicationError('ABORTED', 'ABORTED', error)
        }
        throw this.enterFailureOrAbort(error, 'CONFIRMATION_FAILED')
      }
      if (submittedSnapshot === null) {
        throw this.enterFailureOrAbort(error, 'CONFIRMATION_FAILED')
      }
      const receipt = state.receipt
      this.transition({
        status: 'submitted',
        signedReview: submittedSnapshot.signedReview,
        receipt
      })
      if (isAbortLike(error)) {
        throw trapSafePublicationError('ABORTED', error)
      }
      if (safeOwnDataStringProperty(error, 'code') === 'TXID_MISMATCH') {
        throw trapSafePublicationError('TXID_MISMATCH', error)
      }
      throw trapSafePublicationError('CONFIRMATION_FAILED', error)
    } finally {
      this.endOperation('confirm')
    }
  }

  reset(): void {
    this.beginOperation('reset')

    try {
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
    } finally {
      this.endOperation('reset')
    }
  }

  private beginOperation(operation: Exclude<Tm1ActivePublicationOperation, null>): void {
    if (this.activeOperation !== null) {
      throw new Tm1PublicationError(
        operation === 'prepare' ? 'PUBLICATION_ALREADY_ACTIVE' : 'INVALID_STATE'
      )
    }
    this.activeOperation = operation
  }

  private endOperation(operation: Exclude<Tm1ActivePublicationOperation, null>): void {
    if (this.activeOperation === operation) this.activeOperation = null
  }

  private transition(state: Tm1PublicationState): void {
    this.state = cloneState(state)
    // Subscriber failures are isolated from state transitions and later listeners.
    const listenersSnapshot = [...this.listeners]
    for (const listener of listenersSnapshot) this.notifyListener(listener, this.getState())
  }

  private notifyListener(
    listener: (state: Tm1PublicationState) => void,
    snapshot: Tm1PublicationState
  ): void {
    try {
      listener(snapshot)
    } catch {
      // No logger port exists in this isolated runtime; listener failures are intentionally ignored.
    }
  }

  private enterFailureOrAbort(
    error: unknown,
    defaultCode: Tm1PublicationErrorCode = 'INVALID_STATE'
  ): Tm1PublicationError {
    const stage = toNonTerminalStatus(this.state.status)
    if (this.state.status === 'broadcastUncertain') {
      // Irreversible uncertainty is monotonic. Even a secondary hostile value
      // cannot move this state back to an ordinary failure.
      return safeBroadcastRejectionDiagnostic(error)
    }
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

  private tryEnrichBroadcastUncertainty(
    publicationError: Tm1PublicationError,
    fallbackError: Tm1PublicationError
  ): void {
    if (publicationError === fallbackError || this.state.status !== 'broadcastUncertain') return

    try {
      const state = this.state
      // Diagnostic enrichment is not a lifecycle transition. The safe uncertainty
      // was already stored and published before the rejection was inspected.
      this.state = cloneState({
        status: 'broadcastUncertain',
        signedReview: state.signedReview,
        uncertainty: {
          ...state.uncertainty,
          error: publicationError
        }
      })
    } catch {
      // Keep the already-persisted fallback evidence intact.
    }
  }
}

type Tm1AuditedArtifactEvidence = Readonly<{
  artifact: RegtestSignedTransaction
  artifactHash: string
}>

async function auditSignedArtifact(input: Readonly<{
  auditPort: Tm1SignedArtifactAuditPort
  review: Tm1PreparedReview
  signedArtifact: RegtestSignedTransaction
  signal?: AbortSignal
  expectedTxid?: string
  expectedArtifactHash?: string
}>): Promise<Tm1AuditedArtifactEvidence> {
  let auditResult: unknown
  try {
    assertNotAborted(input.signal)
    auditResult = await input.auditPort.auditSignedArtifact({
      review: freezePreparedReview(input.review),
      signedArtifact: input.signedArtifact,
      signal: input.signal
    })
    assertNotAborted(input.signal)
  } catch (externalAuditError) {
    if (isAbortLike(externalAuditError)) {
      throw trapSafePublicationError('ABORTED', externalAuditError)
    }
    throw trapSafePublicationError('SIGNED_ARTIFACT_INVALID', externalAuditError)
  }

  try {
    const { artifact, transaction } = snapshotValidatedSignedArtifact(auditResult)
    auditTm1Draft02RegtestSignedTransaction({
      candidate: input.review.candidate,
      signedTransaction: transaction
    })
    const artifactHash = hashBytes(artifact.rawTransactionBytes)
    if (
      artifact.inputCount !== input.review.orderedInputs.length ||
      artifact.feeSats !== input.review.feeSats ||
      artifact.fixtureLockingScriptHex !== input.review.candidate.authorLockingScriptHex ||
      (input.expectedTxid !== undefined && artifact.txid !== input.expectedTxid) ||
      (input.expectedArtifactHash !== undefined && artifactHash !== input.expectedArtifactHash)
    ) {
      throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID')
    }

    return Object.freeze({ artifact, artifactHash })
  } catch (validationError) {
    throw trapSafePublicationError('SIGNED_ARTIFACT_INVALID', validationError)
  }
}

function snapshotSigningAuthorizationDecision(value: unknown): Tm1PublicationAuthorizationDecision {
  const status = readRequiredOwnDataProperty(value, 'status')
  if (status === 'approved') {
    return Object.freeze({
      status,
      authorizationId: readRequiredNonEmptyString(value, 'authorizationId')
    })
  }
  if (status === 'rejected' || status === 'expired') {
    const reason = readOptionalString(value, 'reason')
    return reason === undefined
      ? Object.freeze({ status })
      : Object.freeze({ status, reason })
  }
  throw new Error('Invalid signing authorization decision')
}

function snapshotBroadcastAuthorizationDecision(value: unknown): Tm1BroadcastAuthorizationDecision {
  const status = readRequiredOwnDataProperty(value, 'status')
  if (status === 'approved') {
    return Object.freeze({
      status,
      authorizationId: readRequiredNonEmptyString(value, 'authorizationId'),
      signedId: readRequiredNonEmptyString(value, 'signedId'),
      txid: readRequiredNonEmptyString(value, 'txid'),
      signedArtifactHash: readRequiredNonEmptyString(value, 'signedArtifactHash')
    })
  }
  if (status === 'rejected' || status === 'expired') {
    const reason = readOptionalString(value, 'reason')
    return reason === undefined
      ? Object.freeze({ status })
      : Object.freeze({ status, reason })
  }
  throw new Error('Invalid broadcast authorization decision')
}

function readRequiredOwnDataProperty(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid external object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Error(`Missing data property: ${String(key)}`)
  }
  return descriptor.value
}

function readRequiredNonEmptyString(value: unknown, key: PropertyKey): string {
  const property = readRequiredOwnDataProperty(value, key)
  if (typeof property !== 'string' || property.trim().length === 0) {
    throw new Error(`Invalid string property: ${String(key)}`)
  }
  return property
}

function readOptionalString(value: unknown, key: PropertyKey): string | undefined {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid external object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) {
    throw new Error(`Invalid optional string property: ${String(key)}`)
  }
  return descriptor.value
}

function readOptionalNumber(value: unknown, key: PropertyKey): number | undefined {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid external object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'number')) {
    throw new Error(`Invalid optional number property: ${String(key)}`)
  }
  return descriptor.value
}

function snapshotNetworkAttestation(value: unknown): Tm1RegtestNetworkAttestation {
  const environment = readRequiredOwnDataProperty(value, 'environment')
  const chainIdentity = readRequiredOwnDataProperty(value, 'chainIdentity')
  if (
    environment !== TM1_DRAFT_02_CANDIDATE_ENVIRONMENT ||
    typeof chainIdentity !== 'string' ||
    chainIdentity.length === 0 ||
    chainIdentity.trim() !== chainIdentity
  ) {
    throw new Error('Invalid regtest network attestation')
  }
  return Object.freeze({ environment, chainIdentity })
}

function snapshotValidatedDeliveryReceipt(
  value: unknown,
  expectedTxid: string
): Tm1RegtestDeliveryReceipt {
  if (value === null || typeof value !== 'object') {
    throw new Tm1PublicationError('BROADCAST_FAILED')
  }
  // Snapshot the current receipt shape while still inside the post-dispatch
  // uncertainty boundary. Any hostile accessor therefore preserves evidence.
  const snapshot = Object.freeze({ ...value }) as Record<PropertyKey, unknown>
  const txid = snapshot.txid
  const disposition = snapshot.disposition
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) {
    throw new Tm1PublicationError('BROADCAST_FAILED')
  }
  if (txid !== expectedTxid) throw new Tm1PublicationError('TXID_MISMATCH')
  if (disposition !== 'accepted') throw new Tm1PublicationError('BROADCAST_FAILED')
  return Object.freeze({ txid, disposition })
}

function snapshotValidatedConfirmation(
  value: unknown,
  expectedSubmissionId: string,
  expectedTxid: string
): Tm1Confirmation {
  const submissionId = readRequiredNonEmptyString(value, 'submissionId')
  const txid = readRequiredNonEmptyString(value, 'txid')
  const confirmations = readRequiredOwnDataProperty(value, 'confirmations')
  const blockHash = readOptionalString(value, 'blockHash')
  const blockHeight = readOptionalNumber(value, 'blockHeight')

  if (submissionId !== expectedSubmissionId || txid !== expectedTxid) {
    throw new Tm1PublicationError('TXID_MISMATCH')
  }
  if (typeof confirmations !== 'number' || !Number.isSafeInteger(confirmations) || confirmations <= 0) {
    throw new Tm1PublicationError(
      'CONFIRMATION_FAILED',
      'CONFIRMATION_FAILED: confirmations must be a positive safe integer'
    )
  }
  if (blockHash !== undefined && blockHash.length === 0) {
    throw new Tm1PublicationError('CONFIRMATION_FAILED')
  }
  if (
    blockHeight !== undefined &&
    (!Number.isSafeInteger(blockHeight) || blockHeight < 0)
  ) {
    throw new Tm1PublicationError('CONFIRMATION_FAILED')
  }

  return Object.freeze({
    submissionId,
    txid,
    confirmations,
    ...(blockHash === undefined ? {} : { blockHash }),
    ...(blockHeight === undefined ? {} : { blockHeight })
  })
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

function freezePublicationRequest(request: Tm1PublicationRequest): Tm1PublicationRequest {
  return Object.freeze({
    message: request.message,
    activeLockingScriptHex: request.activeLockingScriptHex,
    maxFeeSats: request.maxFeeSats
  })
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

function isBroadcastAuthorizationBound(
  decision: Extract<Tm1BroadcastAuthorizationDecision, { status: 'approved' }>,
  signedReview: Tm1SignedReview
): boolean {
  return decision.signedId === signedReview.signedId &&
    decision.txid === signedReview.txid &&
    decision.signedArtifactHash === signedReview.signedArtifactHash
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
}

const nativeDomExceptionNameGetter = (() => {
  try {
    if (typeof DOMException === 'undefined') return undefined
    return Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get
  } catch {
    return undefined
  }
})()

function isNativeDomExceptionAbort(error: unknown): boolean {
  if (
    nativeDomExceptionNameGetter === undefined ||
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function')
  ) {
    return false
  }

  try {
    return nativeDomExceptionNameGetter.call(error) === 'AbortError'
  } catch {
    // The trusted built-in getter brand-checks without invoking external traps.
    return false
  }
}

function isAbortError(error: unknown): boolean {
  return isNativeDomExceptionAbort(error) ||
    safeOwnDataStringProperty(error, 'code') === 'ABORTED' ||
    safeOwnDataStringProperty(error, 'name') === 'AbortError'
}

function isAbortLike(error: unknown): boolean {
  return isAbortError(error) ||
    safeOwnDataStringProperty(error, 'code') === 'OPERATION_ABORTED'
}

function safeBroadcastRejectionDiagnostic(
  rejection: unknown,
  fallback: Tm1PublicationError = new Tm1PublicationError('BROADCAST_FAILED')
): Tm1PublicationError {
  try {
    if (typeof rejection === 'function') {
      return new Tm1PublicationError('BROADCAST_FAILED', 'BROADCAST_FAILED', rejection)
    }
    if (rejection instanceof Tm1PublicationError) return clonePublicationError(rejection)
    if (rejection === null || typeof rejection !== 'object') {
      return fallback
    }
    return new Tm1PublicationError('BROADCAST_FAILED', 'BROADCAST_FAILED', rejection)
  } catch {
    return fallback
  }
}

function isNonFailureDomainError(code: Tm1PublicationErrorCode): boolean {
  return code === 'INVALID_STATE' ||
    code === 'PUBLICATION_ALREADY_ACTIVE' ||
    code === 'STALE_PREPARED_REVIEW' ||
    code === 'STALE_SIGNED_REVIEW' ||
    code === 'STALE_SUBMISSION' ||
    code === 'SIGNING_REJECTED' ||
    code === 'SIGNING_AUTHORIZATION_EXPIRED' ||
    code === 'BROADCAST_REJECTED' ||
    code === 'BROADCAST_AUTHORIZATION_EXPIRED'
}

function mapUnknownFailure(error: unknown, defaultCode: Tm1PublicationErrorCode): Tm1PublicationErrorCode {
  if (error instanceof Tm1PublicationError) return error.code
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED'
  if (error instanceof Error && 'code' in error && error.code === 'OPERATION_ABORTED') {
    return 'ABORTED'
  }
  if (defaultCode === 'CONFIRMATION_FAILED') return 'CONFIRMATION_FAILED'
  return defaultCode
}

function toNonTerminalStatus(status: Tm1PublicationState['status']): Tm1PublicationNonTerminalStatus {
  if (
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
    case 'broadcastUncertain':
      return Object.freeze({
        status: 'broadcastUncertain',
        signedReview: freezeSignedReview(state.signedReview),
        uncertainty: freezeUncertainty(state.uncertainty)
      })
    case 'submitted':
      return Object.freeze({
        status: 'submitted',
        signedReview: freezeSignedReview(state.signedReview),
        receipt: freezeReceipt(state.receipt)
      })
    case 'confirming':
      return Object.freeze({ status: 'confirming', receipt: freezeReceipt(state.receipt) })
    case 'reconciling':
      return Object.freeze({
        status: 'reconciling',
        signedReview: freezeSignedReview(state.signedReview),
        uncertainty: freezeUncertainty(state.uncertainty)
      })
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
      return Object.freeze({
        status: 'failed',
        stage: state.stage,
        error: clonePublicationError(state.error)
      })
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
  return Object.freeze(cloneSignedArtifact(artifact))
}

function snapshotValidatedSignedArtifact(value: unknown): Readonly<{
  artifact: RegtestSignedTransaction
  transaction: Tx
}> {
  const format = readRequiredOwnDataProperty(value, 'format')
  const artifactVersion = readRequiredOwnDataProperty(value, 'artifactVersion')
  const environment = readRequiredOwnDataProperty(value, 'environment')
  const sighashPolicy = readRequiredOwnDataProperty(value, 'sighashPolicy')
  const fixturePublicKeyHex = readRequiredOwnDataProperty(value, 'fixturePublicKeyHex')
  const fixtureLockingScriptHex = readRequiredOwnDataProperty(value, 'fixtureLockingScriptHex')
  const inputCount = readRequiredOwnDataProperty(value, 'inputCount')
  const feeSats = readRequiredOwnDataProperty(value, 'feeSats')
  const txid = readRequiredOwnDataProperty(value, 'txid')
  const rawTransactionHex = readRequiredOwnDataProperty(value, 'rawTransactionHex')
  const rawTransactionBytes = readRequiredOwnDataProperty(value, 'rawTransactionBytes')

  if (
    format !== TM1_REGTEST_SIGNED_TRANSACTION_FORMAT ||
    artifactVersion !== TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION ||
    environment !== TM1_DRAFT_02_CANDIDATE_ENVIRONMENT ||
    sighashPolicy !== TM1_DRAFT_02_SIGHASH_POLICY ||
    typeof fixturePublicKeyHex !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(fixturePublicKeyHex) ||
    fixturePublicKeyHex !== TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX ||
    typeof fixtureLockingScriptHex !== 'string' ||
    fixtureLockingScriptHex.length === 0 ||
    fixtureLockingScriptHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(fixtureLockingScriptHex) ||
    fixtureLockingScriptHex !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX ||
    typeof inputCount !== 'number' ||
    !Number.isSafeInteger(inputCount) ||
    inputCount <= 0 ||
    typeof feeSats !== 'bigint' ||
    feeSats < 0n ||
    typeof txid !== 'string' ||
    !/^[0-9a-f]{64}$/.test(txid) ||
    typeof rawTransactionHex !== 'string' ||
    rawTransactionHex.length === 0 ||
    rawTransactionHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(rawTransactionHex) ||
    !(rawTransactionBytes instanceof Uint8Array) ||
    rawTransactionBytes.length === 0
  ) {
    throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID')
  }

  const snapshot = Object.freeze({
    format,
    artifactVersion,
    environment,
    sighashPolicy,
    fixturePublicKeyHex,
    fixtureLockingScriptHex,
    inputCount,
    feeSats,
    txid,
    rawTransactionHex,
    rawTransactionBytes: new Uint8Array(rawTransactionBytes)
  }) as RegtestSignedTransaction
  const transaction = assertSignedArtifactCoherent(snapshot)
  return Object.freeze({ artifact: snapshot, transaction })
}

function cloneSignedArtifact(artifact: RegtestSignedTransaction): RegtestSignedTransaction {
  assertSignedArtifactCoherent(artifact)
  return {
    ...artifact,
    rawTransactionBytes: new Uint8Array(artifact.rawTransactionBytes)
  }
}

function freezeUncertainty(uncertainty: Tm1BroadcastUncertainty): Tm1BroadcastUncertainty {
  return Object.freeze({
    submissionId: uncertainty.submissionId,
    preparedId: uncertainty.preparedId,
    signedId: uncertainty.signedId,
    txid: uncertainty.txid,
    signedArtifact: freezeSignedArtifact(uncertainty.signedArtifact),
    signedArtifactHash: uncertainty.signedArtifactHash,
    broadcastAuthorizationId: uncertainty.broadcastAuthorizationId,
    error: clonePublicationError(uncertainty.error)
  })
}

function clonePublicationError(
  error: Tm1PublicationError,
  seen: WeakMap<object, unknown> = new WeakMap()
): Tm1PublicationError {
  const existing = seen.get(error)
  if (existing instanceof Tm1PublicationError) return existing

  const codeDescriptor = safeOwnDataDescriptor(error, 'code')
  const code = isTm1PublicationErrorCode(codeDescriptor?.value)
    ? codeDescriptor.value
    : 'BROADCAST_FAILED'
  const messageDescriptor = safeOwnDataDescriptor(error, 'message')
  const message = typeof messageDescriptor?.value === 'string'
    ? messageDescriptor.value
    : code
  const nameDescriptor = safeOwnDataDescriptor(error, 'name')
  const name = typeof nameDescriptor?.value === 'string' && nameDescriptor.value.length > 0
    ? nameDescriptor.value
    : 'Tm1PublicationError'

  const clone = new Tm1PublicationError(code, message)
  seen.set(error, clone)
  clone.name = name

  const causeDescriptor = safeOwnDataDescriptor(error, 'cause')
  if (causeDescriptor !== undefined) {
    try {
      Object.defineProperty(clone, 'cause', {
        ...causeDescriptor,
        value: cloneErrorCause(causeDescriptor.value, seen)
      })
    } catch {
      // The constructor's undefined cause is a safe fallback.
    }
  }
  cloneDataProperties(error, clone, seen, key =>
    key !== 'stack' &&
    key !== 'name' &&
    key !== 'message' &&
    key !== 'code' &&
    key !== 'cause'
  )
  return clone
}

function safeOwnDataDescriptor(
  value: object,
  key: PropertyKey
): PropertyDescriptor | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor ? descriptor : undefined
  } catch {
    return undefined
  }
}

function safeOwnDataStringProperty(
  value: unknown,
  key: PropertyKey
): string | undefined {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return undefined
  }
  const descriptor = safeOwnDataDescriptor(value, key)
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined
}

function trapSafePublicationError(
  code: Tm1PublicationErrorCode,
  rejection: unknown
): Tm1PublicationError {
  return new Tm1PublicationError(
    code,
    code,
    cloneExternalRejectionCause(rejection)
  )
}

function cloneExternalRejectionCause(rejection: unknown): unknown {
  if (
    rejection === null ||
    (typeof rejection !== 'object' && typeof rejection !== 'function')
  ) {
    return rejection
  }

  const seen = new WeakMap<object, unknown>()
  if (typeof rejection === 'function') return cloneFunctionCause(rejection, seen)

  const clone: Record<PropertyKey, unknown> = {}
  seen.set(rejection, clone)

  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(rejection)
  } catch {
    return unknownObjectCause()
  }

  for (const key of keys) {
    if (key === 'stack') continue

    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(rejection, key)
    } catch {
      return unknownObjectCause()
    }
    if (descriptor === undefined || !('value' in descriptor)) continue

    try {
      Object.defineProperty(clone, key, {
        ...descriptor,
        value: cloneErrorCause(descriptor.value, seen)
      })
    } catch {
      // Keep the remaining safe diagnostic fields.
    }
  }

  return clone
}

function isTm1PublicationErrorCode(value: unknown): value is Tm1PublicationErrorCode {
  switch (value) {
    case 'INVALID_STATE':
    case 'PUBLICATION_ALREADY_ACTIVE':
    case 'STALE_PREPARED_REVIEW':
    case 'STALE_SIGNED_REVIEW':
    case 'STALE_SUBMISSION':
    case 'PREPARATION_FAILED':
    case 'SIGNING_REJECTED':
    case 'SIGNING_AUTHORIZATION_EXPIRED':
    case 'CANDIDATE_REVALIDATION_FAILED':
    case 'SIGNING_FAILED':
    case 'SIGNED_ARTIFACT_INVALID':
    case 'BROADCAST_REJECTED':
    case 'BROADCAST_AUTHORIZATION_EXPIRED':
    case 'BROADCAST_FAILED':
    case 'TXID_MISMATCH':
    case 'CONFIRMATION_FAILED':
    case 'ABORTED':
      return true
    default:
      return false
  }
}

function cloneErrorCause(cause: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return cause

  // Functions are mutable objects even though typeof reports "function". Never
  // retain their callability or share their identity across error snapshots.
  if (typeof cause === 'function') return cloneFunctionCause(cause, seen)

  try {
    if (cause instanceof Tm1PublicationError) return clonePublicationError(cause, seen)
    if (cause instanceof Error) {
      const existing = seen.get(cause)
      if (existing !== undefined) return existing
      const clone = new Error()
      seen.set(cause, clone)
      cloneDataProperties(cause, clone, seen, key => key !== 'stack')
      return clone
    }
    if (cause instanceof Uint8Array) return new Uint8Array(cause)
    if (Array.isArray(cause)) {
      const existing = seen.get(cause)
      if (existing !== undefined) return existing
      const clone: unknown[] = []
      seen.set(cause, clone)
      cloneDataProperties(cause, clone, seen, key => key !== 'length')
      const lengthDescriptor = Object.getOwnPropertyDescriptor(cause, 'length')
      if (lengthDescriptor !== undefined && 'value' in lengthDescriptor) {
        Object.defineProperty(clone, 'length', lengthDescriptor)
      }
      return clone
    }
    if (isPlainObject(cause)) {
      const existing = seen.get(cause)
      if (existing !== undefined) return existing
      const clone: Record<PropertyKey, unknown> = {}
      seen.set(cause, clone)
      cloneDataProperties(cause, clone, seen)
      return clone
    }
  } catch {
    return unknownObjectCause()
  }

  return unknownObjectCause()
}

function cloneFunctionCause(
  source: object,
  seen: WeakMap<object, unknown>
): unknown {
  const existing = seen.get(source)
  if (existing !== undefined) return existing

  const clone: Record<PropertyKey, unknown> = {}
  seen.set(source, clone)

  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(source)
  } catch {
    const fallback = unknownObjectCause()
    seen.set(source, fallback)
    return fallback
  }

  for (const key of keys) {
    if (
      key === 'length' ||
      key === 'prototype' ||
      key === 'arguments' ||
      key === 'caller'
    ) {
      continue
    }

    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key)
    } catch {
      const fallback = unknownObjectCause()
      seen.set(source, fallback)
      return fallback
    }

    // Accessors are external behavior. Omit them without invoking get or set.
    if (descriptor === undefined || !('value' in descriptor)) continue
    try {
      Object.defineProperty(clone, key, {
        ...descriptor,
        value: cloneErrorCause(descriptor.value, seen)
      })
    } catch {
      // An individual hostile data property is not allowed to escape cloning.
    }
  }

  return clone
}

function cloneDataProperties(
  source: object,
  target: object,
  seen: WeakMap<object, unknown>,
  include: (key: PropertyKey) => boolean = () => true
): void {
  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(source)
  } catch {
    return
  }
  for (const key of keys) {
    if (!include(key)) continue
    const descriptor = safeOwnDataDescriptor(source, key)
    // Accessors from external values are intentionally omitted and never invoked.
    if (descriptor === undefined || !('value' in descriptor)) continue
    try {
      Object.defineProperty(target, key, {
        ...descriptor,
        value: cloneErrorCause(descriptor.value, seen)
      })
    } catch {
      // A hostile descriptor must not make publication error construction throw.
    }
  }
}

function unknownObjectCause(): Readonly<{ name: 'UnknownObject'; description: string }> {
  return Object.freeze({
    name: 'UnknownObject',
    description: 'External object could not be cloned safely'
  })
}

function isPlainObject(value: object): value is Record<PropertyKey, unknown> {
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
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

function assertSignedArtifactCoherent(artifact: RegtestSignedTransaction): Tx {
  if (toHex(artifact.rawTransactionBytes) !== artifact.rawTransactionHex) {
    throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID')
  }
  let transaction: Tx
  try {
    transaction = Tx.fromHex(artifact.rawTransactionHex)
  } catch (error) {
    throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID', 'SIGNED_ARTIFACT_INVALID', error)
  }
  if (toHex(transaction.ser()) !== artifact.rawTransactionHex) {
    throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID')
  }
  if (transaction.txid() !== artifact.txid) {
    throw new Tm1PublicationError('SIGNED_ARTIFACT_INVALID')
  }
  return transaction
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
