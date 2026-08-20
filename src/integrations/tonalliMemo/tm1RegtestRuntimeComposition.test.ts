import { Ecc, Tx, toHex } from 'ecash-lib'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const chronikState = vi.hoisted(() => ({
  endpoints: [] as unknown[],
  scripts: [] as unknown[],
  blockchainInfo: vi.fn(),
  block: vi.fn(),
  utxos: vi.fn(),
  tx: vi.fn(),
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

    script(type: string, payload: string): { utxos: () => Promise<unknown> } {
      chronikState.scripts.push([type, payload])
      return { utxos: () => chronikState.utxos() }
    }

    tx(txid: string): Promise<unknown> {
      return chronikState.tx(txid)
    }

    broadcastTx(bytes: Uint8Array): Promise<unknown> {
      return chronikState.broadcastTx(bytes)
    }
  }
}))

import type {
  Tm1RegtestAuthorizationDecisionProvider
} from './tm1RegtestAuthorizationAdapter'
import type {
  Tm1RegtestBroadcastAuthorizationDecisionProvider
} from './tm1RegtestBroadcastAuthorizationAdapter'
import {
  TM1_ECASH_REGTEST_GENESIS_HASH
} from './tm1ChronikRegtestDeliveryTransport'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
} from './tm1Draft02RegtestP2pkhSigner'
import {
  createTm1RegtestRuntime,
  type Tm1RegtestRuntimeConfig
} from './tm1RegtestRuntimeComposition'

const ENDPOINT = 'http://127.0.0.1:3000'
const AUTHOR_TXID = 'aa'.repeat(32)
const SECOND_TXID = 'bb'.repeat(32)
const BLOCK_HASH = 'cc'.repeat(32)
const WRONG_GENESIS = '11'.repeat(32)
const MAINNET_GENESIS =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const TESTNET_GENESIS =
  '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
const FIXTURE_HASH = TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX.slice(6, 46)

type Deferred<T> = Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}>

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined
  let rejectValue: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  void promise.catch(() => undefined)
  return Object.freeze({ promise, resolve: resolveValue, reject: rejectValue })
}

function fixtureUtxo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outpoint: { txid: AUTHOR_TXID, outIdx: 0 },
    blockHeight: 150,
    isCoinbase: false,
    sats: 20_000n,
    isFinal: true,
    token: undefined,
    ...overrides
  }
}

function signingProvider(status: 'approved' | 'rejected' = 'approved'):
Tm1RegtestAuthorizationDecisionProvider {
  return {
    requestDecision: vi.fn().mockResolvedValue(
      status === 'approved' ? { status } : { status, reason: 'declined' }
    )
  }
}

function broadcastProvider(status: 'approved' | 'rejected' = 'approved'):
Tm1RegtestBroadcastAuthorizationDecisionProvider {
  return {
    requestDecision: vi.fn().mockResolvedValue(
      status === 'approved' ? { status } : { status, reason: 'declined' }
    )
  }
}

function runtimeConfig(
  signing: Tm1RegtestAuthorizationDecisionProvider = signingProvider(),
  broadcast: Tm1RegtestBroadcastAuthorizationDecisionProvider = broadcastProvider(),
  ttlMs = 30_000
): Tm1RegtestRuntimeConfig {
  return {
    chronikEndpointUrl: ENDPOINT,
    authorization: {
      signing: {
        decisionProvider: signing,
        ttlMs,
        requester: {
          declaredOrigin: 'http://localhost:4173',
          displayName: 'TM1 regtest signing review'
        }
      },
      broadcast: {
        decisionProvider: broadcast,
        ttlMs,
        requester: {
          declaredOrigin: 'http://localhost:4173',
          displayName: 'TM1 regtest broadcast review'
        }
      }
    }
  }
}

function publicationRequest(message = 'TM1 concrete runtime'): Readonly<{
  message: string
  activeLockingScriptHex: string
}> {
  return {
    message,
    activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
  }
}

async function signReady(runtime = createTm1RegtestRuntime(runtimeConfig())) {
  const prepared = await runtime.prepare(publicationRequest())
  const signed = await runtime.authorizeAndSign(prepared.preparedId)
  return { runtime, prepared, signed }
}

async function publishReady(runtime = createTm1RegtestRuntime(runtimeConfig())) {
  const ready = await signReady(runtime)
  const receipt = await runtime.approveAndBroadcast(ready.signed.signedId)
  return { ...ready, receipt }
}

async function expectPublicationCode(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

beforeEach(() => {
  chronikState.endpoints.length = 0
  chronikState.scripts.length = 0
  chronikState.blockchainInfo.mockReset().mockResolvedValue({
    tipHash: TM1_ECASH_REGTEST_GENESIS_HASH,
    tipHeight: 200
  })
  chronikState.block.mockReset().mockResolvedValue({
    blockInfo: { hash: TM1_ECASH_REGTEST_GENESIS_HASH, height: 0 }
  })
  chronikState.utxos.mockReset().mockResolvedValue({
    outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
    utxos: [fixtureUtxo()]
  })
  chronikState.tx.mockReset().mockImplementation(async (txid: string) => ({
    txid,
    block: { height: 198, hash: BLOCK_HASH }
  }))
  chronikState.broadcastTx.mockReset().mockImplementation(async (bytes: Uint8Array) => ({
    txid: Tx.fromHex(toHex(bytes)).txid()
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TM1 concrete regtest runtime composition', () => {
  test('constructs synchronously without network I/O', () => {
    const runtime = createTm1RegtestRuntime(runtimeConfig())

    expect(runtime.getState()).toEqual({ status: 'idle' })
    expect(chronikState.blockchainInfo).not.toHaveBeenCalled()
    expect(chronikState.block).not.toHaveBeenCalled()
    expect(chronikState.utxos).not.toHaveBeenCalled()
  })

  test('returns an exact frozen method-only least-authority facade', () => {
    const runtime = createTm1RegtestRuntime(runtimeConfig())

    expect(Object.keys(runtime)).toEqual([
      'getState',
      'subscribe',
      'prepare',
      'authorizeAndSign',
      'approveAndBroadcast',
      'reconcile',
      'confirm',
      'reset'
    ])
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(runtime).not.toHaveProperty('sign')
    expect(runtime).not.toHaveProperty('broadcast')
    expect(runtime).not.toHaveProperty('transport')
    expect(runtime).not.toHaveProperty('client')
  })

  test('uses one canonically normalized endpoint for all Chronik clients', () => {
    createTm1RegtestRuntime({
      ...runtimeConfig(),
      chronikEndpointUrl: 'http://localhost:3000/'
    })

    expect(chronikState.endpoints).toEqual([
      ['http://localhost:3000'],
      ['http://localhost:3000']
    ])
  })

  test.each([
    ['remote domain', 'https://chronik.e.cash:443'],
    ['public IP', 'http://8.8.8.8:3000'],
    ['credentials', 'http://user:password@localhost:3000'],
    ['query', 'http://localhost:3000?network=regtest'],
    ['fragment', 'http://localhost:3000#regtest'],
    ['path', 'http://localhost:3000/api'],
    ['missing port', 'http://localhost'],
    ['malformed', 'not a URL']
  ])('rejects %s endpoints synchronously', (_label, endpoint) => {
    expect(() => createTm1RegtestRuntime({
      ...runtimeConfig(),
      chronikEndpointUrl: endpoint
    })).toThrow()
    expect(chronikState.blockchainInfo).not.toHaveBeenCalled()
  })

  test('requires two distinct explicit human decision providers', () => {
    const provider = signingProvider()
    expect(() => createTm1RegtestRuntime(runtimeConfig(
      provider,
      provider as unknown as Tm1RegtestBroadcastAuthorizationDecisionProvider
    ))).toThrowError(/DECISION_PROVIDERS_MUST_BE_DISTINCT/)
  })

  test('completes the nominal two-consent publication lifecycle', async () => {
    const signing = signingProvider()
    const broadcast = broadcastProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing, broadcast))

    const prepared = await runtime.prepare(publicationRequest())
    const signed = await runtime.authorizeAndSign(prepared.preparedId)
    expect(runtime.getState().status).toBe('signedReviewReady')
    expect(signing.requestDecision).toHaveBeenCalledTimes(1)
    expect(broadcast.requestDecision).not.toHaveBeenCalled()

    const receipt = await runtime.approveAndBroadcast(signed.signedId)
    expect(receipt.txid).toBe(signed.txid)
    expect(runtime.getState().status).toBe('submitted')
    expect(broadcast.requestDecision).toHaveBeenCalledTimes(1)
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
  })

  test('binds separate reviews and exposes no fixture secret material', async () => {
    const signing = signingProvider()
    const broadcast = broadcastProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing, broadcast))
    const prepared = await runtime.prepare(publicationRequest('exact intent'))
    const signed = await runtime.authorizeAndSign(prepared.preparedId)
    await runtime.approveAndBroadcast(signed.signedId)

    const signRequest = vi.mocked(signing.requestDecision).mock.calls[0]?.[0]
    const broadcastRequest = vi.mocked(broadcast.requestDecision).mock.calls[0]?.[0]
    expect(signRequest?.preparedId).toBe(prepared.preparedId)
    expect(signRequest?.bindingHash).toBe(prepared.bindingHash)
    expect(broadcastRequest?.signedId).toBe(signed.signedId)
    expect(broadcastRequest?.txid).toBe(signed.txid)
    expect(broadcastRequest?.signedArtifactHash).toBe(signed.signedArtifactHash)
    for (const request of [signRequest, broadcastRequest]) {
      expect(Object.keys(request ?? {})).not.toContain('wif')
      expect(Object.keys(request?.review ?? {})).not.toContain('privateKey')
      expect(request?.operationId).toMatch(/^tm1-regtest\./)
    }
  })

  test('SIGN rejection prevents signing, broadcast consent, and transport', async () => {
    const signing = signingProvider('rejected')
    const broadcast = broadcastProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing, broadcast))
    const prepared = await runtime.prepare(publicationRequest())

    await expectPublicationCode(
      runtime.authorizeAndSign(prepared.preparedId),
      'SIGNING_REJECTED'
    )
    expect(runtime.getState().status).toBe('rejected')
    expect(broadcast.requestDecision).not.toHaveBeenCalled()
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('SIGN abort releases pending authorization and prevents later authority', async () => {
    const pending = deferred<{ status: 'approved' }>()
    const signing: Tm1RegtestAuthorizationDecisionProvider = {
      requestDecision: vi.fn(() => pending.promise)
    }
    const broadcast = broadcastProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing, broadcast))
    const prepared = await runtime.prepare(publicationRequest())
    const controller = new AbortController()
    const operation = runtime.authorizeAndSign(prepared.preparedId, controller.signal)
    await vi.waitFor(() => expect(signing.requestDecision).toHaveBeenCalledTimes(1))

    controller.abort()
    await expectPublicationCode(operation, 'ABORTED')
    expect(broadcast.requestDecision).not.toHaveBeenCalled()
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('SIGN pending expiry terminates and permits an immediate retry cycle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const pending = deferred<{ status: 'approved' }>()
    const providerEntered = deferred<void>()
    const signing: Tm1RegtestAuthorizationDecisionProvider = {
      requestDecision: vi.fn()
        .mockImplementationOnce(() => {
          providerEntered.resolve()
          return pending.promise
        })
        .mockResolvedValue({ status: 'approved' })
    }
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing, broadcastProvider(), 100))
    const prepared = await runtime.prepare(publicationRequest())
    const operation = runtime.authorizeAndSign(prepared.preparedId)
    const outcome = operation.catch(error => error as unknown)
    await providerEntered.promise
    expect(signing.requestDecision).toHaveBeenCalledTimes(1)

    await vi.runOnlyPendingTimersAsync()
    await expect(outcome).resolves.toMatchObject({
      code: 'SIGNING_AUTHORIZATION_EXPIRED'
    })
    vi.useRealTimers()
    runtime.reset()
    const retryPrepared = await runtime.prepare(publicationRequest('retry'))
    await expect(runtime.authorizeAndSign(retryPrepared.preparedId)).resolves.toBeDefined()
  })

  test('a disappearing UTXO during SIGN revalidation blocks the signer path', async () => {
    chronikState.utxos
      .mockResolvedValueOnce({
        outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
        utxos: [fixtureUtxo()]
      })
      .mockResolvedValueOnce({
        outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
        utxos: []
      })
    const runtime = createTm1RegtestRuntime(runtimeConfig())
    const prepared = await runtime.prepare(publicationRequest())

    await expectPublicationCode(
      runtime.authorizeAndSign(prepared.preparedId),
      'CANDIDATE_REVALIDATION_FAILED'
    )
    expect(runtime.getState().status).toBe('failed')
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('a concrete fixture signer failure prevents broadcast consent and transport', async () => {
    const broadcast = broadcastProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signingProvider(), broadcast))
    const prepared = await runtime.prepare(publicationRequest())
    vi.spyOn(Ecc.prototype, 'derivePubkey').mockImplementation(() => {
      throw new Error('fixture signer unavailable')
    })

    await expectPublicationCode(
      runtime.authorizeAndSign(prepared.preparedId),
      'SIGNING_FAILED'
    )
    expect(broadcast.requestDecision).not.toHaveBeenCalled()
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('BROADCAST rejection leaves transport uninvoked', async () => {
    const runtime = createTm1RegtestRuntime(runtimeConfig(
      signingProvider(),
      broadcastProvider('rejected')
    ))
    const prepared = await runtime.prepare(publicationRequest())
    const signed = await runtime.authorizeAndSign(prepared.preparedId)

    await expectPublicationCode(
      runtime.approveAndBroadcast(signed.signedId),
      'BROADCAST_REJECTED'
    )
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('BROADCAST abort releases pending authorization without transport', async () => {
    const pending = deferred<{ status: 'approved' }>()
    const broadcast: Tm1RegtestBroadcastAuthorizationDecisionProvider = {
      requestDecision: vi.fn(() => pending.promise)
    }
    const ready = await signReady(createTm1RegtestRuntime(runtimeConfig(
      signingProvider(),
      broadcast
    )))
    const controller = new AbortController()
    const operation = ready.runtime.approveAndBroadcast(
      ready.signed.signedId,
      controller.signal
    )
    await vi.waitFor(() => expect(broadcast.requestDecision).toHaveBeenCalledTimes(1))

    controller.abort()
    await expectPublicationCode(operation, 'ABORTED')
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('BROADCAST pending expiry terminates without transport and permits retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const pending = deferred<{ status: 'approved' }>()
    const providerEntered = deferred<void>()
    const broadcast: Tm1RegtestBroadcastAuthorizationDecisionProvider = {
      requestDecision: vi.fn()
        .mockImplementationOnce(() => {
          providerEntered.resolve()
          return pending.promise
        })
        .mockResolvedValue({ status: 'approved' })
    }
    const ready = await signReady(createTm1RegtestRuntime(runtimeConfig(
      signingProvider(),
      broadcast,
      100
    )))
    const operation = ready.runtime.approveAndBroadcast(ready.signed.signedId)
    const outcome = operation.catch(error => error as unknown)
    await providerEntered.promise

    await vi.runOnlyPendingTimersAsync()
    await expect(outcome).resolves.toMatchObject({
      code: 'BROADCAST_AUTHORIZATION_EXPIRED'
    })
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
    vi.useRealTimers()
    ready.runtime.reset()
    const retried = await signReady(ready.runtime)
    await expect(
      retried.runtime.approveAndBroadcast(retried.signed.signedId)
    ).resolves.toBeDefined()
  })

  test('post-approval pure re-audit failure prevents transport', async () => {
    const ready = await signReady()
    vi.spyOn(Tx, 'fromHex').mockImplementation(() => {
      throw new Error('audit rejected exact artifact')
    })

    await expectPublicationCode(
      ready.runtime.approveAndBroadcast(ready.signed.signedId),
      'SIGNED_ARTIFACT_INVALID'
    )
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('transport invocation failure becomes broadcastUncertain with no retry', async () => {
    chronikState.broadcastTx.mockRejectedValue(new Error('node response lost'))
    const ready = await signReady()

    await expectPublicationCode(
      ready.runtime.approveAndBroadcast(ready.signed.signedId),
      'BROADCAST_FAILED'
    )
    expect(ready.runtime.getState().status).toBe('broadcastUncertain')
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
  })

  test('reconcile observes after uncertainty without retransmission', async () => {
    chronikState.broadcastTx.mockRejectedValueOnce(new Error('response lost'))
    const ready = await signReady()
    await expect(ready.runtime.approveAndBroadcast(ready.signed.signedId)).rejects.toBeDefined()
    chronikState.tx.mockResolvedValue({
      txid: ready.signed.txid,
      block: { height: 198, hash: BLOCK_HASH }
    })

    await expect(ready.runtime.reconcile()).resolves.toMatchObject({ confirmations: 3 })
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
  })

  test('confirm observes a mined transaction once without retransmission', async () => {
    const published = await publishReady()
    await expect(published.runtime.confirm(published.receipt.submissionId)).resolves.toEqual({
      submissionId: published.receipt.submissionId,
      txid: published.receipt.txid,
      confirmations: 3,
      blockHash: BLOCK_HASH,
      blockHeight: 198
    })
    expect(chronikState.tx).toHaveBeenCalledTimes(1)
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
  })

  test('a mempool transaction is never reported as confirmed', async () => {
    const published = await publishReady()
    chronikState.tx.mockResolvedValue({ txid: published.receipt.txid, block: undefined })

    await expectPublicationCode(
      published.runtime.confirm(published.receipt.submissionId),
      'CONFIRMATION_FAILED'
    )
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
  })

  test('an absent transaction is never reported as confirmed', async () => {
    const published = await publishReady()
    chronikState.tx.mockRejectedValue({ status: 404 })

    await expectPublicationCode(
      published.runtime.confirm(published.receipt.submissionId),
      'CONFIRMATION_FAILED'
    )
    expect(chronikState.broadcastTx).toHaveBeenCalledTimes(1)
  })

  test('queries only the exact fixture script and freshly re-reads UTXOs', async () => {
    const ready = await signReady()

    expect(ready.signed.signedArtifact.fixtureLockingScriptHex).toBe(
      TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
    )
    expect(chronikState.scripts).toEqual([
      ['p2pkh', FIXTURE_HASH],
      ['p2pkh', FIXTURE_HASH]
    ])
    expect(chronikState.utxos).toHaveBeenCalledTimes(2)
  })

  test('filters token-bearing UTXOs while preserving deterministic ordering', async () => {
    chronikState.utxos.mockResolvedValue({
      outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      utxos: [
        fixtureUtxo({
          outpoint: { txid: 'dd'.repeat(32), outIdx: 2 },
          sats: 50_000n,
          token: { tokenId: 'token' }
        }),
        fixtureUtxo({
          outpoint: { txid: SECOND_TXID, outIdx: 1 },
          sats: 25_000n
        }),
        fixtureUtxo({ sats: 20_000n })
      ]
    })
    const runtime = createTm1RegtestRuntime(runtimeConfig())
    const prepared = await runtime.prepare(publicationRequest())

    expect(prepared.orderedInputs.map(input => input.txid)).toEqual([
      SECOND_TXID
    ])
  })

  test('rejects malformed UTXO value metadata', async () => {
    chronikState.utxos.mockResolvedValue({
      outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      utxos: [fixtureUtxo({ sats: Number.NaN })]
    })
    const runtime = createTm1RegtestRuntime(runtimeConfig())

    await expectPublicationCode(runtime.prepare(publicationRequest()), 'PREPARATION_FAILED')
  })

  test('rejects a Chronik response for any non-fixture script', async () => {
    chronikState.utxos.mockResolvedValue({
      outputScript: `76a914${'11'.repeat(20)}88ac`,
      utxos: [fixtureUtxo()]
    })
    const runtime = createTm1RegtestRuntime(runtimeConfig())

    await expectPublicationCode(runtime.prepare(publicationRequest()), 'PREPARATION_FAILED')
  })

  test('filters known immature coinbase and fails closed on unknown maturity', async () => {
    chronikState.utxos.mockResolvedValueOnce({
      outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      utxos: [fixtureUtxo({ isCoinbase: true, blockHeight: 150 })]
    })
    const immature = createTm1RegtestRuntime(runtimeConfig())
    await expectPublicationCode(immature.prepare(publicationRequest()), 'PREPARATION_FAILED')

    chronikState.utxos.mockResolvedValueOnce({
      outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      utxos: [fixtureUtxo({ isCoinbase: true, blockHeight: -1 })]
    })
    const unknown = createTm1RegtestRuntime(runtimeConfig())
    await expectPublicationCode(unknown.prepare(publicationRequest()), 'PREPARATION_FAILED')
  })

  test('includes a coinbase only when chain height proves 100 confirmations', async () => {
    chronikState.utxos.mockResolvedValue({
      outputScript: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      utxos: [fixtureUtxo({ isCoinbase: true, blockHeight: 101 })]
    })
    const runtime = createTm1RegtestRuntime(runtimeConfig())

    await expect(runtime.prepare(publicationRequest())).resolves.toBeDefined()
  })

  test.each([MAINNET_GENESIS, TESTNET_GENESIS, WRONG_GENESIS])(
    'rejects a loopback node reporting non-regtest genesis %s',
    async genesis => {
      chronikState.block.mockResolvedValue({ blockInfo: { hash: genesis, height: 0 } })
      const runtime = createTm1RegtestRuntime(runtimeConfig())

      await expectPublicationCode(runtime.prepare(publicationRequest()), 'PREPARATION_FAILED')
      expect(chronikState.utxos).not.toHaveBeenCalled()
    }
  )

  test('fails closed when network attestation is unavailable', async () => {
    chronikState.blockchainInfo.mockRejectedValue(new Error('offline'))
    const runtime = createTm1RegtestRuntime(runtimeConfig())

    await expectPublicationCode(runtime.prepare(publicationRequest()), 'PREPARATION_FAILED')
    expect(chronikState.utxos).not.toHaveBeenCalled()
  })

  test('network drift before delivery blocks Chronik broadcast', async () => {
    chronikState.block
      .mockResolvedValueOnce({ blockInfo: { hash: TM1_ECASH_REGTEST_GENESIS_HASH, height: 0 } })
      .mockResolvedValueOnce({ blockInfo: { hash: TM1_ECASH_REGTEST_GENESIS_HASH, height: 0 } })
      .mockResolvedValueOnce({ blockInfo: { hash: MAINNET_GENESIS, height: 0 } })
    const ready = await signReady()

    await expectPublicationCode(
      ready.runtime.approveAndBroadcast(ready.signed.signedId),
      'BROADCAST_FAILED'
    )
    expect(chronikState.broadcastTx).not.toHaveBeenCalled()
  })

  test('reset supports a second cycle with fresh IDs and no stale signal poison', async () => {
    const signing = signingProvider()
    const broadcast = broadcastProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing, broadcast))
    const oldController = new AbortController()
    const firstPrepared = await runtime.prepare(
      publicationRequest('first cycle'),
      oldController.signal
    )
    const firstSigned = await runtime.authorizeAndSign(
      firstPrepared.preparedId,
      oldController.signal
    )
    const firstReceipt = await runtime.approveAndBroadcast(
      firstSigned.signedId,
      oldController.signal
    )
    await runtime.confirm(firstReceipt.submissionId, oldController.signal)
    oldController.abort()
    runtime.reset()
    const second = await publishReady(runtime)

    expect(second.prepared.preparedId).not.toBe(firstPrepared.preparedId)
    expect(second.signed.signedId).not.toBe(firstSigned.signedId)
    expect(second.receipt.submissionId).not.toBe(firstReceipt.submissionId)
    const signIds = vi.mocked(signing.requestDecision).mock.calls.map(call => call[0].operationId)
    const broadcastIds = vi.mocked(broadcast.requestDecision).mock.calls.map(call => call[0].operationId)
    expect(new Set(signIds).size).toBe(2)
    expect(new Set(broadcastIds).size).toBe(2)
  })

  test('fails closed on overlapping publication work without a queue', async () => {
    const pending = deferred<unknown>()
    chronikState.blockchainInfo.mockReturnValue(pending.promise)
    const signing = signingProvider()
    const runtime = createTm1RegtestRuntime(runtimeConfig(signing))
    const controller = new AbortController()
    const first = runtime.prepare(publicationRequest('first'), controller.signal)
    await Promise.resolve()

    await expectPublicationCode(
      runtime.prepare(publicationRequest('second')),
      'PUBLICATION_ALREADY_ACTIVE'
    )
    expect(signing.requestDecision).not.toHaveBeenCalled()
    controller.abort()
    await expectPublicationCode(first, 'ABORTED')
  })

  test('public errors and returned records expose no key-loading authority', async () => {
    let configurationError: unknown
    try {
      createTm1RegtestRuntime({
        ...runtimeConfig(),
        chronikEndpointUrl: 'https://example.com:443'
      })
    } catch (error) {
      configurationError = error
    }
    expect(String(configurationError)).not.toMatch(/private|secret|wif/i)

    const published = await publishReady()
    const confirmation = await published.runtime.confirm(published.receipt.submissionId)
    expect(Object.keys(published.receipt)).not.toContain('wif')
    expect(Object.keys(confirmation)).not.toContain('privateKey')
  })
})
