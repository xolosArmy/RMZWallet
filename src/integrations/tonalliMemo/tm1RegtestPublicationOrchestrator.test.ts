import { describe, expect, test } from 'vitest'
import { Tx, sha256d, toHex } from 'ecash-lib'
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
import {
  Tm1InMemoryDeliveryTransport,
  type Tm1RegtestDeliveryReceipt,
  type Tm1RegtestNetworkAttestation
} from './tm1RegtestDeliveryTransport'
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
  let attestationOverride: Tm1RegtestNetworkAttestation | null = null
  let signingDecision: Tm1PublicationAuthorizationDecision = Object.freeze({
    status: 'approved',
    authorizationId: 'sign-auth-1'
  })
  let broadcastDecision: Tm1BroadcastAuthorizationDecision | null = null
  let broadcastAuthorizationFailure: unknown = null
  let broadcastAuthorizationDeferred: Deferred<Tm1BroadcastAuthorizationDecision> | null = null
  let signingAuthorizationFailure: unknown = null
  let attestFailure: unknown = null
  let utxoFailure: unknown = null
  let signerFailure: unknown = null
  let auditFailure: unknown = null
  let auditMutator: ((artifact: RegtestSignedTransaction) => RegtestSignedTransaction) | null = null
  let auditReturnUnchecked: RegtestSignedTransaction | null = null
  const auditArtifacts: RegtestSignedTransaction[] = []
  let broadcastFailure: unknown = null
  let broadcastTxidOverride: string | null = null
  let confirmationOverride: Tm1Confirmation | null = null
  let confirmationFailure: unknown = null
  let confirmationDeferred: Deferred<Tm1Confirmation> | null = null
  let signerDeferred: Deferred<RegtestSignedTransaction> | null = null
  let auditDeferred: Deferred<RegtestSignedTransaction> | null = null
  let utxoDeferred: Deferred<readonly Tm1Draft02FreshUtxo[]> | null = null
  let onSigningAuthorization: (() => void) | null = null
  let onBroadcastAuthorization: (() => void) | null = null
  let broadcastDeferred: Deferred<Tm1RegtestDeliveryReceipt> | null = null
  let broadcastReceiptOverride: Tm1RegtestDeliveryReceipt | null = null
  let broadcastMutator: ((artifact: RegtestSignedTransaction) => void) | null = null
  let lastBroadcastArtifact: RegtestSignedTransaction | null = null
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
        return attestationOverride ?? Object.freeze({
          environment: 'deterministic-regtest-fixture',
          chainIdentity
        })
      }
    },
    utxoProvider: {
      async readUtxos(signal?: AbortSignal) {
        calls.utxos += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (utxoFailure) throw utxoFailure
        if (utxoDeferred) return utxoDeferred.promise
        return Object.freeze(cloneUtxos(utxos))
      }
    },
    signingAuthorization: {
      async requestSigningAuthorization(_review, signal?: AbortSignal) {
        calls.signingAuthorization += 1
        onSigningAuthorization?.()
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (signingAuthorizationFailure) throw signingAuthorizationFailure
        return signingDecision
      }
    },
    signer: {
      async sign(review, signal?: AbortSignal) {
        calls.signer += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (signerFailure) throw signerFailure
        if (signerDeferred) return signerDeferred.promise
        return signTm1Draft02RegtestCandidate({ candidate: review.candidate, signal })
      }
    },
    signedArtifactAudit: {
      async auditSignedArtifact({ signedArtifact }) {
        calls.audit += 1
        auditArtifacts.push(signedArtifact)
        if (auditFailure) throw auditFailure
        if (auditDeferred) return auditDeferred.promise
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
        if (broadcastAuthorizationFailure) throw broadcastAuthorizationFailure
        if (broadcastAuthorizationDeferred) return broadcastAuthorizationDeferred.promise
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
        lastBroadcastArtifact = signedArtifact
        broadcastMutator?.(signedArtifact)
        if (broadcastFailure) throw broadcastFailure
        if (broadcastDeferred) return broadcastDeferred.promise
        if (broadcastReceiptOverride) return broadcastReceiptOverride
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
        if (confirmationDeferred) return confirmationDeferred.promise
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
    setAttestation: (next: Tm1RegtestNetworkAttestation) => { attestationOverride = next },
    setSigningDecision: (next: Tm1PublicationAuthorizationDecision) => { signingDecision = next },
    setBroadcastDecision: (next: Tm1BroadcastAuthorizationDecision) => { broadcastDecision = next },
    failBroadcastAuthorization: (error: unknown) => { broadcastAuthorizationFailure = error },
    failSigningAuthorization: (error: unknown) => { signingAuthorizationFailure = error },
    failAttestation: (error: unknown) => { attestFailure = error },
    failUtxos: (error: unknown) => { utxoFailure = error },
    failSigner: (error: unknown) => { signerFailure = error },
    failAudit: (error: unknown) => { auditFailure = error },
    mutateAudit: (fn: (artifact: RegtestSignedTransaction) => RegtestSignedTransaction) => { auditMutator = fn },
    returnUncheckedAudit: (artifact: RegtestSignedTransaction) => { auditReturnUnchecked = artifact },
    failBroadcast: (error: unknown) => { broadcastFailure = error },
    setBroadcastTxid: (txid: string) => { broadcastTxidOverride = txid },
    setBroadcastReceipt: (receipt: Tm1RegtestDeliveryReceipt) => { broadcastReceiptOverride = receipt },
    setConfirmation: (confirmation: Tm1Confirmation) => { confirmationOverride = confirmation },
    failConfirmation: (error: unknown) => { confirmationFailure = error },
    onSigningAuthorization: (fn: () => void) => { onSigningAuthorization = fn },
    onBroadcastAuthorization: (fn: () => void) => { onBroadcastAuthorization = fn },
    deferBroadcast: () => {
      broadcastDeferred = createDeferred<Tm1RegtestDeliveryReceipt>()
      return broadcastDeferred
    },
    deferBroadcastAuthorization: () => {
      broadcastAuthorizationDeferred = createDeferred<Tm1BroadcastAuthorizationDecision>()
      return broadcastAuthorizationDeferred
    },
    mutateBroadcastArtifact: (fn: (artifact: RegtestSignedTransaction) => void) => { broadcastMutator = fn },
    getLastBroadcastArtifact: () => lastBroadcastArtifact,
    getAuditArtifacts: () => [...auditArtifacts],
    deferConfirmation: () => {
      confirmationDeferred = createDeferred<Tm1Confirmation>()
      return confirmationDeferred
    },
    deferSigner: () => {
      signerDeferred = createDeferred<RegtestSignedTransaction>()
      return signerDeferred
    },
    deferAudit: () => {
      auditDeferred = createDeferred<RegtestSignedTransaction>()
      return auditDeferred
    },
    deferAttestation: () => {
      attestDeferred = createDeferred<void>()
      return attestDeferred
    },
    deferUtxos: () => {
      utxoDeferred = createDeferred<readonly Tm1Draft02FreshUtxo[]>()
      return utxoDeferred
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

async function expectLateBroadcastAuthorizationAbort(
  status: Tm1BroadcastAuthorizationDecision['status']
): Promise<void> {
  const harness = createHarness()
  const signedReview = await prepareAndSign(harness)
  const deferred = harness.deferBroadcastAuthorization()
  const controller = new AbortController()
  const observed: Tm1PublicationState[] = []
  harness.orchestrator.subscribe(state => observed.push(state))

  const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId, controller.signal)

  await new Promise(resolve => setTimeout(resolve, 0))
  expect(harness.calls.broadcastAuthorization).toBe(1)
  controller.abort()
  if (status === 'approved') {
    deferred.resolve(Object.freeze({
      status,
      authorizationId: 'broadcast-auth-late',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    }))
  } else {
    deferred.resolve(Object.freeze({ status, reason: `late ${status}` }))
  }

  await expectCode(promise, 'ABORTED')
  expect(harness.calls.audit).toBe(1)
  expect(harness.calls.broadcast).toBe(0)
  expect(statuses(observed)).not.toContain('broadcasting')
  expect(harness.orchestrator.getState().status).toBe('aborted')
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

  test('snapshots approved signing authorization before re-attestation awaits', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const mutableDecision = { status: 'approved' as const, authorizationId: 'auth-original' }
    const attestation = harness.deferAttestation()
    const observedAuthorizationIds: string[] = []
    harness.setSigningDecision(mutableDecision)
    harness.orchestrator.subscribe(state => {
      if (state.status === 'revalidating' || state.status === 'signing') {
        observedAuthorizationIds.push(state.signingAuthorizationId)
      }
      if (state.status === 'signedReviewReady') {
        observedAuthorizationIds.push(state.signedReview.signingAuthorizationId)
      }
    })

    const promise = harness.orchestrator.authorizeAndSign(review.preparedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observedAuthorizationIds).toEqual(['auth-original'])
    mutableDecision.authorizationId = 'auth-mutated'
    attestation.resolve(undefined)

    const signedReview = await promise
    const state = harness.orchestrator.getState()
    expect(observedAuthorizationIds).toEqual([
      'auth-original',
      'auth-original',
      'auth-original'
    ])
    expect(observedAuthorizationIds).not.toContain('auth-mutated')
    expect(signedReview.signingAuthorizationId).toBe('auth-original')
    expect(state.status).toBe('signedReviewReady')
    if (state.status !== 'signedReviewReady') throw new Error('expected signed review')
    expect(state.signedReview.signingAuthorizationId).toBe('auth-original')
  })

  test('keeps signing authorization when provider mutates approved id to undefined', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const mutableDecision = { status: 'approved' as const, authorizationId: 'auth-original' }
    const attestation = harness.deferAttestation()
    harness.setSigningDecision(mutableDecision)

    const promise = harness.orchestrator.authorizeAndSign(review.preparedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    ;(mutableDecision as { authorizationId?: string }).authorizationId = undefined
    attestation.resolve(undefined)

    const signedReview = await promise
    const state = harness.orchestrator.getState()
    expect(signedReview.signingAuthorizationId).toBe('auth-original')
    expect(state.status).toBe('signedReviewReady')
    if (state.status !== 'signedReviewReady') throw new Error('expected signed review')
    expect(state.signedReview.signingAuthorizationId).toBe('auth-original')
  })

  test('keeps signing authorization stable during pending signing and later object reuse', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const mutableDecision = { status: 'approved' as const, authorizationId: 'auth-original' }
    const signer = harness.deferSigner()
    harness.setSigningDecision(mutableDecision)

    const promise = harness.orchestrator.authorizeAndSign(review.preparedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.signer).toBe(1)
    mutableDecision.authorizationId = 'auth-mutated-during-signing'
    signer.resolve(signTm1Draft02RegtestCandidate({ candidate: review.candidate }))

    const signedReview = await promise
    expect(signedReview.signingAuthorizationId).toBe('auth-original')
    mutableDecision.authorizationId = 'auth-reused-after-return'

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('signedReviewReady')
    if (state.status !== 'signedReviewReady') throw new Error('expected signed review')
    expect(state.signedReview.signingAuthorizationId).toBe('auth-original')
  })

  test('snapshots the initial network attestation before pending UTXO reads', async () => {
    const harness = createHarness()
    const adapterAttestation: Tm1RegtestNetworkAttestation = {
      environment: 'deterministic-regtest-fixture',
      chainIdentity: 'chain-A'
    }
    const utxoRead = harness.deferUtxos()
    const observedNetworks: Tm1RegtestNetworkAttestation[] = []
    harness.setAttestation(adapterAttestation)
    harness.orchestrator.subscribe(state => {
      if (state.status === 'preparing') observedNetworks.push(state.network)
      if (state.status === 'reviewReady') observedNetworks.push(state.review.network)
    })

    const promise = harness.orchestrator.prepare(DEFAULT_REQUEST)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observedNetworks).toHaveLength(1)
    expect(observedNetworks[0].chainIdentity).toBe('chain-A')
    ;(adapterAttestation as { chainIdentity: string }).chainIdentity = 'chain-B'
    utxoRead.resolve(fixtureUtxos())

    const review = await promise
    const state = harness.orchestrator.getState()
    expect(review.network.chainIdentity).toBe('chain-A')
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(state.review.network.chainIdentity).toBe('chain-A')
    expect(observedNetworks.map(network => network.chainIdentity)).toEqual(['chain-A', 'chain-A'])
    expect(review.network).not.toBe(adapterAttestation)
    expect(state.review.network).not.toBe(adapterAttestation)
  })

  test('keeps individual network identity fields stable after the attestation await', async () => {
    const harness = createHarness()
    const adapterAttestation: Tm1RegtestNetworkAttestation = {
      environment: 'deterministic-regtest-fixture',
      chainIdentity: 'chain-A'
    }
    const utxoRead = harness.deferUtxos()
    harness.setAttestation(adapterAttestation)

    const promise = harness.orchestrator.prepare(DEFAULT_REQUEST)

    await new Promise(resolve => setTimeout(resolve, 0))
    ;(adapterAttestation as { environment: string }).environment = 'mutated-environment'
    ;(adapterAttestation as { chainIdentity: string }).chainIdentity = 'chain-B'
    utxoRead.resolve(fixtureUtxos())

    const review = await promise
    expect(review.network).toEqual({
      environment: 'deterministic-regtest-fixture',
      chainIdentity: 'chain-A'
    })
  })

  test('keeps prepared reviews isolated when the attestation adapter reuses an object', async () => {
    const harness = createHarness()
    const adapterAttestation: Tm1RegtestNetworkAttestation = {
      environment: 'deterministic-regtest-fixture',
      chainIdentity: 'chain-A'
    }
    harness.setAttestation(adapterAttestation)

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    ;(adapterAttestation as { chainIdentity: string }).chainIdentity = 'chain-B'

    const state = harness.orchestrator.getState()
    expect(review.network.chainIdentity).toBe('chain-A')
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(state.review.network.chainIdentity).toBe('chain-A')
    expect(review.network).not.toBe(adapterAttestation)
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

  test('maps broadcast authorization service failures to BROADCAST_FAILED', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failBroadcastAuthorization(new Error('broadcast authorization service unavailable'))

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(state.error.code).toBe('BROADCAST_FAILED')
    expect(state.error.code).not.toBe('INVALID_STATE')
    expect(harness.calls.broadcast).toBe(0)
  })

  test('keeps invalid approveAndBroadcast lifecycle calls classified as INVALID_STATE', async () => {
    const harness = createHarness()

    await expectCode(harness.orchestrator.approveAndBroadcast('missing'), 'INVALID_STATE')
    expect(harness.calls.broadcastAuthorization).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
  })

  test('keeps abort during broadcast authorization classified as ABORTED', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const controller = new AbortController()
    controller.abort()

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId, controller.signal), 'ABORTED')
    expect(harness.calls.broadcastAuthorization).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
  })

  test('aborts when broadcast authorization resolves approved after abort', async () => {
    await expectLateBroadcastAuthorizationAbort('approved')
  })

  test('aborts when broadcast authorization resolves rejected after abort', async () => {
    await expectLateBroadcastAuthorizationAbort('rejected')
  })

  test('aborts when broadcast authorization resolves expired after abort', async () => {
    await expectLateBroadcastAuthorizationAbort('expired')
  })

  test('snapshots approved broadcast authorization before artifact audit awaits', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'broadcast-auth-original',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    }
    const audit = harness.deferAudit()
    const observedAuthorizationIds: string[] = []
    harness.setBroadcastDecision(mutableDecision)
    harness.orchestrator.subscribe(state => {
      if (state.status === 'broadcasting') observedAuthorizationIds.push(state.broadcastAuthorizationId)
    })

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.audit).toBe(2)
    mutableDecision.authorizationId = 'broadcast-auth-mutated'
    audit.resolve(signedReview.signedArtifact)

    const receipt = await promise
    const state = harness.orchestrator.getState()
    expect(receipt.txid).toBe(signedReview.txid)
    expect(state.status).toBe('submitted')
    expect(observedAuthorizationIds[0]).toBe('broadcast-auth-original')
    expect(observedAuthorizationIds).not.toContain('broadcast-auth-mutated')
  })

  test('keeps broadcast authorization when provider mutates approved id to undefined', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'broadcast-auth-original',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    }
    const audit = harness.deferAudit()
    const observedAuthorizationIds: string[] = []
    harness.setBroadcastDecision(mutableDecision)
    harness.orchestrator.subscribe(state => {
      if (state.status === 'broadcasting') observedAuthorizationIds.push(state.broadcastAuthorizationId)
    })

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    ;(mutableDecision as { authorizationId?: string }).authorizationId = undefined
    audit.resolve(signedReview.signedArtifact)

    await expect(promise).resolves.toMatchObject({ txid: signedReview.txid })
    expect(observedAuthorizationIds).toEqual(['broadcast-auth-original'])
  })

  test('keeps original broadcast authorization id in broadcastUncertain after post-dispatch failure', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'broadcast-auth-original',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    }
    const broadcast = harness.deferBroadcast()
    harness.setBroadcastDecision(mutableDecision)

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.broadcast).toBe(1)
    mutableDecision.authorizationId = 'broadcast-auth-mutated'
    broadcast.reject(new Error('transport uncertain after dispatch'))

    await expectCode(promise, 'BROADCAST_FAILED')
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('broadcastUncertain')
    if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(state.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-original')
    expect(state.uncertainty.broadcastAuthorizationId).not.toBe('broadcast-auth-mutated')
  })

  test('keeps broadcast authorization stable when provider reuses the decision object', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'broadcast-auth-original',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    }
    const broadcast = harness.deferBroadcast()
    harness.setBroadcastDecision(mutableDecision)

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    mutableDecision.authorizationId = 'broadcast-auth-reused'
    broadcast.resolve(Object.freeze({ txid: signedReview.txid, disposition: 'accepted' as const }))

    const receipt = await promise
    expect(receipt.txid).toBe(signedReview.txid)
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.receipt.txid).toBe(signedReview.txid)
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

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'INVALID_STATE')
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

  test('does not add subscribers created during a transition to the active dispatch', async () => {
    const harness = createHarness()
    const attestation = harness.deferAttestation()
    const events: string[] = []
    let subscribedDuringTransition = false

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'attesting' || subscribedDuringTransition) return
      events.push('A')
      subscribedDuringTransition = true
      harness.orchestrator.subscribe(next => {
        if (next.status === 'attesting') events.push('B-immediate')
      })
      harness.orchestrator.subscribe(next => {
        if (next.status === 'attesting') events.push('C-immediate')
      })
    })

    const promise = harness.orchestrator.prepare(DEFAULT_REQUEST)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(['A', 'B-immediate', 'C-immediate'])
    attestation.resolve(undefined)
    await promise
    expect(events).toEqual(['A', 'B-immediate', 'C-immediate'])
  })

  test('notifies transition-start listener snapshot even when a listener unsubscribes another', async () => {
    const harness = createHarness()
    const attestation = harness.deferAttestation()
    const events: string[] = []
    let unsubscribeB: () => void = () => undefined

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'attesting') return
      events.push('A-attesting')
      unsubscribeB()
    })
    unsubscribeB = harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting' || state.status === 'preparing') {
        events.push(`B-${state.status}`)
      }
    })

    const promise = harness.orchestrator.prepare(DEFAULT_REQUEST)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(['A-attesting', 'B-attesting'])
    attestation.resolve(undefined)
    await promise
    expect(events).toEqual(['A-attesting', 'B-attesting'])
  })

  test('subscriber exceptions still isolate later listeners with transition listener snapshots', async () => {
    const harness = createHarness()
    const observed: string[] = []
    harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting') throw new Error('listener A failed')
    })
    harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting') observed.push('B')
    })
    harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting') observed.push('C')
    })

    await harness.orchestrator.prepare(DEFAULT_REQUEST)

    expect(observed).toEqual(['B', 'C'])
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

  test('delivery transport receives a defensive copy of the signed artifact', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const stateBefore = harness.orchestrator.getState()
    if (stateBefore.status !== 'signedReviewReady') throw new Error('expected signed review')
    const originalHex = signedReview.signedArtifact.rawTransactionHex
    const originalHash = signedReview.signedArtifactHash

    harness.mutateBroadcastArtifact(input => {
      expect(input.rawTransactionBytes).not.toBe(signedReview.signedArtifact.rawTransactionBytes)
      expect(input.rawTransactionBytes).not.toBe(stateBefore.signedReview.signedArtifact.rawTransactionBytes)
      input.rawTransactionBytes[0] ^= 0xff
    })

    await expect(harness.orchestrator.approveAndBroadcast(signedReview.signedId)).resolves.toMatchObject({
      txid: signedReview.txid
    })

    const transportArtifact = harness.getLastBroadcastArtifact()
    if (transportArtifact === null) throw new Error('expected transport artifact')
    expect(toHex(transportArtifact.rawTransactionBytes)).not.toBe(originalHex)
    expect(toHex(signedReview.signedArtifact.rawTransactionBytes)).toBe(originalHex)
    expect(toHex(stateBefore.signedReview.signedArtifact.rawTransactionBytes)).toBe(originalHex)
    expect(signedReview.signedArtifactHash).toBe(originalHash)
    expect(toHex(sha256d(signedReview.signedArtifact.rawTransactionBytes))).toBe(originalHash)
    expect(Tx.fromHex(originalHex).txid()).toBe(signedReview.txid)

    const submitted = harness.orchestrator.getState()
    expect(submitted.status).toBe('submitted')
    if (submitted.status !== 'submitted') throw new Error('expected submitted')
    expect(submitted.signedReview.txid).toBe(signedReview.txid)
    expect(submitted.signedReview.signedArtifactHash).toBe(originalHash)
    expect(toHex(submitted.signedReview.signedArtifact.rawTransactionBytes)).toBe(originalHex)
    expect(submitted.receipt.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)

    transportArtifact.rawTransactionBytes[1] ^= 0xff
    const afterReturn = harness.orchestrator.getState()
    expect(afterReturn.status).toBe('submitted')
    if (afterReturn.status !== 'submitted') throw new Error('expected submitted')
    expect(toHex(afterReturn.signedReview.signedArtifact.rawTransactionBytes)).toBe(originalHex)
    expect(afterReturn.signedReview.signedArtifactHash).toBe(originalHash)
    expect(afterReturn.receipt.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)
  })

  test('broadcast re-audit receives a defensive copy and ignores retained mutations during pending transport', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const stateBefore = harness.orchestrator.getState()
    if (stateBefore.status !== 'signedReviewReady') throw new Error('expected signed review')
    const originalHex = signedReview.signedArtifact.rawTransactionHex
    const originalHash = signedReview.signedArtifactHash
    const broadcast = harness.deferBroadcast()

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(1)
    const auditArtifacts = harness.getAuditArtifacts()
    expect(auditArtifacts).toHaveLength(2)
    const retainedAuditArtifact = auditArtifacts[1]
    if (retainedAuditArtifact === undefined) throw new Error('expected retained audit artifact')
    const transportArtifact = harness.getLastBroadcastArtifact()
    if (transportArtifact === null) throw new Error('expected transport artifact')
    expect(retainedAuditArtifact).not.toBe(signedReview.signedArtifact)
    expect(retainedAuditArtifact).not.toBe(stateBefore.signedReview.signedArtifact)
    expect(retainedAuditArtifact.rawTransactionBytes).not.toBe(signedReview.signedArtifact.rawTransactionBytes)
    expect(retainedAuditArtifact.rawTransactionBytes).not.toBe(stateBefore.signedReview.signedArtifact.rawTransactionBytes)
    expect(transportArtifact).not.toBe(retainedAuditArtifact)
    expect(transportArtifact.rawTransactionBytes).not.toBe(retainedAuditArtifact.rawTransactionBytes)

    retainedAuditArtifact.rawTransactionBytes[0] ^= 0xff
    broadcast.resolve(Object.freeze({ txid: signedReview.txid, disposition: 'accepted' as const }))

    const receipt = await promise
    expect(receipt.txid).toBe(signedReview.txid)
    expect(receipt.deliveryReceipt.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)
    const submitted = harness.orchestrator.getState()
    expect(submitted.status).toBe('submitted')
    if (submitted.status !== 'submitted') throw new Error('expected submitted')
    expect(submitted.signedReview.txid).toBe(signedReview.txid)
    expect(submitted.signedReview.signedArtifactHash).toBe(originalHash)
    expect(toHex(submitted.signedReview.signedArtifact.rawTransactionBytes)).toBe(originalHex)
    expect(submitted.receipt.txid).toBe(signedReview.txid)
    expect(toHex(sha256d(submitted.signedReview.signedArtifact.rawTransactionBytes))).toBe(originalHash)
  })

  test('retained broadcast audit artifact mutations after return cannot affect submitted state', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const originalHex = signedReview.signedArtifact.rawTransactionHex
    const originalHash = signedReview.signedArtifactHash

    await expect(harness.orchestrator.approveAndBroadcast(signedReview.signedId)).resolves.toMatchObject({
      txid: signedReview.txid
    })

    const auditArtifacts = harness.getAuditArtifacts()
    const retainedAuditArtifact = auditArtifacts[1]
    if (retainedAuditArtifact === undefined) throw new Error('expected retained audit artifact')
    retainedAuditArtifact.rawTransactionBytes[0] ^= 0xff

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.signedReview.txid).toBe(signedReview.txid)
    expect(state.signedReview.signedArtifactHash).toBe(originalHash)
    expect(toHex(state.signedReview.signedArtifact.rawTransactionBytes)).toBe(originalHex)
    expect(state.receipt.txid).toBe(signedReview.txid)
    expect(state.receipt.deliveryReceipt.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)
  })

  test('snapshots delivery receipt before storing and returning it', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const transportReceipt: Tm1RegtestDeliveryReceipt = {
      txid: signedReview.txid,
      disposition: 'accepted'
    }
    harness.setBroadcastReceipt(transportReceipt)

    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const submitted = harness.orchestrator.getState()

    expect(submitted.status).toBe('submitted')
    if (submitted.status !== 'submitted') throw new Error('expected submitted')
    expect(receipt.deliveryReceipt).not.toBe(transportReceipt)
    expect(submitted.receipt.deliveryReceipt).not.toBe(transportReceipt)
    expect(Object.isFrozen(receipt.deliveryReceipt)).toBe(true)
    expect(receipt.deliveryReceipt.txid).toBe(signedReview.txid)
    expect(submitted.receipt.deliveryReceipt.txid).toBe(signedReview.txid)

    ;(transportReceipt as { txid: string }).txid = '00'.repeat(32)
    ;(transportReceipt as { disposition: 'accepted' }).disposition = 'accepted'

    const afterMutation = harness.orchestrator.getState()
    expect(receipt.txid).toBe(signedReview.txid)
    expect(receipt.deliveryReceipt.txid).toBe(signedReview.txid)
    expect(receipt.deliveryReceipt.disposition).toBe('accepted')
    expect(afterMutation.status).toBe('submitted')
    if (afterMutation.status !== 'submitted') throw new Error('expected submitted')
    expect(afterMutation.receipt.txid).toBe(signedReview.txid)
    expect(afterMutation.receipt.deliveryReceipt.txid).toBe(signedReview.txid)
    expect(afterMutation.receipt.deliveryReceipt.disposition).toBe('accepted')
  })

  test('caller mutation of returned delivery receipt cannot affect submitted state', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    expect(() => {
      (receipt.deliveryReceipt as { txid: string }).txid = '00'.repeat(32)
    }).toThrow(TypeError)
    expect(() => {
      (receipt as { txid: string }).txid = '11'.repeat(32)
    }).toThrow(TypeError)

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.receipt.txid).toBe(signedReview.txid)
    expect(state.receipt.deliveryReceipt.txid).toBe(signedReview.txid)
  })

  test('isolates submitted receipt delivery receipts between subscribers', async () => {
    const harness = createHarness()
    const listenerReceipts: Tm1RegtestDeliveryReceipt[] = []

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'submitted') return
      listenerReceipts.push(state.receipt.deliveryReceipt)
      try {
        ;(state.receipt.deliveryReceipt as { txid: string }).txid = '00'.repeat(32)
      } catch {
        // The mutation attempt is the assertion; subscriber exceptions must remain isolated.
      }
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'submitted') return
      listenerReceipts.push(state.receipt.deliveryReceipt)
    })

    const signedReview = await prepareAndSign(harness)
    await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    expect(listenerReceipts).toHaveLength(2)
    expect(listenerReceipts[0]).not.toBe(listenerReceipts[1])
    expect(listenerReceipts[1].txid).toBe(signedReview.txid)
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.receipt.deliveryReceipt.txid).toBe(signedReview.txid)
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

  test('rejects reentrant prepare from reset idle notification until reset returns', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let reentrantPrepare: Promise<unknown> | null = null
    const observed: string[] = []

    harness.orchestrator.subscribe(state => {
      if (state.status === 'idle') {
        observed.push(state.status)
        reentrantPrepare = harness.orchestrator.prepare({
          ...DEFAULT_REQUEST,
          message: 'reentrant publication from reset'
        })
      }
    })

    expect(() => harness.orchestrator.reset()).not.toThrow()
    expect(harness.orchestrator.getState().status).toBe('idle')
    expect(observed).toEqual(['idle'])
    if (reentrantPrepare === null) throw new Error('expected reentrant prepare')
    await expectCode(reentrantPrepare, 'PUBLICATION_ALREADY_ACTIVE')
    expect(harness.orchestrator.getState().status).toBe('idle')
    expect(harness.calls.attest).toBe(1)

    await expect(harness.orchestrator.prepare({
      ...DEFAULT_REQUEST,
      message: 'normal publication after reset'
    })).resolves.toMatchObject({ message: 'normal publication after reset' })
    expect(harness.calls.attest).toBe(2)
  })

  test('reset idle subscribers receive the reset snapshot before reentrant attempts can transition', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const events: string[] = []
    let reentrantPrepare: Promise<unknown> | null = null

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'idle') return
      events.push('A:idle')
      reentrantPrepare = harness.orchestrator.prepare({
        ...DEFAULT_REQUEST,
        message: 'subscriber A reentrant prepare'
      })
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'idle') return
      events.push('B:' + state.status)
    })

    harness.orchestrator.reset()

    expect(events).toEqual(['A:idle', 'B:idle'])
    if (reentrantPrepare === null) throw new Error('expected reentrant prepare')
    await expectCode(reentrantPrepare, 'PUBLICATION_ALREADY_ACTIVE')
    expect(harness.orchestrator.getState().status).toBe('idle')
    expect(harness.calls.attest).toBe(1)
  })

  test('subscriber exceptions during reset idle notification do not leak the operation guard', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const observed: string[] = []

    harness.orchestrator.subscribe(state => {
      if (state.status === 'idle') throw new Error('idle subscriber failed')
    })
    harness.orchestrator.subscribe(state => observed.push(state.status))

    expect(() => harness.orchestrator.reset()).not.toThrow()
    expect(harness.orchestrator.getState().status).toBe('idle')
    expect(observed).toContain('idle')

    await expect(harness.orchestrator.prepare({
      ...DEFAULT_REQUEST,
      message: 'normal publication after throwing reset subscriber'
    })).resolves.toMatchObject({ message: 'normal publication after throwing reset subscriber' })
    expect(harness.orchestrator.getState().status).toBe('reviewReady')
    expect(harness.calls.attest).toBe(2)
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


  test('maps ordinary prepare attestation failures to PREPARATION_FAILED', async () => {
    const harness = createHarness()
    harness.failAttestation(new Error('attestation transport unavailable'))

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(state.error.code).toBe('PREPARATION_FAILED')
    expect(state.error.code).not.toBe('INVALID_STATE')
  })

  test('maps ordinary prepare UTXO provider failures to PREPARATION_FAILED', async () => {
    const harness = createHarness()
    harness.failUtxos(new Error('utxo provider unavailable'))

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(state.error.code).toBe('PREPARATION_FAILED')
    expect(state.error.code).not.toBe('INVALID_STATE')
  })

  test('keeps invalid prepare lifecycle calls classified as INVALID_STATE', async () => {
    const harness = createHarness()
    await harness.orchestrator.prepare(DEFAULT_REQUEST)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'INVALID_STATE')
  })

  test('keeps abort during prepare classified as ABORTED', async () => {
    const harness = createHarness()
    const attestation = harness.deferAttestation()
    const controller = new AbortController()
    const promise = harness.orchestrator.prepare(DEFAULT_REQUEST, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    attestation.resolve(undefined)

    await expectCode(promise, 'ABORTED')
    expect(harness.orchestrator.getState().status).toBe('aborted')
  })

  test('respects abort after confirm observer resolves and preserves submitted retry state', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const deferred = harness.deferConfirmation()
    const controller = new AbortController()
    const promise = harness.orchestrator.confirm(receipt.submissionId, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    deferred.resolve(Object.freeze({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1,
      blockHash: 'ff'.repeat(32),
      blockHeight: 104
    }))

    await expectCode(promise, 'ABORTED')
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.receipt.submissionId).toBe(receipt.submissionId)
    expect(state.receipt.txid).toBe(receipt.txid)
    expect(state.signedReview.signedId).toBe(signedReview.signedId)
    expect(state.signedReview.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)

    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1
    })
    expect(harness.calls.broadcast).toBe(1)
  })

  test('respects abort after reconcile observer resolves and preserves uncertainty without rebroadcast', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const broadcast = harness.deferBroadcast()
    const broadcastPromise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    broadcast.reject(new Error('timeout after dispatch'))
    await expectCode(broadcastPromise, 'BROADCAST_FAILED')

    const uncertain = harness.orchestrator.getState()
    expect(uncertain.status).toBe('broadcastUncertain')
    if (uncertain.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    const deferred = harness.deferConfirmation()
    const controller = new AbortController()
    const reconcilePromise = harness.orchestrator.reconcile(controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    deferred.resolve(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: uncertain.uncertainty.txid,
      confirmations: 1,
      blockHash: 'aa'.repeat(32),
      blockHeight: 105
    }))

    await expectCode(reconcilePromise, 'ABORTED')
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('broadcastUncertain')
    if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(state.uncertainty.submissionId).toBe(uncertain.uncertainty.submissionId)
    expect(state.uncertainty.txid).toBe(uncertain.uncertainty.txid)
    expect(state.uncertainty.signedArtifactHash).toBe(uncertain.uncertainty.signedArtifactHash)
    expect(state.signedReview.txid).toBe(signedReview.txid)
    expect(harness.calls.broadcast).toBe(1)
  })

  test('isolates raw transaction bytes between transition subscribers', async () => {
    const harness = createHarness()
    let listenerABytes: Uint8Array | null = null
    let listenerBBytes: Uint8Array | null = null

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'signedReviewReady') return
      listenerABytes = state.signedReview.signedArtifact.rawTransactionBytes
      listenerABytes[0] ^= 0xff
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'signedReviewReady') return
      listenerBBytes = state.signedReview.signedArtifact.rawTransactionBytes
    })

    const signedReview = await prepareAndSign(harness)
    if (listenerABytes === null || listenerBBytes === null) throw new Error('expected listener bytes')
    expect(listenerABytes).not.toBe(listenerBBytes)
    expect(toHex(listenerBBytes)).toBe(signedReview.signedArtifact.rawTransactionHex)

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('signedReviewReady')
    if (state.status !== 'signedReviewReady') throw new Error('expected signed review')
    expect(toHex(state.signedReview.signedArtifact.rawTransactionBytes)).toBe(signedReview.signedArtifact.rawTransactionHex)
    expect(state.signedReview.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(state.signedReview.txid).toBe(signedReview.txid)
  })

  test('isolates effective content bytes between transition subscribers', async () => {
    const harness = createHarness()
    let listenerABytes: Uint8Array | null = null
    let listenerBBytes: Uint8Array | null = null

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'reviewReady') return
      listenerABytes = state.review.effectiveContent
      listenerABytes[0] ^= 0xff
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'reviewReady') return
      listenerBBytes = state.review.effectiveContent
    })

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    if (listenerABytes === null || listenerBBytes === null) throw new Error('expected listener bytes')
    expect(listenerABytes).not.toBe(listenerBBytes)
    expect(toHex(listenerBBytes)).toBe(toHex(review.effectiveContent))

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(toHex(state.review.effectiveContent)).toBe(toHex(review.effectiveContent))
    expect(state.review.bindingHash).toBe(review.bindingHash)
  })

  test('isolates mutable bytes during initial subscription notifications', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let firstBytes: Uint8Array | null = null
    let secondBytes: Uint8Array | null = null

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'reviewReady') return
      firstBytes = state.review.effectiveContent
      firstBytes[0] ^= 0xff
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'reviewReady') return
      secondBytes = state.review.effectiveContent
    })

    if (firstBytes === null || secondBytes === null) throw new Error('expected subscription bytes')
    expect(firstBytes).not.toBe(secondBytes)
    expect(toHex(secondBytes)).toBe(toHex(review.effectiveContent))
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(toHex(state.review.effectiveContent)).toBe(toHex(review.effectiveContent))
  })


  test('aborts after signer resolves when signer ignored the signal', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const deferred = harness.deferSigner()
    const controller = new AbortController()
    const promise = harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.signer).toBe(1)
    controller.abort()
    deferred.resolve(signTm1Draft02RegtestCandidate({ candidate: review.candidate }))

    await expectCode(promise, 'ABORTED')
    expect(harness.calls.audit).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('aborted')
  })

  test('aborts after signed artifact audit resolves when auditor ignored the signal', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const audited = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    const deferred = harness.deferAudit()
    const controller = new AbortController()
    const promise = harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.signer).toBe(1)
    expect(harness.calls.audit).toBe(1)
    controller.abort()
    deferred.resolve(audited)

    await expectCode(promise, 'ABORTED')
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('aborted')
    expect(state.status).not.toBe('signedReviewReady')
    expect(harness.calls.broadcast).toBe(0)
  })

  test('maps authorizeAndSign dependency failures to stage codes instead of INVALID_STATE', async () => {
    const authorizationHarness = createHarness()
    const authorizationReview = await authorizationHarness.orchestrator.prepare(DEFAULT_REQUEST)
    authorizationHarness.failSigningAuthorization(new Error('authorization service unavailable'))
    await expectCode(authorizationHarness.orchestrator.authorizeAndSign(authorizationReview.preparedId), 'SIGNING_FAILED')
    const authorizationState = authorizationHarness.orchestrator.getState()
    expect(authorizationState.status).toBe('failed')
    if (authorizationState.status !== 'failed') throw new Error('expected failed')
    expect(authorizationState.error.code).not.toBe('INVALID_STATE')

    const attestationHarness = createHarness()
    const attestationReview = await attestationHarness.orchestrator.prepare(DEFAULT_REQUEST)
    attestationHarness.failAttestation(new Error('re-attestation unavailable'))
    await expectCode(attestationHarness.orchestrator.authorizeAndSign(attestationReview.preparedId), 'CANDIDATE_REVALIDATION_FAILED')

    const utxoHarness = createHarness()
    const utxoReview = await utxoHarness.orchestrator.prepare(DEFAULT_REQUEST)
    utxoHarness.failUtxos(new Error('utxo refresh unavailable'))
    await expectCode(utxoHarness.orchestrator.authorizeAndSign(utxoReview.preparedId), 'CANDIDATE_REVALIDATION_FAILED')

    const signerHarness = createHarness()
    const signerReview = await signerHarness.orchestrator.prepare(DEFAULT_REQUEST)
    signerHarness.failSigner(new Error('signer unavailable'))
    await expectCode(signerHarness.orchestrator.authorizeAndSign(signerReview.preparedId), 'SIGNING_FAILED')

    const lifecycleHarness = createHarness()
    await expectCode(lifecycleHarness.orchestrator.authorizeAndSign('missing'), 'INVALID_STATE')

    const abortHarness = createHarness()
    const abortReview = await abortHarness.orchestrator.prepare(DEFAULT_REQUEST)
    const controller = new AbortController()
    controller.abort()
    await expectCode(abortHarness.orchestrator.authorizeAndSign(abortReview.preparedId, controller.signal), 'ABORTED')
  })

  test('isolates failed errors between thrown errors and state snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failSigner(new Error('fixture signer failed'))
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.authorizeAndSign(review.preparedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected thrown error')
    const first = harness.orchestrator.getState()
    expect(first.status).toBe('failed')
    if (first.status !== 'failed') throw new Error('expected failed')
    expect(first.error).not.toBe(thrown)
    expect(first.error.code).toBe('SIGNING_FAILED')

    ;(thrown as { code: string; message: string }).code = 'INVALID_STATE'
    ;(thrown as { code: string; message: string }).message = 'mutated thrown'
    ;(first.error as { code: string; message: string }).code = 'INVALID_STATE'
    ;(first.error as { code: string; message: string }).message = 'mutated snapshot'

    const second = harness.orchestrator.getState()
    expect(second.status).toBe('failed')
    if (second.status !== 'failed') throw new Error('expected failed')
    expect(second.error.code).toBe('SIGNING_FAILED')
    expect(second.error.message).toBe('SIGNING_FAILED')
  })

  test('isolates failed errors between subscribers', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failSigner(new Error('fixture signer failed'))
    const listenerAErrors: Tm1PublicationError[] = []
    const listenerBErrors: Tm1PublicationError[] = []

    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      listenerAErrors.push(state.error)
      ;(state.error as { code: string; message: string }).code = 'INVALID_STATE'
      ;(state.error as { code: string; message: string }).message = 'mutated listener'
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      listenerBErrors.push(state.error)
    })

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    expect(listenerAErrors).toHaveLength(1)
    expect(listenerBErrors).toHaveLength(1)
    expect(listenerAErrors[0]).not.toBe(listenerBErrors[0])
    expect(listenerBErrors[0].code).toBe('SIGNING_FAILED')
    expect(listenerBErrors[0].message).toBe('SIGNING_FAILED')
  })

  test('isolates broadcast uncertainty errors and preserves reconciliation metadata', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failBroadcast(new Error('transport failed after dispatch'))
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.approveAndBroadcast(signedReview.signedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected broadcast error')
    const first = harness.orchestrator.getState()
    expect(first.status).toBe('broadcastUncertain')
    if (first.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    const { submissionId, txid, signedArtifactHash } = first.uncertainty
    const signedArtifactHex = first.uncertainty.signedArtifact.rawTransactionHex
    expect(first.uncertainty.error).not.toBe(thrown)

    ;(thrown as { code: string; message: string }).code = 'INVALID_STATE'
    ;(thrown as { code: string; message: string }).message = 'mutated thrown'
    ;(first.uncertainty.error as { code: string; message: string }).code = 'INVALID_STATE'
    ;(first.uncertainty.error as { code: string; message: string }).message = 'mutated uncertainty'

    const second = harness.orchestrator.getState()
    expect(second.status).toBe('broadcastUncertain')
    if (second.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(second.uncertainty.error.code).toBe('BROADCAST_FAILED')
    expect(second.uncertainty.error.message).toBe('BROADCAST_FAILED')
    expect(second.uncertainty.submissionId).toBe(submissionId)
    expect(second.uncertainty.txid).toBe(txid)
    expect(second.uncertainty.signedArtifactHash).toBe(signedArtifactHash)
    expect(second.uncertainty.signedArtifact.rawTransactionHex).toBe(signedArtifactHex)

    harness.failConfirmation(null)
    harness.setConfirmation(Object.freeze({
      submissionId,
      txid,
      confirmations: 1,
      blockHash: 'ab'.repeat(32),
      blockHeight: 106
    }))
    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({ submissionId, txid })
    const confirmed = harness.orchestrator.getState()
    expect(confirmed.status).toBe('confirmed')
    if (confirmed.status !== 'confirmed') throw new Error('expected confirmed')
    expect(confirmed.receipt.submissionId).toBe(submissionId)
    expect(confirmed.receipt.txid).toBe(txid)
    expect(signedReview.signedArtifactHash).toBe(signedArtifactHash)
    expect(signedReview.signedArtifact.rawTransactionHex).toBe(signedArtifactHex)
  })

})
