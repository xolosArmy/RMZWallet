import { describe, expect, test } from 'vitest'
import { Script, Tx, fromHex, isPushOp, sha256d, toHex } from 'ecash-lib'
import { XEC_DUST_SATS } from '../../config/xecFees'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  encodeTm1Draft02CandidateEffectiveContent,
  type Tm1Draft02FreshUtxo
} from './tm1Draft02Candidate'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX,
  signTm1Draft02RegtestCandidate,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
import {
  Tm1InMemoryDeliveryTransport,
  Tm1RegtestDeliveryTransportError,
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
  type Tm1PublicationClock,
  type Tm1RegtestPublicationDependencies,
  type Tm1SigningAuthorizationRequest,
  type Tm1SignedReview
} from './tm1RegtestPublicationOrchestrator'

const TXID_A = 'aa'.repeat(32)
const TXID_B = 'bb'.repeat(32)
const WRONG_VALID_COMPRESSED_PUBLIC_KEY_HEX =
  `03${TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX.slice(2)}`
const NON_FIXTURE_P2PKH_LOCKING_SCRIPT_HEX =
  '76a914111111111111111111111111111111111111111188ac'
const NO_AUDIT_OVERRIDE = Symbol('NO_AUDIT_OVERRIDE')
const NO_BROADCAST_FAILURE = Symbol('NO_BROADCAST_FAILURE')
const NO_ATTESTATION_OVERRIDE = Symbol('NO_ATTESTATION_OVERRIDE')
const NO_UTXO_OVERRIDE = Symbol('NO_UTXO_OVERRIDE')
const NO_GENERATED_ID_OVERRIDE = Symbol('NO_GENERATED_ID_OVERRIDE')
const DEFAULT_REQUEST: Tm1PublicationRequest = Object.freeze({
  message: 'TM1 orchestrator regtest publication',
  activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  maxFeeSats: 10_000n
})
const INVALID_CONFIRMATION_BLOCK_HASHES = [
  ['non-canonical text', 'not-a-hash'],
  ['63 hexadecimal characters', 'a'.repeat(63)],
  ['65 hexadecimal characters', 'a'.repeat(65)],
  ['a non-hexadecimal character', `${'a'.repeat(63)}g`],
  ['a 0x prefix', `0x${'a'.repeat(64)}`],
  ['leading whitespace', ` ${'a'.repeat(64)}`],
  ['trailing whitespace', `${'a'.repeat(64)} `],
  ['uppercase hexadecimal', 'A'.repeat(64)]
] as const

type Harness = ReturnType<typeof createHarness>

type MutableTm1RegtestPublicationDependencies = {
  -readonly [Key in keyof Tm1RegtestPublicationDependencies]:
  Tm1RegtestPublicationDependencies[Key]
}

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

function nativeAbortReason(): unknown {
  const controller = new AbortController()
  controller.abort()
  return controller.signal.reason
}

function awaitCooperativeAudit<T>(
  deferred: Deferred<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Tm1PublicationError('ABORTED'))
  if (signal === undefined) return deferred.promise

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(new Tm1PublicationError('ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    deferred.promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

function awaitCooperativeUtxos<T>(
  deferred: Deferred<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (signal === undefined) return deferred.promise

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    deferred.promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

function mutateSignedArtifactTransaction(
  artifact: RegtestSignedTransaction,
  mutate: (transaction: Tx) => void
): RegtestSignedTransaction {
  const transaction = Tx.fromHex(artifact.rawTransactionHex)
  mutate(transaction)
  const rawTransactionBytes = transaction.ser()
  return Object.freeze({
    ...artifact,
    inputCount: transaction.inputs.length,
    txid: transaction.txid(),
    rawTransactionHex: toHex(rawTransactionBytes),
    rawTransactionBytes: new Uint8Array(rawTransactionBytes)
  })
}

type P2pkhUnlocking = Readonly<{
  signature: Uint8Array
  publicKey: Uint8Array
}>

function mutateSignedArtifactP2pkhUnlocking(
  artifact: RegtestSignedTransaction,
  inputIndex: number,
  mutate: (unlocking: P2pkhUnlocking) => P2pkhUnlocking
): RegtestSignedTransaction {
  return mutateSignedArtifactTransaction(artifact, transaction => {
    const transactionInput = transaction.inputs[inputIndex]
    if (!transactionInput) throw new Error(`expected input ${inputIndex}`)
    const operations = transactionInput.script?.ops()
    const signaturePush = operations?.next()
    const publicKeyPush = operations?.next()
    if (
      !operations ||
      !isPushOp(signaturePush) ||
      !isPushOp(publicKeyPush) ||
      operations.next() !== undefined
    ) {
      throw new Error('expected signer-produced P2PKH unlocking script')
    }
    const unlocking = mutate(Object.freeze({
      signature: new Uint8Array(signaturePush.data),
      publicKey: new Uint8Array(publicKeyPush.data)
    }))
    transactionInput.script = Script.p2pkhSpend(unlocking.publicKey, unlocking.signature)
  })
}

const INVALID_UNLOCKING_MUTATIONS: ReadonlyArray<readonly [
  string,
  (artifact: RegtestSignedTransaction) => RegtestSignedTransaction
]> = [
  ['an empty scriptSig', artifact => mutateSignedArtifactTransaction(artifact, transaction => {
    const input = transaction.inputs[0]
    if (!input) throw new Error('expected an input')
    input.script = new Script()
  })],
  ['a scriptSig with a trailing push', artifact => mutateSignedArtifactTransaction(artifact, transaction => {
    const input = transaction.inputs[0]
    if (!input?.script) throw new Error('expected an unlocking script')
    input.script = new Script(new Uint8Array([...input.script.bytecode, 0]))
  })],
  ['the wrong compressed public key', artifact => mutateSignedArtifactP2pkhUnlocking(
    artifact,
    0,
    unlocking => Object.freeze({
      ...unlocking,
      publicKey: fromHex(WRONG_VALID_COMPRESSED_PUBLIC_KEY_HEX)
    })
  )],
  ['a corrupted Schnorr signature', artifact => mutateSignedArtifactP2pkhUnlocking(
    artifact,
    0,
    unlocking => {
      const signature = new Uint8Array(unlocking.signature)
      signature[0] = (signature[0] ?? 0) ^ 1
      return Object.freeze({ ...unlocking, signature })
    }
  )],
  ['the wrong sighash type', artifact => mutateSignedArtifactP2pkhUnlocking(
    artifact,
    0,
    unlocking => {
      const signature = new Uint8Array(unlocking.signature)
      signature[signature.length - 1] = 0x01
      return Object.freeze({ ...unlocking, signature })
    }
  )]
]

function appendTrailingByte(artifact: RegtestSignedTransaction): RegtestSignedTransaction {
  const rawTransactionBytes = new Uint8Array(artifact.rawTransactionBytes.length + 1)
  rawTransactionBytes.set(artifact.rawTransactionBytes)
  rawTransactionBytes[rawTransactionBytes.length - 1] = 0
  return Object.freeze({
    ...artifact,
    rawTransactionHex: toHex(rawTransactionBytes),
    rawTransactionBytes
  })
}

const CANDIDATE_TRANSACTION_MUTATIONS: ReadonlyArray<readonly [
  string,
  (transaction: Tx) => void
]> = [
  ['version', transaction => { transaction.version += 1 }],
  ['locktime', transaction => { transaction.locktime += 1 }],
  ['input outpoint', transaction => {
    const input = transaction.inputs[0]
    if (!input) throw new Error('expected an input')
    input.prevOut.outIdx += 1
  }],
  ['input sequence', transaction => {
    const input = transaction.inputs[0]
    if (!input) throw new Error('expected an input')
    input.sequence = 0xfffffffe
  }],
  ['output value', transaction => {
    const output = transaction.outputs[1]
    if (!output) throw new Error('expected a change output')
    output.sats -= 1n
  }],
  ['output locking script', transaction => {
    const opReturn = transaction.outputs[0]
    const change = transaction.outputs[1]
    if (!opReturn || !change) throw new Error('expected two outputs')
    change.script = opReturn.script.copy()
  }],
  ['output ordering', transaction => {
    const first = transaction.outputs[0]
    const second = transaction.outputs[1]
    if (!first || !second) throw new Error('expected two outputs')
    transaction.outputs = [second, first]
  }]
]

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
  type GeneratedIdPrefix = Parameters<Tm1PublicationClock['createId']>[0]
  const generatedIdOverrides: Record<GeneratedIdPrefix, unknown> = {
    prepared: NO_GENERATED_ID_OVERRIDE,
    signed: NO_GENERATED_ID_OVERRIDE,
    submission: NO_GENERATED_ID_OVERRIDE
  }
  const generatedIdCalls: Record<GeneratedIdPrefix, number> = {
    prepared: 0,
    signed: 0,
    submission: 0
  }
  let utxos = cloneUtxos(fixtureUtxos())
  let utxoOverride: unknown = NO_UTXO_OVERRIDE
  let chainIdentity = 'tm1-regtest-chain'
  let attestationOverride: unknown = NO_ATTESTATION_OVERRIDE
  let signingDecision: unknown = null
  let signingAuthorizationDeferred: Deferred<Tm1PublicationAuthorizationDecision> | null = null
  let broadcastDecision: unknown = null
  let broadcastAuthorizationFailure: unknown = null
  let broadcastAuthorizationDeferred: Deferred<Tm1BroadcastAuthorizationDecision> | null = null
  let signingAuthorizationFailure: unknown = null
  let attestFailure: unknown = null
  let utxoFailure: unknown = null
  let signerFailure: unknown = null
  let auditFailure: unknown = null
  let auditMutator: ((artifact: RegtestSignedTransaction) => RegtestSignedTransaction) | null = null
  let auditReturnUnchecked: unknown = NO_AUDIT_OVERRIDE
  const auditArtifacts: RegtestSignedTransaction[] = []
  let broadcastFailure: unknown = NO_BROADCAST_FAILURE
  let broadcastTxidOverride: string | null = null
  let confirmationOverride: unknown = null
  let confirmationFailure: unknown = null
  let confirmationDeferred: Deferred<Tm1Confirmation> | null = null
  let signerDeferred: Deferred<RegtestSignedTransaction> | null = null
  let auditDeferred: Deferred<RegtestSignedTransaction> | null = null
  let cooperativeAudit = false
  const auditSignals: Array<AbortSignal | undefined> = []
  const signingAuthorizationRequests: Tm1SigningAuthorizationRequest[] = []
  let utxoDeferred: Deferred<readonly Tm1Draft02FreshUtxo[]> | null = null
  let cooperativeUtxos = false
  let onSigningAuthorization: (() => void) | null = null
  let onBroadcastAuthorization: (() => void) | null = null
  let broadcastDeferred: Deferred<Tm1RegtestDeliveryReceipt> | null = null
  let broadcastReceiptOverride: unknown = null
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

  const dependencies: MutableTm1RegtestPublicationDependencies = {
    networkAttestation: {
      async attest(signal?: AbortSignal) {
        calls.attest += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (attestFailure) throw attestFailure
        if (attestDeferred) await attestDeferred.promise
        return (attestationOverride === NO_ATTESTATION_OVERRIDE
          ? Object.freeze({
            environment: 'deterministic-regtest-fixture',
            chainIdentity
          })
          : attestationOverride) as Tm1RegtestNetworkAttestation
      }
    },
    utxoProvider: {
      async readUtxos(signal?: AbortSignal) {
        calls.utxos += 1
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (utxoFailure) throw utxoFailure
        if (utxoDeferred) {
          const deferred = utxoDeferred
          if (cooperativeUtxos) {
            utxoDeferred = null
            cooperativeUtxos = false
            return awaitCooperativeUtxos(deferred, signal)
          }
          return deferred.promise
        }
        if (utxoOverride !== NO_UTXO_OVERRIDE) {
          return utxoOverride as readonly Tm1Draft02FreshUtxo[]
        }
        return Object.freeze(cloneUtxos(utxos))
      }
    },
    signingAuthorization: {
      async requestSigningAuthorization(request, signal?: AbortSignal) {
        calls.signingAuthorization += 1
        signingAuthorizationRequests.push(request)
        onSigningAuthorization?.()
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        if (signingAuthorizationFailure) throw signingAuthorizationFailure
        if (signingAuthorizationDeferred) return signingAuthorizationDeferred.promise
        return (signingDecision ?? Object.freeze({
          status: 'approved',
          authorizationId: 'sign-auth-1',
          preparedId: request.preparedId,
          bindingHash: request.bindingHash
        })) as Tm1PublicationAuthorizationDecision
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
      async auditSignedArtifact({ signedArtifact, signal }) {
        auditSignals.push(signal)
        if (signal?.aborted) throw new Tm1PublicationError('ABORTED')
        calls.audit += 1
        auditArtifacts.push(signedArtifact)
        if (auditFailure) throw auditFailure
        if (auditDeferred) {
          const deferred = auditDeferred
          if (cooperativeAudit) {
            auditDeferred = null
            cooperativeAudit = false
            return awaitCooperativeAudit(deferred, signal)
          }
          return deferred.promise
        }
        if (auditReturnUnchecked !== NO_AUDIT_OVERRIDE) {
          return auditReturnUnchecked as RegtestSignedTransaction
        }
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
        return (broadcastDecision ?? Object.freeze({
          status: 'approved' as const,
          authorizationId: 'broadcast-auth-1',
          signedId: signedReview.signedId,
          txid: signedReview.txid,
          signedArtifactHash: signedReview.signedArtifactHash
        })) as Tm1BroadcastAuthorizationDecision
      }
    },
    deliveryTransport: {
      async broadcast(signedArtifact: RegtestSignedTransaction) {
        calls.broadcast += 1
        lastBroadcastArtifact = signedArtifact
        broadcastMutator?.(signedArtifact)
        if (broadcastFailure !== NO_BROADCAST_FAILURE) throw broadcastFailure
        if (broadcastDeferred) return broadcastDeferred.promise
        if (broadcastReceiptOverride) return broadcastReceiptOverride as Tm1RegtestDeliveryReceipt
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
        return (confirmationOverride ?? Object.freeze({
          submissionId,
          txid,
          confirmations: 1,
          blockHash: 'cc'.repeat(32),
          blockHeight: 101
        })) as Tm1Confirmation
      }
    },
    clock: {
      createId(prefix) {
        generatedIdCalls[prefix] += 1
        ids += 1
        const override = generatedIdOverrides[prefix]
        return (override === NO_GENERATED_ID_OVERRIDE
          ? `${prefix}-${ids}`
          : override) as string
      }
    }
  }

  const orchestrator = new Tm1RegtestPublicationOrchestratorImpl(dependencies)
  return {
    orchestrator,
    dependencies,
    calls,
    setUtxos: (next: readonly Tm1Draft02FreshUtxo[]) => { utxos = cloneUtxos(next) },
    setResolvedUtxos: (next: unknown) => { utxoOverride = next },
    setChainIdentity: (next: string) => { chainIdentity = next },
    setAttestation: (next: unknown) => { attestationOverride = next },
    setSigningDecision: (next: unknown) => { signingDecision = next },
    setGeneratedId: (prefix: GeneratedIdPrefix, value: unknown) => {
      generatedIdOverrides[prefix] = value
    },
    clearGeneratedId: (prefix: GeneratedIdPrefix) => {
      generatedIdOverrides[prefix] = NO_GENERATED_ID_OVERRIDE
    },
    getGeneratedIdCalls: () => ({ ...generatedIdCalls }),
    setBroadcastDecision: (next: unknown) => { broadcastDecision = next },
    failBroadcastAuthorization: (error: unknown) => { broadcastAuthorizationFailure = error },
    failSigningAuthorization: (error: unknown) => { signingAuthorizationFailure = error },
    failAttestation: (error: unknown) => { attestFailure = error },
    failUtxos: (error: unknown) => { utxoFailure = error },
    failSigner: (error: unknown) => { signerFailure = error },
    failAudit: (error: unknown) => { auditFailure = error },
    mutateAudit: (fn: (artifact: RegtestSignedTransaction) => RegtestSignedTransaction) => { auditMutator = fn },
    returnUncheckedAudit: (artifact: unknown) => { auditReturnUnchecked = artifact },
    failBroadcast: (error: unknown) => { broadcastFailure = error },
    setBroadcastTxid: (txid: string) => { broadcastTxidOverride = txid },
    setBroadcastReceipt: (receipt: unknown) => { broadcastReceiptOverride = receipt },
    setConfirmation: (confirmation: unknown) => { confirmationOverride = confirmation },
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
    deferSigningAuthorization: () => {
      signingAuthorizationDeferred = createDeferred<Tm1PublicationAuthorizationDecision>()
      return signingAuthorizationDeferred
    },
    mutateBroadcastArtifact: (fn: (artifact: RegtestSignedTransaction) => void) => { broadcastMutator = fn },
    getLastBroadcastArtifact: () => lastBroadcastArtifact,
    getAuditArtifacts: () => [...auditArtifacts],
    getAuditSignals: () => [...auditSignals],
    getSigningAuthorizationRequests: () => [...signingAuthorizationRequests],
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
    deferCooperativeAudit: () => {
      auditDeferred = createDeferred<RegtestSignedTransaction>()
      cooperativeAudit = true
      return auditDeferred
    },
    deferAttestation: () => {
      attestDeferred = createDeferred<void>()
      return attestDeferred
    },
    deferUtxos: () => {
      utxoDeferred = createDeferred<readonly Tm1Draft02FreshUtxo[]>()
      return utxoDeferred
    },
    deferCooperativeUtxos: () => {
      utxoDeferred = createDeferred<readonly Tm1Draft02FreshUtxo[]>()
      cooperativeUtxos = true
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

function expectBroadcastUncertainEvidence(
  harness: Harness,
  signedReview: Tm1SignedReview
): Extract<Tm1PublicationState, { status: 'broadcastUncertain' }> {
  const state = harness.orchestrator.getState()
  expect(state.status).toBe('broadcastUncertain')
  if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
  expect(state.uncertainty.preparedId).toBe(signedReview.preparedId)
  expect(state.uncertainty.signedId).toBe(signedReview.signedId)
  expect(state.uncertainty.txid).toBe(signedReview.txid)
  expect(state.uncertainty.signedArtifact.txid).toBe(signedReview.txid)
  expect(state.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
  expect(state.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-1')
  expect(state.signedReview.signedArtifactHash).toBe(signedReview.signedArtifactHash)
  return state
}

function statuses(states: readonly Tm1PublicationState[]): string[] {
  return states.map(state => state.status)
}

function mutatePublicationRequest(request: Tm1PublicationRequest): void {
  const mutable = request as {
    message: string
    activeLockingScriptHex: string
    maxFeeSats?: bigint
  }
  mutable.message = 'message-mutated'
  mutable.activeLockingScriptHex = NON_FIXTURE_P2PKH_LOCKING_SCRIPT_HEX
  mutable.maxFeeSats = 999_999n
}

function innermostCause(error: Tm1PublicationError): unknown {
  let cause = error.cause
  while (cause instanceof Tm1PublicationError) cause = cause.cause
  return cause
}

function publicationErrorCycle(
  error: Tm1PublicationError
): readonly Tm1PublicationError[] {
  const seen = new Map<Tm1PublicationError, number>()
  const path: Tm1PublicationError[] = []
  let current: unknown = error
  while (current instanceof Tm1PublicationError) {
    const cycleStart = seen.get(current)
    if (cycleStart !== undefined) return path.slice(cycleStart)
    seen.set(current, path.length)
    path.push(current)
    current = current.cause
  }
  return []
}

function observedPrepareMessage(state: Tm1PublicationState): string {
  if (state.status === 'attesting' || state.status === 'preparing') return state.message
  if (state.status === 'reviewReady') return state.review.message
  throw new Error(`unexpected prepare state: ${state.status}`)
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

  test('snapshots the original delivery transport immediately at construction', async () => {
    const harness = createHarness()
    let replacementCalls = 0
    harness.dependencies.deliveryTransport = {
      async broadcast(signedArtifact) {
        replacementCalls += 1
        return Object.freeze({ txid: signedArtifact.txid, disposition: 'accepted' as const })
      }
    }

    const signedReview = await prepareAndSign(harness)
    await expect(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    ).resolves.toMatchObject({ txid: signedReview.txid })

    expect(harness.calls.broadcast).toBe(1)
    expect(replacementCalls).toBe(0)
  })

  test('keeps the construction-time transport while broadcast authorization is pending', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const authorization = harness.deferBroadcastAuthorization()
    const observedAuthorizationIds: string[] = []
    let replacementCalls = 0
    harness.orchestrator.subscribe(state => {
      if (state.status === 'broadcasting') {
        observedAuthorizationIds.push(state.broadcastAuthorizationId)
      }
    })

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.broadcastAuthorization).toBe(1)
    harness.dependencies.deliveryTransport = {
      async broadcast(signedArtifact) {
        replacementCalls += 1
        return Object.freeze({ txid: signedArtifact.txid, disposition: 'accepted' as const })
      }
    }
    authorization.resolve(Object.freeze({
      status: 'approved',
      authorizationId: 'broadcast-auth-snapshotted',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    }))

    const receipt = await promise
    const state = harness.orchestrator.getState()
    expect(receipt.txid).toBe(signedReview.txid)
    expect(receipt.deliveryReceipt.txid).toBe(signedReview.txid)
    expect(harness.getLastBroadcastArtifact()?.txid).toBe(signedReview.txid)
    expect(observedAuthorizationIds).toEqual(['broadcast-auth-snapshotted'])
    expect(state.status).toBe('submitted')
    if (state.status !== 'submitted') throw new Error('expected submitted')
    expect(state.signedReview.txid).toBe(signedReview.txid)
    expect(state.signedReview.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(harness.calls.broadcast).toBe(1)
    expect(replacementCalls).toBe(0)
  })

  test('keeps the construction-time transport while broadcast re-audit is pending', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const audit = harness.deferAudit()
    let replacementCalls = 0

    const promise = harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.audit).toBe(2)
    harness.dependencies.deliveryTransport = {
      async broadcast(signedArtifact) {
        replacementCalls += 1
        return Object.freeze({ txid: signedArtifact.txid, disposition: 'accepted' as const })
      }
    }
    audit.resolve(signedReview.signedArtifact)

    await expect(promise).resolves.toMatchObject({ txid: signedReview.txid })
    expect(harness.calls.broadcast).toBe(1)
    expect(replacementCalls).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('submitted')
  })

  test('keeps the construction-time signer while signing authorization is pending', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const authorization = harness.deferSigningAuthorization()
    let replacementCalls = 0

    const promise = harness.orchestrator.authorizeAndSign(review.preparedId)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.signingAuthorization).toBe(1)
    harness.dependencies.signer = {
      async sign(currentReview, signal) {
        replacementCalls += 1
        return signTm1Draft02RegtestCandidate({ candidate: currentReview.candidate, signal })
      }
    }
    authorization.resolve(Object.freeze({
      status: 'approved',
      authorizationId: 'sign-auth-snapshotted',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    }))

    await expect(promise).resolves.toMatchObject({ preparedId: review.preparedId })
    expect(harness.calls.signer).toBe(1)
    expect(replacementCalls).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('signedReviewReady')
  })

  test('keeps the construction-time signed artifact audit after container mutation', async () => {
    const harness = createHarness()
    let replacementCalls = 0
    harness.dependencies.signedArtifactAudit = {
      async auditSignedArtifact({ signedArtifact }) {
        replacementCalls += 1
        return signedArtifact
      }
    }

    await prepareAndSign(harness)

    expect(harness.calls.audit).toBe(1)
    expect(replacementCalls).toBe(0)
  })

  test('keeps the construction-time confirmation observer after submission', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    let replacementCalls = 0
    harness.dependencies.confirmationObserver = {
      async confirm({ submissionId, txid }) {
        replacementCalls += 1
        return Object.freeze({ submissionId, txid, confirmations: 1 })
      }
    }

    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1
    })

    expect(harness.calls.confirm).toBe(1)
    expect(replacementCalls).toBe(0)
  })

  test('keeps construction-time network and UTXO ports for prepare and revalidation', async () => {
    const harness = createHarness()
    let replacementAttestCalls = 0
    let replacementUtxoCalls = 0
    harness.dependencies.networkAttestation = {
      async attest() {
        replacementAttestCalls += 1
        return Object.freeze({
          environment: 'deterministic-regtest-fixture',
          chainIdentity: 'replacement-chain'
        })
      }
    }
    harness.dependencies.utxoProvider = {
      async readUtxos() {
        replacementUtxoCalls += 1
        return Object.freeze(cloneUtxos(fixtureUtxos()))
      }
    }

    await prepareAndSign(harness)

    expect(harness.calls.attest).toBe(2)
    expect(harness.calls.utxos).toBe(2)
    expect(replacementAttestCalls).toBe(0)
    expect(replacementUtxoCalls).toBe(0)
  })

  test('keeps the construction-time clock for every staged identifier', async () => {
    const harness = createHarness()
    let replacementCalls = 0
    harness.dependencies.clock = {
      createId(prefix) {
        replacementCalls += 1
        return `replacement-${prefix}`
      }
    }

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    expect(review.preparedId).toBe('prepared-1')
    expect(signedReview.signedId).toBe('signed-2')
    expect(receipt.submissionId).toBe('submission-3')
    expect(replacementCalls).toBe(0)
  })

  test.each([
    ['an empty string', ''],
    ['whitespace only', ' \t\n'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 123],
    ['an object', { id: 'submission-object' }]
  ])('rejects submission ID generated as %s before dispatch', async (_label, generatedId) => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setGeneratedId('submission', generatedId)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.getGeneratedIdCalls()).toEqual({
      prepared: 1,
      signed: 1,
      submission: 1
    })
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
  })

  test('does not inspect a hostile object returned as a submission ID', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    let getterCalls = 0
    let proxyTrapCalls = 0
    const hostileId = new Proxy(Object.defineProperty({}, 'id', {
      get() {
        getterCalls += 1
        throw new Error('generated ID accessor must not execute')
      }
    }), {
      get() {
        proxyTrapCalls += 1
        throw new Error('generated ID get trap must not execute')
      },
      getPrototypeOf() {
        proxyTrapCalls += 1
        throw new Error('generated ID prototype trap must not execute')
      },
      ownKeys() {
        proxyTrapCalls += 1
        throw new Error('generated ID ownKeys trap must not execute')
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1
        throw new Error('generated ID descriptor trap must not execute')
      }
    })
    harness.setGeneratedId('submission', hostileId)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )

    expect(getterCalls).toBe(0)
    expect(proxyTrapCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
  })

  test('publishes normally with a valid generated submission ID', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const observed: Tm1PublicationState['status'][] = []
    harness.orchestrator.subscribe(state => observed.push(state.status))

    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)

    expect(receipt.submissionId).toBe('submission-3')
    expect(observed).toContain('broadcasting')
    expect(observed.at(-1)).toBe('submitted')
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.getGeneratedIdCalls().submission).toBe(1)
  })

  test('releases the operation and permits reset and retry after an invalid submission ID', async () => {
    const harness = createHarness()
    const firstSignedReview = await prepareAndSign(harness)
    harness.setGeneratedId('submission', '')

    await expectCode(
      harness.orchestrator.approveAndBroadcast(firstSignedReview.signedId),
      'BROADCAST_FAILED'
    )
    expect(harness.calls.broadcast).toBe(0)

    expect(() => harness.orchestrator.reset()).not.toThrow()
    harness.clearGeneratedId('submission')
    const retrySignedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(retrySignedReview.signedId)

    expect(receipt.submissionId).toBe('submission-6')
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('submitted')
  })

  test('rejects an invalid generated prepared ID as a preparation failure', async () => {
    const harness = createHarness()
    harness.setGeneratedId('prepared', null)

    await expectCode(
      harness.orchestrator.prepare(DEFAULT_REQUEST),
      'PREPARATION_FAILED'
    )

    expect(harness.getGeneratedIdCalls()).toEqual({
      prepared: 1,
      signed: 0,
      submission: 0
    })
    expect(harness.calls.signer).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing'
    })
  })

  test('rejects an invalid generated signed ID without publishing a signed review', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setGeneratedId('signed', { id: 'signed-object' })

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_FAILED'
    )

    expect(harness.getGeneratedIdCalls()).toEqual({
      prepared: 1,
      signed: 1,
      submission: 0
    })
    expect(harness.calls.signer).toBe(1)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'signing'
    })
  })

  test('rejects a same-cycle cross-kind duplicate generated ID', async () => {
    const harness = createHarness()
    harness.setGeneratedId('prepared', 'same-id')
    harness.setGeneratedId('signed', 'same-id')
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_FAILED'
    )

    expect(review.preparedId).toBe('same-id')
    expect(harness.getGeneratedIdCalls()).toEqual({
      prepared: 1,
      signed: 1,
      submission: 0
    })
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'signing'
    })
    expect(harness.calls.broadcast).toBe(0)
  })

  test('burns a prepared ID for the orchestrator lifetime and blocks stale reuse after reset', async () => {
    const harness = createHarness()
    harness.setGeneratedId('prepared', 'prepared-stale-action')
    const firstReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    expect(firstReview.preparedId).toBe('prepared-stale-action')
    harness.orchestrator.reset()

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(harness.getGeneratedIdCalls().prepared).toBe(2)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing'
    })
    expect('review' in harness.orchestrator.getState()).toBe(false)

    harness.orchestrator.reset()
    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')
    expect(harness.getGeneratedIdCalls().prepared).toBe(3)
  })

  test('rejects reuse of a signed ID across publication cycles', async () => {
    const harness = createHarness()
    harness.setGeneratedId('signed', 'signed-across-cycles')
    const firstSignedReview = await prepareAndSign(harness)
    expect(firstSignedReview.signedId).toBe('signed-across-cycles')
    harness.orchestrator.reset()
    const secondReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)

    await expectCode(
      harness.orchestrator.authorizeAndSign(secondReview.preparedId),
      'SIGNING_FAILED'
    )

    expect(harness.getGeneratedIdCalls().signed).toBe(2)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'signing'
    })
  })

  test('rejects reuse of a submission ID across confirmed publication cycles before rebroadcast', async () => {
    const harness = createHarness()
    harness.setGeneratedId('submission', 'submission-across-cycles')
    const firstSignedReview = await prepareAndSign(harness)
    const firstReceipt = await harness.orchestrator.approveAndBroadcast(firstSignedReview.signedId)
    await harness.orchestrator.confirm(firstReceipt.submissionId)
    expect(harness.calls.broadcast).toBe(1)
    harness.orchestrator.reset()
    const secondSignedReview = await prepareAndSign(harness)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(secondSignedReview.signedId),
      'BROADCAST_FAILED'
    )

    expect(harness.getGeneratedIdCalls().submission).toBe(2)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
  })

  test('enforces generated ID uniqueness across kinds and publication cycles', async () => {
    const harness = createHarness()
    harness.setGeneratedId('prepared', 'cross-kind-across-cycles')
    const firstReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    expect(firstReview.preparedId).toBe('cross-kind-across-cycles')
    harness.orchestrator.reset()
    harness.clearGeneratedId('prepared')
    harness.setGeneratedId('submission', 'cross-kind-across-cycles')
    const secondSignedReview = await prepareAndSign(harness)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(secondSignedReview.signedId),
      'BROADCAST_FAILED'
    )

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
  })

  test('keeps a generated ID burned when a later operation stage fails', async () => {
    const harness = createHarness()
    harness.setGeneratedId('prepared', 'prepared-before-later-failure')
    const firstReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failSigner(new Error('later signer failure'))

    await expectCode(
      harness.orchestrator.authorizeAndSign(firstReview.preparedId),
      'SIGNING_FAILED'
    )
    harness.orchestrator.reset()

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(harness.getGeneratedIdCalls().prepared).toBe(2)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing'
    })
    expect(harness.calls.broadcast).toBe(0)
  })

  test('forwards the exact operation signal to the primary signed-artifact audit', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const controller = new AbortController()

    await expect(
      harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal)
    ).resolves.toMatchObject({ preparedId: review.preparedId })

    expect(harness.getAuditSignals()).toEqual([controller.signal])
    expect(harness.orchestrator.getState().status).toBe('signedReviewReady')
  })

  test('cooperatively aborts a pending primary audit and releases the active operation', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.deferCooperativeAudit()
    const controller = new AbortController()

    const promise = harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.audit).toBe(1)
    expect(harness.getAuditSignals()).toEqual([controller.signal])
    controller.abort()

    await expectCode(promise, 'ABORTED')
    expect(harness.orchestrator.getState().status).toBe('aborted')
    expect(harness.orchestrator.getState().status).not.toBe('signedReviewReady')

    expect(() => harness.orchestrator.reset()).not.toThrow()
    const retryReview = await harness.orchestrator.prepare({
      ...DEFAULT_REQUEST,
      message: 'retry after primary audit abort'
    })
    await expect(
      harness.orchestrator.authorizeAndSign(retryReview.preparedId)
    ).resolves.toMatchObject({ preparedId: retryReview.preparedId })
    expect(harness.orchestrator.getState().status).toBe('signedReviewReady')
  })

  test('forwards the exact operation signal to the broadcast re-audit', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const controller = new AbortController()

    await expect(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId, controller.signal)
    ).resolves.toMatchObject({ txid: signedReview.txid })

    expect(harness.getAuditSignals()).toEqual([undefined, controller.signal])
    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('submitted')
  })

  test('cooperatively aborts broadcast re-audit before dispatch and releases the operation', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.deferCooperativeAudit()
    const controller = new AbortController()

    const promise = harness.orchestrator.approveAndBroadcast(
      signedReview.signedId,
      controller.signal
    )

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.audit).toBe(2)
    expect(harness.getAuditSignals()).toEqual([undefined, controller.signal])
    controller.abort()

    await expectCode(promise, 'ABORTED')
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('aborted')
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')

    expect(() => harness.orchestrator.reset()).not.toThrow()
    await expect(harness.orchestrator.prepare({
      ...DEFAULT_REQUEST,
      message: 'new operation after re-audit abort'
    })).resolves.toMatchObject({ message: 'new operation after re-audit abort' })
  })

  test('a cooperative audit performs no relevant work for an already-aborted signal', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const signedArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    const controller = new AbortController()
    controller.abort()

    await expectCode(harness.dependencies.signedArtifactAudit.auditSignedArtifact({
      review,
      signedArtifact,
      signal: controller.signal
    }), 'ABORTED')

    expect(harness.getAuditSignals()).toEqual([controller.signal])
    expect(harness.calls.audit).toBe(0)
    expect(harness.getAuditArtifacts()).toHaveLength(0)
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

  test('binds a nominal signing approval to the exact prepared review request', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)

    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)

    expect(harness.getSigningAuthorizationRequests()).toHaveLength(1)
    const [request] = harness.getSigningAuthorizationRequests()
    expect(request).toMatchObject({
      preparedId: review.preparedId,
      bindingHash: review.bindingHash,
      review: {
        preparedId: review.preparedId,
        bindingHash: review.bindingHash
      }
    })
    expect(Object.isFrozen(request)).toBe(true)
    expect(harness.calls.signer).toBe(1)
    expect(signedReview).toMatchObject({
      preparedId: review.preparedId,
      bindingHash: review.bindingHash,
      signingAuthorizationId: 'sign-auth-1'
    })
    expect(harness.orchestrator.getState().status).toBe('signedReviewReady')
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

  test.each([
    ['an unrecognized status', (review: { preparedId: string; bindingHash: string }) => ({
      status: 'unknown',
      authorizationId: 'must-not-authorize',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    })],
    ['an approved decision without a valid id', (review: { preparedId: string; bindingHash: string }) => ({
      status: 'approved',
      authorizationId: '',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    })],
    ['an approved decision without preparedId', (review: { bindingHash: string }) => ({
      status: 'approved',
      authorizationId: 'sign-auth-missing-prepared-id',
      bindingHash: review.bindingHash
    })],
    ['an approved decision without bindingHash', (review: { preparedId: string }) => ({
      status: 'approved',
      authorizationId: 'sign-auth-missing-binding-hash',
      preparedId: review.preparedId
    })],
    ['an approved decision with a malformed bindingHash', (review: { preparedId: string }) => ({
      status: 'approved',
      authorizationId: 'sign-auth-malformed-binding-hash',
      preparedId: review.preparedId,
      bindingHash: 'not-a-canonical-hash'
    })]
  ])('rejects malformed signing authorization with %s', async (_label, makeDecision) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setSigningDecision(makeDecision(review))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_AUTHORIZATION_INVALID'
    )
    expect(harness.calls.signer).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'authorizing' })
  })

  test.each([
    ['the same preparedId but a different bindingHash', (review: Tm1SigningAuthorizationRequest) => ({
      preparedId: review.preparedId,
      bindingHash: '11'.repeat(32)
    })],
    ['a different preparedId but the current bindingHash', (review: Tm1SigningAuthorizationRequest) => ({
      preparedId: `${review.preparedId}-stale`,
      bindingHash: review.bindingHash
    })]
  ])('rejects signing approval bound to %s', async (_label, makeBinding) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setSigningDecision(Object.freeze({
      status: 'approved',
      authorizationId: 'sign-auth-wrong-binding',
      ...makeBinding({
        preparedId: review.preparedId,
        bindingHash: review.bindingHash,
        review
      })
    }))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_AUTHORIZATION_INVALID'
    )

    expect(harness.calls.attest).toBe(1)
    expect(harness.calls.utxos).toBe(1)
    expect(harness.calls.signer).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'authorizing'
    })
  })

  test.each(['authorizationId', 'preparedId', 'bindingHash'] as const)(
    'does not invoke a hostile %s accessor on an approved signing decision',
    async property => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      let getterCalls = 0
      const decision: Record<string, unknown> = {
        status: 'approved',
        authorizationId: 'sign-auth-hostile-accessor',
        preparedId: review.preparedId,
        bindingHash: review.bindingHash
      }
      Object.defineProperty(decision, property, {
        configurable: true,
        get() {
          getterCalls += 1
          throw new Error('signing authorization getter must not execute')
        }
      })
      harness.setSigningDecision(decision)

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'SIGNING_AUTHORIZATION_INVALID'
      )

      expect(getterCalls).toBe(0)
      expect(harness.calls.signer).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        stage: 'authorizing'
      })
    }
  )

  test('contains a signing decision Proxy with a hostile descriptor trap', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let descriptorCalls = 0
    harness.setSigningDecision(new Proxy({}, {
      getOwnPropertyDescriptor() {
        descriptorCalls += 1
        throw new Error('signing authorization descriptor trap must not escape')
      }
    }))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNING_AUTHORIZATION_INVALID'
    )

    expect(descriptorCalls).toBe(1)
    expect(harness.calls.signer).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'authorizing'
    })
  })

  test('never invokes getPrototypeOf while validating a signing decision Proxy', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getPrototypeOfCalls = 0
    harness.setSigningDecision(new Proxy({
      status: 'approved',
      authorizationId: 'sign-auth-proxy',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    }, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('signing authorization prototype trap must not execute')
      }
    }))

    await expect(harness.orchestrator.authorizeAndSign(review.preparedId)).resolves.toMatchObject({
      preparedId: review.preparedId,
      signingAuthorizationId: 'sign-auth-proxy'
    })

    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.calls.signer).toBe(1)
  })

  test('rejects a cached approval for a different prepared identity after reset', async () => {
    const harness = createHarness()
    const firstReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cachedApproval = Object.freeze({
      status: 'approved',
      authorizationId: 'sign-auth-cached-first-review',
      preparedId: firstReview.preparedId,
      bindingHash: firstReview.bindingHash
    })
    harness.orchestrator.reset()
    const secondReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    expect(secondReview.preparedId).not.toBe(firstReview.preparedId)
    expect(secondReview.bindingHash).toBe(firstReview.bindingHash)
    harness.setSigningDecision(cachedApproval)

    await expectCode(
      harness.orchestrator.authorizeAndSign(secondReview.preparedId),
      'SIGNING_AUTHORIZATION_INVALID'
    )

    expect(harness.calls.signer).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'authorizing'
    })
  })

  test('rejects an old content binding even when the adapter reports the current preparedId', async () => {
    const harness = createHarness()
    const firstReview = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.orchestrator.reset()
    const changedReview = await harness.orchestrator.prepare(Object.freeze({
      ...DEFAULT_REQUEST,
      message: `${DEFAULT_REQUEST.message} with changed approved content`
    }))
    expect(changedReview.bindingHash).not.toBe(firstReview.bindingHash)
    harness.setSigningDecision(Object.freeze({
      status: 'approved',
      authorizationId: 'sign-auth-old-content',
      preparedId: changedReview.preparedId,
      bindingHash: firstReview.bindingHash
    }))

    await expectCode(
      harness.orchestrator.authorizeAndSign(changedReview.preparedId),
      'SIGNING_AUTHORIZATION_INVALID'
    )

    expect(harness.calls.signer).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'authorizing'
    })
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
    const state = harness.orchestrator.getState()
    expect(state).toMatchObject({ status: 'failed', stage: 'signing' })
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(state.error)).toMatchObject({ message: 'bad artifact' })
  })

  test('classifies a primary audit getPrototypeOf Proxy rejection without prototype inspection', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getPrototypeOfCalls = 0
    harness.failAudit(new Proxy({}, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('audit prototype trap must not escape')
      }
    }))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'signing',
      error: { code: 'SIGNED_ARTIFACT_INVALID' }
    })
  })

  test('classifies a broadcast re-audit getPrototypeOf Proxy before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    let getPrototypeOfCalls = 0
    harness.failAudit(new Proxy({}, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('re-audit prototype trap must not escape')
      }
    }))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast',
      error: { code: 'SIGNED_ARTIFACT_INVALID' }
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test.each([
    ['ownKeys', () => new Proxy({}, {
      ownKeys() {
        throw new Error('audit ownKeys trap must not escape')
      }
    })],
    ['getOwnPropertyDescriptor', () => new Proxy({ diagnostic: 'unsafe' }, {
      getOwnPropertyDescriptor() {
        throw new Error('audit descriptor trap must not escape')
      }
    })]
  ] as const)(
    'maps a primary audit rejection with hostile %s reflection to SIGNED_ARTIFACT_INVALID',
    async (_trap, createRejection) => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      harness.failAudit(createRejection())

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'SIGNED_ARTIFACT_INVALID'
      )

      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        stage: 'signing',
        error: { code: 'SIGNED_ARTIFACT_INVALID' }
      })
    }
  )

  test('preserves safe diagnostics from a publication-error audit rejection', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failAudit(new Tm1PublicationError(
      'SIGNING_FAILED',
      'external audit diagnostic',
      { metadata: { reason: 'original' } }
    ))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(state.error)).toMatchObject({
      name: 'Tm1PublicationError',
      message: 'external audit diagnostic',
      code: 'SIGNING_FAILED',
      cause: { metadata: { reason: 'original' } }
    })
  })

  test.each([
    ['null', null],
    ['a malformed object', Object.freeze({})]
  ])('maps primary audit runtime value %s to SIGNED_ARTIFACT_INVALID', async (_label, value) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.returnUncheckedAudit(value)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('maps primary audit rawTransactionBytes with the wrong runtime type to SIGNED_ARTIFACT_INVALID', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(Object.freeze({
      ...validArtifact,
      rawTransactionBytes: validArtifact.rawTransactionHex
    }))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('rejects a syntactically valid non-fixture public key during the primary audit', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(Object.freeze({
      ...validArtifact,
      fixturePublicKeyHex: WRONG_VALID_COMPRESSED_PUBLIC_KEY_HEX
    }))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
    expect(harness.orchestrator.getState().status).not.toBe('signedReviewReady')
  })

  test('keeps rejecting a malformed fixture public key during the primary audit', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(Object.freeze({
      ...validArtifact,
      fixturePublicKeyHex: '04-not-a-compressed-public-key'
    }))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test.each([
    ['a syntactically valid non-fixture P2PKH locking script', NON_FIXTURE_P2PKH_LOCKING_SCRIPT_HEX],
    ['a malformed locking script', 'not-a-locking-script']
  ])('rejects %s during the primary audit', async (_label, fixtureLockingScriptHex) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(Object.freeze({
      ...validArtifact,
      fixtureLockingScriptHex
    }))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
    expect(harness.orchestrator.getState().status).not.toBe('signedReviewReady')
  })

  test.each(INVALID_UNLOCKING_MUTATIONS)(
    'rejects signer output with %s during the primary audit',
    async (_label, mutate) => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
      harness.returnUncheckedAudit(mutate(validArtifact))

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'SIGNED_ARTIFACT_INVALID'
      )

      expect(harness.calls.broadcast).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
      expect(harness.orchestrator.getState().status).not.toBe('signedReviewReady')
    }
  )

  test.each([
    ['format', Object.freeze({ format: 'unsupported-signed-transaction-format' })],
    ['artifact version', Object.freeze({ artifactVersion: 2 })]
  ])('rejects an unsupported signed artifact %s', async (_label, override) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(Object.freeze({ ...validArtifact, ...override }))

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNED_ARTIFACT_INVALID')
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('accepts a valid runtime audit result and snapshots its bytes', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(validArtifact)

    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)

    expect(signedReview.txid).toBe(validArtifact.txid)
    expect(signedReview.signedArtifact.fixturePublicKeyHex).toBe(
      TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX
    )
    expect(signedReview.signedArtifact.fixtureLockingScriptHex).toBe(
      TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
    )
    expect(signedReview.signedArtifact.rawTransactionBytes).not.toBe(validArtifact.rawTransactionBytes)
    expect(toHex(signedReview.signedArtifact.rawTransactionBytes)).toBe(validArtifact.rawTransactionHex)
  })

  test.each(CANDIDATE_TRANSACTION_MUTATIONS)(
    'rejects a signed transaction with a candidate %s mismatch during primary audit',
    async (_label, mutate) => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
      harness.returnUncheckedAudit(mutateSignedArtifactTransaction(validArtifact, mutate))

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'SIGNED_ARTIFACT_INVALID'
      )

      expect(harness.calls.broadcast).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
    }
  )

  test('rejects a signed transaction with permuted multi-input ordering', async () => {
    const harness = createHarness()
    harness.setUtxos(fixtureUtxos().map(utxo => ({ ...utxo, sats: 700n })))
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    expect(review.candidate.inputs).toHaveLength(2)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    const reorderedArtifact = mutateSignedArtifactTransaction(validArtifact, transaction => {
      const first = transaction.inputs[0]
      const second = transaction.inputs[1]
      if (!first || !second) throw new Error('expected two inputs')
      transaction.inputs = [second, first]
    })
    harness.returnUncheckedAudit(reorderedArtifact)

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.broadcast).toBe(0)
  })

  test('rejects a multi-input artifact when only one Schnorr signature is corrupted', async () => {
    const harness = createHarness()
    harness.setUtxos(fixtureUtxos().map(utxo => ({ ...utxo, sats: 700n })))
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    expect(review.candidate.inputs).toHaveLength(2)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(mutateSignedArtifactP2pkhUnlocking(
      validArtifact,
      1,
      unlocking => {
        const signature = new Uint8Array(unlocking.signature)
        signature[0] = (signature[0] ?? 0) ^ 1
        return Object.freeze({ ...unlocking, signature })
      }
    ))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('rejects a non-canonical signed transaction with a trailing byte during primary audit', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const validArtifact = signTm1Draft02RegtestCandidate({ candidate: review.candidate })
    harness.returnUncheckedAudit(appendTrailingByte(validArtifact))

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'signing' })
  })

  test('accepts the exact prepared candidate through signed review and submission', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const signedReview = await harness.orchestrator.authorizeAndSign(review.preparedId)

    expect(harness.orchestrator.getState().status).toBe('signedReviewReady')
    expect(toHex(signedReview.signedArtifact.rawTransactionBytes)).toBe(
      signedReview.signedArtifact.rawTransactionHex
    )
    expect(Tx.fromHex(signedReview.signedArtifact.rawTransactionHex).txid()).toBe(
      signedReview.txid
    )
    expect(signedReview.signedArtifactHash).toBe(
      toHex(sha256d(signedReview.signedArtifact.rawTransactionBytes))
    )

    await expect(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    ).resolves.toMatchObject({ txid: signedReview.txid })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('submitted')
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
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'auth-original',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    }
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
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'auth-original',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    }
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
    const mutableDecision = {
      status: 'approved' as const,
      authorizationId: 'auth-original',
      preparedId: review.preparedId,
      bindingHash: review.bindingHash
    }
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

  test.each([
    ['a non-regtest environment', { environment: 'production-mainnet', chainIdentity: 'chain-A' }],
    ['an invalid chain identity', { environment: 'deterministic-regtest-fixture', chainIdentity: ' chain-A ' }]
  ])('rejects initial attestation with %s before reading UTXOs', async (_label, attestation) => {
    const harness = createHarness()
    harness.setAttestation(attestation)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(harness.calls.utxos).toBe(0)
    expect(harness.calls.signer).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'attesting' })
  })

  test('contains a resolved initial attestation whose descriptor trap throws an Error and permits retry', async () => {
    const harness = createHarness()
    const hostileAttestation = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('resolved attestation descriptor trap')
      }
    })
    harness.setAttestation(hostileAttestation)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(harness.calls.utxos).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'attesting',
      error: { code: 'PREPARATION_FAILED' }
    })
    expect(() => harness.orchestrator.reset()).not.toThrow()
    harness.setAttestation(Object.freeze({
      environment: 'deterministic-regtest-fixture',
      chainIdentity: 'retry-chain'
    }))
    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      network: { chainIdentity: 'retry-chain' }
    })
    expect(harness.calls.attest).toBe(2)
  })

  test('contains a hostile Proxy thrown by a resolved initial attestation descriptor trap', async () => {
    const harness = createHarness()
    const trapCalls = {
      getPrototypeOf: 0,
      get: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0
    }
    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf() {
        trapCalls.getPrototypeOf += 1
        throw new Error('secondary prototype trap')
      },
      get() {
        trapCalls.get += 1
        throw new Error('secondary get trap')
      },
      ownKeys() {
        trapCalls.ownKeys += 1
        throw new Error('secondary ownKeys trap')
      },
      getOwnPropertyDescriptor() {
        trapCalls.getOwnPropertyDescriptor += 1
        throw new Error('secondary descriptor trap')
      }
    })
    harness.setAttestation(new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw hostileThrownValue
      }
    }))

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(trapCalls.getPrototypeOf).toBe(0)
    expect(trapCalls.get).toBe(0)
    expect(trapCalls.ownKeys).toBeGreaterThan(0)
    expect(trapCalls.getOwnPropertyDescriptor).toBeGreaterThan(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'attesting',
      error: { code: 'PREPARATION_FAILED' }
    })
    expect(() => harness.orchestrator.reset()).not.toThrow()
  })

  test('does not invoke unrelated ownKeys or prototype traps on a valid resolved attestation', async () => {
    const harness = createHarness()
    const trapCalls = { ownKeys: 0, getPrototypeOf: 0 }
    harness.setAttestation(new Proxy({
      environment: 'deterministic-regtest-fixture',
      chainIdentity: 'descriptor-only-chain'
    }, {
      ownKeys() {
        trapCalls.ownKeys += 1
        throw new Error('ownKeys must not be used')
      },
      getPrototypeOf() {
        trapCalls.getPrototypeOf += 1
        throw new Error('getPrototypeOf must not be used')
      }
    }))

    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      network: { chainIdentity: 'descriptor-only-chain' }
    })

    expect(trapCalls).toEqual({ ownKeys: 0, getPrototypeOf: 0 })
    expect(harness.orchestrator.getState().status).toBe('reviewReady')
  })

  test('rejects accessor-backed initial attestation fields without invoking getters', async () => {
    const harness = createHarness()
    let getterCalls = 0
    const attestation = { chainIdentity: 'chain-A' }
    Object.defineProperty(attestation, 'environment', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('attestation getter must not execute')
      }
    })
    harness.setAttestation(attestation)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(getterCalls).toBe(0)
    expect(harness.calls.utxos).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'attesting'
    })
  })

  test.each([
    ['null', null],
    ['a primitive', 42],
    ['an object missing required fields', {}]
  ])('rejects %s resolved initial attestation as PREPARATION_FAILED', async (_label, attestation) => {
    const harness = createHarness()
    harness.setAttestation(attestation)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(harness.calls.utxos).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'attesting',
      error: { code: 'PREPARATION_FAILED' }
    })
  })

  test.each([
    ['a non-regtest environment', { environment: 'production-mainnet', chainIdentity: 'chain-A' }],
    ['an invalid chain identity', { environment: 'deterministic-regtest-fixture', chainIdentity: '' }]
  ])('rejects signing re-attestation with %s before signing', async (_label, attestation) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.setAttestation(attestation)

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'CANDIDATE_REVALIDATION_FAILED'
    )

    expect(harness.calls.signer).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'revalidating' })
  })

  test.each([
    ['a descriptor trap error', (): unknown => new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('resolved re-attestation descriptor trap')
      }
    })],
    ['a hostile Proxy thrown by a descriptor trap', (): unknown => {
      const hostileThrownValue = new Proxy({}, {
        getPrototypeOf() {
          throw new Error('secondary re-attestation prototype trap')
        },
        ownKeys() {
          throw new Error('secondary re-attestation ownKeys trap')
        },
        getOwnPropertyDescriptor() {
          throw new Error('secondary re-attestation descriptor trap')
        }
      })
      return new Proxy({}, {
        getOwnPropertyDescriptor() {
          throw hostileThrownValue
        }
      })
    }],
    ['a null result', (): unknown => null]
  ] as const)(
    'contains resolved signing re-attestation with %s using revalidation taxonomy',
    async (_label, createAttestation) => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      harness.setAttestation(createAttestation())

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'CANDIDATE_REVALIDATION_FAILED'
      )

      expect(harness.calls.signer).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        stage: 'revalidating',
        error: { code: 'CANDIDATE_REVALIDATION_FAILED' }
      })
      expect(() => harness.orchestrator.reset()).not.toThrow()
    }
  )

  test('snapshots the publication request before pending attestation resolves', async () => {
    const harness = createHarness()
    const attestation = harness.deferAttestation()
    const request: Tm1PublicationRequest = {
      message: 'message-original',
      activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      maxFeeSats: 10_000n
    }
    const observed: Tm1PublicationState[] = []
    harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting' || state.status === 'preparing' || state.status === 'reviewReady') {
        observed.push(state)
      }
    })

    const promise = harness.orchestrator.prepare(request)

    await new Promise(resolve => setTimeout(resolve, 0))
    mutatePublicationRequest(request)
    attestation.resolve(undefined)

    const review = await promise
    const state = harness.orchestrator.getState()
    expect(review.message).toBe('message-original')
    expect(review.candidate.authorLockingScriptHex).toBe(TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX)
    expect(review.candidate.feePolicy.maxFeeSats).toBe(10_000n)
    expect(review.orderedOutputs[0].scriptHex).toBe(encodeTm1Draft02Post({
      eventData: 'message-original',
      authorInputIndex: 0
    }).scriptHex)
    expect(review.orderedOutputs[0].scriptHex).not.toBe(encodeTm1Draft02Post({
      eventData: 'message-mutated',
      authorInputIndex: 0
    }).scriptHex)
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(state.review.message).toBe('message-original')
    expect(state.review.candidate.authorLockingScriptHex).toBe(TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX)
    expect(observed.map(item => item.status)).toEqual(['attesting', 'preparing', 'reviewReady'])
    expect(observed.map(observedPrepareMessage)).toEqual([
      'message-original',
      'message-original',
      'message-original'
    ])
  })

  test('acquires the prepare guard before reading reentrant request getters', async () => {
    const harness = createHarness()
    let reentrantPrepare: Promise<unknown> | null = null
    const request = Object.defineProperties({}, {
      message: {
        enumerable: true,
        get() {
          reentrantPrepare = harness.orchestrator.prepare({
            ...DEFAULT_REQUEST,
            message: 'getter-injected publication'
          })
          return DEFAULT_REQUEST.message
        }
      },
      activeLockingScriptHex: {
        enumerable: true,
        value: DEFAULT_REQUEST.activeLockingScriptHex
      },
      maxFeeSats: {
        enumerable: true,
        value: DEFAULT_REQUEST.maxFeeSats
      }
    }) as Tm1PublicationRequest

    const review = await harness.orchestrator.prepare(request)

    if (reentrantPrepare === null) throw new Error('expected reentrant prepare')
    await expectCode(reentrantPrepare, 'PUBLICATION_ALREADY_ACTIVE')
    expect(review.message).toBe(DEFAULT_REQUEST.message)
    expect(harness.calls.attest).toBe(1)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'reviewReady',
      review: { preparedId: review.preparedId }
    })
  })

  test.each(['message', 'activeLockingScriptHex', 'maxFeeSats'] as const)(
    'records the idle stage and releases the prepare guard when request.%s snapshotting fails',
    async property => {
    const harness = createHarness()
    let getterCalls = 0
    const request = { ...DEFAULT_REQUEST }
    Object.defineProperty(request, property, {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error(`hostile ${property} getter`)
      }
    })

    await expectCode(harness.orchestrator.prepare(request), 'PREPARATION_FAILED')

    expect(getterCalls).toBe(1)
    expect(harness.calls).toEqual({
      attest: 0,
      utxos: 0,
      signingAuthorization: 0,
      signer: 0,
      audit: 0,
      broadcastAuthorization: 0,
      broadcast: 0,
      confirm: 0
    })
    const state = harness.orchestrator.getState()
    expect(state).toMatchObject({ status: 'failed', stage: 'idle' })
    expect('review' in state).toBe(false)
    expect('signedReview' in state).toBe(false)
    harness.orchestrator.reset()
    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      message: DEFAULT_REQUEST.message
    })
    expect(harness.calls.attest).toBe(1)
    }
  )

  test.each(['message', 'activeLockingScriptHex', 'maxFeeSats'] as const)(
    'contains a hostile Proxy thrown by request.%s and permits retry',
    async property => {
      const harness = createHarness()
      let getterCalls = 0
      let getPrototypeOfCalls = 0
      const hostileThrownValue = new Proxy({}, {
        getPrototypeOf() {
          getPrototypeOfCalls += 1
          throw new Error('request snapshot prototype trap must not execute')
        }
      })
      const request = { ...DEFAULT_REQUEST }
      Object.defineProperty(request, property, {
        enumerable: true,
        get() {
          getterCalls += 1
          throw hostileThrownValue
        }
      })

      await expectCode(harness.orchestrator.prepare(request), 'PREPARATION_FAILED')

      expect(getterCalls).toBe(1)
      expect(getPrototypeOfCalls).toBe(0)
      expect(harness.calls.attest).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        stage: 'idle',
        error: { code: 'PREPARATION_FAILED' }
      })
      expect(() => harness.orchestrator.reset()).not.toThrow()
      await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
        message: DEFAULT_REQUEST.message
      })
    }
  )

  test('falls back safely when a request getter throws an ownKeys-hostile Proxy', async () => {
    const harness = createHarness()
    let getterCalls = 0
    let ownKeysCalls = 0
    let getPrototypeOfCalls = 0
    const hostileThrownValue = new Proxy({}, {
      ownKeys() {
        ownKeysCalls += 1
        throw new Error('request snapshot ownKeys trap')
      },
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('request snapshot prototype trap must not execute')
      }
    })
    const request = { ...DEFAULT_REQUEST }
    Object.defineProperty(request, 'message', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw hostileThrownValue
      }
    })

    await expectCode(harness.orchestrator.prepare(request), 'PREPARATION_FAILED')

    expect(getterCalls).toBe(1)
    expect(ownKeysCalls).toBeGreaterThan(0)
    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'idle',
      error: { code: 'PREPARATION_FAILED' }
    })
  })

  test('falls back safely when a request getter throws a descriptor-hostile Proxy', async () => {
    const harness = createHarness()
    let getterCalls = 0
    let ownKeysCalls = 0
    let descriptorCalls = 0
    let getPrototypeOfCalls = 0
    const hostileThrownValue = new Proxy({ diagnostic: 'unsafe' }, {
      ownKeys() {
        ownKeysCalls += 1
        return ['diagnostic']
      },
      getOwnPropertyDescriptor() {
        descriptorCalls += 1
        throw new Error('request snapshot descriptor trap')
      },
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('request snapshot prototype trap must not execute')
      }
    })
    const request = { ...DEFAULT_REQUEST }
    Object.defineProperty(request, 'message', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw hostileThrownValue
      }
    })

    await expectCode(harness.orchestrator.prepare(request), 'PREPARATION_FAILED')

    expect(getterCalls).toBe(1)
    expect(ownKeysCalls).toBeGreaterThan(0)
    expect(descriptorCalls).toBeGreaterThan(0)
    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'idle',
      error: { code: 'PREPARATION_FAILED' }
    })
  })

  test('does not read request getters or replace an existing prepared review', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const stateBeforeInvalidCall = harness.orchestrator.getState()
    let getterCalls = 0
    const hostileRequest = Object.defineProperties({}, {
      message: {
        enumerable: true,
        get() {
          getterCalls += 1
          throw new Error('request getter must not run outside idle')
        }
      },
      activeLockingScriptHex: {
        enumerable: true,
        value: DEFAULT_REQUEST.activeLockingScriptHex
      }
    }) as Tm1PublicationRequest

    await expectCode(harness.orchestrator.prepare(hostileRequest), 'INVALID_STATE')

    expect(getterCalls).toBe(0)
    expect(harness.calls.attest).toBe(1)
    expect(harness.orchestrator.getState()).toEqual(stateBeforeInvalidCall)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'reviewReady',
      review: { preparedId: review.preparedId }
    })
  })

  test('does not read request getters or replace an existing signed review', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const stateBeforeInvalidCall = harness.orchestrator.getState()
    let getterCalls = 0
    const hostileRequest = Object.defineProperties({}, {
      message: {
        enumerable: true,
        get() {
          getterCalls += 1
          throw new Error('request getter must not run outside idle')
        }
      },
      activeLockingScriptHex: {
        enumerable: true,
        value: DEFAULT_REQUEST.activeLockingScriptHex
      }
    }) as Tm1PublicationRequest

    await expectCode(harness.orchestrator.prepare(hostileRequest), 'INVALID_STATE')

    expect(getterCalls).toBe(0)
    expect(harness.calls.attest).toBe(2)
    expect(harness.orchestrator.getState()).toEqual(stateBeforeInvalidCall)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'signedReviewReady',
      signedReview: { signedId: signedReview.signedId }
    })
  })

  test('snapshots the publication request before pending UTXO reads resolve', async () => {
    const harness = createHarness()
    const utxoRead = harness.deferUtxos()
    const request: Tm1PublicationRequest = {
      message: 'message-original',
      activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      maxFeeSats: 10_000n
    }
    const observed: Tm1PublicationState[] = []
    harness.orchestrator.subscribe(state => {
      if (state.status === 'attesting' || state.status === 'preparing' || state.status === 'reviewReady') {
        observed.push(state)
      }
    })

    const promise = harness.orchestrator.prepare(request)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observed.map(item => item.status)).toEqual(['attesting', 'preparing'])
    mutatePublicationRequest(request)
    utxoRead.resolve(fixtureUtxos())

    const review = await promise
    const state = harness.orchestrator.getState()
    expect(review.message).toBe('message-original')
    expect(review.candidate.authorLockingScriptHex).toBe(TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX)
    expect(review.candidate.feePolicy.maxFeeSats).toBe(10_000n)
    expect(review.orderedOutputs[0].scriptHex).toBe(encodeTm1Draft02Post({
      eventData: 'message-original',
      authorInputIndex: 0
    }).scriptHex)
    expect(review.orderedOutputs[0].scriptHex).not.toBe(encodeTm1Draft02Post({
      eventData: 'message-mutated',
      authorInputIndex: 0
    }).scriptHex)
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(state.review.message).toBe('message-original')
    expect(state.review.candidate.authorLockingScriptHex).toBe(TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX)
    expect(observed.map(observedPrepareMessage)).toEqual([
      'message-original',
      'message-original',
      'message-original'
    ])
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

  test.each([
    ['an unrecognized status', (signedReview: Tm1SignedReview) => ({
      status: 'unknown',
      authorizationId: 'must-not-authorize',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    })],
    ['an approved decision without a valid id', (signedReview: Tm1SignedReview) => ({
      status: 'approved',
      authorizationId: '',
      signedId: signedReview.signedId,
      txid: signedReview.txid,
      signedArtifactHash: signedReview.signedArtifactHash
    })]
  ])('rejects malformed broadcast authorization with %s', async (_label, makeDecision) => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastDecision(makeDecision(signedReview))

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')
    expect(harness.calls.audit).toBe(1)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'approvingBroadcast' })
  })

  test.each([
    ['null', null],
    ['a malformed object', Object.freeze({})]
  ])('maps broadcast re-audit runtime value %s to SIGNED_ARTIFACT_INVALID before dispatch', async (_label, value) => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(value)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )
    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'failed', stage: 'approvingBroadcast' })
  })

  test('rejects a syntactically valid non-fixture public key during broadcast re-audit before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(Object.freeze({
      ...signedReview.signedArtifact,
      fixturePublicKeyHex: WRONG_VALID_COMPRESSED_PUBLIC_KEY_HEX
    }))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test('rejects a non-fixture P2PKH locking script during broadcast re-audit before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(Object.freeze({
      ...signedReview.signedArtifact,
      fixtureLockingScriptHex: NON_FIXTURE_P2PKH_LOCKING_SCRIPT_HEX
    }))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test('rejects an empty scriptSig during broadcast re-audit before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(mutateSignedArtifactTransaction(
      signedReview.signedArtifact,
      transaction => {
        const input = transaction.inputs[0]
        if (!input) throw new Error('expected an input')
        input.script = new Script()
      }
    ))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test('rejects a cryptographically invalid signature during broadcast re-audit before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(mutateSignedArtifactP2pkhUnlocking(
      signedReview.signedArtifact,
      0,
      unlocking => {
        const signature = new Uint8Array(unlocking.signature)
        signature[0] = (signature[0] ?? 0) ^ 1
        return Object.freeze({ ...unlocking, signature })
      }
    ))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test('rejects a different candidate during broadcast re-audit before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(mutateSignedArtifactTransaction(
      signedReview.signedArtifact,
      transaction => { transaction.locktime += 1 }
    ))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test('rejects trailing bytes during broadcast re-audit before dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.returnUncheckedAudit(appendTrailingByte(signedReview.signedArtifact))

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'approvingBroadcast'
    })
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
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

  test.each([
    ['getPrototypeOf', (onTrap: () => void) => new Proxy({ diagnostic: 'untrusted' }, {
      getPrototypeOf() {
        onTrap()
        throw new Error('getPrototypeOf trap must not escape')
      }
    }), 1],
    ['ownKeys', (onTrap: () => void) => new Proxy({ diagnostic: 'untrusted' }, {
      ownKeys() {
        onTrap()
        throw new Error('ownKeys trap must not escape')
      }
    }), 1],
    ['getOwnPropertyDescriptor', (onTrap: () => void) => new Proxy({ diagnostic: 'untrusted' }, {
      getOwnPropertyDescriptor() {
        onTrap()
        throw new Error('getOwnPropertyDescriptor trap must not escape')
      }
    }), 1],
    ['get', (onTrap: () => void) => new Proxy({ diagnostic: 'untrusted' }, {
      get() {
        onTrap()
        throw new Error('get trap must never be invoked')
      }
    }), 0]
  ] as const)(
    'persists broadcast uncertainty before best-effort diagnostics touch a hostile %s Proxy',
    async (_trapName, createHostile, expectedTrapCalls) => {
      const harness = createHarness()
      const signedReview = await prepareAndSign(harness)
      const trapStates: string[] = []
      const hostile = createHostile(() => {
        trapStates.push(harness.orchestrator.getState().status)
      })
      harness.failBroadcast(hostile)

      await expectCode(
        harness.orchestrator.approveAndBroadcast(signedReview.signedId),
        'BROADCAST_FAILED'
      )

      expect(harness.calls.broadcast).toBe(1)
      expect(trapStates).toEqual(Array(expectedTrapCalls).fill('broadcastUncertain'))
      const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
      expect(uncertain.uncertainty.error.code).toBe('BROADCAST_FAILED')
      expect(() => harness.orchestrator.reset()).toThrow(Tm1PublicationError)
      expect(harness.orchestrator.getState().status).toBe('broadcastUncertain')

      harness.setConfirmation(Object.freeze({
        submissionId: uncertain.uncertainty.submissionId,
        txid: signedReview.txid,
        confirmations: 1,
        blockHash: 'fc'.repeat(32),
        blockHeight: 110
      }))
      await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({
        submissionId: uncertain.uncertainty.submissionId,
        txid: signedReview.txid
      })
      expect(harness.calls.broadcast).toBe(1)
      expect(harness.orchestrator.getState().status).toBe('confirmed')
    }
  )

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['symbol', Symbol('hostile rejection')],
    ['function', function hostileRejection() { return undefined }]
  ] as const)('records broadcast uncertainty for a post-dispatch %s rejection', async (_label, rejection) => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failBroadcast(rejection)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )

    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    expect(uncertain.uncertainty.error.code).toBe('BROADCAST_FAILED')
    expect(uncertain.uncertainty.error.message).toBe('BROADCAST_FAILED')
  })

  test('keeps an AbortError rejection post-dispatch in broadcastUncertain', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const abortError = new Error('transport aborted after dispatch')
    abortError.name = 'AbortError'
    harness.failBroadcast(abortError)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )

    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    expect(uncertain.uncertainty.error.code).toBe('BROADCAST_FAILED')
    expect(innermostCause(uncertain.uncertainty.error)).toMatchObject({
      name: 'AbortError',
      message: 'transport aborted after dispatch'
    })
    expect(harness.orchestrator.getState().status).not.toBe('aborted')
  })

  test('moves txid accessor failures after transport resolution into broadcastUncertain and reconciles without rebroadcast', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastReceipt({
      get txid(): string {
        throw new Error('txid accessor failed')
      },
      disposition: 'accepted' as const
    } as Tm1RegtestDeliveryReceipt)

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')
    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)

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

  test('moves disposition accessor failures after transport resolution into broadcastUncertain', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastReceipt({
      txid: signedReview.txid,
      get disposition(): 'accepted' {
        throw new Error('disposition accessor failed')
      }
    } as Tm1RegtestDeliveryReceipt)

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')
    expect(harness.calls.broadcast).toBe(1)
    expectBroadcastUncertainEvidence(harness, signedReview)
  })

  test('rejects a non-accepted transport disposition as broadcastUncertain', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastReceipt({
      txid: signedReview.txid,
      disposition: 'rejected'
    })

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')

    expect(harness.calls.broadcast).toBe(1)
    expectBroadcastUncertainEvidence(harness, signedReview)
  })

  test('moves delivery receipt snapshot failures after transport resolution into broadcastUncertain', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const deliveryReceipt = {
      txid: signedReview.txid,
      disposition: 'accepted' as const
    } as Tm1RegtestDeliveryReceipt & { metadata?: unknown }
    Object.defineProperty(deliveryReceipt, 'metadata', {
      enumerable: true,
      get() {
        throw new Error('receipt snapshot failed')
      }
    })
    harness.setBroadcastReceipt(deliveryReceipt)

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')
    expect(harness.calls.broadcast).toBe(1)
    expectBroadcastUncertainEvidence(harness, signedReview)
  })

  test('rejects a delivery txid mismatch as broadcastUncertain after dispatch', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.setBroadcastTxid('00'.repeat(32))

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'TXID_MISMATCH')
    expect(harness.calls.broadcast).toBe(1)
    expectBroadcastUncertainEvidence(harness, signedReview)
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

  test('accepts a canonical confirmation block hash and keeps blockHash optional', async () => {
    const withHash = createHarness()
    const signedReview = await prepareAndSign(withHash)
    const receipt = await withHash.orchestrator.approveAndBroadcast(signedReview.signedId)
    const canonicalBlockHash = 'ab'.repeat(32)
    withHash.setConfirmation(Object.freeze({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1,
      blockHash: canonicalBlockHash
    }))

    await expect(withHash.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      blockHash: canonicalBlockHash
    })
    expect(withHash.orchestrator.getState().status).toBe('confirmed')

    const withoutHash = createHarness()
    const withoutHashSignedReview = await prepareAndSign(withoutHash)
    const withoutHashReceipt = await withoutHash.orchestrator.approveAndBroadcast(
      withoutHashSignedReview.signedId
    )
    withoutHash.setConfirmation(Object.freeze({
      submissionId: withoutHashReceipt.submissionId,
      txid: withoutHashReceipt.txid,
      confirmations: 1
    }))

    const confirmation = await withoutHash.orchestrator.confirm(
      withoutHashReceipt.submissionId
    )
    expect(confirmation).not.toHaveProperty('blockHash')
    expect(withoutHash.orchestrator.getState().status).toBe('confirmed')
  })

  test.each(INVALID_CONFIRMATION_BLOCK_HASHES)(
    'rejects confirmation blockHash with %s and preserves submitted evidence',
    async (_caseName, blockHash) => {
      const harness = createHarness()
      const signedReview = await prepareAndSign(harness)
      const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
      const submitted = harness.orchestrator.getState()
      expect(submitted.status).toBe('submitted')
      harness.setConfirmation(Object.freeze({
        submissionId: receipt.submissionId,
        txid: receipt.txid,
        confirmations: 1,
        blockHash
      }))

      await expectCode(
        harness.orchestrator.confirm(receipt.submissionId),
        'CONFIRMATION_FAILED'
      )

      expect(harness.orchestrator.getState()).toEqual(submitted)
      expect(harness.calls.broadcast).toBe(1)
      expect(harness.calls.broadcastAuthorization).toBe(1)
    }
  )

  test('retries confirmation with a canonical block hash without rebroadcasting', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const submitted = harness.orchestrator.getState()
    expect(submitted.status).toBe('submitted')
    harness.setConfirmation(Object.freeze({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1,
      blockHash: 'not-a-hash'
    }))

    await expectCode(
      harness.orchestrator.confirm(receipt.submissionId),
      'CONFIRMATION_FAILED'
    )
    expect(harness.orchestrator.getState()).toEqual(submitted)

    const canonicalBlockHash = 'de'.repeat(32)
    harness.setConfirmation(Object.freeze({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 2,
      blockHash: canonicalBlockHash,
      blockHeight: 112
    }))
    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: signedReview.txid,
      confirmations: 2,
      blockHash: canonicalBlockHash
    })

    expect(harness.calls.confirm).toBe(2)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.calls.broadcastAuthorization).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('preserves broadcast uncertainty for an invalid block hash and reconciles a valid retry', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failBroadcast(new Error('response lost after dispatch'))
    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )
    const uncertain = harness.orchestrator.getState()
    expect(uncertain.status).toBe('broadcastUncertain')
    if (uncertain.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: uncertain.uncertainty.txid,
      confirmations: 1,
      blockHash: 'not-a-hash'
    }))

    await expectCode(harness.orchestrator.reconcile(), 'CONFIRMATION_FAILED')

    const restored = harness.orchestrator.getState()
    expect(restored.status).toBe('broadcastUncertain')
    if (restored.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(restored.uncertainty.submissionId).toBe(uncertain.uncertainty.submissionId)
    expect(restored.uncertainty.txid).toBe(signedReview.txid)
    expect(restored.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(restored.uncertainty.signedArtifact.rawTransactionHex).toBe(
      signedReview.signedArtifact.rawTransactionHex
    )
    expect(restored.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-1')
    expect(restored.signedReview.signedId).toBe(signedReview.signedId)
    expect(harness.calls.broadcast).toBe(1)

    const canonicalBlockHash = 'ef'.repeat(32)
    harness.setConfirmation(Object.freeze({
      submissionId: restored.uncertainty.submissionId,
      txid: restored.uncertainty.txid,
      confirmations: 1,
      blockHash: canonicalBlockHash,
      blockHeight: 113
    }))
    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({
      submissionId: restored.uncertainty.submissionId,
      txid: signedReview.txid,
      blockHash: canonicalBlockHash
    })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('rejects confirmation for a different txid', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const submitted = harness.orchestrator.getState()
    harness.setConfirmation(Object.freeze({
      submissionId: receipt.submissionId,
      txid: '00'.repeat(32),
      confirmations: 1
    }))

    await expectCode(harness.orchestrator.confirm(receipt.submissionId), 'TXID_MISMATCH')
    expect(harness.orchestrator.getState()).toEqual(submitted)
    expect(harness.calls.broadcast).toBe(1)
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

  test('honors a synchronous subscriber abort before irreversible broadcast dispatch', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    harness.orchestrator.subscribe(state => {
      if (state.status === 'broadcasting') controller.abort()
    })
    const signedReview = await prepareAndSign(harness)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId, controller.signal),
      'ABORTED'
    )

    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'aborted',
      stage: 'broadcasting'
    })
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

  test('recognizes the native AbortController DOMException reason from the signer', async () => {
    const reason = nativeAbortReason()
    expect(reason).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(reason as object, 'name')).toBeUndefined()
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failSigner(reason)

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'ABORTED'
    )

    expect(harness.calls.signer).toBe(1)
    expect(harness.calls.audit).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'aborted' })
    expect(() => harness.orchestrator.reset()).not.toThrow()
  })

  test('recognizes the native AbortController reason from the primary signed artifact audit', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failAudit(nativeAbortReason())

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId),
      'ABORTED'
    )

    expect(harness.calls.audit).toBe(1)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('aborted')
  })

  test('recognizes the native AbortController reason from the broadcast re-audit', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failAudit(nativeAbortReason())

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'ABORTED'
    )

    expect(harness.calls.audit).toBe(2)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('aborted')
    expect(harness.orchestrator.getState().status).not.toBe('broadcastUncertain')
  })

  test('recognizes the native AbortController reason from confirmation and preserves retry evidence', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    harness.failConfirmation(nativeAbortReason())

    await expectCode(
      harness.orchestrator.confirm(receipt.submissionId),
      'ABORTED'
    )

    const submitted = harness.orchestrator.getState()
    expect(submitted.status).toBe('submitted')
    if (submitted.status !== 'submitted') throw new Error('expected submitted')
    expect(submitted.receipt).toEqual(receipt)
    expect(submitted.signedReview.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(harness.calls.broadcast).toBe(1)

    harness.failConfirmation(null)
    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid
    })
    expect(harness.calls.broadcast).toBe(1)
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

  test('restores submitted evidence after a confirmation getPrototypeOf Proxy rejection and retries', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const submitted = harness.orchestrator.getState()
    expect(submitted.status).toBe('submitted')
    let getPrototypeOfCalls = 0
    harness.failConfirmation(new Proxy({}, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('confirmation prototype trap must not escape')
      }
    }))

    await expectCode(
      harness.orchestrator.confirm(receipt.submissionId),
      'CONFIRMATION_FAILED'
    )

    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.orchestrator.getState()).toEqual(submitted)
    const restored = harness.orchestrator.getState()
    expect(restored.status).toBe('submitted')
    if (restored.status !== 'submitted') throw new Error('expected submitted')
    expect(restored.receipt).toEqual(receipt)
    expect(restored.signedReview.signedId).toBe(signedReview.signedId)
    expect(restored.signedReview.txid).toBe(signedReview.txid)
    expect(restored.signedReview.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(restored.signedReview.signedArtifact.rawTransactionHex).toBe(
      signedReview.signedArtifact.rawTransactionHex
    )
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.calls.broadcastAuthorization).toBe(1)

    harness.failConfirmation(null)
    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toMatchObject({
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 1
    })
    expect(harness.calls.confirm).toBe(2)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('contains a hostile confirmation getOwnPropertyDescriptor trap', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    let descriptorCalls = 0
    harness.failConfirmation(new Proxy({}, {
      getOwnPropertyDescriptor() {
        descriptorCalls += 1
        throw new Error('confirmation descriptor trap must not escape')
      }
    }))

    await expectCode(
      harness.orchestrator.confirm(receipt.submissionId),
      'CONFIRMATION_FAILED'
    )

    expect(descriptorCalls).toBeGreaterThan(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'submitted',
      receipt: { submissionId: receipt.submissionId, txid: receipt.txid }
    })
    expect(harness.calls.broadcast).toBe(1)
  })

  test('never invokes a confirmation rejection code getter', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    let getterCalls = 0
    const rejection = {}
    Object.defineProperty(rejection, 'code', {
      configurable: true,
      get() {
        getterCalls += 1
        throw new Error('confirmation code getter must never execute')
      }
    })
    harness.failConfirmation(rejection)

    await expectCode(
      harness.orchestrator.confirm(receipt.submissionId),
      'CONFIRMATION_FAILED'
    )

    expect(getterCalls).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'submitted' })
    expect(harness.calls.broadcast).toBe(1)
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

  test('rejects getter-backed confirmation results without invoking getters in confirm', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    let getterCalls = 0
    const confirmation: Record<PropertyKey, unknown> = {
      submissionId: receipt.submissionId,
      txid: receipt.txid
    }
    Object.defineProperty(confirmation, 'confirmations', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 1
      }
    })
    harness.setConfirmation(confirmation)

    await expectCode(harness.orchestrator.confirm(receipt.submissionId), 'CONFIRMATION_FAILED')

    expect(getterCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'submitted' })
  })

  test('reads each proxy-backed confirmation field once before publishing the snapshot', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const receipt = await harness.orchestrator.approveAndBroadcast(signedReview.signedId)
    const descriptorCalls = new Map<PropertyKey, number>()
    let dataGetterCalls = 0
    const target: Tm1Confirmation = {
      submissionId: receipt.submissionId,
      txid: receipt.txid,
      confirmations: 2,
      blockHash: 'ac'.repeat(32),
      blockHeight: 108
    }
    const confirmation = new Proxy(target, {
      get(targetValue, key, receiver) {
        if (key === 'then') return undefined
        dataGetterCalls += 1
        return Reflect.get(targetValue, key, receiver)
      },
      getOwnPropertyDescriptor(targetValue, key) {
        descriptorCalls.set(key, (descriptorCalls.get(key) ?? 0) + 1)
        return Reflect.getOwnPropertyDescriptor(targetValue, key)
      }
    })
    harness.setConfirmation(confirmation)

    await expect(harness.orchestrator.confirm(receipt.submissionId)).resolves.toEqual(target)

    expect(dataGetterCalls).toBe(0)
    expect(Object.fromEntries(descriptorCalls)).toEqual({
      submissionId: 1,
      txid: 1,
      confirmations: 1,
      blockHash: 1,
      blockHeight: 1
    })
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'confirmed' })
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

  test('rejects getter-backed confirmation results without invoking getters in reconcile', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    harness.failBroadcast(new Error('timeout after dispatch'))
    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )
    const uncertain = harness.orchestrator.getState()
    if (uncertain.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    let getterCalls = 0
    const confirmation: Record<PropertyKey, unknown> = {
      submissionId: uncertain.uncertainty.submissionId,
      txid: uncertain.uncertainty.txid
    }
    Object.defineProperty(confirmation, 'confirmations', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 1
      }
    })
    harness.setConfirmation(confirmation)

    await expectCode(harness.orchestrator.reconcile(), 'CONFIRMATION_FAILED')

    expect(getterCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState()).toMatchObject({ status: 'broadcastUncertain' })
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
    expect(innermostCause(state.error)).toMatchObject({
      message: 'attestation transport unavailable'
    })
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

  test('classifies a hostile attestation rejection without invoking its prototype trap and permits retry', async () => {
    const harness = createHarness()
    let getPrototypeOfCalls = 0
    const rejection = new Proxy({}, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('attestation prototype trap must not execute')
      }
    })
    harness.failAttestation(rejection)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(getPrototypeOfCalls).toBe(0)
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(state.error.code).toBe('PREPARATION_FAILED')
    expect(() => harness.orchestrator.reset()).not.toThrow()
    harness.failAttestation(null)
    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      message: DEFAULT_REQUEST.message
    })
    expect(harness.calls.attest).toBe(2)
  })

  test('classifies a hostile UTXO rejection without invoking its prototype trap', async () => {
    const harness = createHarness()
    let getPrototypeOfCalls = 0
    const rejection = new Proxy({}, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('UTXO prototype trap must not execute')
      }
    })
    harness.failUtxos(rejection)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(getPrototypeOfCalls).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      error: { code: 'PREPARATION_FAILED' }
    })
    expect(() => harness.orchestrator.reset()).not.toThrow()
  })

  test('contains a resolved UTXO collection before iterator or property access reaches planning', async () => {
    const harness = createHarness()
    const trapCalls = { iterator: 0, map: 0, descriptor: 0 }
    const collection = new Proxy(fixtureUtxos(), {
      get(target, key, receiver) {
        // Promise resolution is allowed to probe then; unsafe collection APIs are not.
        if (key === 'then') return undefined
        if (key === Symbol.iterator) {
          trapCalls.iterator += 1
          throw new Error('UTXO iterator trap must not reach planning')
        }
        if (key === 'map') {
          trapCalls.map += 1
          throw new Error('UTXO map trap must not reach planning')
        }
        return Reflect.get(target, key, receiver)
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') {
          trapCalls.descriptor += 1
          throw new Error('UTXO collection descriptor trap')
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    harness.setResolvedUtxos(collection)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(trapCalls).toEqual({ iterator: 0, map: 0, descriptor: 1 })
    expect(harness.calls.signer).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing',
      error: { code: 'PREPARATION_FAILED' }
    })
  })

  test('contains a hostile Proxy thrown while snapshotting a resolved UTXO collection', async () => {
    const harness = createHarness()
    const secondaryTrapCalls = { getPrototypeOf: 0, get: 0, ownKeys: 0, descriptor: 0 }
    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf() {
        secondaryTrapCalls.getPrototypeOf += 1
        throw new Error('secondary UTXO prototype trap')
      },
      get() {
        secondaryTrapCalls.get += 1
        throw new Error('secondary UTXO get trap')
      },
      ownKeys() {
        secondaryTrapCalls.ownKeys += 1
        throw new Error('secondary UTXO ownKeys trap')
      },
      getOwnPropertyDescriptor() {
        secondaryTrapCalls.descriptor += 1
        throw new Error('secondary UTXO descriptor trap')
      }
    })
    const collection = new Proxy(fixtureUtxos(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') throw hostileThrownValue
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    harness.setResolvedUtxos(collection)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(secondaryTrapCalls.getPrototypeOf).toBe(0)
    expect(secondaryTrapCalls.get).toBe(0)
    expect(secondaryTrapCalls.ownKeys).toBeGreaterThan(0)
    expect(secondaryTrapCalls.descriptor).toBeGreaterThan(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing',
      error: { code: 'PREPARATION_FAILED' }
    })
    expect(() => harness.orchestrator.reset()).not.toThrow()
    harness.setResolvedUtxos(fixtureUtxos())
    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      message: DEFAULT_REQUEST.message
    })
  })

  test('does not invoke ownKeys while snapshotting a valid resolved UTXO collection', async () => {
    const harness = createHarness()
    let ownKeysCalls = 0
    harness.setResolvedUtxos(new Proxy(fixtureUtxos(), {
      ownKeys() {
        ownKeysCalls += 1
        throw new Error('UTXO ownKeys trap must not execute')
      }
    }))

    await expect(harness.orchestrator.prepare(DEFAULT_REQUEST)).resolves.toMatchObject({
      candidate: { inputs: expect.any(Array) }
    })

    expect(ownKeysCalls).toBe(0)
    expect(harness.orchestrator.getState().status).toBe('reviewReady')
  })

  test('rejects an accessor-backed UTXO array element without invoking its getter', async () => {
    const harness = createHarness()
    let getterCalls = 0
    const collection: unknown[] = []
    Object.defineProperty(collection, '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1
        throw new Error('UTXO element getter must not execute')
      }
    })
    collection.length = 1
    harness.setResolvedUtxos(collection)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(getterCalls).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing'
    })
  })

  test.each([
    ['a throwing field getter', (): { value: unknown; trapCalls: () => number; expectedCalls: number } => {
      let getterCalls = 0
      const utxo = { ...fixtureUtxos()[0] }
      Object.defineProperty(utxo, 'txid', {
        get() {
          getterCalls += 1
          throw new Error('UTXO field getter must not execute')
        }
      })
      return { value: [utxo], trapCalls: () => getterCalls, expectedCalls: 0 }
    }],
    ['a hostile descriptor Proxy', (): { value: unknown; trapCalls: () => number; expectedCalls: number } => {
      let descriptorCalls = 0
      const utxo = new Proxy(fixtureUtxos()[0], {
        getOwnPropertyDescriptor() {
          descriptorCalls += 1
          throw new Error('UTXO object descriptor trap')
        }
      })
      return { value: [utxo], trapCalls: () => descriptorCalls, expectedCalls: 1 }
    }]
  ] as const)(
    'rejects a normal collection containing %s before planning',
    async (_label, createHostileEntry) => {
      const harness = createHarness()
      const hostile = createHostileEntry()
      harness.setResolvedUtxos(hostile.value)

      await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

      expect(hostile.trapCalls()).toBe(hostile.expectedCalls)
      expect(harness.calls.signer).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        stage: 'preparing'
      })
    }
  )

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a primitive', 7],
    ['a non-array object', {}],
    ['a sparse array', new Array(1)],
    ['a null entry', [null]],
    ['a missing-field entry', [{}]],
    ['an invalid txid', [{ ...fixtureUtxos()[0], txid: 'not-a-txid' }]],
    ['an invalid output index', [{ ...fixtureUtxos()[0], outIdx: -1 }]],
    ['an out-of-range output index', [{ ...fixtureUtxos()[0], outIdx: 0x1_0000_0000 }]],
    ['an invalid satoshi value', [{ ...fixtureUtxos()[0], sats: 0n }]],
    ['an out-of-range satoshi value', [{ ...fixtureUtxos()[0], sats: 0x1_0000_0000_0000_0000n }]],
    ['an invalid locking script', [{ ...fixtureUtxos()[0], lockingScriptHex: 'not-hex' }]]
  ])('rejects resolved UTXO collection with %s', async (_label, resolvedValue) => {
    const harness = createHarness()
    harness.setResolvedUtxos(resolvedValue)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'failed',
      stage: 'preparing',
      error: { code: 'PREPARATION_FAILED' }
    })
    expect(harness.calls.signer).toBe(0)
  })

  test('isolates the planner, review, and state from provider UTXO mutation', async () => {
    const harness = createHarness()
    const pureUtxo = { ...fixtureUtxos()[0] }
    const nestedToken = { nested: { category: 'external-token' } }
    const tokenUtxo = { ...fixtureUtxos()[1], token: nestedToken }
    const providerCollection = [pureUtxo, tokenUtxo]
    harness.setResolvedUtxos(providerCollection)

    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const originalInput = { ...review.candidate.inputs[0] }

    pureUtxo.txid = 'ff'.repeat(32)
    pureUtxo.outIdx = 99
    pureUtxo.sats = 1n
    pureUtxo.lockingScriptHex = '00'
    nestedToken.nested.category = 'mutated-token'
    providerCollection.length = 0

    expect(review.candidate.inputs[0]).toEqual(originalInput)
    expect(review.candidate.inputs[0].txid).toBe(TXID_A)
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('reviewReady')
    if (state.status !== 'reviewReady') throw new Error('expected review')
    expect(state.review.candidate.inputs[0]).toEqual(originalInput)
    expect(state.review.candidate.inputs).toHaveLength(1)
  })

  test.each([
    ['a hostile collection descriptor', (): unknown => new Proxy(fixtureUtxos(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') throw new Error('fresh UTXO descriptor trap')
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })],
    ['an accessor-backed entry', (): unknown => {
      const collection: unknown[] = []
      Object.defineProperty(collection, '0', {
        get() {
          throw new Error('fresh UTXO element getter must not execute')
        }
      })
      collection.length = 1
      return collection
    }],
    ['a malformed collection', (): unknown => null]
  ] as const)(
    'contains resolved UTXO revalidation with %s',
    async (_label, createResolvedValue) => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      harness.setResolvedUtxos(createResolvedValue())

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'CANDIDATE_REVALIDATION_FAILED'
      )

      expect(harness.calls.signer).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        stage: 'revalidating',
        error: { code: 'CANDIDATE_REVALIDATION_FAILED' }
      })
      expect(() => harness.orchestrator.reset()).not.toThrow()
    }
  )

  test('classifies a cooperative UTXO signal.reason abort as ABORTED and releases the operation', async () => {
    const harness = createHarness()
    harness.deferCooperativeUtxos()
    const controller = new AbortController()
    const promise = harness.orchestrator.prepare(DEFAULT_REQUEST, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.calls.utxos).toBe(1)
    controller.abort()

    await expectCode(promise, 'ABORTED')
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'aborted',
      stage: 'preparing'
    })
    expect(() => harness.orchestrator.reset()).not.toThrow()
  })

  test.each([
    ['ownKeys', () => new Proxy({}, {
      ownKeys() {
        throw new Error('preparation ownKeys trap')
      }
    })],
    ['getOwnPropertyDescriptor', () => new Proxy(
      { diagnostic: 'external rejection' },
      {
        getOwnPropertyDescriptor() {
          throw new Error('preparation descriptor trap')
        }
      }
    )]
  ] as const)(
    'uses safe diagnostics for a preparation rejection with hostile %s reflection',
    async (_trap, createRejection) => {
      const harness = createHarness()
      harness.failAttestation(createRejection())

      await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

      const state = harness.orchestrator.getState()
      expect(state.status).toBe('failed')
      if (state.status !== 'failed') throw new Error('expected failed')
      expect(state.error.code).toBe('PREPARATION_FAILED')
      expect(innermostCause(state.error)).toEqual({
        name: 'UnknownObject',
        description: 'External object could not be cloned safely'
      })
      expect(() => harness.orchestrator.reset()).not.toThrow()
    }
  )

  test('classifies a native AbortController attestation reason as ABORTED', async () => {
    const harness = createHarness()
    harness.failAttestation(nativeAbortReason())

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'ABORTED')

    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'aborted',
      stage: 'attesting'
    })
    expect(() => harness.orchestrator.reset()).not.toThrow()
  })

  test.each(['attestation', 'utxo'] as const)(
    'classifies a hostile %s revalidation rejection as CANDIDATE_REVALIDATION_FAILED',
    async port => {
      const harness = createHarness()
      const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
      let getPrototypeOfCalls = 0
      const rejection = new Proxy({}, {
        getPrototypeOf() {
          getPrototypeOfCalls += 1
          throw new Error(`${port} revalidation prototype trap must not execute`)
        }
      })
      if (port === 'attestation') harness.failAttestation(rejection)
      else harness.failUtxos(rejection)

      await expectCode(
        harness.orchestrator.authorizeAndSign(review.preparedId),
        'CANDIDATE_REVALIDATION_FAILED'
      )

      expect(getPrototypeOfCalls).toBe(0)
      expect(harness.orchestrator.getState()).toMatchObject({
        status: 'failed',
        error: { code: 'CANDIDATE_REVALIDATION_FAILED' }
      })
      expect(() => harness.orchestrator.reset()).not.toThrow()
    }
  )

  test('does not classify an arbitrary fully hostile Proxy rejection as an abort', async () => {
    const harness = createHarness()
    const calls = {
      getPrototypeOf: 0,
      get: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0
    }
    const rejection = new Proxy({}, {
      getPrototypeOf() {
        calls.getPrototypeOf += 1
        throw new Error('prototype trap')
      },
      get() {
        calls.get += 1
        throw new Error('get trap')
      },
      ownKeys() {
        calls.ownKeys += 1
        throw new Error('ownKeys trap')
      },
      getOwnPropertyDescriptor() {
        calls.getOwnPropertyDescriptor += 1
        throw new Error('descriptor trap')
      }
    })
    harness.failAttestation(rejection)

    await expectCode(harness.orchestrator.prepare(DEFAULT_REQUEST), 'PREPARATION_FAILED')

    expect(calls.getPrototypeOf).toBe(0)
    expect(calls.get).toBe(0)
    expect(calls.ownKeys).toBeGreaterThan(0)
    expect(calls.getOwnPropertyDescriptor).toBeGreaterThan(0)
    expect(harness.orchestrator.getState().status).not.toBe('aborted')
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

  test('honors a synchronous signing subscriber abort before invoking the signer', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const controller = new AbortController()
    harness.orchestrator.subscribe(state => {
      if (state.status === 'signing') controller.abort()
    })

    await expectCode(
      harness.orchestrator.authorizeAndSign(review.preparedId, controller.signal),
      'ABORTED'
    )

    expect(harness.calls.signer).toBe(0)
    expect(harness.calls.audit).toBe(0)
    expect(harness.calls.broadcast).toBe(0)
    expect(harness.orchestrator.getState()).toMatchObject({
      status: 'aborted',
      stage: 'signing'
    })
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

  test('preserves coded Error diagnostics for failed state snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const originalCause = new Tm1RegtestDeliveryTransportError(
      'DUPLICATE_SUBMISSION'
    ) as Tm1RegtestDeliveryTransportError & { metadata: { retryable: boolean; nested: { reason: string } } }
    originalCause.metadata = { retryable: false, nested: { reason: 'original' } }
    harness.failSigner(originalCause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.authorizeAndSign(review.preparedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected thrown error')
    const thrownCause = innermostCause(thrown) as Error & { code: string; metadata: { nested: { reason: string } } }
    expect(thrownCause).not.toBe(originalCause)
    expect(thrownCause.name).toBe('Tm1RegtestDeliveryTransportError')
    expect(thrownCause.message).toBe('DUPLICATE_SUBMISSION')
    expect(thrownCause.code).toBe('DUPLICATE_SUBMISSION')
    expect(thrownCause.metadata.nested.reason).toBe('original')

    ;(originalCause as { code: string }).code = 'MUTATED'
    originalCause.metadata.nested.reason = 'mutated'

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const stateCause = innermostCause(state.error) as Error & { code: string; metadata: { nested: { reason: string } } }
    expect(stateCause).not.toBe(originalCause)
    expect(stateCause).not.toBe(thrownCause)
    expect(stateCause.name).toBe('Tm1RegtestDeliveryTransportError')
    expect(stateCause.message).toBe('DUPLICATE_SUBMISSION')
    expect(stateCause.code).toBe('DUPLICATE_SUBMISSION')
    expect(stateCause.metadata.nested.reason).toBe('original')
  })

  test('clones mutable Error diagnostic properties and isolates caller mutations', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = new Error('failure') as Error & {
      code: string
      metadata: { retryable: boolean; nested: { reason: string } }
    }
    cause.code = 'ORIGINAL'
    cause.metadata = { retryable: false, nested: { reason: 'original' } }
    harness.failSigner(cause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.authorizeAndSign(review.preparedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected thrown error')
    cause.metadata.nested.reason = 'mutated'
    const thrownCause = innermostCause(thrown) as Error & {
      code: string
      metadata: { retryable: boolean; nested: { reason: string } }
    }
    thrownCause.code = 'CALLER_MUTATED'
    thrownCause.metadata.nested.reason = 'caller-mutated'

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const stateCause = innermostCause(state.error) as Error & {
      code: string
      metadata: { retryable: boolean; nested: { reason: string } }
    }
    expect(stateCause).not.toBe(cause)
    expect(stateCause).not.toBe(thrownCause)
    expect(stateCause.code).toBe('ORIGINAL')
    expect(stateCause.metadata).toEqual({ retryable: false, nested: { reason: 'original' } })
    expect(stateCause.metadata).not.toBe(cause.metadata)
    expect(stateCause.metadata).not.toBe(thrownCause.metadata)
  })

  test('failed state subscribers receive isolated coded Error diagnostics', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = new Error('failure') as Error & {
      code: string
      metadata: { retryable: boolean; nested: { reason: string } }
    }
    cause.code = 'ORIGINAL'
    cause.metadata = { retryable: false, nested: { reason: 'original' } }
    const listenerACauses: unknown[] = []
    const listenerBCauses: unknown[] = []
    harness.failSigner(cause)
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      const snapshotCause = innermostCause(state.error) as Error & {
        code: string
        metadata: { nested: { reason: string } }
      }
      listenerACauses.push(snapshotCause)
      snapshotCause.code = 'LISTENER_MUTATED'
      snapshotCause.metadata.nested.reason = 'listener-mutated'
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      listenerBCauses.push(innermostCause(state.error))
    })

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    expect(listenerACauses).toHaveLength(1)
    expect(listenerBCauses).toHaveLength(1)
    expect(listenerACauses[0]).not.toBe(listenerBCauses[0])
    expect(listenerBCauses[0]).toMatchObject({
      name: 'Error',
      message: 'failure',
      code: 'ORIGINAL',
      metadata: { retryable: false, nested: { reason: 'original' } }
    })
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(state.error)).toMatchObject({
      code: 'ORIGINAL',
      metadata: { retryable: false, nested: { reason: 'original' } }
    })
  })

  test('broadcastUncertain preserves coded Error diagnostics and signed evidence', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const cause = new Tm1RegtestDeliveryTransportError(
      'INVALID_ARTIFACT_ENVIRONMENT'
    ) as Tm1RegtestDeliveryTransportError & { metadata: { retryable: boolean; nested: { reason: string } } }
    cause.metadata = { retryable: false, nested: { reason: 'original' } }
    harness.failBroadcast(cause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.approveAndBroadcast(signedReview.signedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected broadcast error')
    cause.metadata.nested.reason = 'mutated'

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('broadcastUncertain')
    if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    const uncertaintyCause = innermostCause(state.uncertainty.error) as Error & {
      code: string
      metadata: { retryable: boolean; nested: { reason: string } }
    }
    expect(uncertaintyCause).not.toBe(cause)
    expect(uncertaintyCause.name).toBe('Tm1RegtestDeliveryTransportError')
    expect(uncertaintyCause.message).toBe('INVALID_ARTIFACT_ENVIRONMENT')
    expect(uncertaintyCause.code).toBe('INVALID_ARTIFACT_ENVIRONMENT')
    expect(uncertaintyCause.metadata).toEqual({ retryable: false, nested: { reason: 'original' } })
    expect(state.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-1')
    expect(state.uncertainty.txid).toBe(signedReview.txid)
    expect(state.uncertainty.signedArtifact).not.toBe(signedReview.signedArtifact)
    expect(state.uncertainty.signedArtifact.rawTransactionHex).toBe(signedReview.signedArtifact.rawTransactionHex)
    expect(state.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
  })

  test('clones plain object causes without invoking throwing getters', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getterCalls = 0
    const cause: { code: string; dangerous?: unknown } = { code: 'ORIGINAL' }
    Object.defineProperty(cause, 'dangerous', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('getter must never execute')
      }
    })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as Record<PropertyKey, unknown>
    expect(getterCalls).toBe(0)
    expect(clonedCause.code).toBe('ORIGINAL')
    expect(Object.hasOwn(clonedCause, 'dangerous')).toBe(false)
  })

  test('clones nested causes without invoking nested throwing getters', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getterCalls = 0
    const nested: { value: string; dangerous?: unknown } = { value: 'safe' }
    Object.defineProperty(nested, 'dangerous', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('nested getter must never execute')
      }
    })
    harness.failSigner({ code: 'ORIGINAL', nested })

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as { nested: Record<PropertyKey, unknown> }
    expect(getterCalls).toBe(0)
    expect(clonedCause.nested.value).toBe('safe')
    expect(Object.hasOwn(clonedCause.nested, 'dangerous')).toBe(false)
  })

  test('clones Error causes without invoking an own message accessor', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getterCalls = 0
    const cause = new Error('original') as Error & { code: string }
    cause.code = 'ORIGINAL'
    Object.defineProperty(cause, 'message', {
      configurable: true,
      get() {
        getterCalls += 1
        throw new Error('message getter must never execute')
      }
    })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as Error & { code: string }
    expect(getterCalls).toBe(0)
    expect(clonedCause).toBeInstanceOf(Error)
    expect(clonedCause.code).toBe('ORIGINAL')
  })

  test('clones array causes without invoking index accessors', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getterCalls = 0
    const cause: unknown[] = []
    Object.defineProperty(cause, '0', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('array getter must never execute')
      }
    })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as unknown[]
    expect(getterCalls).toBe(0)
    expect(clonedCause).toHaveLength(1)
    expect(0 in clonedCause).toBe(false)
  })

  test('keeps hostile post-dispatch rejection reconcilable without invoking its getter or rebroadcasting', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    let getterCalls = 0
    const cause: { code: string; dangerous?: unknown } = { code: 'ORIGINAL' }
    Object.defineProperty(cause, 'dangerous', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('post-dispatch getter must never execute')
      }
    })
    harness.failBroadcast(cause)

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')

    expect(getterCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    expect(innermostCause(uncertain.uncertainty.error)).toMatchObject({ code: 'ORIGINAL' })
    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid,
      confirmations: 1,
      blockHash: 'ef'.repeat(32),
      blockHeight: 107
    }))

    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid
    })
    expect(getterCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('clones simple Error causes for failed state snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = new Error('simple failure')
    cause.name = 'SimpleFailure'
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const stateCause = innermostCause(state.error) as Error
    expect(stateCause).toBeInstanceOf(Error)
    expect(stateCause).not.toBe(cause)
    expect(stateCause.name).toBe('SimpleFailure')
    expect(stateCause.message).toBe('simple failure')
  })

  test('converts function-valued causes into isolated non-callable diagnostics', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = function rejection() { return undefined } as (() => undefined) & {
      code: string
      message: string
      metadata: { nested: { reason: string } }
      customScalar: number
      cause?: unknown
    }
    cause.code = 'ORIGINAL'
    cause.message = 'original function rejection'
    cause.metadata = { nested: { reason: 'original' } }
    cause.customScalar = 7
    cause.cause = cause
    const listenerACauses: unknown[] = []
    const listenerBCauses: unknown[] = []
    harness.failSigner(cause)
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      const listenerCause = innermostCause(state.error) as {
        metadata: { nested: { reason: string } }
      }
      listenerACauses.push(listenerCause)
      listenerCause.metadata.nested.reason = 'listener-mutated'
    })
    harness.orchestrator.subscribe(state => {
      if (state.status === 'failed') listenerBCauses.push(innermostCause(state.error))
    })
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.authorizeAndSign(review.preparedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected thrown error')
    const thrownCause = innermostCause(thrown) as {
      name: string
      code: string
      message: string
      metadata: { nested: { reason: string } }
      customScalar: number
      cause?: unknown
    }

    expect(thrownCause).not.toBe(cause)
    expect(typeof thrownCause).toBe('object')
    expect(thrownCause.name).toBe('rejection')
    expect(thrownCause.code).toBe('ORIGINAL')
    expect(thrownCause.message).toBe('original function rejection')
    expect(thrownCause.metadata).toEqual({ nested: { reason: 'original' } })
    expect(thrownCause.customScalar).toBe(7)
    expect(thrownCause.cause).toBe(thrownCause)
    expect(Object.prototype.hasOwnProperty.call(thrownCause, 'prototype')).toBe(false)
    expect(listenerACauses).toHaveLength(1)
    expect(listenerBCauses).toHaveLength(1)
    expect(listenerACauses[0]).not.toBe(listenerBCauses[0])
    expect(listenerBCauses[0]).toMatchObject({
      code: 'ORIGINAL',
      metadata: { nested: { reason: 'original' } }
    })

    cause.code = 'MUTATED'
    cause.metadata.nested.reason = 'mutated'
    expect(thrownCause.code).toBe('ORIGINAL')
    expect(thrownCause.metadata.nested.reason).toBe('original')

    thrownCause.code = 'CALLER_MUTATED'
    thrownCause.metadata.nested.reason = 'caller-mutated'
    const firstState = harness.orchestrator.getState()
    expect(firstState.status).toBe('failed')
    if (firstState.status !== 'failed') throw new Error('expected failed')
    const firstStateCause = innermostCause(firstState.error) as typeof thrownCause
    expect(firstStateCause.code).toBe('ORIGINAL')
    expect(firstStateCause.metadata.nested.reason).toBe('original')

    firstStateCause.code = 'SNAPSHOT_MUTATED'
    firstStateCause.metadata.nested.reason = 'snapshot-mutated'
    const secondState = harness.orchestrator.getState()
    expect(secondState.status).toBe('failed')
    if (secondState.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(secondState.error)).toMatchObject({
      code: 'ORIGINAL',
      metadata: { nested: { reason: 'original' } }
    })
  })

  test('never invokes accessors on function-valued causes', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = function accessorRejection() { return undefined }
    let getterCalls = 0
    Object.defineProperty(cause, 'diagnostic', {
      configurable: true,
      get() {
        getterCalls += 1
        throw new Error('function accessor must never execute')
      }
    })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    expect(getterCalls).toBe(0)
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error)
    expect(typeof clonedCause).toBe('object')
    expect(Object.prototype.hasOwnProperty.call(clonedCause, 'diagnostic')).toBe(false)
  })

  test.each([
    ['ownKeys', () => new Proxy(function ownKeysRejection() { return undefined }, {
      ownKeys() {
        throw new Error('hostile ownKeys trap')
      }
    })],
    ['getOwnPropertyDescriptor', () => new Proxy(
      function descriptorRejection() { return undefined },
      {
        getOwnPropertyDescriptor() {
          throw new Error('hostile descriptor trap')
        }
      }
    )]
  ] as const)('uses a safe fallback for a function Proxy with hostile %s reflection', async (_trap, createCause) => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    harness.failSigner(createCause())

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(state.error)).toEqual({
      name: 'UnknownObject',
      description: 'External object could not be cloned safely'
    })
  })

  test('does not inspect the prototype of a function Proxy while cloning it', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    let getPrototypeOfCalls = 0
    const source = function prototypeRejection() { return undefined }
    ;(source as typeof source & { code: string }).code = 'ORIGINAL'
    const cause = new Proxy(source, {
      getPrototypeOf() {
        getPrototypeOfCalls += 1
        throw new Error('function prototype trap must not execute')
      }
    })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    expect(getPrototypeOfCalls).toBe(0)
    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error)
    expect(typeof clonedCause).toBe('object')
    expect(clonedCause).toMatchObject({ code: 'ORIGINAL' })
  })

  test('clones mutable plain object causes for failed state snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = { reason: 'original', nested: { value: 1 } }
    const subscriberCauses: unknown[] = []
    harness.orchestrator.subscribe(state => {
      if (state.status === 'failed') subscriberCauses.push(innermostCause(state.error))
    })
    harness.failSigner(cause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.authorizeAndSign(review.preparedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected thrown error')
    cause.reason = 'mutated'
    cause.nested.value = 999

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(thrown)).toEqual({ reason: 'original', nested: { value: 1 } })
    expect(innermostCause(state.error)).toEqual({ reason: 'original', nested: { value: 1 } })
    expect(subscriberCauses).toHaveLength(1)
    expect(subscriberCauses[0]).toEqual({ reason: 'original', nested: { value: 1 } })
    expect(innermostCause(state.error)).not.toBe(cause)
  })

  test('clones mutable array causes for failed state snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause: unknown[] = ['original', { value: 1 }]
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    cause[0] = 'mutated'
    ;(cause[1] as { value: number }).value = 999

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(state.error)).toEqual(['original', { value: 1 }])
    expect(innermostCause(state.error)).not.toBe(cause)
  })

  test('clones mutable Uint8Array causes for failed state snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = new Uint8Array([1, 2, 3])
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    cause[0] = 255

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(Array.from(innermostCause(state.error) as Uint8Array)).toEqual([1, 2, 3])
    expect(innermostCause(state.error)).not.toBe(cause)
  })

  test('caller mutation of thrown mutable cause cannot affect future getState snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = { reason: 'original', nested: { value: 1 } }
    harness.failSigner(cause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.authorizeAndSign(review.preparedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected thrown error')
    ;(innermostCause(thrown) as { nested: { value: number } }).nested.value = 999

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    expect(innermostCause(state.error)).toEqual({ reason: 'original', nested: { value: 1 } })
  })

  test('failed state subscribers receive isolated mutable cause snapshots', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = { reason: 'original', nested: { value: 1 } }
    const listenerACauses: unknown[] = []
    const listenerBCauses: unknown[] = []
    harness.failSigner(cause)
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      const snapshotCause = innermostCause(state.error)
      listenerACauses.push(snapshotCause)
      ;(snapshotCause as { nested: { value: number } }).nested.value = 999
    })
    harness.orchestrator.subscribe(state => {
      if (state.status !== 'failed') return
      listenerBCauses.push(innermostCause(state.error))
    })

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    expect(listenerACauses).toHaveLength(1)
    expect(listenerBCauses).toHaveLength(1)
    expect(listenerACauses[0]).not.toBe(listenerBCauses[0])
    expect(listenerBCauses[0]).toEqual({ reason: 'original', nested: { value: 1 } })
  })

  test('broadcastUncertain clones mutable plain object causes and preserves signed evidence', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const cause = { reason: 'original', nested: { value: 1 } }
    harness.failBroadcast(cause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.approveAndBroadcast(signedReview.signedId).catch(error => { thrown = error })
    if (thrown === null) throw new Error('expected broadcast error')
    cause.reason = 'mutated'
    cause.nested.value = 999

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('broadcastUncertain')
    if (state.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(innermostCause(thrown)).toEqual({ reason: 'original', nested: { value: 1 } })
    expect(innermostCause(state.uncertainty.error)).toEqual({ reason: 'original', nested: { value: 1 } })
    expect(state.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-1')
    expect(state.uncertainty.txid).toBe(signedReview.txid)
    expect(state.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(state.uncertainty.signedArtifact.rawTransactionHex).toBe(signedReview.signedArtifact.rawTransactionHex)
  })

  test('isolates a post-dispatch function rejection and reconciles without rebroadcast', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const cause = function transportRejection() { return undefined } as (() => undefined) & {
      code: string
      metadata: { nested: { reason: string } }
    }
    cause.code = 'ORIGINAL'
    cause.metadata = { nested: { reason: 'original' } }
    harness.failBroadcast(cause)
    let thrown: Tm1PublicationError | null = null

    await harness.orchestrator.approveAndBroadcast(signedReview.signedId).catch(error => {
      thrown = error
    })
    if (thrown === null) throw new Error('expected broadcast error')

    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    const storedCause = innermostCause(uncertain.uncertainty.error) as {
      name: string
      code: string
      metadata: { nested: { reason: string } }
    }
    const thrownCause = innermostCause(thrown) as typeof storedCause
    expect(uncertain.status).toBe('broadcastUncertain')
    expect(storedCause).not.toBe(cause)
    expect(thrownCause).not.toBe(cause)
    expect(typeof storedCause).toBe('object')
    expect(typeof thrownCause).toBe('object')
    expect(storedCause).toMatchObject({
      name: 'transportRejection',
      code: 'ORIGINAL',
      metadata: { nested: { reason: 'original' } }
    })
    expect(thrownCause).toMatchObject({
      code: 'ORIGINAL',
      metadata: { nested: { reason: 'original' } }
    })

    cause.code = 'MUTATED'
    cause.metadata.nested.reason = 'mutated'
    thrownCause.metadata.nested.reason = 'caller-mutated'
    const subsequentState = harness.orchestrator.getState()
    expect(subsequentState.status).toBe('broadcastUncertain')
    if (subsequentState.status !== 'broadcastUncertain') throw new Error('expected uncertainty')
    expect(innermostCause(subsequentState.uncertainty.error)).toMatchObject({
      code: 'ORIGINAL',
      metadata: { nested: { reason: 'original' } }
    })

    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid,
      confirmations: 1,
      blockHash: 'fd'.repeat(32),
      blockHeight: 111
    }))
    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid
    })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('clones circular plain object causes without stack overflow', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause: { reason: string; self?: unknown } = { reason: 'original' }
    cause.self = cause
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    cause.reason = 'mutated'

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as { reason: string; self?: unknown }
    expect(clonedCause.reason).toBe('original')
    expect(clonedCause.self).toBe(clonedCause)
    expect(clonedCause).not.toBe(cause)
  })

  test.each(['code', 'message', 'name', 'cause'] as const)(
    'never invokes a poisoned publication error %s accessor while cloning',
    async poisonedKey => {
      const harness = createHarness()
      const signedReview = await prepareAndSign(harness)
      const transportError = new Tm1PublicationError(
        'BROADCAST_FAILED',
        'safe transport failure',
        { diagnostic: 'safe cause' }
      )
      let getterCalls = 0
      Object.defineProperty(transportError, poisonedKey, {
        configurable: true,
        get() {
          getterCalls += 1
          throw new Error(`poisoned ${poisonedKey} getter`)
        }
      })
      harness.failBroadcast(transportError)

      await harness.orchestrator.approveAndBroadcast(signedReview.signedId).then(
        () => { throw new Error('expected broadcast rejection') },
        () => undefined
      )

      expect(getterCalls).toBe(0)
      expect(harness.calls.broadcast).toBe(1)
      const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
      expect(uncertain.uncertainty.error.code).toBe('BROADCAST_FAILED')
      expect(uncertain.uncertainty.error.name).toBe('Tm1PublicationError')
      expect(uncertain.uncertainty.error.message).toBe(
        poisonedKey === 'message' ? 'BROADCAST_FAILED' : 'safe transport failure'
      )
      if (poisonedKey === 'cause') {
        expect(uncertain.uncertainty.error.cause).toBeUndefined()
      } else {
        expect(uncertain.uncertainty.error.cause).toEqual({ diagnostic: 'safe cause' })
      }
    }
  )

  test('preserves safe normal publication error metadata in an isolated clone', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const transportError = new Tm1PublicationError(
      'BROADCAST_FAILED',
      'normal publication failure',
      { diagnostic: { attempt: 1 } }
    )
    harness.failBroadcast(transportError)

    await expectCode(
      harness.orchestrator.approveAndBroadcast(signedReview.signedId),
      'BROADCAST_FAILED'
    )

    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    const cloned = uncertain.uncertainty.error
    expect(cloned).toBeInstanceOf(Tm1PublicationError)
    expect(cloned).not.toBe(transportError)
    expect(cloned.name).toBe(transportError.name)
    expect(cloned.message).toBe(transportError.message)
    expect(cloned.code).toBe(transportError.code)
    expect(cloned.cause).toEqual(transportError.cause)
    expect(cloned.cause).not.toBe(transportError.cause)
  })

  test('clones a self-referential publication error with diagnostics and no recursion', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause = new Tm1PublicationError('SIGNING_FAILED', 'self-referential failure') as
      Tm1PublicationError & { metadata: { nested: { reason: string } } }
    cause.metadata = { nested: { reason: 'original' } }
    Object.defineProperty(cause, 'cause', { value: cause })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')
    cause.metadata.nested.reason = 'mutated'

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const cycle = publicationErrorCycle(state.error)
    expect(cycle).toHaveLength(1)
    expect(cycle[0]).not.toBe(cause)
    expect((cycle[0] as Tm1PublicationError & {
      metadata: { nested: { reason: string } }
    }).metadata).toEqual({ nested: { reason: 'original' } })
  })

  test('clones a two-node publication error cycle', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const errorA = new Tm1PublicationError('SIGNING_FAILED', 'cycle A')
    const errorB = new Tm1PublicationError('CANDIDATE_REVALIDATION_FAILED', 'cycle B')
    Object.defineProperty(errorA, 'cause', { value: errorB })
    Object.defineProperty(errorB, 'cause', { value: errorA })
    harness.failSigner(errorA)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const cycle = publicationErrorCycle(state.error)
    expect(cycle).toHaveLength(2)
    expect(cycle.map(error => error.message)).toEqual(['cycle A', 'cycle B'])
    expect(cycle).not.toContain(errorA)
    expect(cycle).not.toContain(errorB)
  })

  test('clones a publication error embedded in a circular plain object', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const publicationError = new Tm1PublicationError('SIGNING_FAILED', 'embedded failure')
    const cause: { self?: unknown; publicationError: Tm1PublicationError } = {
      publicationError
    }
    cause.self = cause
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as typeof cause
    expect(clonedCause).not.toBe(cause)
    expect(clonedCause.self).toBe(clonedCause)
    expect(clonedCause.publicationError).toBeInstanceOf(Tm1PublicationError)
    expect(clonedCause.publicationError).not.toBe(publicationError)
    expect(clonedCause.publicationError.message).toBe('embedded failure')
  })

  test('clones a plain object to publication error back-edge without sharing references', async () => {
    const harness = createHarness()
    const review = await harness.orchestrator.prepare(DEFAULT_REQUEST)
    const cause: { publicationError?: Tm1PublicationError; label: string } = {
      label: 'root'
    }
    const publicationError = new Tm1PublicationError('SIGNING_FAILED', 'back-edge failure')
    cause.publicationError = publicationError
    Object.defineProperty(publicationError, 'cause', { value: cause })
    harness.failSigner(cause)

    await expectCode(harness.orchestrator.authorizeAndSign(review.preparedId), 'SIGNING_FAILED')

    const state = harness.orchestrator.getState()
    expect(state.status).toBe('failed')
    if (state.status !== 'failed') throw new Error('expected failed')
    const clonedCause = innermostCause(state.error) as Required<typeof cause>
    expect(clonedCause).not.toBe(cause)
    expect(clonedCause.publicationError).not.toBe(publicationError)
    expect(clonedCause.publicationError.cause).toBe(clonedCause)
  })

  test('keeps a cyclic publication rejection reconcilable without rebroadcasting', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const cause = new Tm1PublicationError('BROADCAST_FAILED', 'cyclic transport failure')
    Object.defineProperty(cause, 'cause', { value: cause })
    harness.failBroadcast(cause)

    await expectCode(harness.orchestrator.approveAndBroadcast(signedReview.signedId), 'BROADCAST_FAILED')

    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    expect(publicationErrorCycle(uncertain.uncertainty.error)).toHaveLength(1)
    expect(uncertain.uncertainty.txid).toBe(signedReview.txid)
    expect(uncertain.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-1')
    expect(uncertain.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(uncertain.uncertainty.signedArtifact.rawTransactionHex).toBe(
      signedReview.signedArtifact.rawTransactionHex
    )
    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid,
      confirmations: 1,
      blockHash: 'fa'.repeat(32),
      blockHeight: 108
    }))

    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid
    })
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
  })

  test('keeps a post-dispatch poisoned publication error reconcilable without accessors or rebroadcast', async () => {
    const harness = createHarness()
    const signedReview = await prepareAndSign(harness)
    const transportError = new Tm1PublicationError(
      'BROADCAST_FAILED',
      'must never be read directly',
      { diagnostic: 'must never be read directly' }
    )
    let getterCalls = 0
    for (const key of ['code', 'message', 'name', 'cause'] as const) {
      Object.defineProperty(transportError, key, {
        configurable: true,
        get() {
          getterCalls += 1
          throw new Error(`poisoned ${key} getter`)
        }
      })
    }
    harness.failBroadcast(transportError)

    await harness.orchestrator.approveAndBroadcast(signedReview.signedId).then(
      () => { throw new Error('expected broadcast rejection') },
      () => undefined
    )

    expect(getterCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(1)
    const uncertain = expectBroadcastUncertainEvidence(harness, signedReview)
    expect(uncertain.uncertainty.error === transportError).toBe(false)
    expect(uncertain.uncertainty.error.code).toBe('BROADCAST_FAILED')
    expect(uncertain.uncertainty.error.message).toBe('BROADCAST_FAILED')
    expect(uncertain.uncertainty.error.name).toBe('Tm1PublicationError')
    expect(uncertain.uncertainty.error.cause).toBeUndefined()
    expect(uncertain.uncertainty.txid).toBe(signedReview.txid)
    expect(uncertain.uncertainty.signedArtifactHash).toBe(signedReview.signedArtifactHash)
    expect(uncertain.uncertainty.broadcastAuthorizationId).toBe('broadcast-auth-1')
    expect(uncertain.signedReview.txid).toBe(signedReview.txid)
    harness.setConfirmation(Object.freeze({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid,
      confirmations: 1,
      blockHash: 'fb'.repeat(32),
      blockHeight: 109
    }))

    await expect(harness.orchestrator.reconcile()).resolves.toMatchObject({
      submissionId: uncertain.uncertainty.submissionId,
      txid: signedReview.txid
    })
    expect(getterCalls).toBe(0)
    expect(harness.calls.broadcast).toBe(1)
    expect(harness.orchestrator.getState().status).toBe('confirmed')
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
