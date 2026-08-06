import { describe, expect, test } from 'vitest'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  createTm1Draft02Candidate
} from './tm1Draft02Candidate'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  signTm1Draft02RegtestCandidate,
  type RegtestSignedTransaction
} from './tm1Draft02RegtestP2pkhSigner'
import {
  TM1_IN_MEMORY_REGTEST_CHAIN_IDENTITY,
  Tm1InMemoryDeliveryTransport,
  Tm1RegtestDeliveryTransportError
} from './tm1RegtestDeliveryTransport'

const AUTHOR_TXID = 'aa'.repeat(32)
const FUNDING_TXID = 'bb'.repeat(32)

function signedArtifact(): RegtestSignedTransaction {
  const post = encodeTm1Draft02Post({
    eventData: 'In-memory delivery',
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX
  })
  const candidate = createTm1Draft02Candidate({
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    transactionVersion: TM1_DRAFT_02_TX_VERSION,
    locktime: TM1_DRAFT_02_LOCKTIME,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
    authorLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
    inputs: [
      {
        txid: AUTHOR_TXID,
        outIdx: 0,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 7_000n,
        lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
      },
      {
        txid: FUNDING_TXID,
        outIdx: 1,
        sequence: TM1_DRAFT_02_SEQUENCE,
        sats: 4_000n,
        lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
      }
    ],
    outputs: [
      { sats: 0n, scriptHex: post.scriptHex },
      { sats: 10_000n, scriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX }
    ],
    dustSats: 546n,
    maxFeeSats: 2_000n,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY
  })
  return signTm1Draft02RegtestCandidate({ candidate })
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(Tm1RegtestDeliveryTransportError)
  expect((error as Tm1RegtestDeliveryTransportError).code).toBe(code)
}

describe('TM1 Draft 0.2 in-memory regtest delivery transport', () => {
  test('attests the fixed fixture environment and chain identity', async () => {
    const transport = new Tm1InMemoryDeliveryTransport()
    await expect(transport.attestNetwork()).resolves.toEqual({
      environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
      chainIdentity: TM1_IN_MEMORY_REGTEST_CHAIN_IDENTITY
    })
  })

  test('accepts a canonical signed fixture and returns its txid', async () => {
    const artifact = signedArtifact()
    const transport = new Tm1InMemoryDeliveryTransport()

    await expect(transport.submit(artifact)).resolves.toEqual({
      txid: artifact.txid,
      disposition: 'accepted'
    })
  })

  test('rejects forged environment, bytes, and txid metadata', async () => {
    const artifact = signedArtifact()
    const transport = new Tm1InMemoryDeliveryTransport()

    await transport.submit({
      ...artifact,
      environment: 'mainnet'
    } as unknown as RegtestSignedTransaction).then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'INVALID_ARTIFACT_ENVIRONMENT')
    )

    await transport.submit({
      ...artifact,
      rawTransactionBytes: artifact.rawTransactionBytes.slice(0, -1)
    }).then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'RAW_TRANSACTION_BYTES_MISMATCH')
    )

    await transport.submit({
      ...artifact,
      txid: '00'.repeat(32)
    }).then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'TRANSACTION_ID_MISMATCH')
    )
  })

  test('rejects duplicate and concurrent submissions deterministically', async () => {
    const artifact = signedArtifact()
    const transport = new Tm1InMemoryDeliveryTransport({ latencyMs: 10 })

    const first = transport.submit(artifact)
    await transport.submit(artifact).then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'DUPLICATE_SUBMISSION')
    )
    await first

    await transport.submit(artifact).then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'DUPLICATE_SUBMISSION')
    )
  })

  test('respects AbortSignal for attestation and submission without consuming txid', async () => {
    const artifact = signedArtifact()
    const preAborted = new AbortController()
    preAborted.abort()
    const transport = new Tm1InMemoryDeliveryTransport({ latencyMs: 20 })

    await transport.attestNetwork(preAborted.signal).then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'OPERATION_ABORTED')
    )

    const duringSubmit = new AbortController()
    const submission = transport.submit(artifact, duringSubmit.signal)
    duringSubmit.abort()
    await submission.then(
      () => { throw new Error('Expected rejection') },
      error => expectCode(error, 'OPERATION_ABORTED')
    )

    await expect(transport.submit(artifact)).resolves.toEqual({
      txid: artifact.txid,
      disposition: 'accepted'
    })
  })

  test('rejects unsafe configuration', () => {
    expect(() => new Tm1InMemoryDeliveryTransport({ latencyMs: -1 }))
      .toThrowError(Tm1RegtestDeliveryTransportError)
    expect(() => new Tm1InMemoryDeliveryTransport({ chainIdentity: ' fixture ' }))
      .toThrowError(Tm1RegtestDeliveryTransportError)
  })
})
