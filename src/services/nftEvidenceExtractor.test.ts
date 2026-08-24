import { readFileSync } from 'node:fs'
import type { ChronikClient } from 'chronik-client'
import { describe, expect, test, vi } from 'vitest'

import { classifyCollection } from '../domain/nftCollections'
import {
  extractNftCollectionEvidence,
  type NftEvidenceChronikReader
} from './nftEvidenceExtractor'

const CHILD_TOKEN_ID = '1'.repeat(64)
const GROUP_TOKEN_ID = '2'.repeat(64)
const UNKNOWN_GROUP_TOKEN_ID = '3'.repeat(64)
const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'

type ChronikReaderIsCompatible = Pick<ChronikClient, 'token' | 'tx'> extends NftEvidenceChronikReader
  ? true
  : false
const CHRONIK_READER_IS_COMPATIBLE: ChronikReaderIsCompatible = true

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

function childTokenInfo(tokenType: unknown = CHILD_TOKEN_TYPE, tokenId: unknown = CHILD_TOKEN_ID) {
  return {
    tokenId,
    tokenType,
    genesisInfo: {
      tokenTicker: 'ignored',
      tokenName: 'ignored',
      url: 'ignored'
    },
    timeFirstSeen: 0
  }
}

function groupToken(tokenId: unknown = GROUP_TOKEN_ID, tokenType: unknown = GROUP_TOKEN_TYPE) {
  return {
    tokenId,
    tokenType,
    entryIdx: 1,
    atoms: 1n,
    isMintBaton: false
  }
}

const BASE_TOKEN_ENTRY = Object.freeze({
  isInvalid: false,
  burnSummary: '',
  failedColorings: [],
  actualBurnAtoms: 0n,
  intentionalBurnAtoms: 0n,
  burnsMintBatons: false
})

function childTokenEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_TOKEN_ENTRY,
    tokenId: CHILD_TOKEN_ID,
    tokenType: CHILD_TOKEN_TYPE,
    txType: 'GENESIS',
    groupTokenId: GROUP_TOKEN_ID,
    ...overrides
  }
}

function groupTokenEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_TOKEN_ENTRY,
    tokenId: GROUP_TOKEN_ID,
    tokenType: GROUP_TOKEN_TYPE,
    txType: 'NONE',
    ...overrides
  }
}

function genesisTx(
  inputs: unknown[] = [{ token: groupToken() }],
  outputs: unknown[] = [],
  txid: unknown = CHILD_TOKEN_ID,
  overrides: Record<string, unknown> = {}
) {
  return {
    txid,
    inputs,
    outputs,
    tokenEntries: [childTokenEntry(), groupTokenEntry()],
    tokenFailedParsings: [],
    tokenStatus: 'TOKEN_STATUS_NORMAL',
    ...overrides
  }
}

function makeReader(...results: readonly unknown[]) {
  const resolvedTokenResult = results.length >= 1 ? results[0] : childTokenInfo()
  const resolvedTxResult = results.length >= 2 ? results[1] : genesisTx()
  const token = vi.fn(async (): Promise<unknown> => resolvedTokenResult)
  const tx = vi.fn(async (): Promise<unknown> => resolvedTxResult)
  const reader: NftEvidenceChronikReader = { token, tx }

  return { reader, token, tx }
}

const malformedEvidence = {
  kind: 'unverified',
  reason: 'malformed-evidence'
} as const

describe('extractNftCollectionEvidence', () => {
  test('uses a read-only reader structurally compatible with the installed Chronik client', () => {
    expect(CHRONIK_READER_IS_COMPATIBLE).toBe(true)
  })

  test('Test A: returns verified evidence for a legitimate NFT1 Child Genesis', async () => {
    const { reader, token, tx } = makeReader()

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'verified-nft1-child-genesis',
      childTokenId: CHILD_TOKEN_ID,
      groupTokenId: GROUP_TOKEN_ID,
      childTokenType: 65,
      groupTokenType: 129
    })
    expect(token).toHaveBeenCalledExactlyOnceWith(CHILD_TOKEN_ID)
    expect(tx).toHaveBeenCalledExactlyOnceWith(CHILD_TOKEN_ID)
  })

  test.each([
    ['SLP fungible', { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_FUNGIBLE', number: 1 }],
    ['ALP number 65', { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 65 }],
    [
      'mismatched Chronik type name',
      { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_NFT1_GROUP', number: 65 }
    ]
  ])('Test B: rejects an incorrect Child type: %s', async (_label, tokenType) => {
    const { reader, tx } = makeReader(childTokenInfo(tokenType))

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'invalid-child-type'
    })
    expect(tx).not.toHaveBeenCalled()
  })

  test('Test C: returns missing-group-input when input[0] has no token', async () => {
    const { reader } = makeReader(childTokenInfo(), genesisTx([{}]))

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'missing-group-input'
    })
  })

  test('Test D: rejects a non-Group token in input[0]', async () => {
    const fungibleToken = groupToken(GROUP_TOKEN_ID, {
      protocol: 'SLP',
      type: 'SLP_TOKEN_TYPE_FUNGIBLE',
      number: 1
    })
    const { reader } = makeReader(childTokenInfo(), genesisTx([{ token: fungibleToken }]))

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'invalid-group-type'
    })
  })

  test('rejects an ALP token numbered 129 in input[0]', async () => {
    const alpToken = groupToken(GROUP_TOKEN_ID, {
      protocol: 'ALP',
      type: 'ALP_TOKEN_TYPE_STANDARD',
      number: 129
    })
    const { reader } = makeReader(childTokenInfo(), genesisTx([{ token: alpToken }]))

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'invalid-group-type'
    })
  })

  test.each([
    ['timeout', new Error('request timed out')],
    ['HTTP 500', new Error('Failed getting /token/id: 500: Internal Server Error')],
    ['transport exception', new TypeError('network transport failed')]
  ])('Test E: contains a Chronik %s as malformed evidence', async (_label, error) => {
    const token = vi.fn(async (): Promise<unknown> => {
      throw error
    })
    const tx = vi.fn(async (): Promise<unknown> => genesisTx())

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, { token, tx })).resolves.toEqual(
      malformedEvidence
    )
    expect(tx).not.toHaveBeenCalled()
  })

  test.each([
    ['empty', ''],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['non-hex', `${'a'.repeat(63)}g`],
    ['prefixed', `0x${'a'.repeat(64)}`],
    ['leading space', ` ${'a'.repeat(64)}`],
    ['trailing space', `${'a'.repeat(64)} `],
    ['uppercase', 'A'.repeat(64)],
    ['runtime object', {} as unknown as string]
  ])('Test F: rejects %s IDs before making any Chronik call', async (_label, childTokenId) => {
    const { reader, token, tx } = makeReader()

    await expect(extractNftCollectionEvidence(childTokenId, reader)).resolves.toEqual(
      malformedEvidence
    )
    expect(token).not.toHaveBeenCalled()
    expect(tx).not.toHaveBeenCalled()
  })

  test('Test G: ignores a valid Group found only in input[1]', async () => {
    const { reader } = makeReader(
      childTokenInfo(),
      genesisTx([{}, { token: groupToken() }])
    )

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'missing-group-input'
    })
  })

  test('Test H: ignores a Group found only in outputs', async () => {
    const { reader } = makeReader(
      childTokenInfo(),
      genesisTx([{}], [{ token: groupToken() }])
    )

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'missing-group-input'
    })
  })

  test('Test I: does not replace an invalid input[0] with a valid Group from input[1]', async () => {
    const fungibleToken = groupToken(GROUP_TOKEN_ID, {
      protocol: 'SLP',
      type: 'SLP_TOKEN_TYPE_FUNGIBLE',
      number: 1
    })
    const { reader } = makeReader(
      childTokenInfo(),
      genesisTx([{ token: fungibleToken }, { token: groupToken() }])
    )

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'invalid-group-type'
    })
  })

  test.each([
    ['mint baton', { isMintBaton: true }],
    ['zero Group atoms', { atoms: 0n }],
    ['more than one Group atom', { atoms: 2n }],
    ['numeric rather than bigint atoms', { atoms: 1 }]
  ])('rejects semantically invalid Group consumption: %s', async (_label, overrides) => {
    const token = { ...groupToken(), ...overrides }
    const { reader } = makeReader(childTokenInfo(), genesisTx([{ token }]))

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual(
      malformedEvidence
    )
  })

  test.each([
    [
      'non-normal transaction status',
      genesisTx(undefined, undefined, undefined, { tokenStatus: 'TOKEN_STATUS_NOT_NORMAL' })
    ],
    [
      'unknown transaction status',
      genesisTx(undefined, undefined, undefined, { tokenStatus: 'TOKEN_STATUS_UNKNOWN' })
    ],
    [
      'non-Genesis Child operation',
      genesisTx(undefined, undefined, undefined, {
        tokenEntries: [childTokenEntry({ txType: 'SEND' }), groupTokenEntry()]
      })
    ],
    [
      'invalid Child entry',
      genesisTx(undefined, undefined, undefined, {
        tokenEntries: [childTokenEntry({ isInvalid: true }), groupTokenEntry()]
      })
    ],
    [
      'invalid Group entry',
      genesisTx(undefined, undefined, undefined, {
        tokenEntries: [childTokenEntry(), groupTokenEntry({ isInvalid: true })]
      })
    ],
    [
      'non-NONE Group entry operation',
      genesisTx(undefined, undefined, undefined, {
        tokenEntries: [childTokenEntry(), groupTokenEntry({ txType: 'SEND' })]
      })
    ],
    [
      'failed token parsing',
      genesisTx(undefined, undefined, undefined, {
        tokenFailedParsings: [{ pushdataIdx: 0, bytes: '00', error: 'invalid' }]
      })
    ],
    [
      'Child entry with a different Group ID',
      genesisTx(undefined, undefined, undefined, {
        tokenEntries: [
          childTokenEntry({ groupTokenId: UNKNOWN_GROUP_TOKEN_ID }),
          groupTokenEntry()
        ]
      })
    ],
    [
      'input token entryIdx points to Child entry',
      genesisTx([{ token: { ...groupToken(), entryIdx: 0 } }])
    ],
    [
      'input token entryIdx is out of range',
      genesisTx([{ token: { ...groupToken(), entryIdx: 99 } }])
    ]
  ])('rejects incoherent Chronik transaction semantics: %s', async (_label, txResult) => {
    const { reader } = makeReader(childTokenInfo(), txResult)

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual(
      malformedEvidence
    )
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['incomplete object', {}],
    ['non-numeric token type', childTokenInfo({ ...CHILD_TOKEN_TYPE, number: '65' })],
    ['missing token type', { tokenId: CHILD_TOKEN_ID }],
    ['mismatched token ID', childTokenInfo(CHILD_TOKEN_TYPE, 'f'.repeat(64))]
  ])('fails closed for hostile token responses: %s', async (_label, tokenResult) => {
    const { reader } = makeReader(tokenResult)

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual(
      malformedEvidence
    )
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['missing inputs', { txid: CHILD_TOKEN_ID }],
    ['non-array inputs', { txid: CHILD_TOKEN_ID, inputs: {} }],
    ['null input[0]', genesisTx([null])],
    ['mismatched Genesis txid', genesisTx(undefined, undefined, 'f'.repeat(64))],
    ['non-string Group ID', genesisTx([{ token: groupToken(42) }])],
    ['malformed Group ID', genesisTx([{ token: groupToken('not-a-token-id') }])],
    ['non-numeric Group type', genesisTx([{ token: groupToken(GROUP_TOKEN_ID, { ...GROUP_TOKEN_TYPE, number: '129' }) }])]
  ])('fails closed for hostile Genesis responses: %s', async (_label, txResult) => {
    const { reader } = makeReader(childTokenInfo(), txResult)

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual(
      malformedEvidence
    )
  })

  test('returns missing-group-input for an empty inputs array', async () => {
    const { reader } = makeReader(childTokenInfo(), genesisTx([]))

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual({
      kind: 'unverified',
      reason: 'missing-group-input'
    })
  })

  test.each(['tokenInfo', 'genesis', 'input', 'groupToken', 'groupTokenType'])(
    'contains a throwing getter at the %s boundary',
    async (boundary) => {
      const throwingDescriptor: PropertyDescriptor = {
        get() {
          throw new Error('hostile getter')
        }
      }

      let tokenResult: unknown = childTokenInfo()
      let txResult: unknown = genesisTx()

      if (boundary === 'tokenInfo') {
        tokenResult = Object.defineProperty({}, 'tokenId', throwingDescriptor)
      } else if (boundary === 'genesis') {
        txResult = Object.defineProperty({}, 'txid', throwingDescriptor)
      } else if (boundary === 'input') {
        txResult = genesisTx([Object.defineProperty({}, 'token', throwingDescriptor)])
      } else if (boundary === 'groupToken') {
        const hostileToken = { tokenType: GROUP_TOKEN_TYPE }
        Object.defineProperty(hostileToken, 'tokenId', throwingDescriptor)
        txResult = genesisTx([{ token: hostileToken }])
      } else {
        const hostileTokenType = {
          protocol: 'SLP',
          type: 'SLP_TOKEN_TYPE_NFT1_GROUP'
        }
        Object.defineProperty(hostileTokenType, 'number', throwingDescriptor)
        txResult = genesisTx([
          {
            token: groupToken(GROUP_TOKEN_ID, hostileTokenType)
          }
        ])
      }

      const { reader } = makeReader(tokenResult, txResult)
      await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)).resolves.toEqual(
        malformedEvidence
      )
    }
  )

  test.each([
    [
      'token lookup',
      `Failed getting /token/${CHILD_TOKEN_ID}: 404: Token ${CHILD_TOKEN_ID} not found in the index`
    ],
    [
      'Genesis lookup',
      `Failed getting /tx/${CHILD_TOKEN_ID}: 404: Transaction ${CHILD_TOKEN_ID} not found in the index`
    ]
  ])('maps an unequivocal 404 from the %s to missing-genesis', async (lookup, message) => {
    const token = vi.fn(async (): Promise<unknown> => {
      if (lookup === 'token lookup') {
        throw new Error(message)
      }
      return childTokenInfo()
    })
    const tx = vi.fn(async (): Promise<unknown> => {
      throw new Error(message)
    })

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, { token, tx })).resolves.toEqual({
      kind: 'unverified',
      reason: 'missing-genesis'
    })
  })

  test('does not treat an arbitrary status property as proof of absence', async () => {
    const token = vi.fn(async (): Promise<unknown> => {
      throw { status: 404 }
    })
    const tx = vi.fn(async (): Promise<unknown> => genesisTx())

    await expect(extractNftCollectionEvidence(CHILD_TOKEN_ID, { token, tx })).resolves.toEqual(
      malformedEvidence
    )
  })

  test('the extractor source contains no policy, trust anchor, metadata or write capability', () => {
    const source = readFileSync(new URL('./nftEvidenceExtractor.ts', import.meta.url), 'utf8')

    expect(source).not.toContain(OFFICIAL_PARENT_TOKEN_ID)
    expect(source).not.toMatch(
      /NFT_COLLECTIONS|NFT_COLLECTION_TRUST_REGISTRY|classifyCollection|expectedParentTokenId|\bofficial\b|\bcommunity\b|metadata|IPFS|VITE_|process\.env|broadcast|slpMint|slpGenesis|Pinata|Agora/
    )
  })
})

describe('read-only evidence pipeline with collection policy', () => {
  async function evidenceForGroup(groupTokenId: string) {
    const { reader } = makeReader(
      childTokenInfo(),
      genesisTx([{ token: groupToken(groupTokenId) }], undefined, undefined, {
        tokenEntries: [
          childTokenEntry({ groupTokenId }),
          groupTokenEntry({ tokenId: groupTokenId })
        ]
      })
    )

    return extractNftCollectionEvidence(CHILD_TOKEN_ID, reader)
  }

  test('Case 1: the classifier recognizes the official Parent from valid chain evidence', async () => {
    const evidence = await evidenceForGroup(OFFICIAL_PARENT_TOKEN_ID)

    expect(evidence.kind).toBe('verified-nft1-child-genesis')
    expect(classifyCollection(evidence)).toBe('official')
  })

  test('Case 2: an unknown valid Parent remains verified evidence but classifies unknown', async () => {
    const evidence = await evidenceForGroup(UNKNOWN_GROUP_TOKEN_ID)

    expect(evidence).toMatchObject({
      kind: 'verified-nft1-child-genesis',
      groupTokenId: UNKNOWN_GROUP_TOKEN_ID
    })
    expect(classifyCollection(evidence)).toBe('unknown')
  })

  test('Case 3: fraudulent metadata cannot override the observed unknown Parent', async () => {
    const fraudulentMetadata = {
      name: 'Xolos Ramírez Official',
      verification: 'verified',
      parentTokenId: OFFICIAL_PARENT_TOKEN_ID
    }
    const evidence = await evidenceForGroup(UNKNOWN_GROUP_TOKEN_ID)

    expect(fraudulentMetadata.parentTokenId).toBe(OFFICIAL_PARENT_TOKEN_ID)
    expect(classifyCollection(evidence)).toBe('unknown')
  })

  test('Case 4: absent metadata does not weaken valid official chain evidence', async () => {
    const absentMetadata = null
    const evidence = await evidenceForGroup(OFFICIAL_PARENT_TOKEN_ID)

    expect(absentMetadata).toBeNull()
    expect(classifyCollection(evidence)).toBe('official')
  })
})
