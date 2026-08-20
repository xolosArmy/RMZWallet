import { ChronikClient } from 'chronik-client'
import { Tx, toHex, toHexRev } from 'ecash-lib'
import type {
  ApprovalConsumption,
  ApprovalConsumptionLedger
} from '../../features/externalSign/approval'
import { UniversalAuthorizationError } from '../../features/externalSign/contract'
import type {
  UniversalOperationLease,
  UniversalOperationLock
} from '../../features/externalSign/lock'
import {
  Tm1ChronikRegtestDeliveryTransport
} from './tm1ChronikRegtestDeliveryTransport'
import type { Tm1Draft02FundingUtxo } from './tm1Draft02Plan'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  auditTm1Draft02RegtestSignedTransaction,
  signTm1Draft02RegtestCandidate,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
import {
  createTm1RegtestDualAuthorizationPorts,
  type Tm1RegtestBroadcastAuthorizationCompositionConfig,
  type Tm1RegtestSigningAuthorizationCompositionConfig
} from './tm1RegtestDualAuthorizationComposition'
import {
  Tm1RegtestPublicationOrchestratorImpl,
  type Tm1Confirmation,
  type Tm1ConfirmationObserverPort,
  type Tm1DeliveryTransportPort,
  type Tm1NetworkAttestationPort,
  type Tm1RegtestPublicationOrchestrator,
  type Tm1SignedArtifactAuditPort,
  type Tm1SignerPort,
  type Tm1UtxoProviderPort
} from './tm1RegtestPublicationOrchestrator'

const REGTEST_COINBASE_MATURITY = 100
const RANDOM_ID_BYTES = 16
const FIXTURE_P2PKH_HASH_HEX = TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX.slice(6, 46)
const UINT32_MAX = 0xffffffff

export type Tm1RegtestRuntimeAuthorizationConfig = Readonly<{
  signing: Tm1RegtestSigningAuthorizationCompositionConfig
  broadcast: Tm1RegtestBroadcastAuthorizationCompositionConfig
}>

export type Tm1RegtestRuntimeConfig = Readonly<{
  chronikEndpointUrl: string
  authorization: Tm1RegtestRuntimeAuthorizationConfig
}>

export type Tm1RegtestRuntimeCompositionErrorCode =
  | 'INVALID_RUNTIME_CONFIGURATION'
  | 'WEB_CRYPTO_UNAVAILABLE'
  | 'OPERATION_ABORTED'
  | 'CHRONIK_UTXO_UNAVAILABLE'
  | 'INVALID_UTXO_RESPONSE'
  | 'TX_OBSERVATION_UNAVAILABLE'
  | 'INVALID_CONFIRMATION_RESPONSE'

export class Tm1RegtestRuntimeCompositionError extends Error {
  readonly code: Tm1RegtestRuntimeCompositionErrorCode

  constructor(code: Tm1RegtestRuntimeCompositionErrorCode) {
    super(code)
    this.name = 'Tm1RegtestRuntimeCompositionError'
    this.code = code
  }
}

/**
 * Construct one isolated, process-lifetime TM1 regtest publication runtime.
 * Construction is synchronous and does not contact Chronik.
 */
export function createTm1RegtestRuntime(
  config: Tm1RegtestRuntimeConfig
): Tm1RegtestPublicationOrchestrator {
  const snapshot = snapshotRuntimeConfig(config)
  const randomHex = createWebCryptoHexAllocator()

  // This constructor is the canonical loopback endpoint policy. Its normalized
  // endpoint is the only value used by every other Chronik-facing component.
  const deliveryBackend = new Tm1ChronikRegtestDeliveryTransport(
    snapshot.chronikEndpointUrl
  )
  const chronik = new ChronikClient([deliveryBackend.endpointUrl])
  const lock = new RuntimeAuthorizationLock()
  const approvalLedger = new RuntimeApprovalLedger()
  const now = Date.now

  const authorization = createTm1RegtestDualAuthorizationPorts({
    core: {
      enabled: true,
      lock,
      approvalLedger
    },
    now,
    createOperationIdSuffix: () => randomHex(RANDOM_ID_BYTES),
    signing: snapshot.authorization.signing,
    broadcast: snapshot.authorization.broadcast
  })

  const networkAttestation = Object.freeze<Tm1NetworkAttestationPort>({
    attest: (signal?: AbortSignal) => deliveryBackend.attestNetwork(signal)
  })
  const utxoProvider = createFixtureUtxoProvider(chronik)
  const signer = Object.freeze<Tm1SignerPort>({
    sign: async (review, signal) => signTm1Draft02RegtestCandidate({
      candidate: review.candidate,
      signal
    })
  })
  const signedArtifactAudit = createSignedArtifactAudit()
  const deliveryTransport = Object.freeze<Tm1DeliveryTransportPort>({
    broadcast: signedArtifact => deliveryBackend.submit(signedArtifact)
  })
  const confirmationObserver = createConfirmationObserver(
    chronik,
    networkAttestation
  )

  const orchestrator = new Tm1RegtestPublicationOrchestratorImpl({
    networkAttestation,
    utxoProvider,
    signingAuthorization: authorization.signingAuthorization,
    signer,
    signedArtifactAudit,
    broadcastAuthorization: authorization.broadcastAuthorization,
    deliveryTransport,
    confirmationObserver,
    clock: Object.freeze({
      createId: prefix => `${prefix}:${randomHex(RANDOM_ID_BYTES)}`
    })
  })

  const facade: Tm1RegtestPublicationOrchestrator = {
    getState: () => orchestrator.getState(),
    subscribe: listener => orchestrator.subscribe(listener),
    prepare: (request, signal) => orchestrator.prepare(request, signal),
    authorizeAndSign: (preparedId, signal) =>
      orchestrator.authorizeAndSign(preparedId, signal),
    approveAndBroadcast: (signedId, signal) =>
      orchestrator.approveAndBroadcast(signedId, signal),
    reconcile: signal => orchestrator.reconcile(signal),
    confirm: (submissionId, signal) => orchestrator.confirm(submissionId, signal),
    reset: () => orchestrator.reset()
  }
  return Object.freeze(facade)
}

function snapshotRuntimeConfig(config: Tm1RegtestRuntimeConfig): Tm1RegtestRuntimeConfig {
  if (!config || typeof config !== 'object') fail('INVALID_RUNTIME_CONFIGURATION')
  const authorization = config.authorization
  if (!authorization || typeof authorization !== 'object') {
    fail('INVALID_RUNTIME_CONFIGURATION')
  }
  const signing = authorization.signing
  const broadcast = authorization.broadcast
  if (!signing || !broadcast) fail('INVALID_RUNTIME_CONFIGURATION')

  return Object.freeze({
    chronikEndpointUrl: config.chronikEndpointUrl,
    authorization: Object.freeze({ signing, broadcast })
  })
}

function createWebCryptoHexAllocator(): (bytes: number) => string {
  const webCrypto = globalThis.crypto
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    fail('WEB_CRYPTO_UNAVAILABLE')
  }
  const getRandomValues = webCrypto.getRandomValues.bind(webCrypto)

  return bytes => {
    const random = new Uint8Array(bytes)
    getRandomValues(random)
    return toHex(random)
  }
}

class RuntimeAuthorizationLock implements UniversalOperationLock {
  private activeLease: RuntimeAuthorizationLease | null = null

  async acquire(
    operationId: string,
    signal: AbortSignal
  ): Promise<UniversalOperationLease> {
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    if (this.activeLease?.isOwned()) {
      throw new UniversalAuthorizationError('OPERATION_ALREADY_ACTIVE')
    }
    const lease = new RuntimeAuthorizationLease(operationId, () => {
      if (this.activeLease === lease) this.activeLease = null
    })
    this.activeLease = lease
    return lease
  }
}

class RuntimeAuthorizationLease implements UniversalOperationLease {
  private owned = true
  readonly ownerOperationId: string
  private readonly onRelease: () => void

  constructor(
    ownerOperationId: string,
    onRelease: () => void
  ) {
    this.ownerOperationId = ownerOperationId
    this.onRelease = onRelease
  }

  isOwned(): boolean {
    return this.owned
  }

  release(): void {
    if (!this.owned) throw new UniversalAuthorizationError('LEASE_ALREADY_RELEASED')
    this.owned = false
    this.onRelease()
  }
}

class RuntimeApprovalLedger implements ApprovalConsumptionLedger {
  private readonly consumedCapabilityIds = new Set<string>()

  async consume(
    consumption: ApprovalConsumption,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
    if (this.consumedCapabilityIds.has(consumption.capabilityId)) {
      throw new UniversalAuthorizationError('APPROVAL_ALREADY_CONSUMED')
    }
    this.consumedCapabilityIds.add(consumption.capabilityId)
  }
}

function createFixtureUtxoProvider(chronik: ChronikClient): Tm1UtxoProviderPort {
  return Object.freeze({
    readUtxos: async (signal?: AbortSignal): Promise<readonly Tm1Draft02FundingUtxo[]> => {
      assertNotAborted(signal)
      let response: unknown
      let blockchainInfo: unknown
      try {
        ;[response, blockchainInfo] = await abortable(
          Promise.all([
            chronik.script('p2pkh', FIXTURE_P2PKH_HASH_HEX).utxos(),
            chronik.blockchainInfo()
          ]),
          signal
        )
      } catch (error) {
        if (isRuntimeError(error)) throw error
        fail('CHRONIK_UTXO_UNAVAILABLE')
      }

      const tipHeight = readSafeNonNegativeInteger(blockchainInfo, 'tipHeight')
      const scriptHex = readScriptHex(response)
      const utxos = ownData(response, 'utxos')
      if (
        tipHeight === undefined ||
        scriptHex !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX ||
        !Array.isArray(utxos)
      ) {
        fail('INVALID_UTXO_RESPONSE')
      }

      const seenOutpoints = new Set<string>()
      const snapshot: Tm1Draft02FundingUtxo[] = []
      for (const value of utxos) {
        const record = asRecord(value)
        const outpoint = asRecord(ownData(record, 'outpoint'))
        const txid = readTxid(ownData(outpoint, 'txid'))
        const outIdx = ownData(outpoint, 'outIdx')
        const sats = ownData(record, 'sats')
        const isCoinbase = ownData(record, 'isCoinbase')
        const blockHeight = ownData(record, 'blockHeight')
        const token = ownData(record, 'token')
        if (
          txid === undefined ||
          typeof outIdx !== 'number' ||
          !Number.isSafeInteger(outIdx) ||
          outIdx < 0 ||
          outIdx > UINT32_MAX ||
          typeof sats !== 'bigint' ||
          sats <= 0n ||
          typeof isCoinbase !== 'boolean' ||
          typeof blockHeight !== 'number' ||
          !Number.isSafeInteger(blockHeight) ||
          blockHeight < -1 ||
          blockHeight > tipHeight
        ) {
          fail('INVALID_UTXO_RESPONSE')
        }
        const outpointId = `${txid}:${outIdx}`
        if (seenOutpoints.has(outpointId)) fail('INVALID_UTXO_RESPONSE')
        seenOutpoints.add(outpointId)

        if (token !== undefined && token !== null) continue
        if (isCoinbase) {
          if (blockHeight < 0) fail('INVALID_UTXO_RESPONSE')
          if (tipHeight - blockHeight + 1 < REGTEST_COINBASE_MATURITY) continue
        }
        snapshot.push(Object.freeze({
          txid,
          outIdx,
          sats,
          lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
        }))
      }

      snapshot.sort((left, right) => {
        if (left.sats !== right.sats) return left.sats > right.sats ? -1 : 1
        const txidOrder = left.txid.localeCompare(right.txid)
        return txidOrder !== 0 ? txidOrder : left.outIdx - right.outIdx
      })
      return Object.freeze(snapshot)
    }
  })
}

function createSignedArtifactAudit(): Tm1SignedArtifactAuditPort {
  return Object.freeze<Tm1SignedArtifactAuditPort>({
    auditSignedArtifact: async input => {
      assertNotAborted(input.signal)
      const artifact = freezeSignedArtifact(input.signedArtifact)
      auditTm1Draft02RegtestSignedTransaction({
        candidate: input.review.candidate,
        signedTransaction: Tx.fromHex(artifact.rawTransactionHex)
      })
      assertNotAborted(input.signal)
      return artifact
    }
  })
}

function createConfirmationObserver(
  chronik: ChronikClient,
  networkAttestation: Tm1NetworkAttestationPort
): Tm1ConfirmationObserverPort {
  return Object.freeze<Tm1ConfirmationObserverPort>({
    confirm: async input => {
      assertNotAborted(input.signal)
      await networkAttestation.attest(input.signal)
      assertNotAborted(input.signal)

      let transaction: unknown
      try {
        transaction = await abortable(chronik.tx(input.txid), input.signal)
      } catch (error) {
        if (isRuntimeError(error)) throw error
        if (isNotFound(error)) return unconfirmed(input.submissionId, input.txid)
        fail('TX_OBSERVATION_UNAVAILABLE')
      }

      const observedTxid = readTxid(ownData(transaction, 'txid'))
      if (observedTxid !== input.txid) fail('INVALID_CONFIRMATION_RESPONSE')
      const block = ownData(transaction, 'block')
      if (block === undefined || block === null) {
        return unconfirmed(input.submissionId, input.txid)
      }

      let blockchainInfo: unknown
      try {
        blockchainInfo = await abortable(chronik.blockchainInfo(), input.signal)
      } catch (error) {
        if (isRuntimeError(error)) throw error
        fail('TX_OBSERVATION_UNAVAILABLE')
      }
      const blockHeight = readSafeNonNegativeInteger(block, 'height')
      const blockHash = readTxid(ownData(block, 'hash'))
      const tipHeight = readSafeNonNegativeInteger(blockchainInfo, 'tipHeight')
      if (
        blockHeight === undefined ||
        blockHash === undefined ||
        tipHeight === undefined ||
        tipHeight < blockHeight
      ) {
        fail('INVALID_CONFIRMATION_RESPONSE')
      }
      const confirmations = tipHeight - blockHeight + 1
      if (!Number.isSafeInteger(confirmations) || confirmations <= 0) {
        fail('INVALID_CONFIRMATION_RESPONSE')
      }
      return Object.freeze({
        submissionId: input.submissionId,
        txid: input.txid,
        confirmations,
        blockHash,
        blockHeight
      })
    }
  })
}

function unconfirmed(submissionId: string, txid: string): Tm1Confirmation {
  return Object.freeze({ submissionId, txid, confirmations: 0 })
}

function freezeSignedArtifact(
  artifact: RegtestSignedTransaction
): RegtestSignedTransaction {
  return Object.freeze({
    ...artifact,
    rawTransactionBytes: new Uint8Array(artifact.rawTransactionBytes)
  })
}

function readScriptHex(value: unknown): string | undefined {
  const direct = ownData(value, 'outputScript')
  if (typeof direct === 'string' && /^[0-9a-fA-F]+$/.test(direct)) {
    return direct.toLowerCase()
  }
  const bytes = ownData(value, 'script')
  return bytes instanceof Uint8Array ? toHex(bytes) : undefined
}

function readTxid(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase()
  }
  return value instanceof Uint8Array && value.length === 32
    ? toHexRev(value)
    : undefined
}

function readSafeNonNegativeInteger(
  value: unknown,
  key: string
): number | undefined {
  const candidate = ownData(value, key)
  return typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : undefined
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotAborted(signal)
  if (!signal) return promise

  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(new Tm1RegtestRuntimeCompositionError('OPERATION_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
    if (signal.aborted) onAbort()
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('OPERATION_ABORTED')
}

function isNotFound(error: unknown): boolean {
  const status = ownData(error, 'status') ?? ownData(error, 'statusCode')
  const code = ownData(error, 'code')
  return status === 404 || code === 404 || code === '404' || code === 'NOT_FOUND'
}

function ownData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function isRuntimeError(
  error: unknown
): error is Tm1RegtestRuntimeCompositionError {
  return error instanceof Tm1RegtestRuntimeCompositionError
}

function fail(code: Tm1RegtestRuntimeCompositionErrorCode): never {
  throw new Tm1RegtestRuntimeCompositionError(code)
}
