/**
 * @file engine.ts
 *
 * CANONICAL AGENT WALLET EXECUTION ENGINE (Gate C2)
 *
 * Enforces the complete required authority chain:
 * validated WalletApprovalRequestV1
 * -> Wallet-owned human review
 * -> recorded approved HumanApprovalV1
 * -> Wallet ledger lookup / exact binding verification
 * -> authenticated current Wallet session
 * -> Wallet-local one-use execution capability
 * -> immutable prepared transaction plan
 * -> final execution review
 * -> immediate revalidation
 * -> Wallet-owned signing
 * -> signed transaction retained inside Wallet
 * -> STOP (Zero broadcast)
 */

import { fromHex, Script, toHex, TxBuilder } from 'ecash-lib'
import { INTERNAL_EXECUTION_TOKEN, mintExecutionCapability } from './capability'
import { WalletExecutionError } from './errors'
import {
  buildPreparedExecutionPlan,
  computePlanHashSync,
  DEFAULT_FEE_POLICY,
  validateOutputInvariants
} from './plan'
import type {
  AgentWalletExecutionEngine,
  AgentWalletExecutionEngineConfig,
  SignedExecutionHandle,
  WalletExecutionRecord,
  WalletExecutionReviewSnapshot,
  WalletExecutionSession,
  WalletFeePolicy,
  WalletPreparedExecutionPlan
} from './types'

function formatBigIntToExactXEC(sats: bigint): string {
  if (sats < 0n) {
    throw new Error(`[formatBigIntToExactXEC] Negative satoshis not supported: ${sats}`)
  }
  const whole = sats / 100n
  const fraction = sats % 100n
  const fractionStr = fraction.toString().padStart(2, '0')
  return `${whole.toString()}.${fractionStr} XEC`
}

export function createAgentWalletExecutionEngine(
  config: AgentWalletExecutionEngineConfig
): AgentWalletExecutionEngine {
  const {
    approvalLedger,
    executionLedger,
    sessionVerifier,
    utxoProvider,
    signatoryProvider,
    clock,
    idGenerator
  } = config

  const getNow = clock ?? (() => Math.floor(Date.now() / 1000))
  const createId = idGenerator ?? (() => globalThis.crypto.randomUUID())
  const feePolicy: WalletFeePolicy = {
    ...DEFAULT_FEE_POLICY,
    ...(config.feePolicy ?? {})
  }

  let activeExecutionHandle: string | null = null

  return {
    async prepareExecution(receipt: any): Promise<WalletExecutionSession> {
      // 1. Structural receipt check
      if (!receipt || typeof receipt !== 'object') {
        throw new WalletExecutionError('INVALID_RECEIPT', 'Receipt must be a non-null object.')
      }

      if (receipt.status !== 'approved') {
        throw new WalletExecutionError(
          'RECEIPT_NOT_APPROVED',
          `Cannot prepare execution for receipt status "${receipt.status}". Only approved receipts are executable.`
        )
      }

      if (receipt.network !== 'xec:mainnet') {
        throw new WalletExecutionError(
          'OUTPUT_INVARIANT_VIOLATION',
          `Network "${receipt.network}" is not supported. Only "xec:mainnet" is permitted.`
        )
      }

      // Single-flight lock
      if (activeExecutionHandle !== null) {
        throw new WalletExecutionError(
          'CONCURRENT_EXECUTION_ACTIVE',
          'An execution review session is already active.'
        )
      }

      const now = getNow()

      // 2. Lookup recorded approval in WalletApprovalLedger
      const record = await approvalLedger.get(receipt.requestId)
      if (!record) {
        throw new WalletExecutionError(
          'APPROVAL_NOT_FOUND',
          `No recorded approval found for requestId "${receipt.requestId}".`
        )
      }

      // 3. Verify active custodian session
      const session = await sessionVerifier.verifyActiveSession()
      if (!session.authenticated || !session.activeAddress) {
        throw new WalletExecutionError(
          'SESSION_REVALIDATION_FAILED',
          `Active wallet session unauthenticated: ${session.error ?? 'unknown error'}.`
        )
      }

      if (session.activeAddress !== record.fromAddress) {
        throw new WalletExecutionError(
          'SESSION_ADDRESS_MISMATCH',
          `Active wallet session address "${session.activeAddress}" does not match approved fromAddress "${record.fromAddress}".`
        )
      }

      // 4. At-most-once check: verify approval has not already been reserved or executed
      const existingByApproval = await executionLedger.getByApprovalId(record.approvalId)
      if (existingByApproval) {
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `Execution already initiated for approvalId "${record.approvalId}" in state "${existingByApproval.state}".`
        )
      }

      const existingByRequest = await executionLedger.getByRequestId(record.requestId)
      if (existingByRequest) {
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `Execution already initiated for requestId "${record.requestId}" in state "${existingByRequest.state}".`
        )
      }

      // 5. Mint module-private execution capability
      const capability = mintExecutionCapability({
        token: INTERNAL_EXECUTION_TOKEN,
        receipt,
        record,
        activeAddress: session.activeAddress,
        now,
        createId
      })

      // 6. Atomically reserve execution in ledger
      const executionId = `exec_${createId()}`
      await executionLedger.reserveExecutionAtomic({
        executionId,
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        decisionId: record.decisionId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: record.amountSats,
        network: 'xec:mainnet',
        reservedAt: now
      })

      // Set active single-flight slot
      activeExecutionHandle = executionId

      // 7. Read UTXOs through read-only provider
      const availableUtxos = await utxoProvider.getSpendableUtxos(record.fromAddress)

      // 8. Build immutable execution plan
      let plan: WalletPreparedExecutionPlan
      try {
        plan = buildPreparedExecutionPlan({
          approved: {
            approvalId: record.approvalId,
            requestId: record.requestId,
            intentId: record.intentId,
            fromAddress: record.fromAddress,
            destination: record.destination,
            amountSats: record.amountSats
          },
          availableUtxos,
          feePolicy
        })
      } catch (planErr) {
        activeExecutionHandle = null
        await executionLedger.markFailed(
          executionId,
          planErr instanceof Error ? planErr.message : String(planErr),
          getNow()
        )
        throw planErr
      }

      // 9. Bind plan to capability and update ledger to PREPARED
      capability.bindPlan(plan)
      await executionLedger.setPlanPrepared(executionId, plan, now)

      // 10. Construct human-readable review snapshot
      const review: WalletExecutionReviewSnapshot = Object.freeze({
        recipient: plan.destination,
        amountXEC: formatBigIntToExactXEC(plan.paymentAmountSats),
        amountSats: plan.paymentAmountSats.toString(),
        feeXEC: formatBigIntToExactXEC(plan.feeSats),
        feeSats: plan.feeSats.toString(),
        totalDebitXEC: formatBigIntToExactXEC(plan.paymentAmountSats + plan.feeSats),
        totalDebitSats: (plan.paymentAmountSats + plan.feeSats).toString(),
        fundingAddress: plan.fromAddress,
        network: 'xec:mainnet',
        approvalId: plan.approvalId,
        requestId: plan.requestId,
        intentId: plan.intentId,
        planHash: plan.planHash
      })

      // 11. Return interactive review session
      const sessionObject: WalletExecutionSession = Object.freeze({
        executionId,
        handle: executionId,
        plan,
        review,
        confirmExecution: async (): Promise<SignedExecutionHandle> => {
          // A. Ensure capability is not consumed
          if (capability.isConsumed) {
            throw new WalletExecutionError(
              'DUPLICATE_EXECUTION',
              'Execution capability has already been consumed.'
            )
          }

          const confirmNow = getNow()

          // B. Verify approval has not expired in the interim
          if (confirmNow >= record.effectiveExpiresAt) {
            activeExecutionHandle = null
            await executionLedger.markFailed(executionId, 'Approval expired during review', confirmNow)
            throw new WalletExecutionError('APPROVAL_EXPIRED', 'Approval expired during review.')
          }

          // C. Revalidate active custodian session immediately before signing
          const preSignSession = await sessionVerifier.verifyActiveSession()
          if (!preSignSession.authenticated || !preSignSession.activeAddress) {
            activeExecutionHandle = null
            await executionLedger.markFailed(executionId, 'Session unauthenticated before signing', confirmNow)
            throw new WalletExecutionError(
              'SESSION_REVALIDATION_FAILED',
              'Custodian session revalidation failed before signing.'
            )
          }

          if (preSignSession.activeAddress !== plan.fromAddress) {
            activeExecutionHandle = null
            await executionLedger.markFailed(executionId, 'Session address changed before signing', confirmNow)
            throw new WalletExecutionError(
              'SESSION_ADDRESS_MISMATCH',
              `Session address changed to "${preSignSession.activeAddress}" before signing.`
            )
          }

          // D. Re-read and revalidate UTXOs immediately before signing
          const latestUtxos = await utxoProvider.getSpendableUtxos(plan.fromAddress)
          for (const planInput of plan.inputs) {
            const match = latestUtxos.find(
              u => u.txid === planInput.txid && u.outIdx === planInput.outIdx && u.sats === planInput.sats
            )
            if (!match) {
              activeExecutionHandle = null
              await executionLedger.markFailed(executionId, 'Selected UTXO is no longer spendable', confirmNow)
              throw new WalletExecutionError(
                'UTXO_SELECTION_STALE',
                `Selected input ${planInput.txid}:${planInput.outIdx} is no longer spendable.`
              )
            }
          }

          // E. Anti-TOCTOU: Re-verify output invariants and re-verify plan hash
          validateOutputInvariants(
            plan,
            {
              destination: record.destination,
              amountSats: record.amountSats,
              fromAddress: record.fromAddress,
              network: 'xec:mainnet'
            },
            feePolicy
          )

          const recomputedPlanHash = computePlanHashSync(plan)
          if (recomputedPlanHash !== plan.planHash || capability.boundPlanHash !== plan.planHash) {
            activeExecutionHandle = null
            await executionLedger.markFailed(executionId, 'Plan hash mismatch detected', confirmNow)
            throw new WalletExecutionError(
              'PLAN_HASH_MISMATCH',
              'Plan hash mismatch. Transaction plan was modified.'
            )
          }

          // F. Verify ledger state transition to SIGNING
          const currentRecord = await executionLedger.get(executionId)
          if (!currentRecord || currentRecord.state !== 'PREPARED') {
            activeExecutionHandle = null
            throw new WalletExecutionError(
              'INVALID_STATE_TRANSITION',
              `Cannot execute signing from record state "${currentRecord?.state}".`
            )
          }

          await executionLedger.transitionToSigning(executionId, confirmNow)

          // G. Wallet-owned signing
          let rawSignedTxHex: string
          try {
            if (typeof (signatoryProvider as any).signTransaction === 'function') {
              const txBuilder = new TxBuilder({
                version: plan.transactionVersion,
                locktime: plan.locktime,
                inputs: plan.inputs.map(input => ({
                  input: {
                    prevOut: { txid: input.txid, outIdx: input.outIdx },
                    signData: {
                      sats: input.sats,
                      outputScript: new Script(fromHex(input.lockingScriptHex))
                    }
                  }
                })),
                outputs: plan.outputs.map(output => ({
                  sats: output.sats,
                  script: new Script(fromHex(output.scriptHex))
                }))
              })

              const tx = await (signatoryProvider as any).signTransaction(txBuilder)
              rawSignedTxHex = toHex(tx.ser())
            } else {
              const sigResult = await signatoryProvider.getSignatory(plan.fromAddress)
              const signatory =
                sigResult && typeof sigResult === 'object' && 'signatory' in sigResult
                  ? sigResult.signatory
                  : sigResult

              if (!signatory) {
                throw new Error('Signatory provider returned null or undefined signatory.')
              }

              const txBuilder = new TxBuilder({
                version: plan.transactionVersion,
                locktime: plan.locktime,
                inputs: plan.inputs.map(input => ({
                  input: {
                    prevOut: { txid: input.txid, outIdx: input.outIdx },
                    signData: {
                      sats: input.sats,
                      outputScript: new Script(fromHex(input.lockingScriptHex))
                    }
                  },
                  signatory
                })),
                outputs: plan.outputs.map(output => ({
                  sats: output.sats,
                  script: new Script(fromHex(output.scriptHex))
                }))
              })

              const tx = txBuilder.sign()
              rawSignedTxHex = toHex(tx.ser())
            }
          } catch (signErr) {
            // Crash consistency / fail closed
            await executionLedger.markSigningUncertain(
              executionId,
              signErr instanceof Error ? signErr.message : String(signErr),
              getNow()
            )
            activeExecutionHandle = null
            throw new WalletExecutionError(
              'SIGNING_UNCERTAIN',
              'Signing error occurred. Execution marked SIGNING_UNCERTAIN to prevent automated duplicate signing.',
              signErr
            )
          }

          // H. Commit to SIGNED with raw tx retained in internal ledger
          const signedAt = getNow()
          await executionLedger.transitionToSigned(executionId, rawSignedTxHex, signedAt)

          // Consume capability
          capability.consume()
          activeExecutionHandle = null

          // I. Return opaque SignedExecutionHandle. STOP. Zero broadcast.
          const handleResult: SignedExecutionHandle = Object.freeze({
            executionId,
            approvalId: plan.approvalId,
            requestId: plan.requestId,
            status: 'SIGNED',
            planHash: plan.planHash,
            signedAt
          })

          return handleResult
        },

        rejectExecution: async (reason?: string): Promise<void> => {
          activeExecutionHandle = null
          await executionLedger.markRejected(
            executionId,
            reason ?? 'Execution rejected by human custodian.',
            getNow()
          )
        },

        dismiss: (): void => {
          if (activeExecutionHandle === executionId) {
            activeExecutionHandle = null
          }
        }
      })

      return sessionObject
    },

    async getExecutionRecord(executionId: string): Promise<WalletExecutionRecord | undefined> {
      return executionLedger.get(executionId)
    }
  }
}
