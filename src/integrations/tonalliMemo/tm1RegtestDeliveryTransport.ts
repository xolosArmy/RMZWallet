import {
  ALL_BIP143,
  Tx,
  isPushOp,
  toHex
} from 'ecash-lib'
import {
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_SIGHASH_POLICY
} from './tm1Draft02Candidate'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX,
  TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION,
  TM1_REGTEST_SIGNED_TRANSACTION_FORMAT,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'

export const TM1_IN_MEMORY_REGTEST_CHAIN_IDENTITY =
  'tonalli.tm1-draft02.in-memory-regtest.v1'

const SCHNORR_SIGNATURE_BYTES = 64
const MAX_SIMULATED_LATENCY_MS = 60_000

export type Tm1RegtestNetworkAttestation = Readonly<{
  environment: typeof TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
  chainIdentity: string
}>

export type Tm1RegtestDeliveryReceipt = Readonly<{
  txid: string
  disposition: 'accepted'
}>

export interface Tm1RegtestDeliveryTransport {
  attestNetwork(signal?: AbortSignal): Promise<Tm1RegtestNetworkAttestation>
  submit(
    signedArtifact: RegtestSignedTransaction,
    signal?: AbortSignal
  ): Promise<Tm1RegtestDeliveryReceipt>
}

export type Tm1RegtestDeliveryTransportErrorCode =
  | 'OPERATION_ABORTED'
  | 'INVALID_SIMULATED_LATENCY'
  | 'INVALID_CHAIN_IDENTITY'
  | 'INVALID_ARTIFACT_FORMAT'
  | 'INVALID_ARTIFACT_VERSION'
  | 'INVALID_ARTIFACT_ENVIRONMENT'
  | 'INVALID_ARTIFACT_SIGHASH_POLICY'
  | 'INVALID_FIXTURE_IDENTITY'
  | 'INVALID_RAW_TRANSACTION'
  | 'RAW_TRANSACTION_BYTES_MISMATCH'
  | 'TRANSACTION_ID_MISMATCH'
  | 'INPUT_COUNT_MISMATCH'
  | 'INVALID_FIXTURE_TRANSACTION'
  | 'DUPLICATE_SUBMISSION'

export class Tm1RegtestDeliveryTransportError extends Error {
  readonly code: Tm1RegtestDeliveryTransportErrorCode

  constructor(code: Tm1RegtestDeliveryTransportErrorCode, message = code) {
    super(message)
    this.name = 'Tm1RegtestDeliveryTransportError'
    this.code = code
  }
}

export type Tm1InMemoryDeliveryTransportOptions = Readonly<{
  chainIdentity?: string
  latencyMs?: number
}>

export class Tm1InMemoryDeliveryTransport implements Tm1RegtestDeliveryTransport {
  readonly chainIdentity: string
  readonly latencyMs: number
  private readonly pendingTxids = new Set<string>()
  private readonly submittedTxids = new Set<string>()

  constructor(options: Tm1InMemoryDeliveryTransportOptions = {}) {
    const chainIdentity = options.chainIdentity ?? TM1_IN_MEMORY_REGTEST_CHAIN_IDENTITY
    const latencyMs = options.latencyMs ?? 0

    if (chainIdentity.length === 0 || chainIdentity.trim() !== chainIdentity) {
      fail('INVALID_CHAIN_IDENTITY')
    }
    if (
      !Number.isSafeInteger(latencyMs) ||
      latencyMs < 0 ||
      latencyMs > MAX_SIMULATED_LATENCY_MS
    ) {
      fail('INVALID_SIMULATED_LATENCY')
    }

    this.chainIdentity = chainIdentity
    this.latencyMs = latencyMs
  }

  async attestNetwork(signal?: AbortSignal): Promise<Tm1RegtestNetworkAttestation> {
    assertNotAborted(signal)
    await waitForLatency(this.latencyMs, signal)
    assertNotAborted(signal)

    return Object.freeze({
      environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
      chainIdentity: this.chainIdentity
    })
  }

  async submit(
    signedArtifact: RegtestSignedTransaction,
    signal?: AbortSignal
  ): Promise<Tm1RegtestDeliveryReceipt> {
    assertNotAborted(signal)
    const txid = auditRegtestSignedArtifact(signedArtifact)

    if (this.pendingTxids.has(txid) || this.submittedTxids.has(txid)) {
      fail('DUPLICATE_SUBMISSION')
    }

    this.pendingTxids.add(txid)
    try {
      await waitForLatency(this.latencyMs, signal)
      assertNotAborted(signal)

      if (this.submittedTxids.has(txid)) fail('DUPLICATE_SUBMISSION')
      this.submittedTxids.add(txid)

      return Object.freeze({ txid, disposition: 'accepted' })
    } finally {
      this.pendingTxids.delete(txid)
    }
  }
}

function auditRegtestSignedArtifact(artifact: RegtestSignedTransaction): string {
  if (artifact.format !== TM1_REGTEST_SIGNED_TRANSACTION_FORMAT) {
    fail('INVALID_ARTIFACT_FORMAT')
  }
  if (artifact.artifactVersion !== TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION) {
    fail('INVALID_ARTIFACT_VERSION')
  }
  if (artifact.environment !== TM1_DRAFT_02_CANDIDATE_ENVIRONMENT) {
    fail('INVALID_ARTIFACT_ENVIRONMENT')
  }
  if (artifact.sighashPolicy !== TM1_DRAFT_02_SIGHASH_POLICY) {
    fail('INVALID_ARTIFACT_SIGHASH_POLICY')
  }
  if (
    artifact.fixturePublicKeyHex !== TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX ||
    artifact.fixtureLockingScriptHex !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
  ) {
    fail('INVALID_FIXTURE_IDENTITY')
  }
  if (
    typeof artifact.rawTransactionHex !== 'string' ||
    artifact.rawTransactionHex.length === 0 ||
    artifact.rawTransactionHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(artifact.rawTransactionHex) ||
    !(artifact.rawTransactionBytes instanceof Uint8Array)
  ) {
    fail('INVALID_RAW_TRANSACTION')
  }
  if (toHex(artifact.rawTransactionBytes) !== artifact.rawTransactionHex) {
    fail('RAW_TRANSACTION_BYTES_MISMATCH')
  }

  let transaction: Tx
  try {
    transaction = Tx.fromHex(artifact.rawTransactionHex)
  } catch {
    fail('INVALID_RAW_TRANSACTION')
  }

  if (toHex(transaction.ser()) !== artifact.rawTransactionHex) {
    fail('INVALID_RAW_TRANSACTION')
  }
  if (transaction.txid() !== artifact.txid) {
    fail('TRANSACTION_ID_MISMATCH')
  }
  if (transaction.inputs.length !== artifact.inputCount) {
    fail('INPUT_COUNT_MISMATCH')
  }
  if (
    transaction.inputs.length === 0 ||
    transaction.outputs.length !== 2 ||
    transaction.outputs[0]?.sats !== 0n ||
    !transaction.outputs[0]?.script.toHex().startsWith('6a04544d4d00') ||
    transaction.outputs[1]?.script.toHex() !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
  ) {
    fail('INVALID_FIXTURE_TRANSACTION')
  }

  for (const transactionInput of transaction.inputs) {
    const operations = transactionInput.script?.ops()
    const signaturePush = operations?.next()
    const publicKeyPush = operations?.next()
    if (
      !operations ||
      !isPushOp(signaturePush) ||
      !isPushOp(publicKeyPush) ||
      operations.next() !== undefined ||
      signaturePush.data.length !== SCHNORR_SIGNATURE_BYTES + 1 ||
      signaturePush.data[SCHNORR_SIGNATURE_BYTES] !== (ALL_BIP143.toInt() & 0xff) ||
      toHex(publicKeyPush.data) !== TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX
    ) {
      fail('INVALID_FIXTURE_TRANSACTION')
    }
  }

  return artifact.txid
}

function waitForLatency(latencyMs: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal)
  if (latencyMs === 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Tm1RegtestDeliveryTransportError('OPERATION_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, latencyMs)

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('OPERATION_ABORTED')
}

function fail(code: Tm1RegtestDeliveryTransportErrorCode): never {
  throw new Tm1RegtestDeliveryTransportError(code)
}
