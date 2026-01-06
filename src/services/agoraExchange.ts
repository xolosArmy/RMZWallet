import {
  ALL_BIP143,
  Address,
  EccDummy,
  P2PKHSignatory,
  Script,
  TxBuilder,
  calcTxFee,
  fromHex,
  shaRmd160,
  slpSend
} from 'ecash-lib'
import { Agora, AgoraOffer, AgoraPartial, AgoraPartialAdSignatory } from 'ecash-agora'
import type { ScriptUtxo } from 'chronik-client'
import { getChronik } from './ChronikClient'
import type { XolosWalletService } from './XolosWalletService'
import { XEC_DUST_SATS } from '../config/xecFees'

const SLP_NFT1_CHILD = 65
const SLP_NFT1_GROUP = 129
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10
const NANO_SATS_PER_SAT = 1_000_000_000n

export type AgoraOrder = {
  offerId: string
  tokenId: string
  tokenAtoms: bigint
  priceSats: bigint
  priceXec: string
  makerAddress?: string
  rawOffer?: AgoraOffer
}

export type AgoraAvailability = {
  ok: boolean
  status?: number
  message?: string
  details?: string
  chronikUrl?: string
  endpointPath?: string
}

const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const selectXecUtxos = (params: {
  xecUtxos: ScriptUtxo[]
  tokenInputSats: bigint
  fixedOutputs: { sats: bigint }[]
  tokenInputsCount: number
}): { selected: ScriptUtxo[]; includeChange: boolean } => {
  const fixedOutputSats = params.fixedOutputs.reduce((sum, output) => sum + output.sats, 0n)
  const sorted = [...params.xecUtxos].sort((a, b) => {
    if (a.sats === b.sats) return 0
    return a.sats > b.sats ? -1 : 1
  })

  const selected: ScriptUtxo[] = []
  let totalInputSats = params.tokenInputSats

  for (const utxo of sorted) {
    selected.push(utxo)
    totalInputSats += utxo.sats

    const inputCount = params.tokenInputsCount + selected.length
    const outputsBase = params.fixedOutputs.length
    const feeWithChange = estimateFee(inputCount, outputsBase + 1)
    const feeWithoutChange = estimateFee(inputCount, outputsBase)

    const leftoverWithChange = totalInputSats - fixedOutputSats - feeWithChange
    if (leftoverWithChange >= BigInt(XEC_DUST_SATS)) {
      return { selected, includeChange: true }
    }

    const leftoverWithoutChange = totalInputSats - fixedOutputSats - feeWithoutChange
    if (leftoverWithoutChange >= 0n) {
      return { selected, includeChange: false }
    }
  }

  throw new Error('No hay suficiente XEC para cubrir fees y dust de la oferta.')
}

const selectXecUtxosForTarget = (utxos: ScriptUtxo[], targetSats: bigint): ScriptUtxo[] => {
  const sorted = [...utxos].sort((a, b) => {
    if (a.sats === b.sats) return 0
    return a.sats > b.sats ? -1 : 1
  })
  const selected: ScriptUtxo[] = []
  let total = 0n

  for (const utxo of sorted) {
    selected.push(utxo)
    total += utxo.sats
    if (total >= targetSats) {
      return selected
    }
  }

  throw new Error('No hay suficiente XEC para cubrir la compra.')
}

const buildInput = (utxo: ScriptUtxo, outputScript: Script, signatory: ReturnType<typeof P2PKHSignatory>) => {
  return {
    input: {
      prevOut: utxo.outpoint,
      signData: {
        sats: utxo.sats,
        outputScript
      }
    },
    signatory
  }
}

// Basado en Cashtab: getAgoraAdFuelSats para calcular el funding del ad setup SLP.
const getAgoraAdFuelSats = (redeemScript: Script, signatory: unknown, offerOutputs: { sats: bigint; script: Script }[]) => {
  const dummyOfferTx = new TxBuilder({
    inputs: [
      {
        input: {
          prevOut: {
            txid: '1111111111111111111111111111111111111111111111111111111111111111',
            outIdx: 1
          },
          signData: {
            sats: 100000n,
            redeemScript
          }
        },
        signatory: signatory as never
      }
    ],
    outputs: offerOutputs
  })
  const measureTx = dummyOfferTx.sign({ ecc: new EccDummy() })
  return BigInt(Math.ceil((measureTx.serSize() * Number(FEE_PER_KB)) / 1000))
}

let agoraInstance: Agora | null = null
const getAgora = () => {
  if (!agoraInstance) {
    agoraInstance = new Agora(getChronik(), BigInt(XEC_DUST_SATS))
  }
  return agoraInstance
}

const CHRONIK_AGORA_ENDPOINT = '/plugin/agora/groups'

const truncateDetails = (value: string, max = 200) => {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}

const getChronikDiagnostics = () => {
  const chronik = getChronik()
  const proxy = chronik.proxyInterface()
  const endpoints = proxy.getEndpointArray()
  const workingIndex = (proxy as { _workingIndex?: number })._workingIndex ?? 0
  const fallbackIndex = Math.min(Math.max(workingIndex, 0), endpoints.length - 1)
  const chronikUrl = endpoints[fallbackIndex]?.url || endpoints[0]?.url || ''
  return { chronikUrl, endpointPath: CHRONIK_AGORA_ENDPOINT }
}

export const checkAgoraAvailability = async (): Promise<AgoraAvailability> => {
  const { chronikUrl, endpointPath } = getChronikDiagnostics()
  const targetUrl = chronikUrl ? `${chronikUrl}${endpointPath}` : endpointPath

  try {
    const response = await fetch(targetUrl, { method: 'GET' })
    const bodyText = truncateDetails(await response.text())
    if (response.ok) {
      return { ok: true, status: response.status, chronikUrl, endpointPath }
    }
    return {
      ok: false,
      status: response.status,
      message: 'El plugin Agora no está disponible en este nodo.',
      details: bodyText || 'Respuesta vacía del servidor.',
      chronikUrl,
      endpointPath
    }
  } catch (err) {
    const message = (err as Error).message || 'No pudimos verificar el plugin Agora en este nodo.'
    const stack = (err as Error).stack || message
    return {
      ok: false,
      message,
      details: truncateDetails(stack),
      chronikUrl,
      endpointPath
    }
  }
}

const formatSatsToXec = (sats: bigint) => {
  const whole = sats / 100n
  const fraction = (sats % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${fraction}`
}

const parseOfferId = (offerId: string): { txid: string; vout: number } => {
  const trimmed = offerId.trim()
  if (!trimmed) {
    throw new Error('Ingresa un Offer ID válido.')
  }
  const parts = trimmed.split(':')
  if (parts.length !== 2) {
    throw new Error('Usa el formato txid:vout.')
  }
  const txid = parts[0].toLowerCase()
  const vout = Number(parts[1])
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error('El txid no es válido.')
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('El vout debe ser un entero mayor o igual a 0.')
  }
  return { txid, vout }
}

const fetchAgoraOffersForTokenId = async (tokenId: string): Promise<AgoraOffer[]> => {
  const chronik = getChronik()
  const tokenInfo = await chronik.token(tokenId)
  if (tokenInfo?.tokenType?.protocol !== 'SLP') {
    return getAgora().activeOffersByTokenId(tokenId)
  }
  if (tokenInfo.tokenType.number === SLP_NFT1_GROUP) {
    return getAgora().activeOffersByGroupTokenId(tokenId)
  }
  return getAgora().activeOffersByTokenId(tokenId)
}

export const fetchOrderbookByTokenId = async (tokenId: string): Promise<AgoraOrder[]> => {
  const availability = await checkAgoraAvailability()
  if (!availability.ok) {
    throw new Error(availability.message || 'El plugin Agora no está disponible.')
  }

  const offers = await fetchAgoraOffersForTokenId(tokenId)
  return offers.map((offer) => {
    const tokenAtoms = offer.token.atoms
    const priceSats = offer.askedSats(tokenAtoms)
    const makerAddress =
      offer.variant.type === 'PARTIAL'
        ? Address.p2pkh(shaRmd160(offer.variant.params.makerPk)).toString()
        : undefined
    return {
      offerId: `${offer.outpoint.txid}:${offer.outpoint.outIdx}`,
      tokenId: offer.token.tokenId,
      tokenAtoms,
      priceSats,
      priceXec: formatSatsToXec(priceSats),
      makerAddress,
      rawOffer: offer
    }
  })
}

const selectTokenUtxo = (params: {
  utxos: ScriptUtxo[]
  tokenId: string
  tokenProtocol: string
  tokenType: number
  tokenAmount: bigint
}): ScriptUtxo => {
  const sorted = params.utxos
    .filter(
      (utxo) =>
        utxo.token &&
        utxo.token.tokenId === params.tokenId &&
        utxo.token.tokenType.protocol === params.tokenProtocol &&
        utxo.token.tokenType.number === params.tokenType &&
        !utxo.token.isMintBaton
    )
    .sort((a, b) => {
      const aAtoms = a.token?.atoms ?? 0n
      const bAtoms = b.token?.atoms ?? 0n
      if (aAtoms === bAtoms) return 0
      return aAtoms > bAtoms ? 1 : -1
    })

  const selected = sorted.find((utxo) => (utxo.token?.atoms ?? 0n) >= params.tokenAmount)
  if (!selected) {
    throw new Error('No encontramos este token en tu billetera.')
  }
  return selected
}

const createSellOfferInternal = async (params: {
  tokenId: string
  tokenAtoms: bigint
  askXecSats: bigint
  payoutAddress: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
}): Promise<{ offerTxid: string; adTxid: string; offerId: string }> => {
  const makerScript = Script.fromAddress(Address.parse(params.payoutAddress).cash().toString())
  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)

  const chronik = getChronik()
  const utxos = await chronik.address(params.payoutAddress).utxos()
  const tokenInfo = await chronik.token(params.tokenId)
  const tokenProtocol = tokenInfo?.tokenType?.protocol ?? 'SLP'
  const tokenType = tokenInfo?.tokenType?.number ?? SLP_NFT1_CHILD
  if (tokenProtocol !== 'SLP') {
    throw new Error('Este flujo solo soporta tokens SLP.')
  }
  const tokenUtxo = selectTokenUtxo({
    utxos: utxos.utxos,
    tokenId: params.tokenId,
    tokenProtocol,
    tokenType,
    tokenAmount: params.tokenAtoms
  })
  const tokenAtoms = tokenUtxo.token?.atoms ?? 0n
  if (tokenAtoms < params.tokenAtoms) {
    throw new Error('No encontramos suficientes tokens para listar esta oferta.')
  }
  const offeredAtoms = params.tokenAtoms
  const priceNanoSatsPerAtom = (params.askXecSats * NANO_SATS_PER_SAT) / offeredAtoms

  const agoraPartial = AgoraPartial.approximateParams({
    offeredAtoms,
    priceNanoSatsPerAtom,
    makerPk: fromHex(params.keyInfo.publicKeyHex),
    minAcceptedAtoms: offeredAtoms,
    tokenId: params.tokenId,
    tokenType,
    tokenProtocol: 'SLP',
    enforcedLockTime: Math.floor(Date.now() / 1000),
    dustSats: BigInt(XEC_DUST_SATS)
  })
  const actualOfferedAtoms = agoraPartial.offeredAtoms()
  if (actualOfferedAtoms > offeredAtoms) {
    throw new Error('No se pudo preparar la oferta con los tokens disponibles.')
  }
  const changeAtoms = tokenAtoms - actualOfferedAtoms

  const agoraAdScript = new Script(agoraPartial.adScript().bytecode)
  const agoraAdP2sh = Script.p2sh(shaRmd160(agoraAdScript.bytecode))

  const offerScript = new Script(agoraPartial.script().bytecode)
  const offerP2sh = Script.p2sh(shaRmd160(offerScript.bytecode))

  const offerOutputs = [
    { sats: 0n, script: slpSend(params.tokenId, tokenType, [actualOfferedAtoms]) },
    { sats: BigInt(XEC_DUST_SATS), script: offerP2sh }
  ]

  const offerTxFuelSats = getAgoraAdFuelSats(
    agoraAdScript,
    AgoraPartialAdSignatory(fromHex(params.keyInfo.privateKeyHex)),
    offerOutputs
  )

  const adFuelOutputSats = BigInt(XEC_DUST_SATS) + offerTxFuelSats

  const adSendAmounts = changeAtoms > 0n ? [actualOfferedAtoms, changeAtoms] : [actualOfferedAtoms]
  const adSetupOutputs = [
    { sats: 0n, script: slpSend(params.tokenId, tokenType, adSendAmounts) },
    { sats: adFuelOutputSats, script: agoraAdP2sh }
  ]
  if (changeAtoms > 0n) {
    adSetupOutputs.push({ sats: BigInt(XEC_DUST_SATS), script: makerScript })
  }

  const xecUtxos = utxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: tokenUtxo.sats,
    fixedOutputs: adSetupOutputs,
    tokenInputsCount: 1
  })

  const adSetupInputs = [
    buildInput(tokenUtxo, makerScript, signer),
    ...funding.selected.map((utxo) => buildInput(utxo, makerScript, signer))
  ]
  const adSetupFinalOutputs = funding.includeChange ? [...adSetupOutputs, makerScript] : adSetupOutputs

  const adSetupTx = new TxBuilder({
    inputs: adSetupInputs,
    outputs: adSetupFinalOutputs
  }).sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })

  const adBroadcast = await chronik.broadcastTx(adSetupTx.ser())

  const offerInputs = [
    {
      input: {
        prevOut: {
          txid: adBroadcast.txid,
          outIdx: 1
        },
        signData: {
          sats: adFuelOutputSats,
          redeemScript: agoraAdScript
        }
      },
      signatory: AgoraPartialAdSignatory(fromHex(params.keyInfo.privateKeyHex)) as never
    }
  ]

  const offerTx = new TxBuilder({
    inputs: offerInputs,
    outputs: offerOutputs
  }).sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })

  const offerBroadcast = await chronik.broadcastTx(offerTx.ser())

  return {
    offerTxid: offerBroadcast.txid,
    adTxid: adBroadcast.txid,
    offerId: `${offerBroadcast.txid}:1`
  }
}

export const createSellOfferForTokenId = async (params: {
  tokenId: string
  tokenAtoms: bigint
  askXecSats: bigint
  payoutAddress: string
  wallet: XolosWalletService
}): Promise<{ txid: string; offerId: string }> => {
  const availability = await checkAgoraAvailability()
  if (!availability.ok) {
    throw new Error(availability.message || 'El plugin Agora no está disponible.')
  }

  const walletKeyInfo = params.wallet.getKeyInfo()
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }
  const result = await createSellOfferInternal({
    tokenId: params.tokenId,
    tokenAtoms: params.tokenAtoms,
    askXecSats: params.askXecSats,
    payoutAddress: params.payoutAddress,
    keyInfo: {
      privateKeyHex: walletKeyInfo.privateKeyHex,
      publicKeyHex: walletKeyInfo.publicKeyHex
    }
  })
  return { txid: result.offerTxid, offerId: result.offerId }
}

export const acceptOfferByOfferId = async (params: {
  offerId: string
  tokenId: string
  wallet: XolosWalletService
}): Promise<{ txid: string }> => {
  const availability = await checkAgoraAvailability()
  if (!availability.ok) {
    throw new Error(availability.message || 'El plugin Agora no está disponible.')
  }

  const outpoint = parseOfferId(params.offerId)
  const chronik = getChronik()
  await chronik.tx(outpoint.txid)

  const offers = await fetchAgoraOffersForTokenId(params.tokenId)
  const offer = offers.find((candidate) => candidate.outpoint.txid === outpoint.txid && candidate.outpoint.outIdx === outpoint.vout)
  if (!offer) {
    throw new Error('No encontramos esta oferta activa para el token seleccionado.')
  }

  const walletKeyInfo = params.wallet.getKeyInfo()
  const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }
  const recipientScript = Script.fromAddress(Address.parse(xecAddress).cash().toString())

  const acceptedAtoms = offer.token.atoms
  const askedSats = offer.askedSats(acceptedAtoms)
  const feeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
  const totalNeeded = askedSats + feeSats

  const addressUtxos = await chronik.address(xecAddress).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

  const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer))

  const acceptTx = offer.acceptTx({
    covenantSk: fromHex(walletKeyInfo.privateKeyHex),
    covenantPk: fromHex(walletKeyInfo.publicKeyHex),
    fuelInputs,
    recipientScript,
    acceptedAtoms,
    dustSats: BigInt(XEC_DUST_SATS),
    feePerKb: FEE_PER_KB
  })

  const broadcast = await chronik.broadcastTx(acceptTx.ser())
  return { txid: broadcast.txid }
}

// Compatibilidad con el flujo actual basado en tokenId.
export const createSellTokenOffer = async (params: {
  tokenId: string
  receiveXecSats: bigint
  makerAddress: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
  tokenType?: number
  tokenAmount?: bigint
}): Promise<{ offerTxid: string; adTxid: string }> => {
  void params.tokenType
  const tokenAtoms = params.tokenAmount ?? 1n
  const result = await createSellOfferInternal({
    tokenId: params.tokenId,
    tokenAtoms,
    askXecSats: params.receiveXecSats,
    payoutAddress: params.makerAddress,
    keyInfo: params.keyInfo
  })
  return { offerTxid: result.offerTxid, adTxid: result.adTxid }
}

export const acceptTokenOffer = async (params: {
  offer: AgoraOffer
  recipientAddress: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
}): Promise<{ txid: string }> => {
  const recipientScript = Script.fromAddress(Address.parse(params.recipientAddress).cash().toString())
  const chronik = getChronik()

  const acceptedAtoms = params.offer.token.atoms
  const askedSats = params.offer.askedSats(acceptedAtoms)
  const feeSats = params.offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
  const totalNeeded = askedSats + feeSats

  const addressUtxos = await chronik.address(params.recipientAddress).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)
  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer))

  const acceptTx = params.offer.acceptTx({
    covenantSk: fromHex(params.keyInfo.privateKeyHex),
    covenantPk: fromHex(params.keyInfo.publicKeyHex),
    fuelInputs,
    recipientScript,
    acceptedAtoms,
    dustSats: BigInt(XEC_DUST_SATS),
    feePerKb: FEE_PER_KB
  })

  const broadcast = await chronik.broadcastTx(acceptTx.ser())
  return { txid: broadcast.txid }
}
