/**
 * @file plan.ts
 *
 * CANONICAL PREPARED EXECUTION PLAN BUILDER & AUDIT VERIFIER (Gate C2)
 *
 * Enforces all 10 output invariants, strict fee security policy, deterministic UTXO selection,
 * canonical nested field serialisation, and immutable plan hashing.
 */

import { Script, sha256, toHex } from 'ecash-lib'
import { XEC_DUST_SATS } from '../../config/xecFees'
import { WalletExecutionError } from './errors'
import type {
  ExecutionTxOutput,
  ExecutionUtxoInput,
  WalletFeePolicy,
  WalletPreparedExecutionPlan
} from './types'

export const DEFAULT_FEE_POLICY: Readonly<WalletFeePolicy> = Object.freeze({
  minFeeRateSatsPerByte: 1.0,
  maxFeeRateSatsPerByte: 5.0,
  maxAbsoluteFeeSats: 50_000n, // 500 XEC hard ceiling for standard payments
  targetFeeRateSatsPerByte: 1.2
})

/**
 * Deterministic standard P2PKH transaction size calculation:
 * - Version: 4 bytes
 * - Locktime: 4 bytes
 * - In count varint: 1 byte
 * - Each P2PKH input: ~148 bytes (outpoint 36, script length 1, scriptSig ~107, sequence 4)
 * - Out count varint: 1 byte
 * - Each P2PKH output: 34 bytes (value 8, script length 1, p2pkh script 25)
 */
export function estimateP2pkhTransactionSize(inputCount: number, outputCount: number): number {
  if (inputCount <= 0) {
    throw new WalletExecutionError('INSUFFICIENT_FUNDS', 'Input count must be greater than zero.')
  }
  if (outputCount <= 0) {
    throw new WalletExecutionError('OUTPUT_INVARIANT_VIOLATION', 'Output count must be greater than zero.')
  }
  return 10 + inputCount * 148 + outputCount * 34
}

/**
 * Validates that the fee complies with strict wallet-owned fee policy bounds.
 */
export function assertFeePolicy(
  feeSats: bigint,
  estimatedSize: number,
  policy: WalletFeePolicy = DEFAULT_FEE_POLICY
): void {
  if (feeSats < 0n) {
    throw new WalletExecutionError('FEE_POLICY_VIOLATION', 'Transaction fee cannot be negative.', { feeSats })
  }

  if (feeSats > policy.maxAbsoluteFeeSats) {
    throw new WalletExecutionError(
      'FEE_POLICY_VIOLATION',
      `Fee ${feeSats} sats exceeds maximum allowed fee of ${policy.maxAbsoluteFeeSats} sats.`,
      { feeSats, maxAbsoluteFeeSats: policy.maxAbsoluteFeeSats }
    )
  }

  const effectiveFeeRate = Number(feeSats) / estimatedSize
  // Rounding tolerance of 0.05
  if (effectiveFeeRate < policy.minFeeRateSatsPerByte - 0.05) {
    throw new WalletExecutionError(
      'FEE_POLICY_VIOLATION',
      `Effective fee rate ${effectiveFeeRate.toFixed(2)} sat/byte is below policy minimum ${policy.minFeeRateSatsPerByte} sat/byte.`,
      { effectiveFeeRate, minFeeRate: policy.minFeeRateSatsPerByte }
    )
  }

  if (effectiveFeeRate > policy.maxFeeRateSatsPerByte + 0.1) {
    throw new WalletExecutionError(
      'FEE_POLICY_VIOLATION',
      `Effective fee rate ${effectiveFeeRate.toFixed(2)} sat/byte exceeds policy maximum ${policy.maxFeeRateSatsPerByte} sat/byte.`,
      { effectiveFeeRate, maxFeeRate: policy.maxFeeRateSatsPerByte }
    )
  }
}

/**
 * Deterministic canonical JSON stringifier that sorts object keys recursively at all levels.
 * Guarantees that nested arrays and objects are stringified deterministically without omitting properties.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const sortedKeys = Object.keys(obj).sort()
  const entries = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`)
  return '{' + entries.join(',') + '}'
}

/**
 * Computes deterministic SHA-256 hash of the execution plan binding every single nested field.
 */
export function computeCanonicalPlanHash(
  plan: Omit<WalletPreparedExecutionPlan, 'planHash'>
): string {
  const canonicalPayload = {
    approvalId: plan.approvalId,
    changeAddress: plan.changeAddress,
    changeAmountSats: plan.changeAmountSats.toString(),
    destination: plan.destination,
    feeRateSatsPerByte: plan.feeRateSatsPerByte,
    feeSats: plan.feeSats.toString(),
    fromAddress: plan.fromAddress,
    inputs: plan.inputs.map(input => ({
      lockingScriptHex: input.lockingScriptHex.toLowerCase(),
      outIdx: input.outIdx,
      sats: input.sats.toString(),
      txid: input.txid.toLowerCase()
    })),
    intentId: plan.intentId,
    locktime: plan.locktime,
    network: plan.network,
    outputs: plan.outputs.map(output => ({
      destination: output.destination,
      index: output.index,
      isChange: output.isChange,
      sats: output.sats.toString(),
      scriptHex: output.scriptHex.toLowerCase()
    })),
    paymentAmountSats: plan.paymentAmountSats.toString(),
    requestId: plan.requestId,
    totalInputSats: plan.totalInputSats.toString(),
    transactionVersion: plan.transactionVersion
  }

  const canonicalJson = canonicalJsonStringify(canonicalPayload)
  const bytes = new TextEncoder().encode(canonicalJson)
  return toHex(sha256(bytes))
}

/**
 * Backward compatibility alias for computeCanonicalPlanHash.
 */
export function computePlanHashSync(plan: Omit<WalletPreparedExecutionPlan, 'planHash'>): string {
  return computeCanonicalPlanHash(plan)
}

/**
 * Asynchronous plan hash computation for compatibility.
 */
export async function calculatePlanHash(
  plan: Omit<WalletPreparedExecutionPlan, 'planHash'>
): Promise<string> {
  return computeCanonicalPlanHash(plan)
}

/**
 * Validates all 10 canonical output invariants.
 */
export function validateOutputInvariants(
  plan: WalletPreparedExecutionPlan,
  approved: {
    destination: string
    amountSats: bigint
    fromAddress: string
    network: string
  },
  policy: WalletFeePolicy = DEFAULT_FEE_POLICY
): void {
  // Invariant 1: Network strictly xec:mainnet
  if (plan.network !== 'xec:mainnet' || approved.network !== 'xec:mainnet') {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Unsupported network "${plan.network}". Only "xec:mainnet" is permitted.`
    )
  }

  // Invariant 2 & 4: Exact output count (1 or 2)
  if (plan.outputs.length !== 1 && plan.outputs.length !== 2) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Invalid output count ${plan.outputs.length}. Only 1 or 2 outputs are permitted.`
    )
  }

  // Invariant 3: Primary output destination and amount exact match
  const primaryOutput = plan.outputs[0]
  if (
    primaryOutput.index !== 0 ||
    primaryOutput.destination !== approved.destination ||
    primaryOutput.sats !== approved.amountSats ||
    primaryOutput.isChange !== false
  ) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      'Primary output does not match approved payment destination and amount.'
    )
  }

  // Invariant 3b (Cryptographic Address-to-Script Match): Primary output script matches destination address
  let expectedPrimaryScriptHex: string
  try {
    expectedPrimaryScriptHex = toHex(Script.fromAddress(approved.destination).bytecode).toLowerCase()
  } catch (err) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Failed to derive standard script from destination address "${approved.destination}": ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (primaryOutput.scriptHex.toLowerCase() !== expectedPrimaryScriptHex) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Primary output scriptHex "${primaryOutput.scriptHex}" does not match script derived from destination "${approved.destination}".`
    )
  }

  // Invariant 5: Change output destination must equal fromAddress
  if (plan.outputs.length === 2) {
    const changeOutput = plan.outputs[1]
    if (
      changeOutput.index !== 1 ||
      changeOutput.destination !== approved.fromAddress ||
      changeOutput.isChange !== true
    ) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Change output destination "${changeOutput.destination}" does not match wallet address "${approved.fromAddress}".`
      )
    }

    if (changeOutput.sats < BigInt(XEC_DUST_SATS)) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Change output ${changeOutput.sats} sats is below dust threshold ${XEC_DUST_SATS} sats.`
      )
    }

    if (changeOutput.sats !== plan.changeAmountSats) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Change output amount ${changeOutput.sats} does not match plan changeAmountSats ${plan.changeAmountSats}.`
      )
    }

    // Invariant 5b (Cryptographic Change Address-to-Script Match): Change output script matches fromAddress
    let expectedChangeScriptHex: string
    try {
      expectedChangeScriptHex = toHex(Script.fromAddress(approved.fromAddress).bytecode).toLowerCase()
    } catch (err) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Failed to derive standard script from wallet address "${approved.fromAddress}": ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (changeOutput.scriptHex.toLowerCase() !== expectedChangeScriptHex) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Change output scriptHex "${changeOutput.scriptHex}" does not match script derived from wallet address "${approved.fromAddress}".`
      )
    }
  } else {
    if (plan.changeAmountSats !== 0n) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Plan has no change output but changeAmountSats is ${plan.changeAmountSats}.`
      )
    }
  }

  // Invariant 6: No OP_RETURN outputs
  for (const out of plan.outputs) {
    if (out.scriptHex.toLowerCase().startsWith('6a')) {
      throw new WalletExecutionError('OUTPUT_INVARIANT_VIOLATION', 'OP_RETURN output is strictly prohibited.')
    }
  }

  // Invariant 7: No token scripts (plain P2PKH XEC only)
  for (const out of plan.outputs) {
    const hex = out.scriptHex.toLowerCase()
    // Standard P2PKH is: 76a914{20-byte-hash}88ac (50 hex characters)
    if (!hex.startsWith('76a914') || !hex.endsWith('88ac') || hex.length !== 50) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Output script "${out.scriptHex}" is not standard P2PKH.`
      )
    }
  }

  // Invariant 8: Conservation of Satoshis
  let sumInputs = 0n
  for (const input of plan.inputs) {
    if (input.sats <= 0n) {
      throw new WalletExecutionError('OUTPUT_INVARIANT_VIOLATION', 'Input satoshi value must be strictly positive.')
    }
    sumInputs += input.sats
  }

  if (sumInputs !== plan.totalInputSats) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Sum of inputs (${sumInputs}) does not match plan totalInputSats (${plan.totalInputSats}).`
    )
  }

  const expectedOutputsAndFee = plan.paymentAmountSats + plan.changeAmountSats + plan.feeSats
  if (sumInputs !== expectedOutputsAndFee) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Input satoshis (${sumInputs}) must exactly equal outputs + fee (${expectedOutputsAndFee}).`
    )
  }

  // Invariant 9: Strict fee policy enforcement
  const estimatedSize = estimateP2pkhTransactionSize(plan.inputs.length, plan.outputs.length)
  assertFeePolicy(plan.feeSats, estimatedSize, policy)

  // Invariant 10: Standard transaction format
  if (plan.transactionVersion !== 2) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Invalid transaction version ${plan.transactionVersion}. Expected 2.`
    )
  }

  if (plan.locktime !== 0) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Invalid locktime ${plan.locktime}. Expected 0.`
    )
  }
}

/**
 * Builds an immutable, audited execution plan using deterministic UTXO selection.
 */
export function buildPreparedExecutionPlan(params: {
  readonly approved: {
    readonly approvalId: string
    readonly requestId: string
    readonly intentId: string
    readonly fromAddress: string
    readonly destination: string
    readonly amountSats: bigint
  }
  readonly availableUtxos: readonly ExecutionUtxoInput[]
  readonly feePolicy?: WalletFeePolicy
}): WalletPreparedExecutionPlan {
  const { approved, availableUtxos } = params
  const policy: WalletFeePolicy = params.feePolicy ?? DEFAULT_FEE_POLICY

  if (approved.amountSats <= 0n) {
    throw new WalletExecutionError('OUTPUT_INVARIANT_VIOLATION', 'Approved amount must be strictly positive.')
  }

  if (availableUtxos.length === 0) {
    throw new WalletExecutionError('INSUFFICIENT_FUNDS', 'No spendable UTXOs available for wallet address.')
  }

  // Deterministic sorting of available UTXOs:
  // 1. Largest value first
  // 2. Tie-break by txid ascending
  // 3. Tie-break by outIdx ascending
  const sortedUtxos = [...availableUtxos].sort((a, b) => {
    if (a.sats > b.sats) return -1
    if (a.sats < b.sats) return 1
    const txidCmp = a.txid.localeCompare(b.txid)
    if (txidCmp !== 0) return txidCmp
    return a.outIdx - b.outIdx
  })

  // Coin selection loop
  const selectedInputs: ExecutionUtxoInput[] = []
  let selectedTotal = 0n
  let changeSats = 0n
  let feeSats = 0n
  let hasChange = false

  for (const utxo of sortedUtxos) {
    selectedInputs.push(utxo)
    selectedTotal += utxo.sats

    // Estimate with 2 outputs (payment + change)
    const estSize2 = estimateP2pkhTransactionSize(selectedInputs.length, 2)
    const estFee2 = BigInt(Math.ceil(estSize2 * policy.targetFeeRateSatsPerByte))

    if (selectedTotal >= approved.amountSats + estFee2 + BigInt(XEC_DUST_SATS)) {
      feeSats = estFee2
      changeSats = selectedTotal - approved.amountSats - feeSats
      hasChange = true
      break
    }

    // Check if exact match with 1 output (payment, no change)
    const estSize1 = estimateP2pkhTransactionSize(selectedInputs.length, 1)
    const estFee1 = BigInt(Math.ceil(estSize1 * policy.targetFeeRateSatsPerByte))

    if (selectedTotal >= approved.amountSats + estFee1) {
      const remaining = selectedTotal - approved.amountSats - estFee1
      if (remaining < BigInt(XEC_DUST_SATS)) {
        feeSats = estFee1 + remaining
        changeSats = 0n
        hasChange = false
        break
      }
    }
  }

  if (selectedTotal < approved.amountSats + feeSats) {
    throw new WalletExecutionError(
      'INSUFFICIENT_FUNDS',
      `Insufficient funds. Available: ${selectedTotal} sats, Required: ${approved.amountSats + feeSats} sats.`
    )
  }

  const estimatedSize = estimateP2pkhTransactionSize(selectedInputs.length, hasChange ? 2 : 1)
  assertFeePolicy(feeSats, estimatedSize, policy)

  // Construct primary output
  const primaryScript = Script.fromAddress(approved.destination)
  const outputs: ExecutionTxOutput[] = [
    Object.freeze({
      index: 0,
      destination: approved.destination,
      scriptHex: toHex(primaryScript.bytecode),
      sats: approved.amountSats,
      isChange: false
    })
  ]

  // Construct change output if applicable
  if (hasChange && changeSats > 0n) {
    const changeScript = Script.fromAddress(approved.fromAddress)
    outputs.push(
      Object.freeze({
        index: 1,
        destination: approved.fromAddress,
        scriptHex: toHex(changeScript.bytecode),
        sats: changeSats,
        isChange: true
      })
    )
  }

  const effectiveFeeRate = Number(feeSats) / estimatedSize

  const partialPlan: Omit<WalletPreparedExecutionPlan, 'planHash'> = {
    network: 'xec:mainnet',
    fromAddress: approved.fromAddress,
    destination: approved.destination,
    paymentAmountSats: approved.amountSats,
    changeAmountSats: changeSats,
    changeAddress: hasChange ? approved.fromAddress : '',
    feeSats,
    feeRateSatsPerByte: Number(effectiveFeeRate.toFixed(4)),
    inputs: Object.freeze(selectedInputs),
    outputs: Object.freeze(outputs),
    totalInputSats: selectedTotal,
    transactionVersion: 2,
    locktime: 0,
    approvalId: approved.approvalId,
    requestId: approved.requestId,
    intentId: approved.intentId
  }

  const planHash = computeCanonicalPlanHash(partialPlan)

  const finalPlan: WalletPreparedExecutionPlan = Object.freeze({
    ...partialPlan,
    planHash
  })

  validateOutputInvariants(finalPlan, {
    destination: approved.destination,
    amountSats: approved.amountSats,
    fromAddress: approved.fromAddress,
    network: 'xec:mainnet'
  }, policy)

  return finalPlan
}
