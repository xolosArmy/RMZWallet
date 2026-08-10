import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptUtxo, TokenInfo, Tx } from 'chronik-client'
import { Agora, AgoraOffer, AgoraPartial, DUMMY_KEYPAIR } from 'ecash-agora'
import { ALL_BIP143, Address, P2PKHSignatory, Script, shaRmd160, toHex } from 'ecash-lib'
import { FIRMA_ALPHA } from '../config/firmaAlpha'
import { TOKEN_DUST_SATS, buildAlpAgoraListOutputs } from '../dex/agoraPhase1'
import { getAgoraChronik, getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'
import {
  discoverFirmaOffers,
  executeFirmaBuy,
  executeFirmaSale,
  fetchFirmaBidPrice,
  prepareBestFirmaBuy,
  prepareFirmaBuyByOfferId,
  prepareFirmaSale
} from './firmaAlphaExchange'

const agoraMocks = vi.hoisted(() => ({
  selectAcceptFuelInputs: vi.fn()
}))

vi.mock('ecash-agora', async (importOriginal) => {
  const original = await importOriginal<typeof import('ecash-agora')>()
  return {
    ...original,
    getAgoraPartialAcceptFuelInputs: (
      ...args: Parameters<typeof original.getAgoraPartialAcceptFuelInputs>
    ) => {
      agoraMocks.selectAcceptFuelInputs(...args)
      return original.getAgoraPartialAcceptFuelInputs(...args)
    }
  }
})

const alicePubkey = DUMMY_KEYPAIR.pk
const alicePubkeyHex = toHex(alicePubkey)
const bobPubkey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x44)])
const bobPubkeyHex = toHex(bobPubkey)
const bobAddress = Address.p2pkh(shaRmd160(bobPubkey)).toString()
const offerOutpoint = { txid: 'a'.repeat(64), outIdx: 1 }

const canonicalTokenInfo = (): TokenInfo => ({
  tokenId: FIRMA_ALPHA.tokenId,
  tokenType: {
    protocol: 'ALP',
    type: 'ALP_TOKEN_TYPE_STANDARD',
    number: 0
  },
  genesisInfo: {
    tokenTicker: FIRMA_ALPHA.ticker,
    tokenName: FIRMA_ALPHA.onChainName,
    url: 'firmaprotocol.com',
    decimals: FIRMA_ALPHA.decimals,
    data: '',
    authPubkey: FIRMA_ALPHA.genesisAuthPubkeyHex
  }
} as TokenInfo)

const makePartial = (makerPk = alicePubkey) => AgoraPartial.approximateParams({
  offeredAtoms: 10_000n,
  priceNanoSatsPerAtom: 70_000_000_000n,
  makerPk,
  minAcceptedAtoms: 100n,
  tokenId: FIRMA_ALPHA.tokenId,
  tokenType: 0,
  tokenProtocol: 'ALP',
  enforcedLockTime: 600_000_001,
  dustSats: TOKEN_DUST_SATS
})

const makeOffer = (partial = makePartial()) => new AgoraOffer({
  variant: { type: 'PARTIAL', params: partial },
  outpoint: offerOutpoint,
  txBuilderInput: {
    prevOut: offerOutpoint,
    signData: { sats: TOKEN_DUST_SATS, redeemScript: partial.script() }
  },
  token: {
    tokenId: FIRMA_ALPHA.tokenId,
    tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
    atoms: partial.offeredAtoms(),
    isMintBaton: false
  },
  status: 'OPEN'
})

const makeOfferTx = (partial: AgoraPartial): Tx => {
  const outputs = buildAlpAgoraListOutputs({
    agoraPartial: partial,
    tokenId: FIRMA_ALPHA.tokenId,
    sendAmounts: [partial.offeredAtoms()]
  })
  return {
    outputs: outputs.map((output, index) => ({
      sats: output.sats,
      outputScript: toHex((output as { script: Script }).script.bytecode),
      spentBy: undefined,
      token: index === 1
        ? {
            tokenId: FIRMA_ALPHA.tokenId,
            tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
            atoms: partial.offeredAtoms(),
            isMintBaton: false
          }
        : undefined
    }))
  } as Tx
}

const xecUtxo = (suffix: string, sats: bigint): ScriptUtxo => ({
  outpoint: { txid: suffix.repeat(64), outIdx: 0 },
  blockHeight: 1,
  isCoinbase: false,
  sats,
  isFinal: true
} as ScriptUtxo)

const firmaUtxo = (suffix: string, atoms: bigint): ScriptUtxo => ({
  ...xecUtxo(suffix, TOKEN_DUST_SATS),
  token: {
    tokenId: FIRMA_ALPHA.tokenId,
    tokenType: { protocol: 'ALP', type: 'ALP_TOKEN_TYPE_STANDARD', number: 0 },
    atoms,
    isMintBaton: false
  }
} as ScriptUtxo)

describe('Firma Alpha security boundaries', () => {
  const chronik = getChronik()
  const agoraChronik = getAgoraChronik()
  const aliceOffer = makeOffer()
  const aliceOfferTx = makeOfferTx(aliceOffer.variant.type === 'PARTIAL' ? aliceOffer.variant.params : makePartial())
  let currentBid = 7_000
  let currentCapacitySats = 5_000_000n
  let accountUtxos: ScriptUtxo[] = []

  beforeEach(() => {
    agoraMocks.selectAcceptFuelInputs.mockClear()
    currentBid = 7_000
    currentCapacitySats = 5_000_000n
    accountUtxos = [firmaUtxo('b', 50_000n), xecUtxo('c', 2_000_000n)]

    vi.spyOn(chronik, 'token').mockResolvedValue(canonicalTokenInfo())
    vi.spyOn(chronik, 'tx').mockResolvedValue(aliceOfferTx)
    vi.spyOn(chronik, 'address').mockImplementation((address: string) => ({
      utxos: async () => ({
        outputScript: '',
        utxos: address === FIRMA_ALPHA.redeemAddress
          ? [xecUtxo('d', currentCapacitySats)]
          : accountUtxos
      })
    }) as never)
    vi.spyOn(chronik, 'broadcastTx').mockResolvedValue({ txid: 'e'.repeat(64) })
    vi.spyOn(agoraChronik, 'script').mockReturnValue({
      utxos: async () => ({ outputScript: '', utxos: [] })
    } as never)
    vi.spyOn(Agora.prototype, 'activeOffersByTokenId').mockResolvedValue([aliceOffer])

    vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockReturnValue({
      address: bobAddress,
      publicKey: bobPubkeyHex
    })
    vi.spyOn(xolosWalletService, 'getSignatory').mockReturnValue({
      address: bobAddress,
      publicKeyHex: bobPubkeyHex,
      publicKey: bobPubkey,
      signatory: P2PKHSignatory(DUMMY_KEYPAIR.sk, DUMMY_KEYPAIR.pk, ALL_BIP143)
    })
    vi.spyOn(xolosWalletService, 'withPrivateKey').mockImplementation((handler) => handler(DUMMY_KEYPAIR.sk))
    vi.spyOn(xolosWalletService, 'signTxBuilder').mockReturnValue({
      ser: () => new Uint8Array([1, 2, 3])
    } as never)
    vi.spyOn(xolosWalletService, 'getBalances').mockResolvedValue({} as never)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ bid: currentBid }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lets Bob discover and prepare Alice\'s canonical peer offer', async () => {
    expect(alicePubkeyHex).not.toBe(FIRMA_ALPHA.genesisAuthPubkeyHex)
    expect(alicePubkeyHex).not.toBe(bobPubkeyHex)

    const orderbook = await discoverFirmaOffers(bobPubkeyHex)
    expect(orderbook.offers).toHaveLength(1)
    expect(orderbook.offers[0]).toMatchObject({
      offerId: `${offerOutpoint.txid}:${offerOutpoint.outIdx}`,
      makerPubkeyHex: alicePubkeyHex,
      source: 'peer'
    })

    const preview = await prepareBestFirmaBuy('1')
    expect(preview.offerId).toBe(`${offerOutpoint.txid}:${offerOutpoint.outIdx}`)
    expect(preview.acceptedAtoms).toBe(10_000n)
  })

  it('never materializes or signs with wallet private keys during buy preparation', async () => {
    const getSignatory = vi.mocked(xolosWalletService.getSignatory)
    const withPrivateKey = vi.mocked(xolosWalletService.withPrivateKey)
    const signTxBuilder = vi.mocked(xolosWalletService.signTxBuilder)

    await prepareFirmaBuyByOfferId(`${offerOutpoint.txid}:${offerOutpoint.outIdx}`, 10_000n)
    await prepareBestFirmaBuy('1')

    expect(getSignatory).not.toHaveBeenCalled()
    expect(withPrivateKey).not.toHaveBeenCalled()
    expect(signTxBuilder).not.toHaveBeenCalled()
  })

  it('rejects an unacceptable remainder before producing a confirmable preview', async () => {
    const invalidRemainder = AgoraPartial.approximateParams({
      offeredAtoms: 1_000n,
      priceNanoSatsPerAtom: 1_000_000_000n,
      makerPk: alicePubkey,
      minAcceptedAtoms: 546n,
      tokenId: FIRMA_ALPHA.tokenId,
      tokenType: 0,
      tokenProtocol: 'ALP',
      enforcedLockTime: 600_000_002,
      dustSats: TOKEN_DUST_SATS
    })
    vi.mocked(chronik.tx).mockResolvedValueOnce(makeOfferTx(invalidRemainder))

    await expect(
      prepareFirmaBuyByOfferId(`${offerOutpoint.txid}:${offerOutpoint.outIdx}`, 546n)
    ).rejects.toThrow(/remainder FIRMA inaceptable/)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
  })

  it('uses the official Agora fuel-input strategy in both preview and confirmation', async () => {
    const preview = await prepareFirmaBuyByOfferId(
      `${offerOutpoint.txid}:${offerOutpoint.outIdx}`,
      10_000n
    )
    expect(preview.effectivePriceXecPerFirma).toBe('7001.9')
    expect(agoraMocks.selectAcceptFuelInputs).toHaveBeenCalledTimes(1)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()

    await expect(executeFirmaBuy(preview)).resolves.toBe('e'.repeat(64))

    expect(agoraMocks.selectAcceptFuelInputs).toHaveBeenCalledTimes(2)
    expect(agoraMocks.selectAcceptFuelInputs.mock.calls[0][2]).toBe(10_000n)
    expect(agoraMocks.selectAcceptFuelInputs.mock.calls[1][2]).toBe(10_000n)
    expect(agoraMocks.selectAcceptFuelInputs.mock.calls[0][1].map((utxo: ScriptUtxo) => utxo.outpoint))
      .toEqual(agoraMocks.selectAcceptFuelInputs.mock.calls[1][1].map((utxo: ScriptUtxo) => utxo.outpoint))
    expect(agoraMocks.selectAcceptFuelInputs.mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(xolosWalletService.getSignatory).mock.invocationCallOrder[0])
  })

  it('validates the authoritative bid response and XEC-per-FIRMA units', async () => {
    currentBid = 147_306.27
    await expect(fetchFirmaBidPrice()).resolves.toEqual({
      display: '147306.27',
      satsPerFirma: 14_730_627n
    })

    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(fetchFirmaBidPrice()).rejects.toThrow(/campo bid/)

    vi.mocked(fetch).mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    await expect(fetchFirmaBidPrice()).rejects.toThrow(/HTTP 503/)
  })

  it('aborts redemption confirmation when the bid changed', async () => {
    const preview = await prepareFirmaSale({ amount: '1', mode: 'redeem' })
    currentBid = 7_001

    await expect(executeFirmaSale(preview)).rejects.toThrow(/bid FIRMA cambió/)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
  })

  it('aborts redemption confirmation when sweeper capacity no longer covers askedSats', async () => {
    const preview = await prepareFirmaSale({ amount: '1', mode: 'redeem' })
    currentCapacitySats = preview.askedSats

    await expect(executeFirmaSale(preview)).rejects.toThrow(/capacidad de redención FIRMA cambió/)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
  })

  it('aborts redemption confirmation when wallet UTXOs changed', async () => {
    const preview = await prepareFirmaSale({ amount: '1', mode: 'redeem' })
    accountUtxos = [firmaUtxo('f', 50_000n), xecUtxo('c', 2_000_000n)]

    await expect(executeFirmaSale(preview)).rejects.toThrow(/UTXOs cambiaron/)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
  })

  it('allows confirmation only when bid, capacity, UTXOs and covenant remain current', async () => {
    const preview = await prepareFirmaSale({ amount: '1', mode: 'redeem' })

    await expect(executeFirmaSale(preview)).resolves.toEqual({
      txid: 'e'.repeat(64),
      offerId: `${'e'.repeat(64)}:1`
    })
    expect(xolosWalletService.getSignatory).toHaveBeenCalledOnce()
    expect(xolosWalletService.signTxBuilder).toHaveBeenCalledOnce()
    expect(chronik.broadcastTx).toHaveBeenCalledOnce()
  })
})
