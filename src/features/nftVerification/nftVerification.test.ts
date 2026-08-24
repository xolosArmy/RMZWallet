import { describe, expect, test, vi } from 'vitest'

import { NFT_COLLECTION_TRUST_REGISTRY } from '../../domain/nftCollections'
import type { NftEvidenceChronikReader } from '../../services/nftEvidenceExtractor'
import { createNftVerificationService } from './nftVerification'

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

function makeNftReader(groupTokenId: string = OFFICIAL_GROUP_TOKEN_ID) {
  const token = vi.fn(async () => ({
    tokenId: CHILD_TOKEN_ID,
    tokenType: CHILD_TOKEN_TYPE
  }))
  const tx = vi.fn(async () => ({
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
  }))
  const reader: NftEvidenceChronikReader = { token, tx }

  return { reader, token, tx }
}

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
