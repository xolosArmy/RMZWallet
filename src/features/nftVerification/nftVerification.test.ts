import { afterEach, describe, expect, test, vi } from 'vitest'

import { NFT_COLLECTION_TRUST_REGISTRY } from '../../domain/nftCollections'
import type { NftEvidenceChronikReader } from '../../services/nftEvidenceExtractor'
import {
  createNftVerificationService,
  NFT_VERIFICATION_TIMEOUT_MS
} from './nftVerification'

const CHILD_TOKEN_ID = '1'.repeat(64)
const OFFICIAL_GROUP_TOKEN_ID = NFT_COLLECTION_TRUST_REGISTRY.official.parentTokenId
const UNKNOWN_GROUP_TOKEN_ID = '2'.repeat(64)

const CHILD_TOKEN_TYPE = Object.freeze({
  protocol: 'SLP',
  type: 'SLP_TOKEN_TYPE_NFT1_CHILD',
  number: 65
})

const GROUP_TOKEN_TYPE = Object.freeze({
  protocol: 'SLP',
  type: 'SLP_TOKEN_TYPE_NFT1_GROUP',
  number: 129
})

const BASE_TOKEN_ENTRY = Object.freeze({
  isInvalid: false,
  burnSummary: '',
  failedColorings: [],
  actualBurnAtoms: 0n,
  intentionalBurnAtoms: 0n,
  burnsMintBatons: false
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function makeTokenInfo() {
  return {
    tokenId: CHILD_TOKEN_ID,
    tokenType: CHILD_TOKEN_TYPE
  }
}

function makeGenesis(groupTokenId: string = OFFICIAL_GROUP_TOKEN_ID) {
  return {
    txid: CHILD_TOKEN_ID,
    inputs: [
      {
        token: {
          tokenId: groupTokenId,
          tokenType: GROUP_TOKEN_TYPE,
          entryIdx: 1,
          atoms: 1n,
          isMintBaton: false
        }
      }
    ],
    outputs: [],
    tokenEntries: [
      {
        ...BASE_TOKEN_ENTRY,
        tokenId: CHILD_TOKEN_ID,
        tokenType: CHILD_TOKEN_TYPE,
        txType: 'GENESIS',
        groupTokenId
      },
      {
        ...BASE_TOKEN_ENTRY,
        tokenId: groupTokenId,
        tokenType: GROUP_TOKEN_TYPE,
        txType: 'NONE'
      }
    ],
    tokenFailedParsings: [],
    tokenStatus: 'TOKEN_STATUS_NORMAL'
  }
}

function makeNftReader(groupTokenId: string = OFFICIAL_GROUP_TOKEN_ID) {
  const token = vi.fn(async () => makeTokenInfo())
  const tx = vi.fn(async () => makeGenesis(groupTokenId))
  const reader: NftEvidenceChronikReader = { token, tx }

  return { reader, token, tx }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('NFT verification service', () => {
  test('runs the complete extractor → classifier pipeline before returning official', async () => {
    const { reader, token, tx } = makeNftReader()
    const service = createNftVerificationService(() => reader)

    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
      status: 'resolved',
      tier: 'official'
    })
    expect(token).toHaveBeenCalledExactlyOnceWith(CHILD_TOKEN_ID)
    expect(tx).toHaveBeenCalledExactlyOnceWith(CHILD_TOKEN_ID)
  })

  test('keeps a structurally valid but unregistered Group resolved as unknown', async () => {
    const { reader } = makeNftReader(UNKNOWN_GROUP_TOKEN_ID)
    const service = createNftVerificationService(() => reader)

    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
      status: 'resolved',
      tier: 'unknown'
    })
  })

  test('preserves malformed or unavailable Chronik evidence as a neutral UI error', async () => {
    const token = vi.fn(async (): Promise<unknown> => {
      throw new Error('Chronik timeout')
    })
    const tx = vi.fn(async (): Promise<unknown> => null)
    const reader: NftEvidenceChronikReader = { token, tx }
    const service = createNftVerificationService(() => reader)

    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({ status: 'error' })
    expect(token).toHaveBeenCalledOnce()
    expect(tx).not.toHaveBeenCalled()
  })

  test('evicts a transient Chronik error and retries the same childTokenId successfully', async () => {
    let recovered = false
    const token = vi.fn(async () => {
      if (!recovered) {
        throw new Error('Chronik 503')
      }
      return makeTokenInfo()
    })
    const tx = vi.fn(async () => makeGenesis())
    const reader: NftEvidenceChronikReader = { token, tx }
    const service = createNftVerificationService(() => reader)

    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({ status: 'error' })
    expect(token).toHaveBeenCalledTimes(1)
    expect(tx).not.toHaveBeenCalled()

    recovered = true
    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
      status: 'resolved',
      tier: 'official'
    })
    expect(token).toHaveBeenCalledTimes(2)
    expect(tx).toHaveBeenCalledTimes(1)
  })

  test('deduplicates simultaneous consumers and caches the settled result by childTokenId', async () => {
    const { reader, token, tx } = makeNftReader()
    const service = createNftVerificationService(() => reader)

    const first = service.verify(CHILD_TOKEN_ID)
    const second = service.verify(CHILD_TOKEN_ID)

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'resolved', tier: 'official' },
      { status: 'resolved', tier: 'official' }
    ])
    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
      status: 'resolved',
      tier: 'official'
    })
    expect(token).toHaveBeenCalledTimes(1)
    expect(tx).toHaveBeenCalledTimes(1)
  })

  test('times out one deduplicated attempt, clears it, and permits a successful retry', async () => {
    vi.useFakeTimers()
    const neverSettles = deferred<unknown>()
    const hangingToken = vi.fn(() => neverSettles.promise)
    const hangingReader: NftEvidenceChronikReader = {
      token: hangingToken,
      tx: vi.fn(async () => makeGenesis())
    }
    const recovered = makeNftReader()
    const readerFactory = vi
      .fn<() => NftEvidenceChronikReader>()
      .mockReturnValueOnce(hangingReader)
      .mockReturnValue(recovered.reader)
    const service = createNftVerificationService(readerFactory)

    const first = service.verify(CHILD_TOKEN_ID)
    const duplicate = service.verify(CHILD_TOKEN_ID)
    expect(duplicate).toBe(first)

    await vi.advanceTimersByTimeAsync(NFT_VERIFICATION_TIMEOUT_MS)
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { status: 'error' },
      { status: 'error' }
    ])

    const retry = service.verify(CHILD_TOKEN_ID)
    expect(retry).not.toBe(first)
    await expect(retry).resolves.toEqual({ status: 'resolved', tier: 'official' })
    expect(readerFactory).toHaveBeenCalledTimes(2)
    expect(hangingToken).toHaveBeenCalledTimes(1)
    expect(recovered.token).toHaveBeenCalledTimes(1)
    expect(recovered.tx).toHaveBeenCalledTimes(1)
  })

  test('does not let a timed-out official result overwrite a newer unknown result', async () => {
    vi.useFakeTimers()
    const lateTokenInfo = deferred<unknown>()
    const lateTx = vi.fn(async () => makeGenesis())
    const lateReader: NftEvidenceChronikReader = {
      token: vi.fn(() => lateTokenInfo.promise),
      tx: lateTx
    }
    const current = makeNftReader(UNKNOWN_GROUP_TOKEN_ID)
    const readerFactory = vi
      .fn<() => NftEvidenceChronikReader>()
      .mockReturnValueOnce(lateReader)
      .mockReturnValue(current.reader)
    const service = createNftVerificationService(readerFactory)

    const timedOutAttempt = service.verify(CHILD_TOKEN_ID)
    await vi.advanceTimersByTimeAsync(NFT_VERIFICATION_TIMEOUT_MS)
    await expect(timedOutAttempt).resolves.toEqual({ status: 'error' })

    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
      status: 'resolved',
      tier: 'unknown'
    })

    lateTokenInfo.resolve(makeTokenInfo())
    await flushMicrotasks()
    expect(lateTx).toHaveBeenCalledTimes(1)
    await flushMicrotasks()

    await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
      status: 'resolved',
      tier: 'unknown'
    })
    expect(readerFactory).toHaveBeenCalledTimes(2)
  })

  test('absorbs a reader rejection that arrives after timeout without poisoning the retry', async () => {
    vi.useFakeTimers()
    const lateTokenInfo = deferred<unknown>()
    const lateReader: NftEvidenceChronikReader = {
      token: vi.fn(() => lateTokenInfo.promise),
      tx: vi.fn(async () => makeGenesis())
    }
    const recovered = makeNftReader()
    const readerFactory = vi
      .fn<() => NftEvidenceChronikReader>()
      .mockReturnValueOnce(lateReader)
      .mockReturnValue(recovered.reader)
    const service = createNftVerificationService(readerFactory)
    const unhandledRejection = vi.fn()
    process.on('unhandledRejection', unhandledRejection)

    try {
      const timedOutAttempt = service.verify(CHILD_TOKEN_ID)
      await vi.advanceTimersByTimeAsync(NFT_VERIFICATION_TIMEOUT_MS)
      await expect(timedOutAttempt).resolves.toEqual({ status: 'error' })

      await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
        status: 'resolved',
        tier: 'official'
      })
      lateTokenInfo.reject(new Error('late transport rejection'))
      await flushMicrotasks()

      expect(unhandledRejection).not.toHaveBeenCalled()
      await expect(service.verify(CHILD_TOKEN_ID)).resolves.toEqual({
        status: 'resolved',
        tier: 'official'
      })
      expect(readerFactory).toHaveBeenCalledTimes(2)
    } finally {
      process.off('unhandledRejection', unhandledRejection)
    }
  })

  test('supports explicit per-token invalidation of a settled result', async () => {
    const { reader, token, tx } = makeNftReader()
    const service = createNftVerificationService(() => reader)

    await service.verify(CHILD_TOKEN_ID)
    service.invalidate(CHILD_TOKEN_ID)
    await service.verify(CHILD_TOKEN_ID)

    expect(token).toHaveBeenCalledTimes(2)
    expect(tx).toHaveBeenCalledTimes(2)
  })

  test('keeps malformed child IDs fail-closed and makes zero Chronik calls', async () => {
    const { reader, token, tx } = makeNftReader()
    const readerFactory = vi.fn(() => reader)
    const service = createNftVerificationService(readerFactory)

    await expect(service.verify('not-a-token-id')).resolves.toEqual({ status: 'error' })
    expect(readerFactory).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
    expect(tx).not.toHaveBeenCalled()
  })
})
