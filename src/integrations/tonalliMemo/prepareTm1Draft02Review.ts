import { Script, toHex } from 'ecash-lib'
import { getChronik } from '../../services/ChronikClient'
import { xolosWalletService } from '../../services/XolosWalletService'
import { encodeTm1Draft02Post } from './tm1Draft02'
import {
  TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
  planTm1Draft02Post,
  type Tm1Draft02FundingUtxo
} from './tm1Draft02Plan'

export type Tm1Draft02ReviewInput = Readonly<{
  eventData: string
}>

export type Tm1Draft02ReviewSnapshot = Readonly<{
  protocol: 'TM1'
  draft: '0.2'
  address: string
  authorPublicKeyHashHex: string
  authorInputIndex: 0
  message: string
  messageByteLength: number
  selectedInputs: readonly Readonly<{
    index: number
    role: 'author' | 'funding'
    txid: string
    outIdx: number
    sats: bigint
  }>[]
  estimatedFeeSats: bigint
  estimatedFeeXec: string
  estimatedChangeSats: bigint
  estimatedSizeBytes: number
  feeRateSatsPerByte: number
  signedInputSizeAssumptionBytes: number
  opReturnScriptHex: string
}>

export type Tm1Draft02ReviewUtxoResponse = Readonly<{
  utxos: readonly Readonly<{
    outpoint: Readonly<{ txid: string; outIdx: number }>
    sats: bigint
    token?: unknown | null
  }>[]
}>

export type Tm1Draft02ReviewDependencies = Readonly<{
  getActiveAddress: () => string | null
  getAddressUtxos: (address: string) => Promise<Tm1Draft02ReviewUtxoResponse>
  addressToLockingScriptHex: (address: string) => string
}>

export type Tm1Draft02ReviewErrorCode =
  | 'WALLET_NOT_READY'
  | 'ACTIVE_ADDRESS_INVALID'
  | 'UTXO_LOOKUP_FAILED'

export class Tm1Draft02ReviewError extends Error {
  readonly code: Tm1Draft02ReviewErrorCode

  constructor(code: Tm1Draft02ReviewErrorCode, message: string) {
    super(message)
    this.name = 'Tm1Draft02ReviewError'
    this.code = code
  }
}

const defaultDependencies: Tm1Draft02ReviewDependencies = {
  getActiveAddress: () => xolosWalletService.getAddress(),
  getAddressUtxos: async (address) => getChronik().address(address).utxos(),
  addressToLockingScriptHex: (address) => toHex(Script.fromAddress(address).bytecode)
}

export async function prepareTm1Draft02Review(
  input: Tm1Draft02ReviewInput,
  dependencies: Tm1Draft02ReviewDependencies = defaultDependencies
): Promise<Tm1Draft02ReviewSnapshot> {
  const address = dependencies.getActiveAddress()
  if (!address) {
    throw new Tm1Draft02ReviewError(
      'WALLET_NOT_READY',
      'La billetera debe estar inicializada para calcular un plan TM1 estimado.'
    )
  }

  let activeLockingScriptHex: string
  try {
    activeLockingScriptHex = dependencies.addressToLockingScriptHex(address)
  } catch {
    throw new Tm1Draft02ReviewError(
      'ACTIVE_ADDRESS_INVALID',
      'No se pudo convertir la dirección activa en un locking script P2PKH.'
    )
  }

  let response: Tm1Draft02ReviewUtxoResponse
  try {
    response = await dependencies.getAddressUtxos(address)
  } catch {
    throw new Tm1Draft02ReviewError(
      'UTXO_LOOKUP_FAILED',
      'No se pudieron consultar los UTXOs de la dirección activa.'
    )
  }

  const preview = encodeTm1Draft02Post({
    eventData: input.eventData,
    authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
  })

  const utxos: Tm1Draft02FundingUtxo[] = response.utxos.map((utxo) => ({
    txid: utxo.outpoint.txid,
    outIdx: utxo.outpoint.outIdx,
    sats: utxo.sats,
    token: utxo.token,
    lockingScriptHex: activeLockingScriptHex
  }))

  const plan = planTm1Draft02Post({
    preview,
    utxos,
    activeLockingScriptHex
  })

  return Object.freeze({
    protocol: 'TM1',
    draft: '0.2',
    address,
    authorPublicKeyHashHex: plan.authorPublicKeyHashHex,
    authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
    message: preview.eventData,
    messageByteLength: preview.eventDataByteLength,
    selectedInputs: Object.freeze(plan.inputs.map((plannedInput) => Object.freeze({
      index: plannedInput.index,
      role: plannedInput.role,
      txid: plannedInput.txid,
      outIdx: plannedInput.outIdx,
      sats: plannedInput.sats
    }))),
    estimatedFeeSats: plan.estimatedFeeSats,
    estimatedFeeXec: formatSatsAsXec(plan.estimatedFeeSats),
    estimatedChangeSats: plan.changeSats,
    estimatedSizeBytes: plan.estimatedSizeBytes,
    feeRateSatsPerByte: plan.feeRateSatsPerByte,
    signedInputSizeAssumptionBytes: plan.signedInputSizeAssumptionBytes,
    opReturnScriptHex: preview.scriptHex
  })
}

function formatSatsAsXec(sats: bigint): string {
  const whole = sats / 100n
  const fraction = (sats % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}
