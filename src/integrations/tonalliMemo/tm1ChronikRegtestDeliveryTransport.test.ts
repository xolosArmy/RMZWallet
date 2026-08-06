import { beforeEach, describe, expect, test, vi } from 'vitest'

const chronikState = vi.hoisted(() => ({
  endpoints: [] as unknown[],
  blockchainInfo: vi.fn(),
  block: vi.fn(),
  broadcastTx: vi.fn()
}))

vi.mock('chronik-client', () => ({
  ChronikClient: class {
    constructor(endpoints: unknown) {
      chronikState.endpoints.push(endpoints)
    }

    blockchainInfo(): Promise<unknown> {
      return chronikState.blockchainInfo()
    }

    block(height: number): Promise<unknown> {
      return chronikState.block(height)
    }

    broadcastTx(bytes: Uint8Array): Promise<unknown> {
      return chronikState.broadcastTx(bytes)
    }
  }
}))

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
  signTm1Draft02RegtestCandidate
} from './tm1Draft02RegtestP2pkhSigner'
import {
  TM1_CHRONIK_REGTEST_CHAIN_IDENTITY,
  TM1_ECASH_REGTEST_GENESIS_HASH,
  Tm1ChronikRegtestDeliveryTransport,
  Tm1ChronikRegtestDeliveryTransportError
} from './tm1ChronikRegtestDeliveryTransport'

const AUTHOR_TXID = 'aa'.repeat(32)
const FUNDING_TXID = 'bb'.repeat(32)
const MAINNET_GENESIS =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'

function signedArtifact() {
  const post = encodeTm1Draft02Post({
    eventData: 'Chronik regtest transport',
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

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('Expected action to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(Tm1ChronikRegtestDeliveryTransportError)
    expect((error as Tm1ChronikRegtestDeliveryTransportError).code).toBe(code)
  }
}

async function expectAsyncCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error('Expected promise to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(Tm1ChronikRegtestDeliveryTransportError)
    expect((error as Tm1ChronikRegtestDeliveryTransportError).code).toBe(code)
  }
}

beforeEach(() => {
  chronikState.endpoints.length = 0
  chronikState.blockchainInfo.mockReset().mockResolvedValue({
    tipHash: TM1_ECASH_REGTEST_GENESIS_HASH,
    tipHeight: 0
  })
  chronikState.block.mockReset().mockResolvedValue({
    blockInfo: {
      hash: TM1_ECASH_REGTEST_GENESIS_HASH,
      height: 0
    }
  })
  chronikState.broadcastTx.mockReset()
})

describe('TM1 strict local Chronik regtest transport', () => {
  test('accepts only explicit loopback endpoints with an explicit port', () => {
    const transport = new Tm1ChronikRegtestDeliveryTransport('http://127.0.0.1:3000')

    expect(transport.endpointUrl).toBe('http://127.0.0.1:3000')
    expect(chronikState.endpoints).toEqual([['http://127.0.0.1:3000']])
    expectCode(
      () => new Tm1ChronikRegtestDeliveryTransport('https://chronik.e.cash:443'),
      'NON_LOCAL_ENDPOINT_FORBIDDEN'
    )
    expectCode(
      () => new Tm1ChronikRegtestDeliveryTransport('http://localhost'),
      'ENDPOINT_PORT_REQUIRED'
    )
    expectCode(
      () => new Tm1ChronikRegtestDeliveryTransport('http://user:pass@localhost:3000'),
      'ENDPOINT_CREDENTIALS_FORBIDDEN'
    )
    expectCode(
      () => new Tm1ChronikRegtestDeliveryTransport('http://localhost:3000/api'),
      'ENDPOINT_PATH_FORBIDDEN'
    )
  })

  test('attests the exact eCash regtest genesis and returns a stable identity', async () => {
    const transport = new Tm1ChronikRegtestDeliveryTransport('http://localhost:3000')

    await expect(transport.attestNetwork()).resolves.toEqual({
      environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
      chainIdentity: TM1_CHRONIK_REGTEST_CHAIN_IDENTITY
    })
    expect(chronikState.blockchainInfo).toHaveBeenCalledTimes(1)
    expect(chronikState.block).toHaveBeenCalledWith(0)
  })

  test('rejects a local Chronik serving mainnet before any broadcast', async () => {
    chronikState.block.mockResolvedValue({
      blockInfo: { hash: MAINNET_GENESIS, height: 0 }
    })
    const transport = new Tm1ChronikRegtestDeliveryTransport('http://127.0.0.1:3000')

    await expectAsyncCode(transport.submit(signedArtifact()), 'REGTEST_GENESIS_MISMATCH')
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('broadcasts audited bytes and requires the exact node txid', async () => {
    const artifact = signedArtifact()
    chronikState.broadcastTx.mockResolvedValue({ txid: artifact.txid })
    const transport = new Tm1ChronikRegtestDeliveryTransport('http://[::1]:3000')

    await expect(transport.submit(artifact)).resolves.toEqual({
      txid: artifact.txid,
      disposition: 'accepted'
    })
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
    expect(chronikState.broadcastTx).toHaveBeenCalledWith(artifact.rawTransactionBytes)
  })

  test('maps Chronik rejection and txid substitution to closed transport errors', async () => {
    const artifact = signedArtifact()
    const transport = new Tm1ChronikRegtestDeliveryTransport('http://localhost:3000')

    chronikState.broadcastTx.mockRejectedValueOnce(new Error('mempool reject'))
    await expectAsyncCode(transport.submit(artifact), 'BROADCAST_REJECTED')

    chronikState.broadcastTx.mockResolvedValueOnce({ txid: '11'.repeat(32) })
    await expectAsyncCode(transport.submit(artifact), 'BROADCAST_TXID_MISMATCH')
  })

  test('honors AbortSignal before attestation and before irreversible dispatch', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = new Tm1ChronikRegtestDeliveryTransport('http://127.0.0.1:3000')

    await expectAsyncCode(
      transport.attestNetwork(controller.signal),
      'OPERATION_ABORTED'
    )
    await expectAsyncCode(
      transport.submit(signedArtifact(), controller.signal),
      'OPERATION_ABORTED'
    )
    expect(chronikState.blockchainInfo).not.toHaveBeenCalled()
    expect(chronikState.block).not.toHaveBeenCalled()
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })
})
