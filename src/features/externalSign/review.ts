import { Address, Tx, toHex, toHexRev } from 'ecash-lib'
import type { Tx as ChronikTx } from 'chronik-client'
import {
  EXTERNAL_SIGN_MAX_ABSOLUTE_FEE_SATS,
  EXTERNAL_SIGN_MAX_FEE_RATE_SATS_PER_BYTE,
  EXTERNAL_SIGN_MAX_OUTPUTS,
  EXTERNAL_SIGN_MIN_FEE_RATE_SATS_PER_BYTE
} from './config'
import { ExternalSignError, type ExternalSignWireRequestV1 } from './contract'

export type ExternalSignReviewInputV1 = Readonly<{
  index: string
  txid: string
  vout: string
  sats: string
  outputScript: string
  ownedByActiveWallet: true
  token: null
}>

export type ExternalSignReviewOutputV1 = Readonly<{
  index: string
  sats: string
  outputScript: string
  address: string
  classification: 'recipient' | 'change'
  token: null
  opReturn: null
}>

export type ExternalSignTxReviewV1 = Readonly<{
  version: string
  lockTime: string
  serializedSizeBytes: string
  unsignedTxHex: string
  inputTotalSats: string
  outputTotalSats: string
  feeSats: string
  feeRateSatsPerByte: string
  inputs: readonly ExternalSignReviewInputV1[]
  outputs: readonly ExternalSignReviewOutputV1[]
}>

export type ExternalSignPrevoutProvider = Readonly<{
  tx: (txid: string) => Promise<ChronikTx>
  validateRawTx: (rawTx: string) => Promise<ChronikTx>
}>

const txidOf = (txid: string | Uint8Array) => typeof txid === 'string' ? txid.toLowerCase() : toHexRev(txid).toLowerCase()
const decimal = (value: bigint | number) => value.toString(10)
const feeRateDisplay = (fee: bigint, size: bigint) => `${fee / size}.${((fee % size) * 100n / size).toString().padStart(2, '0')}`
const P2PKH_UNLOCKING_SCRIPT_BYTES = 100

const assertNonTokenTx = (tx: ChronikTx, code: string) => {
  if (
    tx.tokenStatus !== 'TOKEN_STATUS_NON_TOKEN' ||
    tx.tokenEntries.length !== 0 ||
    tx.tokenFailedParsings.length !== 0 ||
    tx.inputs.some(input => input.token !== undefined) ||
    tx.outputs.some(output => output.token !== undefined)
  ) {
    throw new ExternalSignError(code)
  }
}

export async function buildExternalSignReview(
  request: ExternalSignWireRequestV1,
  activeWalletAddress: string,
  provider: ExternalSignPrevoutProvider
): Promise<ExternalSignTxReviewV1> {
  let tx: Tx
  try {
    tx = Tx.fromHex(request.unsignedTxHex)
  } catch {
    throw new ExternalSignError('INVALID_UNSIGNED_TX_HEX')
  }
  if (tx.toHex().toLowerCase() !== request.unsignedTxHex) throw new ExternalSignError('TRAILING_OR_NONCANONICAL_TX_BYTES')
  if (tx.inputs.length === 0) throw new ExternalSignError('NO_INPUTS')
  if (tx.inputs.some(input => (input.script?.bytecode.length ?? 0) !== 0)) {
    throw new ExternalSignError('UNSIGNED_INPUT_SCRIPT_NOT_EMPTY')
  }
  if (tx.outputs.length === 0 || tx.outputs.length > EXTERNAL_SIGN_MAX_OUTPUTS) throw new ExternalSignError('OUTPUT_COUNT_FORBIDDEN')

  let walletScriptHex: string
  try {
    const walletAddress = Address.parse(activeWalletAddress)
    if (walletAddress.type !== 'p2pkh') throw new Error()
    walletScriptHex = walletAddress.toScriptHex().toLowerCase()
  } catch {
    throw new ExternalSignError('ACTIVE_WALLET_NOT_P2PKH')
  }

  const validated = await provider.validateRawTx(request.unsignedTxHex)
  assertNonTokenTx(validated, 'TOKEN_OR_UNINTERPRETABLE_DATA')
  if (
    validated.version !== tx.version ||
    validated.lockTime !== tx.locktime ||
    validated.size !== tx.serSize() ||
    validated.inputs.length !== tx.inputs.length ||
    validated.outputs.length !== tx.outputs.length ||
    validated.inputs.some((input, index) => (
      input.prevOut.txid.toLowerCase() !== txidOf(tx.inputs[index].prevOut.txid) ||
      input.prevOut.outIdx !== tx.inputs[index].prevOut.outIdx
    ))
  ) {
    throw new ExternalSignError('CHRONIK_TX_MISMATCH')
  }

  const prevTxCache = new Map<string, ChronikTx>()
  const inputs: ExternalSignReviewInputV1[] = []
  let inputTotal = 0n
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const localInput = tx.inputs[index]
    const txid = txidOf(localInput.prevOut.txid)
    const vout = localInput.prevOut.outIdx
    if (!Number.isSafeInteger(vout) || vout < 0) throw new ExternalSignError('INVALID_OUTPOINT')
    let prevTx = prevTxCache.get(txid)
    if (!prevTx) {
      prevTx = await provider.tx(txid)
      prevTxCache.set(txid, prevTx)
    }
    assertNonTokenTx(prevTx, 'TOKEN_OR_UNINTERPRETABLE_PREVOUT')
    if (prevTx.txid.toLowerCase() !== txid) throw new ExternalSignError('PREVOUT_TXID_MISMATCH')
    const prevOutput = prevTx.outputs[vout]
    if (!prevOutput) throw new ExternalSignError('PREVOUT_NOT_FOUND')
    if (prevOutput.token !== undefined) throw new ExternalSignError('TOKEN_OR_UNINTERPRETABLE_PREVOUT')
    const outputScript = prevOutput.outputScript.toLowerCase()
    if (outputScript !== walletScriptHex) throw new ExternalSignError('INPUT_NOT_OWNED')
    if (prevOutput.sats < 0n) throw new ExternalSignError('FEE_UNDETERMINABLE')
    inputTotal += prevOutput.sats
    inputs.push(Object.freeze({
      index: decimal(index),
      txid,
      vout: decimal(vout),
      sats: decimal(prevOutput.sats),
      outputScript,
      ownedByActiveWallet: true,
      token: null
    }))
  }

  const outputs: ExternalSignReviewOutputV1[] = []
  let outputTotal = 0n
  let changeCount = 0
  for (let index = 0; index < tx.outputs.length; index += 1) {
    const output = tx.outputs[index]
    if (output.sats < 0n) throw new ExternalSignError('FEE_UNDETERMINABLE')
    const outputScript = toHex(output.script.bytecode).toLowerCase()
    let address: Address
    try {
      address = Address.fromScriptHex(outputScript)
      if (address.type !== 'p2pkh') throw new Error()
    } catch {
      throw new ExternalSignError('UNSUPPORTED_OUTPUT_SCRIPT')
    }
    const validatedOutput = validated.outputs[index]
    if (
      validatedOutput.outputScript.toLowerCase() !== outputScript ||
      validatedOutput.sats !== output.sats ||
      validatedOutput.token !== undefined
    ) {
      throw new ExternalSignError('CHRONIK_TX_MISMATCH')
    }
    const classification = outputScript === walletScriptHex ? 'change' : 'recipient'
    if (classification === 'change') changeCount += 1
    if (changeCount > 1) throw new ExternalSignError('MULTIPLE_CHANGE_OUTPUTS')
    outputTotal += output.sats
    outputs.push(Object.freeze({
      index: decimal(index),
      sats: decimal(output.sats),
      outputScript,
      address: address.toString(),
      classification,
      token: null,
      opReturn: null
    }))
  }

  const fee = inputTotal - outputTotal
  if (fee < 0n) throw new ExternalSignError('FEE_UNDETERMINABLE')
  const size = BigInt(tx.serSize() + tx.inputs.length * P2PKH_UNLOCKING_SCRIPT_BYTES)
  if (
    fee < size * EXTERNAL_SIGN_MIN_FEE_RATE_SATS_PER_BYTE ||
    fee > size * EXTERNAL_SIGN_MAX_FEE_RATE_SATS_PER_BYTE ||
    fee > EXTERNAL_SIGN_MAX_ABSOLUTE_FEE_SATS
  ) {
    throw new ExternalSignError('FEE_OUT_OF_POLICY')
  }

  return Object.freeze({
    version: decimal(tx.version),
    lockTime: decimal(tx.locktime),
    serializedSizeBytes: decimal(size),
    unsignedTxHex: request.unsignedTxHex,
    inputTotalSats: decimal(inputTotal),
    outputTotalSats: decimal(outputTotal),
    feeSats: decimal(fee),
    feeRateSatsPerByte: feeRateDisplay(fee, size),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs)
  })
}

export function xecFromSats(sats: string): string {
  const value = BigInt(sats)
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')} XEC`
}
