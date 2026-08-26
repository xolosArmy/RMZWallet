import { describe, expect, test } from 'vitest'

import { buildXolosarmyNftMetadata } from './nftMetadata'

const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const COMMUNITY_PARENT_TOKEN_ID =
  'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'

describe('buildXolosarmyNftMetadata collection description', () => {
  test('preserves the existing Official metadata shape with the canonical Parent', () => {
    expect(
      buildXolosarmyNftMetadata({
        collectionId: 'official',
        name: 'Xilonen Ramírez',
        description: 'Official fixture',
        imageCid: 'bafy-official'
      })
    ).toEqual({
      name: 'Xilonen Ramírez',
      description: 'Official fixture',
      image: 'ipfs://bafy-official',
      external_url: undefined,
      collection: {
        name: 'xolosArmy NFTs',
        family: 'Xolos Ramírez'
      },
      attributes: [],
      lineage: undefined,
      parent: OFFICIAL_PARENT_TOKEN_ID,
      app: 'Tonalli Wallet',
      schema_version: undefined
    })
  })

  test('describes Community with its canonical Parent without claiming Official lineage', () => {
    const metadata = buildXolosarmyNftMetadata({
      collectionId: 'community',
      name: 'Xolos Ramírez Official',
      description: 'verification=verified cannot change ancestry',
      imageCid: 'bafy-community'
    })

    expect(metadata.collection).toEqual({
      name: 'xolosArmy Community',
      family: 'xolosArmy Community'
    })
    expect(metadata.parent).toBe(COMMUNITY_PARENT_TOKEN_ID)
    expect(metadata.parent).not.toBe(OFFICIAL_PARENT_TOKEN_ID)
    expect(metadata).not.toHaveProperty('verification')
  })

  test('rejects a free-form collection selector instead of accepting an arbitrary Parent', () => {
    expect(() =>
      buildXolosarmyNftMetadata({
        collectionId: 'attacker' as 'community',
        name: 'Attacker',
        description: 'Attacker',
        imageCid: 'bafy-attacker'
      })
    ).toThrow('Colección NFT no registrada.')
  })
})
