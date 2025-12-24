import { AgoraPartial, AGORA_LOKAD_ID } from 'ecash-agora'
import {
  Address,
  Script,
  alpSend,
  bytesToStr,
  emppScript,
  fromHex,
  parseAlp,
  parseEmppScript,
  shaRmd160
} from 'ecash-lib'
import type { AlpSend, TxOutput as EcashTxOutput } from 'ecash-lib'
import type { Token, Tx, TxOutput as ChronikTxOutput } from 'chronik-client'

const NANO_SATS_PER_SAT = 1_000_000_000n
const XEC_DECIMALS = 2
const U64_SIZE = 8
const U32_SIZE = 4

export const TOKEN_DUST_SATS = 546n

export interface OfferOutpoint {
  txid: string
  vout: number
}

export interface ParsedAgoraOffer {
  agoraPartial: AgoraPartial
  offeredAtoms: bigint
  payoutAddress: string
  askedSats: bigint
  priceNanoSatsPerAtom: bigint
  token: Token
  offerOutput: ChronikTxOutput
  warning?: string
}

interface ParsedAgoraAd {
  numAtomsTruncBytes: number
  numSatsTruncBytes: number
  atomsScaleFactor: bigint
  scaledTruncAtomsPerTruncSat: bigint
  minAcceptedScaledTruncAtoms: bigint
  enforcedLockTime: number
  makerPk: Uint8Array
}

export function parseOfferId(input: string): OfferOutpoint {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Ingresa un Offer ID válido.')
  }

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { txid?: string; vout?: number }
    if (!parsed.txid || parsed.vout === undefined) {
      throw new Error('El JSON debe incluir txid y vout.')
    }
    return normalizeOutpoint(parsed.txid, parsed.vout)
  }

  const parts = trimmed.split(':')
  if (parts.length !== 2) {
    throw new Error('Usa el formato txid:vout.')
  }
  const vout = Number(parts[1])
  return normalizeOutpoint(parts[0], vout)
}

export function buildAlpAgoraListOutputs(params: {
  agoraPartial: AgoraPartial
  tokenId: string
  sendAmounts: bigint[]
}): EcashTxOutput[] {
  const alpPushdata = alpSend(params.tokenId, params.agoraPartial.tokenType, params.sendAmounts)
  const opReturnScript = emppScript([params.agoraPartial.adPushdata(), alpPushdata])
  const offerScript = params.agoraPartial.script()
  const offerVaultScript = Script.p2sh(shaRmd160(offerScript.bytecode))

  return [
    { sats: 0n, script: opReturnScript },
    { sats: params.agoraPartial.dustSats, script: offerVaultScript }
  ]
}

export function parseAgoraOfferFromTx(tx: Tx, offerVout: number, tokenId: string): ParsedAgoraOffer {
  const offerOutput = tx.outputs[offerVout]
  if (!offerOutput) {
    throw new Error('El Offer ID no apunta a un output válido.')
  }

  const offerScript = new Script(fromHex(offerOutput.outputScript))
  if (!offerScript.isP2sh()) {
    throw new Error('El Offer ID no apunta a un P2SH válido.')
  }

  if (offerOutput.sats < TOKEN_DUST_SATS) {
    throw new Error('El output de la oferta no tiene dust suficiente.')
  }

  const opReturnOutput = tx.outputs[0]
  if (!opReturnOutput) {
    throw new Error('La transacción no tiene OP_RETURN con los datos de la oferta.')
  }

  const emppPushes = parseEmppScript(new Script(fromHex(opReturnOutput.outputScript)))
  if (!emppPushes) {
    throw new Error('El OP_RETURN no contiene un eMPP válido.')
  }

  let alpSendData: AlpSend | undefined
  let agoraAd: ParsedAgoraAd | undefined

  for (const pushdata of emppPushes) {
    const alp = parseAlp(pushdata)
    if (alp && alp.txType === 'SEND') {
      alpSendData = alp
      continue
    }
    const parsedAd = parseAgoraPartialAd(pushdata)
    if (parsedAd) {
      agoraAd = parsedAd
    }
  }

  if (!alpSendData) {
    throw new Error('El OP_RETURN no contiene un ALP SEND válido.')
  }
  if (alpSendData.tokenId !== tokenId) {
    throw new Error('La oferta no corresponde al token RMZ.')
  }
  if (!agoraAd) {
    throw new Error('El OP_RETURN no contiene la publicidad Agora esperada.')
  }

  const offeredAtoms = alpSendData.sendAtomsArray[0]
  if (!offeredAtoms || offeredAtoms <= 0n) {
    throw new Error('La oferta no contiene tokens disponibles.')
  }

  const truncBits = BigInt(8 * agoraAd.numAtomsTruncBytes)
  const truncAtoms = offeredAtoms >> truncBits
  if (truncAtoms << truncBits !== offeredAtoms) {
    throw new Error('La oferta tiene una granularidad de tokens inesperada.')
  }

  const agoraPartial = new AgoraPartial({
    truncAtoms,
    numAtomsTruncBytes: agoraAd.numAtomsTruncBytes,
    atomsScaleFactor: agoraAd.atomsScaleFactor,
    scaledTruncAtomsPerTruncSat: agoraAd.scaledTruncAtomsPerTruncSat,
    numSatsTruncBytes: agoraAd.numSatsTruncBytes,
    makerPk: agoraAd.makerPk,
    minAcceptedScaledTruncAtoms: agoraAd.minAcceptedScaledTruncAtoms,
    tokenId,
    tokenType: alpSendData.tokenType,
    tokenProtocol: 'ALP',
    scriptLen: 0,
    enforcedLockTime: agoraAd.enforcedLockTime,
    dustSats: offerOutput.sats
  })
  agoraPartial.updateScriptLen()

  const payoutAddress = Address.p2pkh(shaRmd160(agoraAd.makerPk)).toString()
  const preparedAtoms = agoraPartial.prepareAcceptedAtoms(offeredAtoms)
  const askedSats = agoraPartial.askedSats(preparedAtoms)
  const priceNanoSatsPerAtom = agoraPartial.priceNanoSatsPerAtom(preparedAtoms)

  if (!offerOutput.token) {
    throw new Error('Chronik no pudo validar el token de esta oferta.')
  }

  return {
    agoraPartial,
    offeredAtoms,
    payoutAddress,
    askedSats,
    priceNanoSatsPerAtom,
    token: offerOutput.token,
    offerOutput
  }
}

export function parseDecimalToAtoms(value: string, decimals: number): bigint {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Ingresa un monto válido.')
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('El monto debe ser numérico.')
  }

  const [whole, fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals) {
    throw new Error(`Máximo ${decimals} decimales permitidos.`)
  }

  const paddedFraction = fraction.padEnd(decimals, '0')
  const atoms = BigInt(whole) * pow10(decimals) + BigInt(paddedFraction || '0')
  return atoms
}

export function formatAtomsToDecimal(atoms: bigint, decimals: number): string {
  const base = pow10(decimals)
  const whole = atoms / base
  const fraction = atoms % base
  if (decimals === 0) {
    return whole.toString()
  }
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fractionStr ? `${whole}.${fractionStr}` : whole.toString()
}

export function parseXecToSats(value: string): bigint {
  return parseDecimalToAtoms(value, XEC_DECIMALS)
}

export function formatSatsToXec(sats: bigint): string {
  return formatAtomsToDecimal(sats, XEC_DECIMALS)
}

export function calcPriceNanoSatsPerAtom(params: {
  xecPerTokenSats: bigint
  tokenDecimals: number
}): bigint {
  const atomsPerToken = pow10(params.tokenDecimals)
  return (params.xecPerTokenSats * NANO_SATS_PER_SAT) / atomsPerToken
}

export function calcPriceNanoSatsFromTotal(params: {
  totalSats: bigint
  offeredAtoms: bigint
}): bigint {
  return (params.totalSats * NANO_SATS_PER_SAT) / params.offeredAtoms
}

export function formatOfferSummary(params: {
  offeredAtoms: bigint
  tokenDecimals: number
  askedSats: bigint
}): { offeredDisplay: string; askedDisplay: string } {
  return {
    offeredDisplay: formatAtomsToDecimal(params.offeredAtoms, params.tokenDecimals),
    askedDisplay: formatSatsToXec(params.askedSats)
  }
}

function normalizeOutpoint(txid: string, vout: number): OfferOutpoint {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error('El txid no es válido.')
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('El vout debe ser un entero mayor o igual a 0.')
  }
  return { txid: txid.toLowerCase(), vout }
}

function parseAgoraPartialAd(pushdata: Uint8Array): ParsedAgoraAd | undefined {
  if (pushdata.length < AGORA_LOKAD_ID.length + 1) {
    return undefined
  }
  const lokad = pushdata.slice(0, AGORA_LOKAD_ID.length)
  if (bytesToStr(lokad) !== bytesToStr(AGORA_LOKAD_ID)) {
    return undefined
  }

  let offset = AGORA_LOKAD_ID.length
  const variantLen = pushdata[offset]
  offset += 1
  if (offset + variantLen > pushdata.length) {
    throw new Error('La publicidad Agora está incompleta.')
  }
  const variantBytes = pushdata.slice(offset, offset + variantLen)
  const variant = bytesToStr(variantBytes)
  offset += variantLen
  if (variant !== AgoraPartial.COVENANT_VARIANT) {
    return undefined
  }

  const minimumLength = offset + 2 + 3 * U64_SIZE + U32_SIZE + 33
  if (pushdata.length < minimumLength) {
    throw new Error('La publicidad Agora está incompleta.')
  }

  const numAtomsTruncBytes = pushdata[offset]
  offset += 1
  const numSatsTruncBytes = pushdata[offset]
  offset += 1
  const atomsScaleFactor = readU64LE(pushdata, offset)
  offset += U64_SIZE
  const scaledTruncAtomsPerTruncSat = readU64LE(pushdata, offset)
  offset += U64_SIZE
  const minAcceptedScaledTruncAtoms = readU64LE(pushdata, offset)
  offset += U64_SIZE
  const enforcedLockTime = Number(readU32LE(pushdata, offset))
  offset += U32_SIZE
  const makerPk = pushdata.slice(offset, offset + 33)
  if (makerPk.length !== 33) {
    throw new Error('La publicidad Agora está incompleta.')
  }

  return {
    numAtomsTruncBytes,
    numSatsTruncBytes,
    atomsScaleFactor,
    scaledTruncAtomsPerTruncSat,
    minAcceptedScaledTruncAtoms,
    enforcedLockTime,
    makerPk
  }
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let result = 0n
  for (let i = 0; i < U64_SIZE; i += 1) {
    result |= BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i)
  }
  return result
}

function readU32LE(bytes: Uint8Array, offset: number): bigint {
  let result = 0n
  for (let i = 0; i < U32_SIZE; i += 1) {
    result |= BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i)
  }
  return result
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals)
}
