import { FEE_RATE_SATS_PER_BYTE, XEC_DUST_SATS } from '../../config/xecFees'
import type { Tm1Draft02PostPreview } from './tm1Draft02'

export const TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX = 0
export const TM1_DRAFT_02_P2PKH_INPUT_ESTIMATE_BYTES = 149
export const TM1_DRAFT_02_P2PKH_OUTPUT_BYTES = 34

export type Tm1Draft02PlanErrorCode =
  | 'INVALID_ACTIVE_P2PKH_SCRIPT'
  | 'AUTHOR_INPUT_INDEX_MUST_BE_ZERO'
  | 'INVALID_FEE_RATE'
  | 'INVALID_DUST_LIMIT'
  | 'INVALID_UTXO'
  | 'DUPLICATE_OUTPOINT'
  | 'NO_ACTIVE_P2PKH_UTXOS'
  | 'INSUFFICIENT_FUNDS'

export class Tm1Draft02PlanError extends Error {
  readonly code: Tm1Draft02PlanErrorCode

  constructor(code: Tm1Draft02PlanErrorCode, message: string) {
    super(message)
    this.name = 'Tm1Draft02PlanError'
    this.code = code
  }
}

export type Tm1Draft02FundingUtxo = {
  readonly txid: string
  readonly outIdx: number
  readonly sats: bigint
  readonly lockingScriptHex: string
  readonly token?: unknown | null
}

export type Tm1Draft02PlannedInput = {
  readonly index: number
  readonly role: 'author' | 'funding'
  readonly txid: string
  readonly outIdx: number
  readonly sats: bigint
  readonly lockingScriptHex: string
}

export type Tm1Draft02PlannedOutput =
  | {
      readonly index: 0
      readonly kind: 'op_return'
      readonly sats: 0n
      readonly scriptHex: string
    }
  | {
      readonly index: 1
      readonly kind: 'change'
      readonly sats: bigint
      readonly scriptHex: string
    }

export type Tm1Draft02TransactionPlan = {
  readonly protocol: 'TM1'
  readonly draft: '0.2'
  readonly authorInputIndex: 0
  readonly authorPublicKeyHashHex: string
  readonly inputs: readonly Tm1Draft02PlannedInput[]
  readonly outputs: readonly Tm1Draft02PlannedOutput[]
  readonly totalInputSats: bigint
  readonly estimatedFeeSats: bigint
  readonly changeSats: bigint
  readonly estimatedSizeBytes: number
  readonly feeRateSatsPerByte: number
  readonly dustSats: bigint
  readonly signedInputSizeAssumptionBytes: typeof TM1_DRAFT_02_P2PKH_INPUT_ESTIMATE_BYTES
}

export type PlanTm1Draft02PostOptions = {
  readonly preview: Tm1Draft02PostPreview
  readonly utxos: readonly Tm1Draft02FundingUtxo[]
  readonly activeLockingScriptHex: string
  readonly feeRateSatsPerByte?: number
  readonly dustSats?: bigint
}

export function planTm1Draft02Post(options: PlanTm1Draft02PostOptions): Tm1Draft02TransactionPlan {
  if (options.preview.authorInputIndex !== TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX) {
    throw new Tm1Draft02PlanError(
      'AUTHOR_INPUT_INDEX_MUST_BE_ZERO',
      'La política de publicación ordinaria de Tonalli Wallet requiere author_input_index = 0.'
    )
  }

  const activeLockingScriptHex = normalizeHex(options.activeLockingScriptHex)
  const activeScriptMatch = /^76a914([0-9a-f]{40})88ac$/.exec(activeLockingScriptHex)
  if (!activeScriptMatch) {
    throw new Tm1Draft02PlanError(
      'INVALID_ACTIVE_P2PKH_SCRIPT',
      'La identidad activa debe usar un locking script P2PKH estándar.'
    )
  }

  const feeRateSatsPerByte = options.feeRateSatsPerByte ?? FEE_RATE_SATS_PER_BYTE
  if (!Number.isFinite(feeRateSatsPerByte) || feeRateSatsPerByte <= 0) {
    throw new Tm1Draft02PlanError('INVALID_FEE_RATE', 'La tarifa por byte debe ser un número positivo y finito.')
  }

  const dustSats = options.dustSats ?? BigInt(XEC_DUST_SATS)
  if (dustSats <= 0n) {
    throw new Tm1Draft02PlanError('INVALID_DUST_LIMIT', 'El límite de dust debe ser mayor a cero.')
  }

  const normalizedUtxos = normalizeAndValidateUtxos(options.utxos)
  const eligibleUtxos = normalizedUtxos
    .filter((utxo) => utxo.token == null)
    .filter((utxo) => utxo.lockingScriptHex === activeLockingScriptHex)
    .sort(compareUtxosDeterministically)

  if (eligibleUtxos.length === 0) {
    throw new Tm1Draft02PlanError(
      'NO_ACTIVE_P2PKH_UTXOS',
      'No hay UTXOs XEC puros y firmables por la identidad P2PKH activa.'
    )
  }

  for (let inputCount = 1; inputCount <= eligibleUtxos.length; inputCount += 1) {
    const selected = eligibleUtxos.slice(0, inputCount)
    const totalInputSats = selected.reduce((sum, utxo) => sum + utxo.sats, 0n)
    const estimatedSizeBytes = estimateTm1Draft02TransactionSizeBytes(
      inputCount,
      options.preview.scriptByteLength
    )
    const estimatedFeeSats = BigInt(Math.ceil(estimatedSizeBytes * feeRateSatsPerByte))
    const changeSats = totalInputSats - estimatedFeeSats

    if (changeSats < dustSats) {
      continue
    }

    const inputs: Tm1Draft02PlannedInput[] = selected.map((utxo, index) => ({
      index,
      role: index === TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX ? 'author' : 'funding',
      txid: utxo.txid,
      outIdx: utxo.outIdx,
      sats: utxo.sats,
      lockingScriptHex: utxo.lockingScriptHex
    }))

    return {
      protocol: 'TM1',
      draft: '0.2',
      authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX,
      authorPublicKeyHashHex: activeScriptMatch[1],
      inputs,
      outputs: [
        {
          index: 0,
          kind: 'op_return',
          sats: 0n,
          scriptHex: options.preview.scriptHex
        },
        {
          index: 1,
          kind: 'change',
          sats: changeSats,
          scriptHex: activeLockingScriptHex
        }
      ],
      totalInputSats,
      estimatedFeeSats,
      changeSats,
      estimatedSizeBytes,
      feeRateSatsPerByte,
      dustSats,
      signedInputSizeAssumptionBytes: TM1_DRAFT_02_P2PKH_INPUT_ESTIMATE_BYTES
    }
  }

  throw new Tm1Draft02PlanError(
    'INSUFFICIENT_FUNDS',
    'Los UTXOs XEC puros de la identidad activa no cubren la comisión estimada y un cambio no-dust.'
  )
}

export function estimateTm1Draft02TransactionSizeBytes(inputCount: number, opReturnScriptBytes: number): number {
  if (!Number.isSafeInteger(inputCount) || inputCount <= 0) {
    throw new Tm1Draft02PlanError('INVALID_UTXO', 'La estimación requiere al menos un input.')
  }
  if (!Number.isSafeInteger(opReturnScriptBytes) || opReturnScriptBytes <= 0) {
    throw new Tm1Draft02PlanError('INVALID_UTXO', 'La longitud del OP_RETURN debe ser un entero positivo.')
  }

  const outputCount = 2
  const opReturnOutputBytes = 8 + compactSizeLength(opReturnScriptBytes) + opReturnScriptBytes

  return (
    4 +
    compactSizeLength(inputCount) +
    inputCount * TM1_DRAFT_02_P2PKH_INPUT_ESTIMATE_BYTES +
    compactSizeLength(outputCount) +
    opReturnOutputBytes +
    TM1_DRAFT_02_P2PKH_OUTPUT_BYTES +
    4
  )
}

function normalizeAndValidateUtxos(utxos: readonly Tm1Draft02FundingUtxo[]): Tm1Draft02FundingUtxo[] {
  const seenOutpoints = new Set<string>()

  return utxos.map((utxo) => {
    const txid = utxo.txid.toLowerCase()
    const lockingScriptHex = normalizeHex(utxo.lockingScriptHex)

    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new Tm1Draft02PlanError('INVALID_UTXO', 'Cada UTXO debe incluir un txid hexadecimal de 32 bytes.')
    }
    if (!Number.isSafeInteger(utxo.outIdx) || utxo.outIdx < 0) {
      throw new Tm1Draft02PlanError('INVALID_UTXO', 'Cada UTXO debe incluir un outIdx entero no negativo.')
    }
    if (utxo.sats <= 0n) {
      throw new Tm1Draft02PlanError('INVALID_UTXO', 'Cada UTXO debe tener un valor positivo en satoshis.')
    }

    const outpoint = `${txid}:${utxo.outIdx}`
    if (seenOutpoints.has(outpoint)) {
      throw new Tm1Draft02PlanError('DUPLICATE_OUTPOINT', `El outpoint ${outpoint} está duplicado.`)
    }
    seenOutpoints.add(outpoint)

    return {
      ...utxo,
      txid,
      lockingScriptHex
    }
  })
}

function compareUtxosDeterministically(a: Tm1Draft02FundingUtxo, b: Tm1Draft02FundingUtxo): number {
  if (a.sats !== b.sats) {
    return a.sats > b.sats ? -1 : 1
  }
  if (a.txid !== b.txid) {
    return a.txid < b.txid ? -1 : 1
  }
  return a.outIdx - b.outIdx
}

function normalizeHex(value: string): string {
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Tm1Draft02PlanError('INVALID_UTXO', 'Se esperaba una cadena hexadecimal de longitud par.')
  }
  return normalized
}

function compactSizeLength(value: number): number {
  if (value <= 0xfc) return 1
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}
