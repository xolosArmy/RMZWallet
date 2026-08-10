import type { ScriptUtxo, TokenInfo, Tx } from 'chronik-client'
import { Agora, AgoraOffer, AgoraPartial } from 'ecash-agora'
import { ALP_STANDARD, Script, TxBuilder, calcTxFee, toHex } from 'ecash-lib'
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
  source: 'official' | 'own'
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

export function isCanonicalFirmaOffer(offer: AgoraOffer, ownPubkeyHex?: string): offer is FirmaPartialOffer {
  if (offer.status !== 'OPEN' || offer.variant.type !== 'PARTIAL') return false

  const partial = offer.variant.params
  const makerPubkeyHex = toHex(partial.makerPk).toLowerCase()
  const makerAllowed = makerPubkeyHex === FIRMA_ALPHA.makerPubkeyHex || makerPubkeyHex === ownPubkeyHex?.toLowerCase()

  return (
    makerAllowed &&
    partial.tokenId === FIRMA_ALPHA.tokenId &&
    partial.tokenProtocol === FIRMA_ALPHA.protocol &&
    partial.tokenType === FIRMA_ALPHA.tokenType &&
    offer.token.tokenId === FIRMA_ALPHA.tokenId &&
    offer.token.tokenType.protocol === FIRMA_ALPHA.protocol &&
    offer.token.tokenType.number === FIRMA_ALPHA.tokenType &&
    !offer.token.isMintBaton &&
    offer.token.atoms > 0n &&
    partial.offeredAtoms() === offer.token.atoms
  )
}

export function compareFirmaOffersByPrice(a: FirmaOfferSummary, b: FirmaOfferSummary): number {
  const left = a.askedSats * b.offeredAtoms
  const right = b.askedSats * a.offeredAtoms
  if (left === right) return a.offerId.localeCompare(b.offerId)
  return left < right ? -1 : 1
}

export function toFirmaOfferSummary(offer: FirmaPartialOffer): FirmaOfferSummary {
  const partial = offer.variant.params
  const offeredAtoms = partial.offeredAtoms()
  const makerPubkeyHex = toHex(partial.makerPk).toLowerCase()
  return {
    offerId: `${offer.outpoint.txid}:${offer.outpoint.outIdx}`,
    offeredAtoms,
    minAcceptedAtoms: partial.minAcceptedAtoms(),
    askedSats: offer.askedSats(offeredAtoms),
    makerPubkeyHex,
    priceNanoSatsPerAtom: partial.priceNanoSatsPerAtom(offeredAtoms),
    source: makerPubkeyHex === FIRMA_ALPHA.makerPubkeyHex ? 'official' : 'own'
  }
}

export async function discoverFirmaOffers(ownPubkeyHex?: string): Promise<FirmaOrderbook> {
  const tokenInfo = await verifyFirmaAlphaGenesis()
  const activeWalletPubkey = ownPubkeyHex ?? xolosWalletService.getX402ActiveAccount()?.publicKey

  try {
    const agora = new Agora(getAgoraChronik() as never)
    const activeOffers = await agora.activeOffersByTokenId(FIRMA_ALPHA.tokenId)
    const offers = activeOffers
      .filter((offer): offer is FirmaPartialOffer => isCanonicalFirmaOffer(offer, activeWalletPubkey))
      .map(toFirmaOfferSummary)
      .sort(compareFirmaOffersByPrice)

    return {
      tokenInfo,
      offers,
      totalLiquidityAtoms: offers
        .filter((offer) => offer.source === 'official')
        .reduce((total, offer) => total + offer.offeredAtoms, 0n)
    }
  } catch (error) {
    if (isAgoraPluginUnavailable(error)) throw new FirmaAgoraUnavailableError()
    throw error
  }
}

export function selectBestFirmaOffer(offers: FirmaOfferSummary[], desiredAtoms: bigint): FirmaOfferSummary {
  if (desiredAtoms <= 0n) throw new Error('La cantidad a comprar debe ser mayor a cero.')

  const candidates = offers.filter(
    (offer) => desiredAtoms <= offer.offeredAtoms && desiredAtoms >= offer.minAcceptedAtoms
  )
  if (candidates.length === 0) {
    if (!offers.some((offer) => offer.offeredAtoms >= desiredAtoms)) {
      throw new Error('No hay suficiente liquidez FIRMA en una sola oferta para esta compra.')
    }
    throw new Error('La cantidad no cumple el mínimo de las ofertas FIRMA disponibles.')
  }
  return [...candidates].sort(compareFirmaOffersByPrice)[0]
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

  if (
    details.agoraPartial.tokenProtocol !== FIRMA_ALPHA.protocol ||
    details.agoraPartial.tokenType !== FIRMA_ALPHA.tokenType ||
    toHex(details.agoraPartial.makerPk).toLowerCase() !== FIRMA_ALPHA.makerPubkeyHex
  ) {
    throw new Error('La oferta no pertenece al minter oficial de Firma Alpha.')
  }

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

  return { outpoint, details, offer }
}

export async function prepareFirmaBuyByOfferId(
  offerId: string,
  requestedAtoms: bigint
): Promise<FirmaBuyPreview> {
  await verifyFirmaAlphaGenesis()
  const account = xolosWalletService.getX402ActiveAccount()
  if (!account) throw new Error('Desbloquea la billetera para preparar la compra.')

  const { details, offer } = await loadCanonicalFirmaOffer(offerId)
  if (requestedAtoms <= 0n || requestedAtoms > details.offeredAtoms) {
    throw new Error('La cantidad FIRMA solicitada no está disponible en esta oferta.')
  }

  const acceptedAtoms = details.agoraPartial.prepareAcceptedAtoms(requestedAtoms)
  if (acceptedAtoms <= 0n || acceptedAtoms > details.offeredAtoms) {
    throw new Error('Agora no puede representar esta cantidad FIRMA.')
  }
  if (acceptedAtoms < details.agoraPartial.minAcceptedAtoms()) {
    throw new Error('La cantidad está por debajo del mínimo de esta oferta FIRMA.')
  }

  const recipientScript = Script.fromAddress(account.address)
  const askedSats = offer.askedSats(acceptedAtoms)
  const signer = xolosWalletService.getSignatory()
  const addressUtxos = await getChronik().address(account.address).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  let networkFeeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FIRMA_FEE_PER_KB })
  let funding: ScriptUtxo[] = []

  for (let attempt = 0; attempt < 5; attempt += 1) {
    funding = selectXecUtxosForTarget(xecUtxos, askedSats + networkFeeSats)
    const extraInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer.signatory))
    const nextFee = offer.acceptFeeSats({
      recipientScript,
      extraInputs,
      acceptedAtoms,
      feePerKb: FIRMA_FEE_PER_KB
    })
    if (nextFee === networkFeeSats) break
    networkFeeSats = nextFee
  }
  funding = selectXecUtxosForTarget(xecUtxos, askedSats + networkFeeSats)

  return {
    kind: 'buy',
    offerId,
    requestedAtoms,
    acceptedAtoms,
    askedSats,
    networkFeeSats,
    totalSats: askedSats + networkFeeSats,
    payoutAddress: details.payoutAddress,
    adjustedForAgora: acceptedAtoms !== requestedAtoms,
    inputOutpoints: funding.map(outpointKey)
  }
}

export async function prepareBestFirmaBuy(amount: string): Promise<FirmaBuyPreview> {
  const requestedAtoms = parseDecimalToAtoms(amount, FIRMA_ALPHA.decimals)
  const account = xolosWalletService.getX402ActiveAccount()
  const orderbook = await discoverFirmaOffers(account?.publicKey)
  const bestOffer = selectBestFirmaOffer(
    orderbook.offers.filter((offer) => offer.source === 'official'),
    requestedAtoms
  )
  return prepareFirmaBuyByOfferId(bestOffer.offerId, requestedAtoms)
}

const selectXecUtxosForTarget = (utxos: ScriptUtxo[], targetSats: bigint): ScriptUtxo[] => {
  const sorted = [...utxos].sort((a, b) => (a.sats === b.sats ? 0 : a.sats > b.sats ? -1 : 1))
  const selected: ScriptUtxo[] = []
  let total = 0n
  for (const utxo of sorted) {
    selected.push(utxo)
    total += utxo.sats
    if (total >= targetSats) return selected
  }
  throw new Error('No hay suficiente XEC para el precio y la comisión de red.')
}

const buildInput = (utxo: ScriptUtxo, outputScript: Script, signatory: WalletSignatory['signatory']) => ({
  input: {
    prevOut: utxo.outpoint,
    signData: { sats: utxo.sats, outputScript }
  },
  signatory
})

export async function executeFirmaBuy(preview: FirmaBuyPreview): Promise<string> {
  const freshPreview = await prepareFirmaBuyByOfferId(preview.offerId, preview.requestedAtoms)
  if (
    freshPreview.acceptedAtoms !== preview.acceptedAtoms ||
    freshPreview.askedSats !== preview.askedSats ||
    freshPreview.networkFeeSats !== preview.networkFeeSats ||
    freshPreview.inputOutpoints.join('|') !== preview.inputOutpoints.join('|')
  ) {
    throw new Error('La oferta FIRMA cambió. Revisa una nueva previsualización antes de firmar.')
  }

  const signer = xolosWalletService.getSignatory()
  const recipientScript = Script.fromAddress(signer.address)
  const { details, offer } = await loadCanonicalFirmaOffer(preview.offerId)
  const addressUtxos = await getChronik().address(signer.address).utxos()
  const fuelUtxos = selectXecUtxosForTarget(
    addressUtxos.utxos.filter((utxo) => !utxo.token),
    preview.totalSats
  )
  if (fuelUtxos.map(outpointKey).join('|') !== preview.inputOutpoints.join('|')) {
    throw new Error('Tus UTXOs XEC cambiaron. Genera otra previsualización antes de firmar.')
  }
  const fuelInputs = fuelUtxos.map((utxo) => buildInput(utxo, recipientScript, signer.signatory))

  const acceptTx = xolosWalletService.withPrivateKey((privateKey) =>
    offer.acceptTx({
      covenantSk: privateKey,
      covenantPk: signer.publicKey,
      fuelInputs,
      recipientScript,
      acceptedAtoms: preview.acceptedAtoms,
      dustSats: details.offerOutput.sats,
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
  const response = await fetch(FIRMA_ALPHA.bidApiUrl, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Firma bid API respondió HTTP ${response.status}.`)
  const body = (await response.json()) as { bid?: string | number }
  const display = String(body.bid ?? '')
  const satsPerFirma = parseXecToSats(display)
  if (satsPerFirma <= 0n) throw new Error('Firma bid API devolvió un precio inválido.')
  return { display: formatSatsToXec(satsPerFirma), satsPerFirma }
}

export async function fetchFirmaRedemptionCapacity(): Promise<bigint> {
  const response = await getChronik().address(FIRMA_ALPHA.redeemAddress).utxos()
  return response.utxos.reduce((total, utxo) => total + utxo.sats, 0n)
}

export const createFirmaSalePartial = (params: {
  amount: string
  xecPerFirma?: string
  mode: FirmaSaleMode
  makerPk: Uint8Array
  bidSatsPerFirma?: bigint
}) => {
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

  const build = () => AgoraPartial.approximateParams({
    offeredAtoms: requestedAtoms,
    priceNanoSatsPerAtom,
    makerPk: params.makerPk,
    minAcceptedAtoms,
    tokenId: FIRMA_ALPHA.tokenId,
    tokenType: ALP_STANDARD,
    tokenProtocol: FIRMA_ALPHA.protocol,
    enforcedLockTime: Math.floor(Date.now() / 1000),
    dustSats: TOKEN_DUST_SATS
  })

  let partial = build()
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
      partial = build()
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
  const created = createFirmaSalePartial({
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
