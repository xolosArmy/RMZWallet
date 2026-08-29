import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('public NFT mint collection architecture', () => {
  const publicMintFiles = [
    '../routes/Nfts.tsx',
    '../routes/DEX.tsx',
    '../services/nftService.ts',
    '../services/nftMetadata.ts',
    '../services/slpNftTxBuilder.ts'
  ]

  test('keeps environment-controlled and legacy Parent values out of every public mint layer', () => {
    for (const file of publicMintFiles) {
      const contents = source(file)
      expect(contents).not.toMatch(/VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID/)
      expect(contents).not.toMatch(/XOLOSARMY_NFT_PARENT_TOKEN_ID/)
    }
  })

  test('passes typed collection identity through UI, service, metadata and builder', () => {
    const route = source('../routes/Nfts.tsx')
    const service = source('../services/nftService.ts')
    const metadata = source('../services/nftMetadata.ts')
    const builder = source('../services/slpNftTxBuilder.ts')

    expect(route).toMatch(/collectionId,\s*name:/)
    expect(service).toMatch(/collectionId: CollectionId/)
    expect(service).toMatch(/mintNftChildGenesis\(\{[\s\S]*collectionId,[\s\S]*expectedMintPass/)
    expect(metadata).toMatch(/collectionId: CollectionId/)
    expect(builder).toMatch(/mintNftChildGenesis = async \(params: \{[\s\S]*collectionId: CollectionId/)
    expect(builder).toMatch(/resolveNftCollectionParentTokenId\(params\.collectionId\)/)
  })

  test('routes Mint Pass DEX operations through the refactored Offers entry point', () => {
    const route = source('../routes/Nfts.tsx')
    const dex = source('../routes/DEX.tsx')

    expect(route).toContain('/dex?mode=mintpass&collectionId=${selectedCollectionId}')
    expect(dex).toMatch(/searchParams\.has\('mode'\)/)
    expect(dex).toMatch(/MintPassOffers/)
    expect(dex).not.toMatch(/mode === 'mintpass'[^\n]*tokenId/)
  })

  test('does not mix classification policy or metadata claims into mint authorization', () => {
    for (const file of publicMintFiles) {
      const contents = source(file)
      expect(contents).not.toMatch(/classifyCollection|OnChainNftCollectionEvidence/)
    }
  })
})
