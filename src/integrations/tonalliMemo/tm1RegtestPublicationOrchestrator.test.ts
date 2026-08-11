import { describe, expect, test } from 'vitest'
import { sha256d, toHex } from 'ecash-lib'
import { XEC_DUST_SATS } from '../../config/xecFees'
import {
  encodeTm1Draft02CandidateEffectiveContent,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  signTm1Draft02RegtestCandidate,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
import { Tm1InMemoryDeliveryTransport } from './tm1RegtestDeliveryTransport'
import {
  Tm1PublicationError,
  Tm1RegtestPublicationOrchestratorImpl,
  type Tm1BroadcastAuthorizationDecision,
  type Tm1Confirmation,
  type Tm1PublicationAuthorizationDecision,
  type Tm1PublicationErrorCode,
  type Tm1PublicationRequest,
  type Tm1PublicationState,
  type Tm1RegtestPublicationDependencies,
  type Tm1SignedReview
} from './tm1RegtestPublicationOrchestrator'

const TXID_A = 'aa'.repeat(32)
const TXID_B = 'bb'.repeat(32)
const DEFAULT_REQUEST: Tm1PublicationRequest = Object.freeze({
  message: 'TM1 orchestrator regtest publication',
  activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  maxFeeSats: 10_000n
})

type Harness = ReturnType<typeof createHarness>

type Deferred<T> = Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}>

function createDeferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined
  let rejectValue: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  void promise.catch(() => undefined)
  return Object.freeze({ promise, resolve: resolveValue, reject: rejectValue })
}

function fixtureUtxos(): Tm1Draft02FreshUtxo[] {
  return [
    {
      txid: TXID_A,
      outIdx: 0,
      sats: 20_000n,
      lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      token: null
    },
    {
      txid: TXID_B,
      outIdx: 1,
      sats: 10_000n,
      lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      token: null
    }
  ]
}

function cloneUtxos(utxos: readonly Tm1Draft02FreshUtxo[]): Tm1Draft02FreshUtxo[] {
  return utxos.map(utxo => ({ ...utxo }))
}

function createHarness() {
  let ids = 0
  let utxos = cloneUtxos(fixtureUtxos())
  let chainIdentity = 'tm1-regtest-chain'
  let signingDecision: Tm1PublicationAuthorizationDecision = Object.freeze({
    status: 'approved',
    authorizationId: 'sign-auth-1'
  })
  let broadcastDecision: Tm1BroadcastAuthorizationDecision | null = null
  let attestFailure: unknown = null
  let signerFailure: unknown = null
  let auditFailure: unknown = null
  let auditMutator: ((artifact: RegtestSignedTransaction) => RegtestSignedTransaction) | null = null
  let auditReturnUnchecked: RegtestSignedTransaction | null = null
  let broadcastFailure: unknown = null
  let broadcastTxidOverride: string | null = null
  let confirmationOverride: Tm1Confirmation | null = null
  let confirmationFailure: unknown = null
  let onSigningAuthorization: (() => void) | null = null
  let onBroadcastAuthorization: (() => void) | null = null
  let broadcastDeferred: Deferred<Readonly<{ txid: string; disposition: 'accepted' }>> | null = null
  let attestDeferred: Deferred<void> | null = null

  const calls = {
    attest: 0,
    utxos: 0,
    signingAuthorization: 0,
    signer: 0,
    audit: 0,
    broadcastAuthorization: 0,
    broadcast: 0,
    confirm: 0
  }

  const dependencies: Tm1RegtestPublicationDependencies = {
    networkAttestation: {
      async attest(signal?: AbortSignal) {
        calls.attest += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (attestFailure) throw attestFailure
        if (attestDeferred) await attestDeferred.promise
        return Object.freeze({
          environment: 'deterministic-regtest-fixture',
          chainIdentity
        })
      }
    },
    utxoProvider: {
      async readUtxos(signal?: AbortSignal) {
        calls.utxos += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        return Object.freeze(cloneUtxos(utxos))
      }
    },
    signingAuthorization: {
      async requestSigningAuthorization(_review, signal?: AbortSignal) {
        calls.signingAuthorization += 1
        onSigningAuthorization?.()
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        return signingDecision
      }
    },
    signer: {
      async sign(review, signal?: AbortSignal) {
        calls.signer += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (signerFailure) throw signerFailure
        return signTm1Draft02RegtestCandidate({ candidate: review.candidate, signal })
      }
    },
    signedArtifactAudit: {
      async auditSignedArtifact({ signedArtifact }) {
        calls.audit += 1
        if (auditFailure) throw auditFailure
        if (auditReturnUnchecked) return auditReturnUnchecked
        const audited = auditMutator ? auditMutator(signedArtifact) : signedArtifact
        await new Tm1InMemoryDeliveryTransport().submit(audited)
        return Object.freeze({
          ...audited,
          rawTransactionBytes: new Uint8Array(audited.rawTransactionBytes)
        })
      }
    },
    broadcastAuthorization: {
      async requestBroadcastAuthorization(signedReview, signal?: AbortSignal) {
        calls.broadcastAuthorization += 1
        onBroadcastAuthorization?.()
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        return broadcastDecision ?? Object.freeze({
          status: 'approved' as const,
          authorizationId: 'broadcast-auth-1',
          signedId: signedReview.signedId,
          txid: signedReview.txid,
          signedArtifactHash: signedReview.signedArtifactHash
        })
      }
    },
    deliveryTransport: {
      async broadcast(signedArtifact: RegtestSignedTransaction) {
        calls.broadcast += 1
        if (broadcastFailure) throw broadcastFailure
        if (broadcastDeferred) return broadcastDeferred.promise
        return Object.freeze({
          txid: broadcastTxidOverride ?? signedArtifact.txid,
          disposition: 'accepted' as const
        })
      }
    },
    confirmationObserver: {
      async confirm({ submissionId, txid, signal }) {
        calls.confirm += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (confirmationFailure) throw confirmationFailure
        return confirmationOverride ?? Object.freeze({
          submissionId,
          txid,
          confirmations: 1,
          blockHash: 'cc'.repeat(32),
          blockHeight: 101
        })
      }
    },
    clock: {
      createId(prefix) {
        ids += 1
        return `${prefix}-${ids}`
      }
    }
  }

  const orchestrator = new Tm1RegtestPublicationOrchestratorImpl(dependencies)
  return {
    orchestrator,
    calls,
    setUtxos: (next: readonly Tm1Draft02FreshUtxo[]) => { utxos = cloneUtxos(next) },
    setChainIdentity: (next: string) => { chainIdentity = next },
    setSigningDecision: (next: Tm1PublicationAuthorizationDecision) => { signingDecision = next },
    setBroadcastDecision: (next: Tm1BroadcastAuthorizationDecision) => { broadcastDecision = next },
    failAttestation: (error: unknown) => { attestFailure = error },
    failSigner: (error: unknown) => { signerFailure = error },
    failAudit: (error: unknown) => { auditFailure = error },
    mutateAudit: (fn: (artifact: RegtestSignedTransaction) => RegtestSignedTransaction) => { auditMutator = fn },
    returnUncheckedAudit: (artifact: RegtestSignedTransaction) => { auditReturnUnchecked = artifact },
    failBroadcast: (error: unknown) => { broadcastFailure = error },
    setBroadcastTxid: (txid: string) => { broadcastTxidOverride = txid },
    setConfirmation: (confirmation: Tm1Confirmation) => { confirmationOverride = confirmation },
    failConfirmation: (error: unknown) => { confirmationFailure = error },
    onSigningAuthorization: (fn: () => void) => { onSigningAuthorization = fn },
    onBroadcastAuthorization: (fn: () => void) => { onBroadcastAuthorization = fn },
    deferBroadcast: () => {
      broadcastDeferred = createDeferred<Readonly<{ txid: string; disposition: 'accepted' }>>()
      return broadcastDeferred
    },
    deferAttestation: () => {
      attestDeferred = createDeferred<void>()
      return attestDeferred
    }
  }
}

async function prepareAndSign(harness: Harness): Promise<Tm1SignedReview> {
  const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
  return harness.orchestrator.authorizeAndSign(review.preparedId)
}

async function expectCode(promise: Promise<unknown>, code: Tm1PublicationErrorCode): Promise<void> {
  await promise.then(
    () => { throw new Error(`Expected ${code}`) },
    error => {
      expect(error).toBeInstanceOf(Tm1PublicationError)
      expect((error as Tm1PublicationError).code).toBe(code)
    }
  )
}

function statuses(states: readonly Tm1PublicationState[]): string[] {
  return states.map(state => state.status)
}

describe('TM1 regtest publication orchestrator', () => {
  test('runs the complete staged happy path and confirms the exact txid', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const confirmation = await harness.orchestrator.confirm(receipt.submissionId)

    expect(confirmation.txid).toBe(signedReview.txid)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
    expect(harness.calls).toEqual({
      attest: 2,
      utxos: 2,
      signingAuthorization: 1,
      signer: 1,
      audit: 2,
      broadcastAuthorization: 1,
      broadcast: 1,
      confirm: 1
    })
  })

  test('emits the exact non-terminal state sequence for the happy path', async () => {
    const harness = createHarness()
    const observed: Tm1PublicationState[] = []
    harness.orchestrator.subscribe(state => observed.push(state))

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    await harness.orchestrator.confirm(receipt.submissionId)

    expect(statuses(observed)).toEqual([
      'idle',
      'attesting',
      'preparing',
      'reviewReady',
      'authorizing',
      'revalidating',
      'signing',
      'signedReviewReady',
      'approvingBroadcast',
      'broadcasting',
      'submitted',
      'confirming',
      'confirmed'
    ])
  })

  test('does not sign or broadcast during prepare', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)

    expect(harness.calls.signingAuthorization).toBe(0)
    expect(harness.calls.signer).toBe(0)
    expect(harness.calls.broadcastAuthorization).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
  })

  test('handles rejected signing authorization as a typed terminal state', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setSigningDecision({ status: 'rejected', reason: 'human declined' })

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_REJECTED')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'rejected', stage: 'signing' })
    expect(harness.calls.signer).toBe(0)
  })

  test('handles expired signing authorization without signing', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setSigningDecision({ status: 'expired', reason: 'lease expired' })

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_AUTHORIZATION_EXPIRED')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'expired', stage: 'signing' })
    expect(harness.calls.signer).toBe(0)
  })

  test('rejects a mutated UTXO after review approval', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const mutated = fixtureUtxos()
    mutated[0] = { ...mutated[0], sats: mutated[0].sats - 1n }
    harness.setUtxos(mutated)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'CANDIDATE_REVALIDATION_FAILED')
    expect(harness.calls.signer).toBe(0)
  })

  test('rejects a disappeared UTXO after review approval', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setUtxos(fixtureUtxos().slice(1))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'CANDIDATE_REVALIDATION_FAILED')
    expect(harness.calls.signer).toBe(0)
  })

  test('rejects network identity changes during signing revalidation', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setChainIdentity('different-regtest-chain')

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'CANDIDATE_REVALIDATION_FAILED')
    expect(harness.calls.signer).toBe(0)
  })

  test('maps signer failures to SIGNING_FAILED', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failSigner(new Error('fixture signer failed'))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('maps signed artifact audit failures to SIGNED_ARTIFACT_INVALID', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failAudit(new Error('bad artifact'))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('binds txid and signed bytes into the signed review', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)

    const state = harness.orchestrator.getState()

    expect(state.status).toBe('signedReviewReady')
    expect(signedReview.txid).toBe(signedReview.signedArtifact.txid)
    expect(signedReview.signedArtifactHash).toMatch(/^[0-9a-f]{64}$/)
    if (state.status === 'signedReviewReady') {
      expect(signedReview.bindingHash).toBe(state.signedReview.bindingHash)
    }
  })

  test('does not broadcast before independent broadcast authorization', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastDecision({ status: 'rejected', reason: 'second human declined' })

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_REJECTED')
    expect(harness.calls.broadcastAuthorization).toBe(1)
    expect(harness.calls.broadcast).toBe(0)
  })

  test('handles expired broadcast authorization without broadcast', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastDecision({ status: 'expired', reason: 'broadcast lease expired' })

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_AUTHORIZATION_EXPIRED'
    )
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'expired', stage: 'broadcast' })
    expect(harness.calls.broadcast).toBe(0)
  })

  test('maps delivery transport failures to BROADCAST_FAILED', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failBroadcast(new Error('transport failed'))

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'broadcastUncertain' })
  })

  test('rejects a delivery txid mismatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastTxid('00'.repeat(32))

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'TXID_MISMATCH')
  })

  test('aborts before signing and invokes no signer', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const controller = new AbortController()
    controller.abort()

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal), 'ABORTED')
    expect(harness.orchestrator.getState().status).toBe('aborted')
    expect(harness.calls.signer).toBe(0)
  })

  test('aborts after review without broadcast', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const controller = new AbortController()
    controller.abort()

    await expectCode(harness.orchestrator.approveAndBroadcast('missing', controller.signal), 'INVALID_STATE')
    expect(harness.calls.broadcast).toBe(0)
  })

  test('aborts before irreversible dispatch and performs zero broadcasts', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const controller = new AbortController()
    harness.onBroadcastAuthorization(() => controller.abort())

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId, controller.signal), 'ABORTED')
    expect(harness.calls.broadcast).toBe(0)
  })

  test('does not double broadcast when abort happens after irreversible dispatch starts', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const deferred = harness.deferBroadcast()
    const controller = new AbortController()
    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.broadcast).toBe(1)
    controller.abort()
    deferred.resolve(Object.freeze({ txid: signedReview.txid, disposition: 'accepted' as const }))
    await expect(promise).resolves.toMatchObject({ txid: signedReview.txid })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('submitted')
  })

  test('confirms a submitted publication', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1
    })
  })

  test('rejects confirmation for a different txid', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    harness.setConfirmation(Object.freeze({
      submissionId: receipt.submissionId,
      txid: '00'.repeat(32),
      confirmations: 1
    }))

    await expectCode(harness.orchestrator.confirm(receipt.submissionId), 'TXID_MISMATCH')
  })

  test('rejects a concurrent second publication', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PUBLICATION_ALREADY_ACTIVE')
  })

  test('rejects stale prepared and signed review ids', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)

    await expectCode(harness.orchestrator.authorizeAndSign(`${review.preparedId}-stale`), 'STALE_PREPARED_REVIEW')
    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)
    await expectCode(harness.orchestrator.approveAndBroadcast(`${signedReview.signedId}-stale`), 'STALE_SIGNED_REVIEW')
  })

  test('allows reset only from safe states', async () => {
    const reviewReady = createHarness()
    await reviewReady.orchestrator.prepare(DEFAULT_REQUEST)
    expect(() => reviewReady.orchestrator.reset()).not.toThrow()
    expect(reviewReady.orchestrator.getState().status).toBe('idle')

    const inFlight = createHarness()
    const controller = new AbortController()
    inFlight.onSigningAuthorization(() => {
      expect(() => inFlight.orchestrator.reset()).toThrowError(Tm1PublicationError)
      controller.abort()
    })
    const review = await inFlight.orchestrator.prepare(DEFAULT_REQUEST)
    await expectCode(inFlight.orchestrator.authorizeAndSign(review.preparedId, controller.signal), 'ABORTED')
    expect(() => inFlight.orchestrator.reset()).not.toThrow()
    expect(inFlight.orchestrator.getState().status).toBe('idle')
  })

  test('subscribers receive immutable snapshots in order', async () => {
    const harness = createHarness()
    const observed: Tm1PublicationState[] = []
    harness.orchestrator.subscribe(state => observed.push(state))

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const reviewState = observed.find(state => state.status === 'reviewReady')

    expect(statuses(observed)).toEqual(['idle', 'attesting', 'preparing', 'reviewReady'])
    expect(Object.isFrozen(reviewState)).toBe(true)
    expect(Object.isFrozen(review)).toBe(true)
    expect(Object.isFrozen(review.orderedInputs)).toBe(true)
    expect(review.bindingHash).toBe(toHex(sha256d(encodeTm1Draft02CandidateEffectiveContent(review.candidate))))
  })

  test('unsubscribe stops future state events', async () => {
    const harness = createHarness()
    const observed: string[] = []
    const unsubscribe = harness.orchestrator.subscribe(state => observed.push(state.status))
    unsubscribe()

    await harness.orchestrator.prepare(DEFAULT_REQUEST)
    expect(observed).toEqual(['idle'])
  })

  test('keeps prepare bounded to preview planning without authorization or transport', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)

    expect(review.message).toBe(DEFAULT_REQUEST.message)
    expect(review.network.chainIdentity).toBe('tm1-regtest-chain')
    expect(review.orderedInputs.map(input => `${input.txid}:${input.outIdx}`)).toEqual([
      `${TXID_A}:0`
    ])
    expect(review.orderedOutputs).toHaveLength(2)
    expect(review.feeSats).toBeGreaterThan(0n)
    expect(review.candidate.feePolicy.dustSats).toBe(BigInt(XEC_DUST_SATS))
  })

  test('moves post-dispatch timeout into broadcastUncertain and reconciles by txid without rebroadcast', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const deferred = harness.deferBroadcast()
    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.broadcast).toBe(1)
    deferred.reject(new Error('transport timeout after dispatch'))
    await expectCode(promise, 'BROADCAST_FAILED')

    const uncertain = harness.orchestrator.getState()
    expect(uncertain.status).toBe('broadcastUncertain')
    if (uncertain.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(uncertain.uncertainty.preparedId).toBe(signedReview.preparedId)
    expect(uncertain.uncertainty.signedId).toBe(signedReview.signedId)
    expect(uncertain.uncertainty.txid).toBe(signedReview.txid)
    expect(uncertain.uncertainty.signedArtifact.txid).toBe(signedReview.txid)
    expect(uncertain.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(() => harness.orchestrator.reset()).toThrowError(Tm1PublicationError)

    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid,
      confirmations: 1,
      blockHash: 'dd'.repeat(32),
      blockHeight: 102
    }))
    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({ txid: signedReview.txid })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('leaves uncertainty in place when reconcile cannot determine inclusion', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const deferred = harness.deferBroadcast()
    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    deferred.reject(new Error('timeout'))
    await expectCode(promise, 'BROADCAST_FAILED')
    harness.failConfirmation(new Error('not indexed yet'))

    await expectCode(harness.orchestrator.reconcile(), 'CONFIRMATION_FAILED')
    expect(harness.orchestrator.getState().status).toBe('broadcastUncertain')
    expect(harness.calls.broadcast).toBe(1)
  })

  test('isolates subscriber exceptions and still notifies later listeners through submitted', async () => {
    const harness = createHarness()
    const observed: string[] = []
    harness.orchestrator.subscribe(() => { throw new Error('listener A failed') })
    harness.orchestrator.subscribe(state => observed.push(state.status))

    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    expect(receipt.txid).toBe(signedReview.txid)
    expect(observed).toContain('broadcasting')
    expect(observed).toContain('submitted')
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('submitted')
  })

  test('subscriber exceptions during broadcasting and submitted do not cause retries or failure', async () => {
    const harness = createHarness()
    const observed: string[] = []
    harness.orchestrator.subscribe(state => {
      if (state.status === 'broadcasting' || state.status === 'submitted') throw new Error('boom')
    })
    harness.orchestrator.subscribe(state => observed.push(state.status))

    const signedReview = await prepareAndSign(harness)
    await expect(harness.orchestrator.approveAndBroadcast(signedReview.signedId)).resolves.toMatchObject({
      txid: signedReview.txid
    })

    expect(observed).toContain('broadcasting')
    expect(observed).toContain('submitted')
    expect(harness.calls.broadcast).toBe(1)
  })

  test('subscriber reentrant operations are rejected by guards without breaking invariants', async () => {
    const harness = createHarness()
    const reentrant: Promise<unknown>[] = []
    const resetErrors: unknown[] = []
    harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting') reentrant.push(harness.orchestrator.prepare(DEFAULT_REQUEST))
      if (state.status === 'approvingBroadcast') reentrant.push(harness.orchestrator.approveAndBroadcast(state.signedReview.signedId))
      if (state.status === 'broadcasting') {
        try { harness.orchestrator.reset() } catch (error) { resetErrors.push(error) }
      }
    })

    const signedReview = await prepareAndSign(harness)
    await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await Promise.all(reentrant.map(promise => expect(promise).rejects.toBeInstanceOf(Tm1PublicationError)))
    expect(resetErrors).toHaveLength(1)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('submitted')
  })

  test('recognizes external AbortError from signer, attestation, and confirmation observer', async () => {
    const abortError = (): Error => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      return error
    }

    const signerHarness = createHarness()
    const signerReview = await signerHarness.orchestrator.prepare(DEFAULT_REQUEST)
    signerHarness.failSigner(abortError())
    await expectCode(signerHarness.orchestrator.authorizeAndSign(signerReview.preparedId), 'ABORTED')
    expect(signerHarness.orchestrator.getState().status).toBe('aborted')

    const attestationHarness = createHarness()
    attestationHarness.failAttestation(abortError())
    await expectCode(attestationHarness.orchestrator.prepare(DEFAULT_REQUEST), 'ABORTED')
    expect(attestationHarness.orchestrator.getState().status).toBe('aborted')

    const confirmationHarness = createHarness()
    const signedReview = await prepareAndSign(confirmationHarness)
    const receipt = await confirmationHarness.orchestrator.approveAndBroadcast(signedReview.signedId)
    confirmationHarness.failConfirmation(abortError())
    await expectCode(confirmationHarness.orchestrator.confirm(receipt.submissionId), 'ABORTED')
    expect(confirmationHarness.orchestrator.getState().status).toBe('submitted')
  })

  test('rejects locally incoherent signed artifact bytes, hex, and txid before broadcast', async () => {
    const txidHarness = createHarness()
    const txidReview = await txidHarness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: txidReview.candidate })
    txidHarness.returnUncheckedAudit(Object.freeze({ ...validArtifact, txid: '00'.repeat(32) }))
    await expectCode(txidHarness.orchestrator.authorizeAndSign(txidReview.preparedId), 'SIGNED_ARTIFACT_INVALID')
    expect(txidHarness.calls.broadcast).toBe(0)

    const hexHarness = createHarness()
    const hexReview = await hexHarness.orchestrator.prepare(DEFAULT_REQUEST)
    const hexArtifact = signTm1Draft02RegtestCandidate({ candidate: hexReview.candidate })
    hexHarness.returnUncheckedAudit(Object.freeze({ ...hexArtifact, rawTransactionHex: `00${hexArtifact.rawTransactionHex.slice(2)}` }))
    await expectCode(hexHarness.orchestrator.authorizeAndSign(hexReview.preparedId), 'SIGNED_ARTIFACT_INVALID')
    expect(hexHarness.calls.broadcast).toBe(0)
  })

  test('requires broadcast authorization binding to signed id txid and artifact hash', async () => {
    const good = createHarness()
    const goodSigned = await prepareAndSign(good)
    good.setBroadcastDecision(Object.freeze({
      status: 'approved',
      authorizationId: 'broadcast-auth-1',
      signedId: goodSigned.signedId,
      txid: goodSigned.txid,
      signedArtifactHash: goodSigned.signedArtifactHash
    }))
    await expect(good.orchestrator.approveAndBroadcast(goodSigned.signedId)).resolves.toMatchObject({ txid: goodSigned.txid })

    const staleSigned = createHarness()
    const staleReview = await prepareAndSign(staleSigned)
    staleSigned.setBroadcastDecision(Object.freeze({
      status: 'approved',
      authorizationId: 'broadcast-auth-1',
      signedId: `${staleReview.signedId}-old`,
      txid: staleReview.txid,
      signedArtifactHash: staleReview.signedArtifactHash
    }))
    await expectCode(staleSigned.orchestrator.approveAndBroadcast(staleReview.signedId), 'BROADCAST_REJECTED')
    expect(staleSigned.calls.broadcast).toBe(0)

    const wrongTxid = createHarness()
    const wrongTxidReview = await prepareAndSign(wrongTxid)
    wrongTxid.setBroadcastDecision(Object.freeze({
      status: 'approved',
      authorizationId: 'broadcast-auth-1',
      signedId: wrongTxidReview.signedId,
      txid: '00'.repeat(32),
      signedArtifactHash: wrongTxidReview.signedArtifactHash
    }))
    await expectCode(wrongTxid.orchestrator.approveAndBroadcast(wrongTxidReview.signedId), 'BROADCAST_REJECTED')
    expect(wrongTxid.calls.broadcast).toBe(0)

    const previousGrant = createHarness()
    const previousSigned = await prepareAndSign(previousGrant)
    previousGrant.setBroadcastDecision(Object.freeze({
      status: 'approved',
      authorizationId: previousSigned.signingAuthorizationId,
      signedId: previousSigned.signedId,
      txid: previousSigned.txid,
      signedArtifactHash: '11'.repeat(32)
    }))
    await expectCode(previousGrant.orchestrator.approveAndBroadcast(previousSigned.signedId), 'BROADCAST_REJECTED')
    expect(previousGrant.calls.broadcast).toBe(0)
  })

  test('returns STALE_SUBMISSION for confirmation with a wrong submission id', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await expectCode(harness.orchestrator.confirm(`${receipt.submissionId}-old`), 'STALE_SUBMISSION')
  })

  test('rejects real concurrent prepare and double broadcast attempts deterministically', async () => {
    const prepareHarness = createHarness()
    const attestation = prepareHarness.deferAttestation()
    const a = prepareHarness.orchestrator.prepare(DEFAULT_REQUEST)
    const b = prepareHarness.orchestrator.prepare({ ...DEFAULT_REQUEST, message: 'second' })
    await expectCode(b, 'PUBLICATION_ALREADY_ACTIVE')
    attestation.resolve(undefined)
    await expect(a).resolves.toMatchObject({ message: DEFAULT_REQUEST.message })

    const broadcastHarness = createHarness()
    const signedReview = await prepareAndSign(broadcastHarness)
    const deferred = broadcastHarness.deferBroadcast()
    const first = broadcastHarness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const second = broadcastHarness.orchestrator.approveAndBroadcast(signedReview.signedId)
    await expectCode(second, 'INVALID_STATE')
    deferred.resolve(Object.freeze({ txid: signedReview.txid, disposition: 'accepted' as const }))
    await expect(first).resolves.toMatchObject({ txid: signedReview.txid })
    expect(broadcastHarness.calls.broadcast).toBe(1)
  })

  test('returned snapshots are defensively isolated from mutation attempts', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const state = harness.orchestrator.getState()
    expect(() => { (state as { status: string }).status = 'idle' }).toThrow(TypeError)
    expect(() => { (review as { preparedId: string }).preparedId = 'mutated' }).toThrow(TypeError)
    expect(() => {
      (review.candidate.outputs as unknown as Array<{ scriptHex: string }>)[0] = { scriptHex: '00' }
    }).toThrow(TypeError)
    review.effectiveContent[0] ^= 0xff

    expect(harness.orchestrator.getState().status).toBe('reviewReady')
    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)
    const signedState = harness.orchestrator.getState()
    if (signedState.status !== 'signedReviewReady') throw new Error('expected signed review')
    expect(() => {
      (signedState.signedReview as unknown as { txid: string }).txid = '00'.repeat(32)
    }).toThrow(TypeError)
    signedReview.signedArtifact.rawTransactionBytes[0] ^= 0xff

    await expect(harness.orchestrator.approveAndBroadcast(signedReview.signedId)).resolves.toMatchObject({
      txid: signedReview.txid
    })
    expect(harness.calls.broadcast).toBe(1)
  })

  test('old prepared signed and submission ids cannot operate after reset and a new cycle', async () => {
    const harness = createHarness()
    const oldReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const oldSigned = await harness.orchestrator.authorizeAndSign(oldReview.preparedId)
    const oldReceipt = await harness.orchestrator.approveAndBroadcast(oldSigned.signedId)
    await harness.orchestrator.confirm(oldReceipt.submissionId)
    harness.orchestrator.reset()

    const newReview = await harness.orchestrator.prepare({ ...DEFAULT_REQUEST, message: 'new publication' })
    await expectCode(harness.orchestrator.authorizeAndSign(oldReview.preparedId), 'STALE_PREPARED_REVIEW')
    const newSigned = await harness.orchestrator.authorizeAndSign(newReview.preparedId)
    await expectCode(harness.orchestrator.approveAndBroadcast(oldSigned.signedId), 'STALE_SIGNED_REVIEW')
    const newReceipt = await harness.orchestrator.approveAndBroadcast(newSigned.signedId)
    await expectCode(harness.orchestrator.confirm(oldReceipt.submissionId), 'STALE_SUBMISSION')
    await expect(harness.orchestrator.confirm(newReceipt.submissionId)).resolves.toMatchObject({
      submissionId: newReceipt.submissionId
    })
  })

  test('blocks reset and a new prepare from a reviewReady subscriber until prepare returns', async () => {
    const harness = createHarness()
    let resetError: unknown = null
    let reentrantPrepare: Promise<unknown> | null = null

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'reviewReady' || state.review.message !== DEFAULT_REQUEST.message) return
      try {
        harness.orchestrator.reset()
      } catch (error) {
        resetError = error
      }
      reentrantPrepare = harness.orchestrator.prepare({
        ...DEFAULT_REQUEST,
        message: 'reentrant publication B'
      })
    })

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)

    expect(resetError).toBeInstanceOf(Tm1PublicationError)
    expect((resetError as Tm1PublicationError).code).toBe('INVALID_STATE')
    if (reentrantPrepare === null) throw new Error('expected reentrant prepare')
    await expectCode(reentrantPrepare, 'PUBLICATION_ALREADY_ACTIVE')
    expect(review.message).toBe(DEFAULT_REQUEST.message)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'reviewReady',
      review: { preparedId: review.preparedId }
    })
    expect(harness.calls.attest).toBe(1)

    expect(() => harness.orchestrator.reset()).not.toThrow()
    await expect(harness.orchestrator.prepare({
      ...DEFAULT_REQUEST,
      message: 'publication B after reset'
    })).resolves.toMatchObject({ message: 'publication B after reset' })
    expect(harness.calls.attest).toBe(2)
  })

  test('blocks reset and a new prepare from a signedReviewReady subscriber until authorizeAndSign returns', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let resetError: unknown = null
    let reentrantPrepare: Promise<unknown> | null = null

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'signedReviewReady') return
      try {
        harness.orchestrator.reset()
      } catch (error) {
        resetError = error
      }
      reentrantPrepare = harness.orchestrator.prepare({
        ...DEFAULT_REQUEST,
        message: 'reentrant publication B'
      })
    })

    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)

    expect(resetError).toBeInstanceOf(Tm1PublicationError)
    expect((resetError as Tm1PublicationError).code).toBe('INVALID_STATE')
    if (reentrantPrepare === null) throw new Error('expected reentrant prepare')
    await expectCode(reentrantPrepare, 'PUBLICATION_ALREADY_ACTIVE')
    expect(signedReview.preparedId).toBe(review.preparedId)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'signedReviewReady',
      signedReview: { signedId: signedReview.signedId }
    })
    expect(harness.calls.attest).toBe(2)

    expect(() => harness.orchestrator.reset()).not.toThrow()
    await expect(harness.orchestrator.prepare({
      ...DEFAULT_REQUEST,
      message: 'publication B after reset'
    })).resolves.toMatchObject({ message: 'publication B after reset' })
    expect(harness.calls.attest).toBe(3)
  })

  test('clears the active staged operation after exceptions', async () => {
    const harness = createHarness()
    harness.failAttestation(new Error('attestation unavailable'))

    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).rejects.toBeInstanceOf(Tm1PublicationError)
    expect(() => harness.orchestrator.reset()).not.toThrow()

    harness.failAttestation(null)
    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      message: DEFAULT_REQUEST.message
    })
  })

  test('keeps submitted receipt retryable when confirmation observation fails transiently', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    harness.failConfirmation(new Error('indexer unavailable'))

    await expectCode(harness.orchestrator.confirm(receipt.submissionId), 'CONFIRMATION_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.receipt.submissionId).toBe(receipt.submissionId)
    expect(state.receipt.txid).toBe(receipt.txid)
    expect(state.signedReview.signedId).toBe(signedReview.signedId)
    expect(harness.calls.broadcast).toBe(1)

    harness.failConfirmation(null)
    harness.setConfirmation(Object.freeze({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 2,
      blockHash: 'ee'.repeat(32),
      blockHeight: 103
    }))
    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 2
    })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.calls.confirm).toBe(2)
  })

  test('keeps submitted receipt retryable when confirmation observation aborts', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const abortError = new Error('observer aborted')
    abortError.name = 'AbortError'
    harness.failConfirmation(abortError)

    await expectCode(harness.orchestrator.confirm(receipt.submissionId), 'ABORTED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.receipt.submissionId).toBe(receipt.submissionId)
    expect(state.receipt.txid).toBe(receipt.txid)
    expect(harness.calls.broadcast).toBe(1)

    harness.failConfirmation(null)
    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1
    })
    expect(harness.calls.broadcast).toBe(1)
  })

  test('requires positive safe integer confirmations before confirming submitted publications', async () => {
    const cases = [0, -1, Number.NaN, 1.5, 1]

    for (const confirmations of cases) {
      const harness = createHarness()
      const signedReview = await prepareAndSign(harness)
      const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
      harness.setConfirmation(Object.freeze({
        submissionId: receipt.submissionId,
        txid: receipt.txid,
        confirmations
      }))

      if (confirmations === 1) {
        await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
          confirmations: 1
        })
        expect(harness.orchestrator.getState().status).toBe('confirmed')
      } else {
        await expectCode(harness.orchestrator.confirm(receipt.submissionId), 'CONFIRMATION_FAILED')
        const state = harness.orchestrator.getState()
        expect(state.status).toBe('submitted')
        if (state.status !== 'submitted') throw new Error('expected submitted')
        expect(state.receipt.submissionId).toBe(receipt.submissionId)
        expect(state.receipt.txid).toBe(receipt.txid)
      }
    }
  })

  test('requires positive safe integer confirmations during reconciliation without losing uncertainty', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const deferred = harness.deferBroadcast()
    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    deferred.reject(new Error('timeout'))
    await expectCode(promise, 'BROADCAST_FAILED')
    const uncertain = harness.orchestrator.getState()
    if (uncertain.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: uncertain.uncertainty.txid,
      confirmations: 0
    }))

    await expectCode(harness.orchestrator.reconcile(), 'CONFIRMATION_FAILED')
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('broadcastUncertain')
    if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(state.uncertainty.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)
  })

  test('classifies coded operation aborts during reconciliation without losing uncertainty', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const deferred = harness.deferBroadcast()
    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    deferred.reject(new Error('timeout'))
    await expectCode(promise, 'BROADCAST_FAILED')
    const uncertain = harness.orchestrator.getState()
    if (uncertain.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    const codedAbort = new Error('operation aborted') as Error & { code: string }
    codedAbort.code = 'OPERATION_ABORTED'
    harness.failConfirmation(codedAbort)

    await expectCode(harness.orchestrator.reconcile(), 'ABORTED')
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('broadcastUncertain')
    if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(state.uncertainty.txid).toBe(signedReview.txid)
    expect(state.uncertainty.submissionId).toBe(uncertain.uncertainty.submissionId)
    expect(harness.calls.broadcast).toBe(1)
  })


})
