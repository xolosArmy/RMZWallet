/**
 * @file plan.ts
 *
 * CANONICAL PREPARED EXECUTION PLAN BUILDER & AUDIT VERIFIER (Gate C2)
 *
 * Enforces all 10 output invariants, strict fee security policy, deterministic UTXO selection,
 * and immutable plan hashing.
 */

import { Script, toHex } from 'ecash-lib'
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
 * Computes deterministic SHA-256 hash of the execution plan.
 */
export async function calculatePlanHash(
  plan: Omit<WalletPreparedExecutionPlan, 'planHash'>
): Promise<string> {
  const canonicalPayload = {
    network: plan.network,
    fromAddress: plan.fromAddress,
    destination: plan.destination,
    paymentAmountSats: plan.paymentAmountSats.toString(),
    changeAmountSats: plan.changeAmountSats.toString(),
    changeAddress: plan.changeAddress,
    feeSats: plan.feeSats.toString(),
    feeRateSatsPerByte: plan.feeRateSatsPerByte,
    transactionVersion: plan.transactionVersion,
    locktime: plan.locktime,
    approvalId: plan.approvalId,
    requestId: plan.requestId,
    intentId: plan.intentId,
    totalInputSats: plan.totalInputSats.toString(),
    inputs: plan.inputs.map(input => ({
      txid: input.txid,
      outIdx: input.outIdx,
      sats: input.sats.toString(),
      lockingScriptHex: input.lockingScriptHex
    })),
    outputs: plan.outputs.map(output => ({
      index: output.index,
      destination: output.destination,
      scriptHex: output.scriptHex,
      sats: output.sats.toString(),
      isChange: output.isChange
    }))
  }

  const jsonString = JSON.stringify(canonicalPayload, Object.keys(canonicalPayload).sort())
  const encoder = new TextEncoder()
  const bytes = encoder.encode(jsonString)
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Synchronous plan hash computation using deterministic sha256.
 */
export function computePlanHashSync(plan: Omit<WalletPreparedExecutionPlan, 'planHash'>): string {
  // Use simple sha256 via WebCrypto sync fallback or crypto-js / shaRmd160
  // Since WebCrypto subtle is standard in modern Node and browser, we can use a deterministic byte hash.
  // In Node.js or browser with ecash-lib, let's use ecash-lib's sha256 if available, or crypto.createHash.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto') as { createHash: (algo: string) => { update: (data: string) => { digest: (enc: string) => string } } }
    const canonicalPayload = {
      network: plan.network,
      fromAddress: plan.fromAddress,
      destination: plan.destination,
      paymentAmountSats: plan.paymentAmountSats.toString(),
      changeAmountSats: plan.changeAmountSats.toString(),
      changeAddress: plan.changeAddress,
      feeSats: plan.feeSats.toString(),
      feeRateSatsPerByte: plan.feeRateSatsPerByte,
      transactionVersion: plan.transactionVersion,
      locktime: plan.locktime,
      approvalId: plan.approvalId,
      requestId: plan.requestId,
      intentId: plan.intentId,
      totalInputSats: plan.totalInputSats.toString(),
      inputs: plan.inputs.map(input => ({
        txid: input.txid,
        outIdx: input.outIdx,
        sats: input.sats.toString(),
        lockingScriptHex: input.lockingScriptHex
      })),
      outputs: plan.outputs.map(output => ({
        index: output.index,
        destination: output.destination,
        scriptHex: output.scriptHex,
        sats: output.sats.toString(),
        isChange: output.isChange
      }))
    }
    const jsonString = JSON.stringify(canonicalPayload, Object.keys(canonicalPayload).sort())
    return crypto.createHash('sha256').update(jsonString).digest('hex')
  } catch {
    throw new WalletExecutionError('PLAN_HASH_MISMATCH', 'Crypto hash computation unavailable.')
  }
}

/**
 * Validates all 10 Output & Arithmetic Invariants immediately before signing.
 *
 * 1. network === xec:mainnet
 * 2. payment destination EXACTLY equals approved destination
 * 3. payment amount EXACTLY equals approved amountSats
 * 4. no additional third-party outputs exist
 * 5. any change output returns ONLY to a Wallet-controlled address (fromAddress)
 * 6. no unexpected OP_RETURN
 * 7. no token output / NFT output
 * 8. sum(inputs) = payment + change + fee
 * 9. fee is positive/non-negative as appropriate and policy-valid
 * 10. no arithmetic uses unsafe JS Number for satoshi accounting (BigInt throughout)
 */
export function validateOutputInvariants(
  plan: WalletPreparedExecutionPlan,
  approved: {
    readonly destination: string
    readonly amountSats: bigint
    readonly fromAddress: string
    readonly network: 'xec:mainnet'
  },
  policy: WalletFeePolicy = DEFAULT_FEE_POLICY
): void {
  // Invariant 1: network === xec:mainnet
  if (plan.network !== 'xec:mainnet' || approved.network !== 'xec:mainnet') {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Invalid network: expected "xec:mainnet", got "${plan.network}".`
    )
  }

  // Invariant 2: payment destination EXACTLY equals approved destination
  if (plan.destination !== approved.destination) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Payment destination mismatch: plan destination "${plan.destination}" does not match approved "${approved.destination}".`
    )
  }

  // Invariant 3: payment amount EXACTLY equals approved amountSats
  if (typeof plan.paymentAmountSats !== 'bigint' || plan.paymentAmountSats !== approved.amountSats) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Payment amount mismatch: plan amount ${plan.paymentAmountSats} does not match approved ${approved.amountSats}.`
    )
  }

  if (plan.paymentAmountSats <= 0n) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      'Payment amount must be greater than zero.'
    )
  }

  // Invariant 6: no OP_RETURN across any outputs
  for (const output of plan.outputs) {
    if (output.scriptHex.toLowerCase().startsWith('6a')) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Unexpected OP_RETURN output detected: "${output.scriptHex}".`
      )
    }
  }

  // Invariant 7: no token output / NFT output across any outputs
  // Plain XEC payments produce standard P2PKH script (starts with 76a914, length 50 hex chars = 25 bytes)
  for (const output of plan.outputs) {
    if (!output.scriptHex.toLowerCase().startsWith('76a914') || output.scriptHex.length !== 50) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Non-standard output script detected: "${output.scriptHex}". Only plain P2PKH XEC outputs are permitted.`
      )
    }
  }

  // Invariant 4: no additional third-party outputs exist (1 payment, and optional 1 change)
  if (plan.outputs.length < 1 || plan.outputs.length > 2) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Output count violation: expected 1 or 2 outputs, got ${plan.outputs.length}.`
    )
  }

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

  // Invariant 5: change output returns ONLY to wallet-controlled address
  if (plan.outputs.length === 2) {
    const changeOutput = plan.outputs[1]
    if (
      changeOutput.index !== 1 ||
      changeOutput.destination !== approved.fromAddress ||
      changeOutput.sats !== plan.changeAmountSats ||
      changeOutput.isChange !== true
    ) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Change output violation: change destination "${changeOutput.destination}" must match wallet address "${approved.fromAddress}".`
      )
    }

    if (plan.changeAddress !== approved.fromAddress) {
      throw new WalletExecutionError(
        'OUTPUT_INVARIANT_VIOLATION',
        `Change address violation: plan changeAddress "${plan.changeAddress}" must match approved fromAddress "${approved.fromAddress}".`
      )
    }
  } else if (plan.changeAmountSats !== 0n) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Change output missing: plan specifies change of ${plan.changeAmountSats} sats but no change output is present.`
    )
  }

  // Invariant 8: sum(inputs) = payment + change + fee (Exact conservation)
  const sumInputs = plan.inputs.reduce((sum, input) => sum + input.sats, 0n)
  if (sumInputs !== plan.totalInputSats) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Input sum arithmetic error: computed sum ${sumInputs} !== totalInputSats ${plan.totalInputSats}.`
    )
  }

  const expectedTotalDebit = plan.paymentAmountSats + plan.changeAmountSats + plan.feeSats
  if (sumInputs !== expectedTotalDebit) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Exact satoshi balance violation: inputs (${sumInputs}) != payment (${plan.paymentAmountSats}) + change (${plan.changeAmountSats}) + fee (${plan.feeSats}).`
    )
  }

  // Invariant 9: fee is positive/non-negative and policy-valid
  const estimatedSize = estimateP2pkhTransactionSize(plan.inputs.length, plan.outputs.length)
  assertFeePolicy(plan.feeSats, estimatedSize, policy)

  // Invariant 10: bigint accounting verified across all fields
  if (
    typeof plan.paymentAmountSats !== 'bigint' ||
    typeof plan.changeAmountSats !== 'bigint' ||
    typeof plan.feeSats !== 'bigint' ||
    typeof plan.totalInputSats !== 'bigint'
  ) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      'All monetary amounts must use BigInt satoshi accounting.'
    )
  }
}

/**
 * Builds an immutable, audited WalletPreparedExecutionPlan from spendable UTXOs and approved intent.
 */
export function buildPreparedExecutionPlan(options: {
  readonly approved: {
    readonly approvalId: string
    readonly requestId: string
    readonly intentId: string
    readonly fromAddress: string
    readonly destination: string
    readonly amountSats: bigint
  }
  readonly availableUtxos: readonly ExecutionUtxoInput[]
  readonly feePolicy?: Partial<WalletFeePolicy>
}): WalletPreparedExecutionPlan {
  const { approved, availableUtxos } = options
  const policy: WalletFeePolicy = {
    ...DEFAULT_FEE_POLICY,
    ...(options.feePolicy ?? {})
  }

  if (approved.amountSats <= 0n) {
    throw new WalletExecutionError('OUTPUT_INVARIANT_VIOLATION', 'Amount must be greater than zero.')
  }

  // Verify destinations are valid eCash addresses
  let destinationScript: Script
  let fromAddressScript: Script
  try {
    destinationScript = Script.fromAddress(approved.destination)
  } catch (err) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Invalid payment destination address: ${approved.destination}`,
      err
    )
  }

  try {
    fromAddressScript = Script.fromAddress(approved.fromAddress)
  } catch (err) {
    throw new WalletExecutionError(
      'OUTPUT_INVARIANT_VIOLATION',
      `Invalid sender fromAddress: ${approved.fromAddress}`,
      err
    )
  }

  const destinationScriptHex = toHex(destinationScript.bytecode)
  const fromAddressScriptHex = toHex(fromAddressScript.bytecode)

  // Filter spendable UTXOs: must be non-zero sats and valid txid
  const candidates = [...availableUtxos].filter(
    utxo => utxo.sats > 0n && typeof utxo.txid === 'string' && utxo.txid.length === 64
  )

  // Sort deterministically: descending sats, tie break by txid:outIdx
  candidates.sort((a, b) => {
    if (a.sats > b.sats) return -1
    if (a.sats < b.sats) return 1
    const idA = `${a.txid}:${a.outIdx}`
    const idB = `${b.txid}:${b.outIdx}`
    return idA.localeCompare(idB)
  })

  const dustLimitSats = BigInt(XEC_DUST_SATS)
  let selectedInputs: ExecutionUtxoInput[] = []
  let totalInputSats = 0n
  let feeSats = 0n
  let changeSats = 0n
  let selectedOutputs: ExecutionTxOutput[] = []
  let resolved = false

  for (let i = 0; i < candidates.length; i += 1) {
    selectedInputs.push(candidates[i])
    totalInputSats += candidates[i].sats

    // Estimate size assuming 2 outputs (payment + change)
    const estimatedSizeWithChange = estimateP2pkhTransactionSize(selectedInputs.length, 2)
    const targetFeeWithChange = BigInt(Math.ceil(estimatedSizeWithChange * policy.targetFeeRateSatsPerByte))

    if (totalInputSats >= approved.amountSats + targetFeeWithChange + dustLimitSats) {
      feeSats = targetFeeWithChange
      changeSats = totalInputSats - approved.amountSats - feeSats

      selectedOutputs = [
        Object.freeze({
          index: 0,
          destination: approved.destination,
          scriptHex: destinationScriptHex,
          sats: approved.amountSats,
          isChange: false
        }),
        Object.freeze({
          index: 1,
          destination: approved.fromAddress,
          scriptHex: fromAddressScriptHex,
          sats: changeSats,
          isChange: true
        })
      ]
      resolved = true
      break
    }

    // Check if it fits with 1 output (exact amount without change, dust absorbed into fee)
    const estimatedSizeWithoutChange = estimateP2pkhTransactionSize(selectedInputs.length, 1)
    const targetFeeWithoutChange = BigInt(Math.ceil(estimatedSizeWithoutChange * policy.targetFeeRateSatsPerByte))
    const potentialChange = totalInputSats - approved.amountSats - targetFeeWithoutChange

    if (potentialChange >= 0n && potentialChange < dustLimitSats) {
      // Absorb dust into fee
      const absorbedFee = targetFeeWithoutChange + potentialChange
      if (absorbedFee <= policy.maxAbsoluteFeeSats) {
        feeSats = absorbedFee
        changeSats = 0n
        selectedOutputs = [
          Object.freeze({
            index: 0,
            destination: approved.destination,
            scriptHex: destinationScriptHex,
            sats: approved.amountSats,
            isChange: false
          })
        ]
        resolved = true
        break
      }
    }
  }

  if (!resolved) {
    throw new WalletExecutionError(
      'INSUFFICIENT_FUNDS',
      `Insufficient spendable funds. Total available: ${totalInputSats} sats, required: ${approved.amountSats} sats plus fees.`,
      { totalAvailableSats: totalInputSats, requiredSats: approved.amountSats }
    )
  }

  const basePlan = {
    network: 'xec:mainnet' as const,
    fromAddress: approved.fromAddress,
    destination: approved.destination,
    paymentAmountSats: approved.amountSats,
    changeAmountSats: changeSats,
    changeAddress: approved.fromAddress,
    feeSats,
    feeRateSatsPerByte: policy.targetFeeRateSatsPerByte,
    inputs: Object.freeze(selectedInputs.map(input => Object.freeze({ ...input }))),
    outputs: Object.freeze(selectedOutputs),
    totalInputSats,
    transactionVersion: 2,
    locktime: 0,
    approvalId: approved.approvalId,
    requestId: approved.requestId,
    intentId: approved.intentId
  }

  const planHash = computePlanHashSync(basePlan)

  const frozenPlan: WalletPreparedExecutionPlan = Object.freeze({
    ...basePlan,
    planHash
  })

  // Self-audit: validate output invariants immediately upon construction
  validateOutputInvariants(
    frozenPlan,
    {
      destination: approved.destination,
      amountSats: approved.amountSats,
      fromAddress: approved.fromAddress,
      network: 'xec:mainnet'
    },
    policy
  )

  return frozenPlan
}
