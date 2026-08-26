import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  NFT_COLLECTION_TRUST_REGISTRY,
  NFT_COLLECTION_TRUST_REGISTRY_VERSION,
  buildNftCollectionMetadata,
  classifyCollection,
  isCollectionId,
  resolveNftCollectionParentTokenId,
  resolveRegisteredNftCollection,
  type OnChainNftCollectionEvidence
} from './nftCollections'

const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const COMMUNITY_PARENT_TOKEN_ID =
  'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'
const CHILD_TOKEN_ID = 'a'.repeat(64)
const OTHER_GROUP_TOKEN_ID = 'b'.repeat(64)

type VerifiedEvidence = Extract<
  OnChainNftCollectionEvidence,
  { kind: 'verified-nft1-child-genesis' }
>

const officialEvidence = (): VerifiedEvidence => ({
  kind: 'verified-nft1-child-genesis',
  childTokenId: CHILD_TOKEN_ID,
  groupTokenId: OFFICIAL_PARENT_TOKEN_ID,
  childTokenType: 65,
  groupTokenType: 129
})

const communityEvidence = (): VerifiedEvidence => ({
  ...officialEvidence(),
  groupTokenId: COMMUNITY_PARENT_TOKEN_ID
})

describe('NFT collection trust registry', () => {
  test('pins distinct official and community trust anchors in source', () => {
    expect(NFT_COLLECTION_TRUST_REGISTRY_VERSION).toBe(2)
    expect(NFT_COLLECTION_TRUST_REGISTRY).toEqual({
      official: {
        id: 'official',
        tier: 'official',
        parentTokenId: OFFICIAL_PARENT_TOKEN_ID
      },
      community: {
        id: 'community',
        tier: 'community',
        parentTokenId: COMMUNITY_PARENT_TOKEN_ID
      }
    })
    expect(NFT_COLLECTION_TRUST_REGISTRY.official.parentTokenId).not.toBe(
      NFT_COLLECTION_TRUST_REGISTRY.community.parentTokenId
    )
    expect(Object.isFrozen(NFT_COLLECTION_TRUST_REGISTRY)).toBe(true)
    expect(Object.isFrozen(NFT_COLLECTION_TRUST_REGISTRY.official)).toBe(true)
    expect(Object.isFrozen(NFT_COLLECTION_TRUST_REGISTRY.community)).toBe(true)
  })

  test('has no environment-configurable trust input', () => {
    const source = readFileSync(new URL('./nftCollections.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/VITE_|import\.meta\.env|process\.env/)
  })

  test('ignores a hostile legacy Parent environment value', () => {
    const previous = process.env.VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID
    process.env.VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID = OTHER_GROUP_TOKEN_ID
    try {
      expect(resolveNftCollectionParentTokenId('official')).toBe(OFFICIAL_PARENT_TOKEN_ID)
      expect(resolveNftCollectionParentTokenId('community')).toBe(COMMUNITY_PARENT_TOKEN_ID)
    } finally {
      if (previous === undefined) {
        delete process.env.VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID
      } else {
        process.env.VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID = previous
      }
    }
  })

  test('resolves only typed, registered collections to canonical Parents', () => {
    expect(resolveRegisteredNftCollection('official')).toBe(NFT_COLLECTION_TRUST_REGISTRY.official)
    expect(resolveRegisteredNftCollection('community')).toBe(NFT_COLLECTION_TRUST_REGISTRY.community)
    expect(resolveNftCollectionParentTokenId('official')).toBe(OFFICIAL_PARENT_TOKEN_ID)
    expect(resolveNftCollectionParentTokenId('community')).toBe(COMMUNITY_PARENT_TOKEN_ID)
    expect(isCollectionId('official')).toBe(true)
    expect(isCollectionId('community')).toBe(true)
  })

  test.each([null, undefined, '', 'Official', 'unknown', OTHER_GROUP_TOKEN_ID, {}, []])(
    'fails closed for an arbitrary runtime collection selector: %j',
    (collectionId) => {
      expect(isCollectionId(collectionId)).toBe(false)
      expect(() =>
        resolveRegisteredNftCollection(collectionId as 'official')
      ).toThrow('Colección NFT no registrada.')
    }
  )
})

describe('classifyCollection', () => {
  test('classifies exact verified community Child evidence as community', () => {
    expect(classifyCollection(communityEvidence())).toBe('community')
  })

  test('keeps the official Parent classified as official', () => {
    expect(classifyCollection(officialEvidence())).toBe('official')
  })

  test('Test A: metadata claims cannot override a different on-chain Group ID', () => {
    const adversarialFixture = {
      metadata: {
        name: 'Xolos Ramírez Official',
        verification: 'verified',
        parentTokenId: OFFICIAL_PARENT_TOKEN_ID
      },
      evidence: {
        ...officialEvidence(),
        groupTokenId: OTHER_GROUP_TOKEN_ID
      } satisfies OnChainNftCollectionEvidence
    }

    expect(classifyCollection(adversarialFixture.evidence)).toBe('unknown')
  })

  test.each(['official', 'community'])('metadata impersonating %s cannot affect classification', (tier) => {
    const adversarialFixture = {
      metadata: {
        name: tier === 'official' ? 'Xolos Ramírez Official' : 'xolosArmy Community',
        ticker: tier === 'official' ? 'XOLOSNFT' : 'RMZCOMM',
        verification: 'verified',
        parentTokenId:
          tier === 'official' ? OFFICIAL_PARENT_TOKEN_ID : COMMUNITY_PARENT_TOKEN_ID
      },
      evidence: {
        ...officialEvidence(),
        groupTokenId: OTHER_GROUP_TOKEN_ID
      } satisfies OnChainNftCollectionEvidence
    }

    expect(classifyCollection(adversarialFixture.evidence)).toBe('unknown')
  })

  test.each([
    ['missing metadata', null],
    ['corrupt metadata', '{not-json'],
    ['inaccessible metadata', new Error('offline')]
  ])('Test B: valid cryptographic evidence is official with %s', (_label, metadata) => {
    const fixture = { metadata, evidence: officialEvidence() }

    expect(fixture.metadata).toBe(metadata)
    expect(classifyCollection(fixture.evidence)).toBe('official')
  })

  test.each<Extract<OnChainNftCollectionEvidence, { kind: 'unverified' }>['reason']>([
    'missing-genesis',
    'invalid-child-type',
    'missing-group-input',
    'invalid-group-type',
    'malformed-evidence'
  ])('returns unknown for unverified evidence: %s', (reason) => {
    expect(classifyCollection({ kind: 'unverified', reason })).toBe('unknown')
  })

  test.each([
    ['missing child token ID', { ...officialEvidence(), childTokenId: undefined }],
    ['malformed child token ID', { ...officialEvidence(), childTokenId: 'not-a-token-id' }],
    [
      'uppercase group token ID',
      { ...officialEvidence(), groupTokenId: OFFICIAL_PARENT_TOKEN_ID.toUpperCase() }
    ],
    ['invalid child token type', { ...officialEvidence(), childTokenType: 1 }],
    ['invalid group token type', { ...officialEvidence(), groupTokenType: 1 }],
    ['missing group token ID', { ...officialEvidence(), groupTokenId: undefined }],
    [
      'non-string group token ID',
      {
        ...officialEvidence(),
        groupTokenId: { toString: (): string => OFFICIAL_PARENT_TOKEN_ID }
      }
    ],
    ['null evidence', null]
  ])('fails closed for runtime-malformed evidence: %s', (_label, evidence) => {
    expect(classifyCollection(evidence as OnChainNftCollectionEvidence)).toBe('unknown')
  })

  test('does not inspect a Group ID unless the evidence kind is verified', () => {
    let groupTokenIdReads = 0
    const unverifiedEvidence = {
      kind: 'unverified',
      reason: 'malformed-evidence'
    }
    Object.defineProperty(unverifiedEvidence, 'groupTokenId', {
      get() {
        groupTokenIdReads += 1
        throw new Error('groupTokenId must remain unread')
      }
    })

    expect(classifyCollection(unverifiedEvidence as OnChainNftCollectionEvidence)).toBe('unknown')
    expect(groupTokenIdReads).toBe(0)
  })

  test('contains hostile evidence access and returns unknown', () => {
    const hostileEvidence = new Proxy(officialEvidence(), {
      get() {
        throw new Error('hostile evidence getter')
      }
    })

    expect(classifyCollection(hostileEvidence)).toBe('unknown')
  })

  test('returns unknown for an arbitrary unregistered Group token', () => {
    expect(
      classifyCollection({
        ...officialEvidence(),
        groupTokenId: OTHER_GROUP_TOKEN_ID
      })
    ).toBe('unknown')
  })
})

describe('buildNftCollectionMetadata', () => {
  test('builds deterministic future metadata from the canonical registry', () => {
    const attributes = [{ trait_type: 'Variedad', value: 'Sin pelo' }] as const

    const metadata = buildNftCollectionMetadata({
      collectionId: 'official',
      name: 'Xilonen Ramírez',
      description: 'Expediente futuro de linaje',
      image: 'ipfs://bafy-image',
      externalUrl: 'https://xolosramirez.com/xilonen',
      attributes
    })

    expect(metadata).toEqual({
      schema: 'tonalli-nft-collection',
      schema_version: 1,
      name: 'Xilonen Ramírez',
      description: 'Expediente futuro de linaje',
      image: 'ipfs://bafy-image',
      external_url: 'https://xolosramirez.com/xilonen',
      attributes: [{ trait_type: 'Variedad', value: 'Sin pelo' }],
      collection: {
        id: 'official',
        parentTokenId: OFFICIAL_PARENT_TOKEN_ID,
        registryVersion: 2
      }
    })
    expect(metadata.attributes).not.toBe(attributes)
    expect(metadata.attributes[0]).not.toBe(attributes[0])
    expect('verification' in metadata).toBe(false)
  })

  test('builds community metadata from the registered Parent without affecting classification', () => {
    const metadata = buildNftCollectionMetadata({
      collectionId: 'community',
      name: 'Future community collection',
      description: 'Not active',
      image: 'ipfs://bafy-community'
    })

    expect(metadata.collection).toEqual({
      id: 'community',
      parentTokenId: COMMUNITY_PARENT_TOKEN_ID,
      registryVersion: 2
    })
    expect(
      classifyCollection({
        ...officialEvidence(),
        groupTokenId: OTHER_GROUP_TOKEN_ID
      })
    ).toBe('unknown')
  })

  test('keeps classification policy and on-chain evidence out of the mint path', () => {
    const productionFiles = [
      '../config/nfts.ts',
      '../services/nftMetadata.ts',
      '../services/slpNftTxBuilder.ts',
      '../routes/Nfts.tsx'
    ]

    for (const productionFile of productionFiles) {
      const source = readFileSync(new URL(productionFile, import.meta.url), 'utf8')
      expect(source).not.toMatch(/buildNftCollectionMetadata|classifyCollection|OnChainNftCollectionEvidence/)
    }
  })
})
