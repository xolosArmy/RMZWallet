import { describe, expect, it } from 'vitest'
import type { TokenInfo } from 'chronik-client'
import { FIRMA_ALPHA, assertFirmaAlphaTokenInfo } from './firmaAlpha'

const canonicalTokenInfo = (overrides: Record<string, unknown> = {}) => ({
  tokenId: FIRMA_ALPHA.tokenId,
  tokenType: {
    protocol: 'ALP',
    type: 'ALP_TOKEN_TYPE_STANDARD',
    number: 0
  },
  genesisInfo: {
    tokenTicker: 'FIRMA',
    tokenName: 'Firma',
    url: 'firma.cash',
    decimals: 4,
    data: '',
    authPubkey: FIRMA_ALPHA.genesisAuthPubkeyHex
  },
  ...overrides
}) as TokenInfo

describe('Firma Alpha canonical config', () => {
  it('uses the verified genesis Token ID, ALP standard and four decimals', () => {
    expect(FIRMA_ALPHA.tokenId).toBe('0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0')
    expect(FIRMA_ALPHA.protocol).toBe('ALP')
    expect(FIRMA_ALPHA.tokenType).toBe(0)
    expect(FIRMA_ALPHA.decimals).toBe(4)
    expect(FIRMA_ALPHA.genesisAuthPubkeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/)
  })

  it('accepts only the complete canonical genesis identity', () => {
    expect(assertFirmaAlphaTokenInfo(canonicalTokenInfo()).tokenId).toBe(FIRMA_ALPHA.tokenId)
  })

  it.each([
    ['fake Token ID', { tokenId: 'f'.repeat(64) }],
    ['wrong protocol', { tokenType: { protocol: 'SLP', type: 'SLP_TOKEN_TYPE_FUNGIBLE', number: 1 } }],
    ['wrong decimals', { genesisInfo: { ...canonicalTokenInfo().genesisInfo, decimals: 2 } }],
    ['wrong authority', { genesisInfo: { ...canonicalTokenInfo().genesisInfo, authPubkey: `02${'00'.repeat(32)}` } }]
  ])('rejects %s even if the ticker says FIRMA', (_label, overrides) => {
    expect(() => assertFirmaAlphaTokenInfo(canonicalTokenInfo(overrides))).toThrow()
  })
})
