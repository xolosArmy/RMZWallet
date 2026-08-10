import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScriptUtxo } from 'chronik-client'
import { Agora, AgoraOffer, AgoraPartial } from 'ecash-agora'
import { Script, shaRmd160, toHex } from 'ecash-lib'
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
const bytes = (hex: string) => Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)))
const peerPubkeyHex = `02${'11'.repeat(32)}`

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
}) => AgoraPartial.approximateParams({
  offeredAtoms: params.offered ?? 10_000n,
  priceNanoSatsPerAtom: 70_000_000_000n,
  makerPk: bytes(params.maker ?? FIRMA_ALPHA.genesisAuthPubkeyHex),
  minAcceptedAtoms: params.min ?? 100n,
  tokenId: params.tokenId ?? FIRMA_ALPHA.tokenId,
  tokenProtocol: params.protocol ?? 'ALP',
  tokenType: params.type ?? 0,
  enforcedLockTime: 600_000_000,
  dustSats: 546n
})

const offer = (
  partialParams: Parameters<typeof partial>[0] & { asked?: bigint } = {},
  tokenId = FIRMA_ALPHA.tokenId
) => {
  const agoraPartial = partial(partialParams)
  const atoms = agoraPartial.offeredAtoms()
  const offerOutpoint = outpoint('a')
  const created = new AgoraOffer({
    variant: { type: 'PARTIAL', params: agoraPartial },
    outpoint: offerOutpoint,
    txBuilderInput: {
      prevOut: offerOutpoint,
      signData: { sats: 546n, redeemScript: agoraPartial.script() }
    },
    token: {
      tokenId,
      tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
      atoms,
      isMintBaton: false
    },
    status: 'OPEN'
  })
  if (partialParams.asked !== undefined) {
    created.askedSats = () => partialParams.asked as bigint
  }
  return created
}

const deterministicAgora = () => {
  let locktime = 600_000_000
  return {
    selectParams: async (params: Record<string, unknown>) => AgoraPartial.approximateParams({
      ...params,
      enforcedLockTime: locktime++
    })
  } as Pick<Agora, 'selectParams'>
}

describe('Firma Alpha balance and permissionless offers', () => {
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

  it('accepts valid peers and rejects fake token IDs or invalid covenants', () => {
    expect(isCanonicalFirmaOffer(offer())).toBe(true)
    expect(isCanonicalFirmaOffer(offer({ maker: peerPubkeyHex }))).toBe(true)
    expect(isCanonicalFirmaOffer(offer({}, 'f'.repeat(64)))).toBe(false)

    const malformed = offer()
    ;(malformed.txBuilderInput as { signData: { redeemScript: Script } }).signData.redeemScript = new Script()
    expect(isCanonicalFirmaOffer(malformed)).toBe(false)
  })

  it('labels maker identity without using it as token authorization', () => {
    expect(toFirmaOfferSummary(offer({ maker: peerPubkeyHex }) as never, `03${'22'.repeat(32)}`).source).toBe('peer')
    expect(toFirmaOfferSummary(offer({ maker: peerPubkeyHex }) as never, peerPubkeyHex).source).toBe('own')
  })

  it('maps and sorts offers by rational XEC-per-atom price', () => {
    const cheaper = toFirmaOfferSummary(offer({ offered: 20_000n, asked: 10_000n }) as never)
    const expensive = toFirmaOfferSummary(offer({ offered: 10_000n, asked: 7_000n }) as never)
    expect([expensive, cheaper].sort(compareFirmaOffersByPrice).map((item) => item.askedSats)).toEqual([10_000n, 7_000n])
  })
})

describe('Firma Alpha liquidity selection', () => {
  const summary = (
    offerId: string,
    offeredAtoms: bigint,
    minAcceptedAtoms: bigint,
    askedSats: bigint,
    source: FirmaOfferSummary['source'] = 'peer'
  ): FirmaOfferSummary => ({
    offerId,
    offeredAtoms,
    minAcceptedAtoms,
    askedSats,
    makerPubkeyHex: peerPubkeyHex,
    priceNanoSatsPerAtom: 1n,
    source
  })

  it('selects the best compatible offer regardless of maker label', () => {
    const offers = [
      summary('official-expensive', 10_000n, 100n, 8_000n, 'official'),
      summary('peer-too-small', 500n, 100n, 100n),
      summary('alice-best', 10_000n, 100n, 7_000n)
    ]
    expect(selectBestFirmaOffer(offers, 1_000n).offerId).toBe('alice-best')
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

describe('Firma Alpha safe sale and redemption parameters', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const makerPk = bytes(peerPubkeyHex)

  it('uses all four FIRMA decimals for a regular listing selected by Agora', async () => {
    const selector = deterministicAgora()
    const selectParams = vi.spyOn(selector, 'selectParams')
    const result = await createFirmaSalePartial(
      { amount: '1.2345', xecPerFirma: '7000.00', mode: 'sell', makerPk },
      selector
    )
    expect(selectParams).toHaveBeenCalledOnce()
    expect(result.requestedAtoms).toBe(12_345n)
    expect(result.partial.offeredAtoms()).toBeGreaterThan(0n)
    expect(result.partial.tokenId).toBe(FIRMA_ALPHA.tokenId)
    expect(result.partial.tokenProtocol).toBe('ALP')
  })

  it('uses Agora.selectParams to avoid identical covenant locktimes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T19:00:00Z'))
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.75)

    const existingScripts = new Set<string>()
    const queriedScripts: string[] = []
    const chronik = {
      plugin: () => ({}),
      script: (_type: string, scriptHash: string) => ({
        utxos: async () => {
          queriedScripts.push(scriptHash)
          return { utxos: existingScripts.has(scriptHash) ? [{}] : [] }
        }
      })
    }
    const agora = new Agora(chronik as never)
    const terms = { amount: '1', xecPerFirma: '7000.00', mode: 'sell' as const, makerPk }
    const alice = await createFirmaSalePartial(terms, agora)
    existingScripts.add(toHex(shaRmd160(alice.partial.script().bytecode)))
    const bob = await createFirmaSalePartial(terms, agora)

    expect(queriedScripts).toHaveLength(3)
    expect(bob.partial.enforcedLockTime).not.toBe(alice.partial.enforcedLockTime)
    expect(toHex(bob.partial.script().bytecode)).not.toBe(toHex(alice.partial.script().bytecode))
  })

  it('does not construct a FIRMA covenant from Date.now()/1000', () => {
    const source = readFileSync(new URL('./firmaAlphaExchange.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/Date\.now\(\)\s*\/\s*1000/)
    expect(source).not.toMatch(/enforcedLockTime\s*:/)
  })

  it('enforces the 0.01 FIRMA redemption minimum', async () => {
    await expect(createFirmaSalePartial({
      amount: '0.0099',
      mode: 'redeem',
      makerPk,
      bidSatsPerFirma: 700_000n
    }, deterministicAgora())).rejects.toThrow(/0\.01 FIRMA/)
  })

  it('prices a redemption strictly below the official bid after covenant approximation', async () => {
    const bidSatsPerFirma = 700_000n
    const result = await createFirmaSalePartial(
      { amount: '1', mode: 'redeem', makerPk, bidSatsPerFirma },
      deterministicAgora()
    )
    const offeredAtoms = result.partial.offeredAtoms()
    const atomsPerFirma = 10n ** BigInt(FIRMA_ALPHA.decimals)
    expect(result.partial.askedSats(offeredAtoms) * atomsPerFirma).toBeLessThan(bidSatsPerFirma * offeredAtoms)
    expect(result.partial.minAcceptedAtoms()).toBe(offeredAtoms)
  })
})
