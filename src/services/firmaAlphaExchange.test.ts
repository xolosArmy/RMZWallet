import { describe, expect, it } from 'vitest'
import type { ScriptUtxo } from 'chronik-client'
import type { AgoraOffer, AgoraPartial } from 'ecash-agora'
import { FIRMA_ALPHA } from '../config/firmaAlpha'
import {
  compareFirmaOffersByPrice,
  createFirmaSalePartial,
  formatFirmaAtoms,
  getFirmaBalanceFromUtxos,
  isCanonicalFirmaOffer,
  selectBestFirmaOffer,
  toFirmaOfferSummary,
  type FirmaOfferSummary
} from './firmaAlphaExchange'

const outpoint = (suffix: string, outIdx = 1) => ({ txid: suffix.padStart(64, '0'), outIdx })

const tokenUtxo = (params: {
  tokenId?: string
  protocol?: string
  type?: number
  atoms: bigint
  baton?: boolean
}): ScriptUtxo => ({
  outpoint: outpoint('1'),
  blockHeight: 1,
  isCoinbase: false,
  sats: 546n,
  isFinal: true,
  token: {
    tokenId: params.tokenId ?? FIRMA_ALPHA.tokenId,
    tokenType: {
      protocol: params.protocol ?? 'ALP',
      type: 'ALP_TOKEN_TYPE_STANDARD',
      number: params.type ?? 0
    },
    atoms: params.atoms,
    isMintBaton: params.baton ?? false
  }
} as ScriptUtxo)

const partial = (params: {
  maker?: string
  tokenId?: string
  protocol?: 'ALP' | 'SLP'
  type?: number
  offered?: bigint
  min?: bigint
  asked?: bigint
}) => ({
  tokenId: params.tokenId ?? FIRMA_ALPHA.tokenId,
  tokenProtocol: params.protocol ?? 'ALP',
  tokenType: params.type ?? 0,
  makerPk: Uint8Array.from((params.maker ?? FIRMA_ALPHA.makerPubkeyHex).match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))),
  offeredAtoms: () => params.offered ?? 10_000n,
  minAcceptedAtoms: () => params.min ?? 100n,
  askedSats: () => params.asked ?? 7_000n,
  priceNanoSatsPerAtom: () => 700_000_000n
}) as unknown as AgoraPartial

const offer = (partialParams: Parameters<typeof partial>[0] = {}, tokenId = FIRMA_ALPHA.tokenId) => {
  const agoraPartial = partial(partialParams)
  const atoms = agoraPartial.offeredAtoms()
  return {
    variant: { type: 'PARTIAL', params: agoraPartial },
    outpoint: outpoint('a'),
    token: {
      tokenId,
      tokenType: { protocol: 'ALP', number: 0 },
      atoms,
      isMintBaton: false
    },
    status: 'OPEN',
    askedSats: () => partialParams.asked ?? 7_000n
  } as unknown as AgoraOffer
}

describe('Firma Alpha balance and offers', () => {
  it('sums only exact, standard, non-baton FIRMA UTXOs with bigint arithmetic', () => {
    const huge = 9_007_199_254_740_993n
    expect(getFirmaBalanceFromUtxos([
      tokenUtxo({ atoms: huge }),
      tokenUtxo({ atoms: 7n }),
      tokenUtxo({ atoms: 99n, tokenId: 'f'.repeat(64) }),
      tokenUtxo({ atoms: 99n, protocol: 'SLP' }),
      tokenUtxo({ atoms: 0n, baton: true })
    ])).toBe(huge + 7n)
  })

  it('formats four FIRMA decimals without floating point', () => {
    expect(formatFirmaAtoms(12_345n)).toBe('1.2345')
    expect(formatFirmaAtoms(90_071_992_547_409_930_000n)).toBe('9007199254740993')
  })

  it('accepts official-minter offers and rejects fake token IDs or makers', () => {
    expect(isCanonicalFirmaOffer(offer())).toBe(true)
    expect(isCanonicalFirmaOffer(offer({}, 'f'.repeat(64)))).toBe(false)
    expect(isCanonicalFirmaOffer(offer({ maker: `02${'00'.repeat(32)}` }))).toBe(false)
  })

  it('keeps an active-wallet listing visible without treating it as official liquidity', () => {
    const ownMaker = `02${'11'.repeat(32)}`
    expect(isCanonicalFirmaOffer(offer({ maker: ownMaker }), ownMaker)).toBe(true)
    expect(isCanonicalFirmaOffer(offer({ maker: ownMaker }))).toBe(false)
  })

  it('maps and sorts offers by rational XEC-per-atom price', () => {
    const cheaper = toFirmaOfferSummary(offer({ offered: 20_000n, asked: 10_000n }) as never)
    const expensive = toFirmaOfferSummary(offer({ offered: 10_000n, asked: 7_000n }) as never)
    expect([expensive, cheaper].sort(compareFirmaOffersByPrice).map((item) => item.askedSats)).toEqual([10_000n, 7_000n])
  })
})

describe('Firma Alpha liquidity selection', () => {
  const summary = (offerId: string, offeredAtoms: bigint, minAcceptedAtoms: bigint, askedSats: bigint): FirmaOfferSummary => ({
    offerId,
    offeredAtoms,
    minAcceptedAtoms,
    askedSats,
    makerPubkeyHex: FIRMA_ALPHA.makerPubkeyHex,
    priceNanoSatsPerAtom: 1n,
    source: 'official'
  })

  it('selects the best single offer that can satisfy the requested amount', () => {
    const offers = [
      summary('expensive', 10_000n, 100n, 8_000n),
      summary('cheap-too-small', 500n, 100n, 100n),
      summary('best', 10_000n, 100n, 7_000n)
    ]
    expect(selectBestFirmaOffer(offers, 1_000n).offerId).toBe('best')
  })

  it('rejects insufficient one-offer liquidity and minimum violations', () => {
    expect(() => selectBestFirmaOffer([summary('a', 500n, 100n, 100n)], 501n)).toThrow(/liquidez/)
    expect(() => selectBestFirmaOffer([
      summary('a', 600n, 100n, 100n),
      summary('b', 600n, 100n, 100n)
    ], 1_000n)).toThrow(/una sola oferta/)
    expect(() => selectBestFirmaOffer([summary('a', 500n, 200n, 100n)], 100n)).toThrow(/mínimo/)
  })
})

describe('Firma Alpha sale and redemption parameters', () => {
  const makerPk = Uint8Array.from(FIRMA_ALPHA.makerPubkeyHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)))

  it('uses all four FIRMA decimals for a regular listing', () => {
    const result = createFirmaSalePartial({ amount: '1.2345', xecPerFirma: '7000.00', mode: 'sell', makerPk })
    expect(result.requestedAtoms).toBe(12_345n)
    expect(result.partial.offeredAtoms()).toBeGreaterThan(0n)
    expect(result.partial.tokenId).toBe(FIRMA_ALPHA.tokenId)
    expect(result.partial.tokenProtocol).toBe('ALP')
  })

  it('enforces the 0.01 FIRMA redemption minimum', () => {
    expect(() => createFirmaSalePartial({
      amount: '0.0099',
      mode: 'redeem',
      makerPk,
      bidSatsPerFirma: 700_000n
    })).toThrow(/0\.01 FIRMA/)
  })

  it('prices a redemption strictly below the official bid after covenant approximation', () => {
    const bidSatsPerFirma = 700_000n
    const result = createFirmaSalePartial({ amount: '1', mode: 'redeem', makerPk, bidSatsPerFirma })
    const offeredAtoms = result.partial.offeredAtoms()
    const atomsPerFirma = 10n ** BigInt(FIRMA_ALPHA.decimals)
    expect(result.partial.askedSats(offeredAtoms) * atomsPerFirma).toBeLessThan(bidSatsPerFirma * offeredAtoms)
    expect(result.partial.minAcceptedAtoms()).toBe(offeredAtoms)
  })
})
