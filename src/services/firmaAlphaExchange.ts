import type { ScriptUtxo, TokenInfo, Tx } from 'chronik-client'
import {
  Agora,
  AgoraOffer,
  AgoraPartial,
  DUMMY_KEYPAIR,
  getAgoraPartialAcceptFuelInputs
} from 'ecash-agora'
import {
  ALL_BIP143,
  ALP_STANDARD,
  P2PKHSignatory,
  Script,
  TxBuilder,
  calcTxFee,
  shaRmd160,
  toHex
} from 'ecash-lib'
import { FIRMA_ALPHA, assertFirmaAlphaTokenInfo } from '../config/firmaAlpha'
import {
  TOKEN_DUST_SATS,
  buildAlpAgoraListOutputs,
  calcPriceNanoSatsPerAtom,
  formatAtomsToDecimal,
  formatSatsToXec,
  parseAgoraOfferFromTx,
  parseDecimalToAtoms,
  parseOfferId,
  parseXecToSats
} from '../dex/agoraPhase1'
import { getAgoraChronik, getChronik } from './ChronikClient'
import { xolosWalletService, type WalletSignatory } from './XolosWalletService'
import { toFriendlyBroadcastError } from './buyOfferById'

export const FIRMA_FEE_PER_KB = 1200n
export const FIRMA_MIN_REDEEM_ATOMS = 100n

const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10
const REDEEM_PRICE_STEP_NANOSATS_PER_ATOM = 500_000_000n
const MAX_REDEEM_PRICE_ADJUSTMENTS = 25
const FIRMA_BID_PROXY_URL = '/api/firma-bid'

const FIRMA_BID_TIMEOUT_MESSAGE = 'El oráculo de redención de Firma no respondió a tiempo.'
const FIRMA_BID_UNAVAILABLE_MESSAGE = 'El oráculo de redención de Firma no está disponible temporalmente.'
const FIRMA_BID_INVALID_MESSAGE = 'Firma devolvió un precio de redención inválido.'

type FirmaPartialOffer = AgoraOffer & {
  variant: { type: 'PARTIAL'; params: AgoraPartial }
}

export type FirmaOfferSummary = {
  offerId: string
  offeredAtoms: bigint
  minAcceptedAtoms: bigint
  askedSats: bigint
  makerPubkeyHex: string
  priceNanoSatsPerAtom: bigint
  source: 'official' | 'peer' | 'own'
}

export type FirmaOrderbook = {
  tokenInfo: TokenInfo
  offers: FirmaOfferSummary[]
  totalLiquidityAtoms: bigint
}

export type FirmaBuyPreview = {
  kind: 'buy'
  offerId: string
  requestedAtoms: bigint
  acceptedAtoms: bigint
  askedSats: bigint
  effectivePriceXecPerFirma: string
  networkFeeSats: bigint
  totalSats: bigint
  payoutAddress: string
  adjustedForAgora: boolean
  inputOutpoints: string[]
}

export type FirmaSaleMode = 'sell' | 'redeem'

export type FirmaSalePreview = {
  kind: FirmaSaleMode
  requestedAtoms: bigint
  offeredAtoms: bigint
  askedSats: bigint
  networkFeeSats: bigint
  priceNanoSatsPerAtom: bigint
  priceXecPerFirma: string
  tokenChangeAtoms: bigint
  inputOutpoints: string[]
  redemptionCapacitySats?: bigint
  bidPriceXec?: string
  bidSatsPerFirma?: bigint
  agoraPartial: AgoraPartial
  planFingerprint: string
}

export class FirmaAgoraUnavailableError extends Error {
  constructor() {
    super('El endpoint Chronik configurado no tiene el plugin Agora activo.')
    this.name = 'FirmaAgoraUnavailableError'
  }
}

export function isAgoraPluginUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: number; message?: string }
  return candidate.status === 404 || /404|plugin.*agora|agora.*plugin/i.test(candidate.message || '')
}

export async function verifyFirmaAlphaGenesis(): Promise<TokenInfo> {
  return assertFirmaAlphaTokenInfo(await getChronik().token(FIRMA_ALPHA.tokenId))
}

export function getFirmaBalanceFromUtxos(utxos: ScriptUtxo[]): bigint {
  return utxos.reduce((total, utxo) => {
    const token = utxo.token
    if (
      token?.tokenId === FIRMA_ALPHA.tokenId &&
      token.tokenType.protocol === FIRMA_ALPHA.protocol &&
      token.tokenType.number === FIRMA_ALPHA.tokenType &&
      !token.isMintBaton
    ) {
      return total + token.atoms
    }
    return total
  }, 0n)
}

const isCompressedPubkey = (pubkey: Uint8Array) =>
  pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)

const hasValidFirmaCovenant = (offer: FirmaPartialOffer) => {
  try {
    const partial = offer.variant.params
    const offeredAtoms = partial.offeredAtoms()
    const minAcceptedAtoms = partial.minAcceptedAtoms()
    const input = offer.txBuilderInput as {
      prevOut?: { txid?: string; outIdx?: number }
      signData?: { redeemScript?: Script }
    }
    const redeemScript = input.signData?.redeemScript

    return (
      isCompressedPubkey(partial.makerPk) &&
      offeredAtoms > 0n &&
      minAcceptedAtoms > 0n &&
      minAcceptedAtoms <= offeredAtoms &&
      offer.askedSats(offeredAtoms) > 0n &&
      input.prevOut?.txid === offer.outpoint.txid &&
      input.prevOut?.outIdx === offer.outpoint.outIdx &&
      redeemScript?.bytecode instanceof Uint8Array &&
      toHex(redeemScript.bytecode) === toHex(partial.script().bytecode)
    )
  } catch {
    return false
  }
}

export function isCanonicalFirmaOffer(offer: AgoraOffer): offer is FirmaPartialOffer {
  if (offer.status !== 'OPEN' || offer.variant.type !== 'PARTIAL') return false

  const partial = offer.variant.params

  return (
    partial.tokenId === FIRMA_ALPHA.tokenId &&
    partial.tokenProtocol === FIRMA_ALPHA.protocol &&
    partial.tokenType === FIRMA_ALPHA.tokenType &&
    offer.token.tokenId === FIRMA_ALPHA.tokenId &&
    offer.token.tokenType.protocol === FIRMA_ALPHA.protocol &&
    offer.token.tokenType.number === FIRMA_ALPHA.tokenType &&
    !offer.token.isMintBaton &&
    offer.token.atoms > 0n &&
    partial.offeredAtoms() === offer.token.atoms &&
    hasValidFirmaCovenant(offer as FirmaPartialOffer)
  )
}

export function compareFirmaOffersByPrice(a: FirmaOfferSummary, b: FirmaOfferSummary): number {
  const left = a.askedSats * b.offeredAtoms
  const right = b.askedSats * a.offeredAtoms
  if (left === right) return a.offerId.localeCompare(b.offerId)
  return left < right ? -1 : 1
}

export type FirmaPurchaseQuote = {
  offer: FirmaPartialOffer
  offerId: string
  offeredAtoms: bigint
  acceptedAtoms: bigint
  askedSats: bigint
}

const quoteFirmaPurchase = (offer: FirmaPartialOffer, requestedAtoms: bigint): FirmaPurchaseQuote => {
  const partial = offer.variant.params
  const offeredAtoms = partial.offeredAtoms()
  const acceptedAtoms = partial.prepareAcceptedAtoms(requestedAtoms)

  if (acceptedAtoms <= 0n || acceptedAtoms > offeredAtoms) {
    throw new Error('Agora no puede representar esta cantidad FIRMA.')
  }
  if (acceptedAtoms < partial.minAcceptedAtoms()) {
    throw new Error('La cantidad está por debajo del mínimo de esta oferta FIRMA.')
  }
  try {
    partial.preventUnacceptableRemainder(acceptedAtoms)
  } catch {
    throw new Error(
      'Esta cantidad dejaría un remainder FIRMA inaceptable en la oferta. Compra menos o acepta la oferta completa.'
    )
  }

  const askedSats = offer.askedSats(acceptedAtoms)
  if (askedSats <= 0n) throw new Error('La oferta FIRMA no produce un precio comprable.')

  return {
    offer,
    offerId: `${offer.outpoint.txid}:${offer.outpoint.outIdx}`,
    offeredAtoms,
    acceptedAtoms,
    askedSats
  }
}

const compareFirmaPurchaseQuotes = (a: FirmaPurchaseQuote, b: FirmaPurchaseQuote): number => {
  const left = a.askedSats * b.acceptedAtoms
  const right = b.askedSats * a.acceptedAtoms
  if (left === right) return a.offerId.localeCompare(b.offerId)
  return left < right ? -1 : 1
}

export function toFirmaOfferSummary(offer: FirmaPartialOffer, ownPubkeyHex?: string): FirmaOfferSummary {
  const partial = offer.variant.params
  const offeredAtoms = partial.offeredAtoms()
  const makerPubkeyHex = toHex(partial.makerPk).toLowerCase()
  const source = makerPubkeyHex === ownPubkeyHex?.toLowerCase()
    ? 'own'
    : FIRMA_ALPHA.officialLiquidityPubkeyHex &&
        makerPubkeyHex === FIRMA_ALPHA.officialLiquidityPubkeyHex.toLowerCase()
      ? 'official'
      : 'peer'
  return {
    offerId: `${offer.outpoint.txid}:${offer.outpoint.outIdx}`,
    offeredAtoms,
    minAcceptedAtoms: partial.minAcceptedAtoms(),
    askedSats: offer.askedSats(offeredAtoms),
    makerPubkeyHex,
    priceNanoSatsPerAtom: partial.priceNanoSatsPerAtom(offeredAtoms),
    source
  }
}

const loadActiveCanonicalFirmaOffers = async () => {
  const tokenInfo = await verifyFirmaAlphaGenesis()

  try {
    const agora = new Agora(getAgoraChronik() as never)
    const activeOffers = await agora.activeOffersByTokenId(FIRMA_ALPHA.tokenId)
    return {
      tokenInfo,
      offers: activeOffers.filter((offer): offer is FirmaPartialOffer => isCanonicalFirmaOffer(offer))
    }
  } catch (error) {
    if (isAgoraPluginUnavailable(error)) throw new FirmaAgoraUnavailableError()
    throw error
  }
}

export async function discoverFirmaOffers(ownPubkeyHex?: string): Promise<FirmaOrderbook> {
  const activeWalletPubkey = ownPubkeyHex ?? xolosWalletService.getX402ActiveAccount()?.publicKey
  const market = await loadActiveCanonicalFirmaOffers()
  const offers = market.offers
    .map((offer) => toFirmaOfferSummary(offer, activeWalletPubkey))
    .sort(compareFirmaOffersByPrice)

  return {
    tokenInfo: market.tokenInfo,
    offers,
    totalLiquidityAtoms: offers.reduce((total, offer) => total + offer.offeredAtoms, 0n)
  }
}

export function selectBestFirmaOffer(offers: AgoraOffer[], desiredAtoms: bigint): FirmaPurchaseQuote {
  if (desiredAtoms <= 0n) throw new Error('La cantidad a comprar debe ser mayor a cero.')

  const canonicalOffers = offers.filter((offer): offer is FirmaPartialOffer => isCanonicalFirmaOffer(offer))
  const candidates: FirmaPurchaseQuote[] = []
  for (const offer of canonicalOffers) {
    if (desiredAtoms > offer.variant.params.offeredAtoms()) continue
    try {
      candidates.push(quoteFirmaPurchase(offer, desiredAtoms))
    } catch {
      // A different canonical offer can still accept the requested amount.
    }
  }
  if (candidates.length === 0) {
    if (!canonicalOffers.some((offer) => offer.variant.params.offeredAtoms() >= desiredAtoms)) {
      throw new Error('No hay suficiente liquidez FIRMA en una sola oferta para esta compra.')
    }
    throw new Error(
      'Ninguna oferta FIRMA puede aceptar esta cantidad sin violar su mínimo, granularidad o remainder permitido.'
    )
  }
  return candidates.sort(compareFirmaPurchaseQuotes)[0]
}

const assertOfferOutputUnspent = (tx: Tx, vout: number) => {
  if (!tx.outputs[vout] || tx.outputs[vout].spentBy) {
    throw new Error('La oferta FIRMA ya fue gastada o modificada. Actualiza el mercado.')
  }
}

const loadCanonicalFirmaOffer = async (offerId: string) => {
  const outpoint = parseOfferId(offerId)
  const tx = await getChronik().tx(outpoint.txid)
  assertOfferOutputUnspent(tx, outpoint.vout)
  const details = parseAgoraOfferFromTx(tx, outpoint.vout, FIRMA_ALPHA.tokenId)

  const offer = new AgoraOffer({
    variant: { type: 'PARTIAL', params: details.agoraPartial },
    outpoint: { txid: outpoint.txid, outIdx: outpoint.vout },
    txBuilderInput: {
      prevOut: { txid: outpoint.txid, outIdx: outpoint.vout },
      signData: {
        sats: details.offerOutput.sats,
        redeemScript: details.agoraPartial.script()
      }
    },
    token: details.token,
    status: 'OPEN'
  })

  if (!isCanonicalFirmaOffer(offer)) {
    throw new Error('La oferta no contiene un covenant FIRMA canónico válido.')
  }

  return { outpoint, details, offer }
}

const formatFirmaEffectivePrice = (askedSats: bigint, acceptedAtoms: bigint): string => {
  if (askedSats <= 0n || acceptedAtoms <= 0n) throw new Error('No se puede calcular el precio efectivo FIRMA.')
  const displayDecimals = 8
  const atomsPerFirma = 10n ** BigInt(FIRMA_ALPHA.decimals)
  const scale = 10n ** BigInt(displayDecimals)
  const numerator = askedSats * atomsPerFirma
  const denominator = acceptedAtoms * 100n
  const rounded = (numerator * scale + denominator / 2n) / denominator
  return formatAtomsToDecimal(rounded, displayDecimals)
}

const buildFirmaBuyPlan = async (
  offerId: string,
  requestedAtoms: bigint
): Promise<{
  preview: FirmaBuyPreview
  account: NonNullable<ReturnType<typeof xolosWalletService.getX402ActiveAccount>>
  details: Awaited<ReturnType<typeof loadCanonicalFirmaOffer>>['details']
  offer: FirmaPartialOffer
  recipientScript: Script
  funding: ScriptUtxo[]
}> => {
  await verifyFirmaAlphaGenesis()
  const account = xolosWalletService.getX402ActiveAccount()
  if (!account) throw new Error('Desbloquea la billetera para preparar la compra.')

  const { details, offer } = await loadCanonicalFirmaOffer(offerId)
  if (requestedAtoms <= 0n || requestedAtoms > details.offeredAtoms) {
    throw new Error('La cantidad FIRMA solicitada no está disponible en esta oferta.')
  }

  const quote = quoteFirmaPurchase(offer, requestedAtoms)
  const { acceptedAtoms, askedSats } = quote

  const recipientScript = Script.fromAddress(account.address)
  const addressUtxos = await getChronik().address(account.address).utxos()
  const xecUtxos = sortXecUtxos(addressUtxos.utxos.filter((utxo) => !utxo.token))
  const funding = getAgoraPartialAcceptFuelInputs(offer, xecUtxos, acceptedAtoms, FIRMA_FEE_PER_KB)
  const dummySignatory = P2PKHSignatory(DUMMY_KEYPAIR.sk, DUMMY_KEYPAIR.pk, ALL_BIP143)
  const dummyInputs = funding.map((utxo) => buildInput(utxo, recipientScript, dummySignatory))
  const networkFeeSats = offer.acceptFeeSats({
    recipientScript,
    extraInputs: dummyInputs,
    acceptedAtoms,
    feePerKb: FIRMA_FEE_PER_KB
  })

  return {
    preview: {
      kind: 'buy',
      offerId,
      requestedAtoms,
      acceptedAtoms,
      askedSats,
      effectivePriceXecPerFirma: formatFirmaEffectivePrice(askedSats, acceptedAtoms),
      networkFeeSats,
      totalSats: askedSats + networkFeeSats,
      payoutAddress: details.payoutAddress,
      adjustedForAgora: acceptedAtoms !== requestedAtoms,
      inputOutpoints: funding.map(outpointKey)
    },
    account,
    details,
    offer,
    recipientScript,
    funding
  }
}

export async function prepareFirmaBuyByOfferId(
  offerId: string,
  requestedAtoms: bigint
): Promise<FirmaBuyPreview> {
  return (await buildFirmaBuyPlan(offerId, requestedAtoms)).preview
}

export async function prepareBestFirmaBuy(amount: string): Promise<FirmaBuyPreview> {
  const requestedAtoms = parseDecimalToAtoms(amount, FIRMA_ALPHA.decimals)
  const market = await loadActiveCanonicalFirmaOffers()
  const bestQuote = selectBestFirmaOffer(market.offers, requestedAtoms)
  return prepareFirmaBuyByOfferId(bestQuote.offerId, requestedAtoms)
}

const sortXecUtxos = (utxos: ScriptUtxo[]) =>
  [...utxos].sort((a, b) => (a.sats === b.sats ? 0 : a.sats > b.sats ? -1 : 1))

const buildInput = (utxo: ScriptUtxo, outputScript: Script, signatory: WalletSignatory['signatory']) => ({
  input: {
    prevOut: utxo.outpoint,
    signData: { sats: utxo.sats, outputScript }
  },
  signatory
})

export async function executeFirmaBuy(preview: FirmaBuyPreview): Promise<string> {
  const freshPlan = await buildFirmaBuyPlan(preview.offerId, preview.requestedAtoms)
  const freshPreview = freshPlan.preview
  if (
    freshPreview.acceptedAtoms !== preview.acceptedAtoms ||
    freshPreview.askedSats !== preview.askedSats ||
    freshPreview.effectivePriceXecPerFirma !== preview.effectivePriceXecPerFirma ||
    freshPreview.networkFeeSats !== preview.networkFeeSats ||
    freshPreview.inputOutpoints.join('|') !== preview.inputOutpoints.join('|')
  ) {
    throw new Error('La oferta FIRMA cambió. Revisa una nueva previsualización antes de firmar.')
  }

  const signer = xolosWalletService.getSignatory()
  if (signer.address !== freshPlan.account.address || signer.publicKeyHex !== freshPlan.account.publicKey) {
    throw new Error('La cuenta activa cambió. Genera otra previsualización.')
  }
  const fuelInputs = freshPlan.funding.map((utxo) =>
    buildInput(utxo, freshPlan.recipientScript, signer.signatory)
  )

  const acceptTx = xolosWalletService.withPrivateKey((privateKey) =>
    freshPlan.offer.acceptTx({
      covenantSk: privateKey,
      covenantPk: signer.publicKey,
      fuelInputs,
      recipientScript: freshPlan.recipientScript,
      acceptedAtoms: preview.acceptedAtoms,
      dustSats: freshPlan.details.offerOutput.sats,
      feePerKb: FIRMA_FEE_PER_KB
    })
  )

  try {
    const broadcast = await getChronik().broadcastTx(acceptTx.ser())
    await xolosWalletService.getBalances()
    return broadcast.txid
  } catch (error) {
    throw toFriendlyBroadcastError(error)
  }
}

const estimateFee = (inputCount: number, outputCount: number): bigint =>
  calcTxFee(TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE, FIRMA_FEE_PER_KB)

const selectTokenUtxos = (utxos: ScriptUtxo[], targetAtoms: bigint) => {
  const sorted = [...utxos].sort((a, b) => {
    const left = a.token?.atoms ?? 0n
    const right = b.token?.atoms ?? 0n
    return left === right ? 0 : left > right ? -1 : 1
  })
  const selected: ScriptUtxo[] = []
  let totalAtoms = 0n
  for (const utxo of sorted) {
    selected.push(utxo)
    totalAtoms += utxo.token?.atoms ?? 0n
    if (totalAtoms >= targetAtoms) return { selected, totalAtoms }
  }
  throw new Error('No hay suficiente FIRMA verificada en la dirección activa.')
}

const selectSaleFunding = (params: {
  xecUtxos: ScriptUtxo[]
  tokenInputSats: bigint
  fixedOutputs: { sats: bigint }[]
  tokenInputsCount: number
}) => {
  const fixedOutputSats = params.fixedOutputs.reduce((total, output) => total + output.sats, 0n)
  const sorted = [...params.xecUtxos].sort((a, b) => (a.sats === b.sats ? 0 : a.sats > b.sats ? -1 : 1))
  const selected: ScriptUtxo[] = []
  let totalInputSats = params.tokenInputSats

  for (const utxo of sorted) {
    selected.push(utxo)
    totalInputSats += utxo.sats
    const inputCount = params.tokenInputsCount + selected.length
    const outputCount = params.fixedOutputs.length
    const feeWithChange = estimateFee(inputCount, outputCount + 1)
    if (totalInputSats - fixedOutputSats - feeWithChange >= TOKEN_DUST_SATS) {
      return { selected, includeChange: true, networkFeeSats: feeWithChange }
    }
    const feeWithoutChange = totalInputSats - fixedOutputSats
    if (feeWithoutChange >= estimateFee(inputCount, outputCount)) {
      return { selected, includeChange: false, networkFeeSats: feeWithoutChange }
    }
  }
  throw new Error('No hay suficiente XEC puro para cubrir dust y comisiones.')
}

const outpointKey = (utxo: ScriptUtxo) => `${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`

const makeSaleFingerprint = (params: {
  partial: AgoraPartial
  offeredAtoms: bigint
  askedSats: bigint
  feeSats: bigint
  inputs: ScriptUtxo[]
}) =>
  [
    params.partial.tokenId,
    toHex(params.partial.adPushdata()),
    params.offeredAtoms.toString(),
    params.askedSats.toString(),
    params.feeSats.toString(),
    ...params.inputs.map(outpointKey)
  ].join('|')

const buildFirmaSalePlan = async (partial: AgoraPartial) => {
  const account = xolosWalletService.getX402ActiveAccount()
  if (!account) throw new Error('Desbloquea la billetera para preparar la oferta.')
  const p2pkhScript = Script.fromAddress(account.address)
  const addressUtxos = (await getChronik().address(account.address).utxos()).utxos
  const offeredAtoms = partial.offeredAtoms()
  const tokenUtxos = addressUtxos.filter(
    (utxo) =>
      utxo.token?.tokenId === FIRMA_ALPHA.tokenId &&
      utxo.token.tokenType.protocol === FIRMA_ALPHA.protocol &&
      utxo.token.tokenType.number === FIRMA_ALPHA.tokenType &&
      !utxo.token.isMintBaton
  )
  const tokenSelection = selectTokenUtxos(tokenUtxos, offeredAtoms)
  const tokenChangeAtoms = tokenSelection.totalAtoms - offeredAtoms
  const sendAmounts = tokenChangeAtoms > 0n ? [offeredAtoms, tokenChangeAtoms] : [offeredAtoms]
  const outputs = buildAlpAgoraListOutputs({
    agoraPartial: partial,
    tokenId: FIRMA_ALPHA.tokenId,
    sendAmounts
  })
  if (tokenChangeAtoms > 0n) outputs.push({ sats: TOKEN_DUST_SATS, script: p2pkhScript })

  const tokenInputSats = tokenSelection.selected.reduce((total, utxo) => total + utxo.sats, 0n)
  const funding = selectSaleFunding({
    xecUtxos: addressUtxos.filter((utxo) => !utxo.token),
    tokenInputSats,
    fixedOutputs: outputs,
    tokenInputsCount: tokenSelection.selected.length
  })
  const inputs = [...tokenSelection.selected, ...funding.selected]
  const askedSats = partial.askedSats(offeredAtoms)
  const planFingerprint = makeSaleFingerprint({
    partial,
    offeredAtoms,
    askedSats,
    feeSats: funding.networkFeeSats,
    inputs
  })

  return {
    account,
    p2pkhScript,
    offeredAtoms,
    askedSats,
    tokenChangeAtoms,
    tokenUtxos: tokenSelection.selected,
    funding,
    outputs,
    inputs,
    planFingerprint
  }
}

const actualPriceXecPerFirma = (askedSats: bigint, offeredAtoms: bigint): string => {
  const atomsPerFirma = 10n ** BigInt(FIRMA_ALPHA.decimals)
  const priceSats = (askedSats * atomsPerFirma) / offeredAtoms
  return formatSatsToXec(priceSats)
}

export async function fetchFirmaBidPrice(): Promise<{ display: string; satsPerFirma: bigint }> {
  let response: Response
  try {
    response = await fetch(FIRMA_BID_PROXY_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    })
  } catch {
    throw new Error(FIRMA_BID_UNAVAILABLE_MESSAGE)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (!response.ok) throw new Error(FIRMA_BID_UNAVAILABLE_MESSAGE)
    throw new Error(FIRMA_BID_INVALID_MESSAGE)
  }

  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body
      ? (body as { code?: unknown }).code
      : undefined
    if (response.status === 504 || code === 'FIRMA_BID_TIMEOUT') {
      throw new Error(FIRMA_BID_TIMEOUT_MESSAGE)
    }
    if (code === 'FIRMA_BID_INVALID_PAYLOAD') {
      throw new Error(FIRMA_BID_INVALID_MESSAGE)
    }
    throw new Error(FIRMA_BID_UNAVAILABLE_MESSAGE)
  }

  if (!body || typeof body !== 'object' || !('bid' in body)) {
    throw new Error(FIRMA_BID_INVALID_MESSAGE)
  }
  const rawBid = (body as { bid?: unknown }).bid
  if ((typeof rawBid !== 'string' && typeof rawBid !== 'number') || String(rawBid).trim() === '') {
    throw new Error(FIRMA_BID_INVALID_MESSAGE)
  }
  const display = String(rawBid).trim()
  let satsPerFirma: bigint
  try {
    satsPerFirma = parseXecToSats(display)
  } catch {
    throw new Error(FIRMA_BID_INVALID_MESSAGE)
  }
  if (satsPerFirma <= 0n) throw new Error(FIRMA_BID_INVALID_MESSAGE)
  return { display: formatSatsToXec(satsPerFirma), satsPerFirma }
}

export async function fetchFirmaRedemptionCapacity(): Promise<bigint> {
  const response = await getChronik().address(FIRMA_ALPHA.redeemAddress).utxos()
  return response.utxos.reduce((total, utxo) => total + utxo.sats, 0n)
}

const assertFirmaCovenantAvailable = async (partial: AgoraPartial) => {
  const scriptHash = toHex(shaRmd160(partial.script().bytecode))
  const response = await getAgoraChronik().script('p2sh', scriptHash).utxos()
  if (response.utxos.length > 0) {
    throw new Error('Ya existe un covenant Agora con estos parámetros. Genera otra previsualización.')
  }
}

export const createFirmaSalePartial = async (params: {
  amount: string
  xecPerFirma?: string
  mode: FirmaSaleMode
  makerPk: Uint8Array
  bidSatsPerFirma?: bigint
}, agora: Pick<Agora, 'selectParams'> = new Agora(getAgoraChronik() as never)) => {
  const requestedAtoms = parseDecimalToAtoms(params.amount, FIRMA_ALPHA.decimals)
  if (requestedAtoms <= 0n) throw new Error('La cantidad FIRMA debe ser mayor a cero.')
  if (params.mode === 'redeem' && requestedAtoms < FIRMA_MIN_REDEEM_ATOMS) {
    throw new Error('La redención mínima es 0.01 FIRMA.')
  }

  const priceSats = params.mode === 'redeem'
    ? params.bidSatsPerFirma
    : parseXecToSats(params.xecPerFirma || '')
  if (!priceSats || priceSats <= 0n) throw new Error('El precio FIRMA debe ser mayor a cero.')

  let priceNanoSatsPerAtom = calcPriceNanoSatsPerAtom({
    xecPerTokenSats: priceSats,
    tokenDecimals: FIRMA_ALPHA.decimals
  })
  const minAcceptedAtoms = params.mode === 'redeem'
    ? requestedAtoms
    : requestedAtoms / 1000n > 0n
      ? requestedAtoms / 1000n
      : requestedAtoms

  const build = () => agora.selectParams({
    offeredAtoms: requestedAtoms,
    priceNanoSatsPerAtom,
    makerPk: params.makerPk,
    minAcceptedAtoms,
    tokenId: FIRMA_ALPHA.tokenId,
    tokenType: ALP_STANDARD,
    tokenProtocol: FIRMA_ALPHA.protocol,
    dustSats: TOKEN_DUST_SATS
  })

  let partial = await build()
  if (params.mode === 'redeem' && params.bidSatsPerFirma) {
    let attempts = 0
    const atomsPerFirma = 10n ** BigInt(FIRMA_ALPHA.decimals)
    while (
      partial.askedSats(partial.offeredAtoms()) * atomsPerFirma >=
        params.bidSatsPerFirma * partial.offeredAtoms() &&
      attempts < MAX_REDEEM_PRICE_ADJUSTMENTS
    ) {
      if (priceNanoSatsPerAtom <= REDEEM_PRICE_STEP_NANOSATS_PER_ATOM) {
        throw new Error('No se pudo representar un precio de redención FIRMA seguro.')
      }
      priceNanoSatsPerAtom -= REDEEM_PRICE_STEP_NANOSATS_PER_ATOM
      partial = await build()
      attempts += 1
    }
    if (attempts >= MAX_REDEEM_PRICE_ADJUSTMENTS) {
      throw new Error('No se pudo ajustar la oferta por debajo del bid FIRMA. Prueba otra cantidad.')
    }
  }

  if (partial.minAcceptedAtoms() > partial.offeredAtoms()) {
    throw new Error('La cantidad FIRMA no se puede representar con un mínimo aceptable.')
  }
  if (params.mode === 'redeem' && partial.minAcceptedAtoms() !== partial.offeredAtoms()) {
    throw new Error('La redención FIRMA debe publicarse como una oferta por el monto completo.')
  }

  return { requestedAtoms, partial, priceNanoSatsPerAtom }
}

export async function prepareFirmaSale(params: {
  amount: string
  xecPerFirma?: string
  mode: FirmaSaleMode
}): Promise<FirmaSalePreview> {
  await verifyFirmaAlphaGenesis()
  const account = xolosWalletService.getX402ActiveAccount()
  if (!account) throw new Error('Desbloquea la billetera para preparar la oferta.')

  const redemption = params.mode === 'redeem'
    ? await Promise.all([fetchFirmaBidPrice(), fetchFirmaRedemptionCapacity()])
    : undefined
  const bid = redemption?.[0]
  const redemptionCapacitySats = redemption?.[1]
  const created = await createFirmaSalePartial({
    ...params,
    makerPk: hexToBytes(account.publicKey),
    bidSatsPerFirma: bid?.satsPerFirma
  })
  const plan = await buildFirmaSalePlan(created.partial)

  if (params.mode === 'redeem' && (redemptionCapacitySats === undefined || redemptionCapacitySats <= plan.askedSats)) {
    throw new Error('La hot wallet FIRMA no tiene capacidad suficiente para esta redención inmediata.')
  }

  return {
    kind: params.mode,
    requestedAtoms: created.requestedAtoms,
    offeredAtoms: plan.offeredAtoms,
    askedSats: plan.askedSats,
    networkFeeSats: plan.funding.networkFeeSats,
    priceNanoSatsPerAtom: created.partial.priceNanoSatsPerAtom(plan.offeredAtoms),
    priceXecPerFirma: actualPriceXecPerFirma(plan.askedSats, plan.offeredAtoms),
    tokenChangeAtoms: plan.tokenChangeAtoms,
    inputOutpoints: plan.inputs.map(outpointKey),
    redemptionCapacitySats,
    bidPriceXec: bid?.display,
    bidSatsPerFirma: bid?.satsPerFirma,
    agoraPartial: created.partial,
    planFingerprint: plan.planFingerprint
  }
}

const hexToBytes = (hex: string) => {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('Clave pública inválida.')
  return Uint8Array.from(hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [])
}

export async function executeFirmaSale(preview: FirmaSalePreview): Promise<{ txid: string; offerId: string }> {
  await verifyFirmaAlphaGenesis()
  const freshPlan = await buildFirmaSalePlan(preview.agoraPartial)
  if (freshPlan.planFingerprint !== preview.planFingerprint) {
    throw new Error('Tus UTXOs cambiaron. Genera otra previsualización antes de firmar.')
  }

  if (preview.kind === 'redeem') {
    if (preview.bidSatsPerFirma === undefined) {
      throw new Error('La previsualización no contiene el bid FIRMA verificable. Genérala nuevamente.')
    }
    const [freshBid, freshCapacitySats] = await Promise.all([
      fetchFirmaBidPrice(),
      fetchFirmaRedemptionCapacity()
    ])
    if (freshBid.satsPerFirma !== preview.bidSatsPerFirma) {
      throw new Error('El bid FIRMA cambió. Genera otra previsualización antes de firmar.')
    }
    if (freshCapacitySats <= freshPlan.askedSats) {
      throw new Error('La capacidad de redención FIRMA cambió y ya no cubre la oferta. Genera otra previsualización.')
    }
  }

  await assertFirmaCovenantAvailable(preview.agoraPartial)

  const signer = xolosWalletService.getSignatory()
  if (signer.address !== freshPlan.account.address || signer.publicKeyHex !== freshPlan.account.publicKey) {
    throw new Error('La cuenta activa cambió. Genera otra previsualización.')
  }
  const signedInputs = [
    ...freshPlan.tokenUtxos.map((utxo) => buildInput(utxo, freshPlan.p2pkhScript, signer.signatory)),
    ...freshPlan.funding.selected.map((utxo) => buildInput(utxo, freshPlan.p2pkhScript, signer.signatory))
  ]
  const outputs = freshPlan.funding.includeChange
    ? [...freshPlan.outputs, freshPlan.p2pkhScript]
    : freshPlan.outputs
  const signedTx = xolosWalletService.signTxBuilder(new TxBuilder({ inputs: signedInputs, outputs }), {
    feePerKb: FIRMA_FEE_PER_KB,
    dustSats: TOKEN_DUST_SATS
  })

  try {
    const broadcast = await getChronik().broadcastTx(signedTx.ser())
    await xolosWalletService.getBalances()
    return { txid: broadcast.txid, offerId: `${broadcast.txid}:1` }
  } catch (error) {
    throw toFriendlyBroadcastError(error)
  }
}

export const formatFirmaAtoms = (atoms: bigint) => formatAtomsToDecimal(atoms, FIRMA_ALPHA.decimals)
