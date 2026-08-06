import { ChronikClient } from 'chronik-client'
import { toHex } from 'ecash-lib'
import { TM1_DRAFT_02_CANDIDATE_ENVIRONMENT } from './tm1Draft02Candidate'
import type { RegtestSignedTransaction } from './tm1Draft02RegtestP2pkhSigner'
import {
  Tm1InMemoryDeliveryTransport,
  type Tm1RegtestDeliveryReceipt,
  type Tm1RegtestDeliveryTransport,
  type Tm1RegtestNetworkAttestation
} from './tm1RegtestDeliveryTransport'

export const TM1_ECASH_REGTEST_GENESIS_HASH =
  '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
export const TM1_CHRONIK_REGTEST_CHAIN_IDENTITY =
  `ecash-regtest:${TM1_ECASH_REGTEST_GENESIS_HASH}`

const LOCAL_CHRONIK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1'
])

export type Tm1ChronikRegtestDeliveryTransportErrorCode =
  | 'OPERATION_ABORTED'
  | 'INVALID_ENDPOINT_URL'
  | 'NON_LOCAL_ENDPOINT_FORBIDDEN'
  | 'ENDPOINT_CREDENTIALS_FORBIDDEN'
  | 'ENDPOINT_PORT_REQUIRED'
  | 'ENDPOINT_PATH_FORBIDDEN'
  | 'CHRONIK_UNAVAILABLE'
  | 'INVALID_BLOCKCHAIN_INFO'
  | 'REGTEST_GENESIS_MISMATCH'
  | 'BROADCAST_REJECTED'
  | 'BROADCAST_TXID_MISMATCH'

export class Tm1ChronikRegtestDeliveryTransportError extends Error {
  readonly code: Tm1ChronikRegtestDeliveryTransportErrorCode

  constructor(
    code: Tm1ChronikRegtestDeliveryTransportErrorCode,
    message: string = code
  ) {
    super(message)
    this.name = 'Tm1ChronikRegtestDeliveryTransportError'
    this.code = code
  }
}

export class Tm1ChronikRegtestDeliveryTransport
implements Tm1RegtestDeliveryTransport {
  readonly endpointUrl: string
  private readonly chronik: ChronikClient

  constructor(endpointUrl: string) {
    this.endpointUrl = normalizeLocalChronikEndpoint(endpointUrl)
    this.chronik = new ChronikClient([this.endpointUrl])
  }

  async attestNetwork(signal?: AbortSignal): Promise<Tm1RegtestNetworkAttestation> {
    assertNotAborted(signal)

    let blockchainInfo: unknown
    let genesisBlock: unknown
    try {
      ;[blockchainInfo, genesisBlock] = await abortable(
        Promise.all([
          this.chronik.blockchainInfo(),
          this.chronik.block(0)
        ]),
        signal
      )
    } catch (error) {
      if (isTransportError(error)) throw error
      fail('CHRONIK_UNAVAILABLE', errorMessage(error))
    }

    auditBlockchainInfo(blockchainInfo)
    auditRegtestGenesis(genesisBlock)

    return Object.freeze({
      environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
      chainIdentity: TM1_CHRONIK_REGTEST_CHAIN_IDENTITY
    })
  }

  async submit(
    signedArtifact: RegtestSignedTransaction,
    signal?: AbortSignal
  ): Promise<Tm1RegtestDeliveryReceipt> {
    assertNotAborted(signal)

    const artifactSnapshot: RegtestSignedTransaction = Object.freeze({
      ...signedArtifact,
      rawTransactionBytes: new Uint8Array(signedArtifact.rawTransactionBytes)
    })

    // Reuse the already verified 5-G2 boundary as the canonical artifact audit.
    await new Tm1InMemoryDeliveryTransport().submit(artifactSnapshot, signal)
    await this.attestNetwork(signal)
    assertNotAborted(signal)

    let response: unknown
    try {
      // Broadcast is irreversible. AbortSignal is honored through the final
      // pre-dispatch check; after dispatch we return the node's actual result.
      response = await this.chronik.broadcastTx(artifactSnapshot.rawTransactionBytes)
    } catch (error) {
      fail('BROADCAST_REJECTED', errorMessage(error))
    }

    const broadcastTxids = hashCandidates(recordValue(response, 'txid'))
    if (!broadcastTxids.includes(artifactSnapshot.txid)) {
      fail('BROADCAST_TXID_MISMATCH')
    }

    return Object.freeze({
      txid: artifactSnapshot.txid,
      disposition: 'accepted'
    })
  }
}

function normalizeLocalChronikEndpoint(endpointUrl: string): string {
  if (
    typeof endpointUrl !== 'string' ||
    endpointUrl.length === 0 ||
    endpointUrl.trim() !== endpointUrl
  ) {
    fail('INVALID_ENDPOINT_URL')
  }

  let endpoint: URL
  try {
    endpoint = new URL(endpointUrl)
  } catch {
    fail('INVALID_ENDPOINT_URL')
  }

  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    fail('INVALID_ENDPOINT_URL')
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    fail('ENDPOINT_CREDENTIALS_FORBIDDEN')
  }
  if (!LOCAL_CHRONIK_HOSTNAMES.has(endpoint.hostname.toLowerCase())) {
    fail('NON_LOCAL_ENDPOINT_FORBIDDEN')
  }
  if (endpoint.port.length === 0) {
    fail('ENDPOINT_PORT_REQUIRED')
  }
  if (
    endpoint.pathname !== '/' ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    fail('ENDPOINT_PATH_FORBIDDEN')
  }

  return `${endpoint.protocol}//${endpoint.host}`
}

function auditBlockchainInfo(value: unknown): void {
  const record = asRecord(value)
  const tipHeight = record?.tipHeight
  const tipHashes = hashCandidates(record?.tipHash)

  if (
    typeof tipHeight !== 'number' ||
    !Number.isSafeInteger(tipHeight) ||
    tipHeight < 0 ||
    tipHashes.length === 0
  ) {
    fail('INVALID_BLOCKCHAIN_INFO')
  }
  if (
    tipHeight === 0 &&
    !tipHashes.includes(TM1_ECASH_REGTEST_GENESIS_HASH)
  ) {
    fail('REGTEST_GENESIS_MISMATCH')
  }
}

function auditRegtestGenesis(value: unknown): void {
  const blockInfo = asRecord(asRecord(value)?.blockInfo)
  const height = blockInfo?.height
  const hashes = hashCandidates(blockInfo?.hash)

  if (height !== 0 || hashes.length === 0) {
    fail('INVALID_BLOCKCHAIN_INFO')
  }
  if (!hashes.includes(TM1_ECASH_REGTEST_GENESIS_HASH)) {
    fail('REGTEST_GENESIS_MISMATCH')
  }
}

function hashCandidates(value: unknown): string[] {
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) {
    return [value.toLowerCase()]
  }
  if (!(value instanceof Uint8Array) || value.length !== 32) return []

  const direct = toHex(value)
  const reversed = toHex(new Uint8Array(value).reverse())
  return direct === reversed ? [direct] : [direct, reversed]
}

function recordValue(value: unknown, key: string): unknown {
  return asRecord(value)?.[key]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as Record<string, unknown>
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotAborted(signal)
  if (!signal) return promise

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new Tm1ChronikRegtestDeliveryTransportError('OPERATION_ABORTED'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
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

function isTransportError(
  error: unknown
): error is Tm1ChronikRegtestDeliveryTransportError {
  return error instanceof Tm1ChronikRegtestDeliveryTransportError
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(
  code: Tm1ChronikRegtestDeliveryTransportErrorCode,
  message: string = code
): never {
  throw new Tm1ChronikRegtestDeliveryTransportError(code, message)
}
