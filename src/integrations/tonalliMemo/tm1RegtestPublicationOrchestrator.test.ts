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
  let broadcastDecision: Tm1PublicationAuthorizationDecision = Object.freeze({
    status: 'approved',
    authorizationId: 'broadcast-auth-1'
  })
  let signerFailure: unknown = null
  let auditFailure: unknown = null
  let broadcastFailure: unknown = null
  let broadcastTxidOverride: string | null = null
  let confirmationOverride: Tm1Confirmation | null = null
  let onSigningAuthorization: (() => void) | null = null
  let onBroadcastAuthorization: (() => void) | null = null
  let broadcastDeferred: Deferred<Readonly<{ txid: string; disposition: 'accepted' }>> | null = null

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
        await new Tm1InMemoryDeliveryTransport().submit(signedArtifact)
        return Object.freeze({
          ...signedArtifact,
          rawTransactionBytes: new Uint8Array(signedArtifact.rawTransactionBytes)
        })
      }
    },
    broadcastAuthorization: {
      async requestBroadcastAuthorization(_signedReview, signal?: AbortSignal) {
        calls.broadcastAuthorization += 1
        onBroadcastAuthorization?.()
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        return broadcastDecision
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
    setBroadcastDecision: (next: Tm1PublicationAuthorizationDecision) => { broadcastDecision = next },
    failSigner: (error: unknown) => { signerFailure = error },
    failAudit: (error: unknown) => { auditFailure = error },
    failBroadcast: (error: unknown) => { broadcastFailure = error },
    setBroadcastTxid: (txid: string) => { broadcastTxidOverride = txid },
    setConfirmation: (confirmation: Tm1Confirmation) => { confirmationOverride = confirmation },
    onSigningAuthorization: (fn: () => void) => { onSigningAuthorization = fn },
    onBroadcastAuthorization: (fn: () => void) => { onBroadcastAuthorization = fn },
    deferBroadcast: () => {
      broadcastDeferred = createDeferred<Readonly<{ txid: string; disposition: 'accepted' }>>()
      return broadcastDeferred
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
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'broadcasting' })
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
})
