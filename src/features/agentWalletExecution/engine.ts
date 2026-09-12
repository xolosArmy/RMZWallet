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
 * -> module-private one-use execution capability (closure encapsulated)
 * -> immutable prepared transaction plan
 * -> review-only session (no public signing method)
 * -> Wallet-owned UI/controller with one-use local confirmation authority
 * -> immediate anti-TOCTOU revalidation
 * -> Wallet-owned signing
 * -> post-signing transaction verification (P1-4)
 * -> signed transaction retained inside Wallet
 * -> STOP (Zero broadcast)
 */

import { fromHex, Script, toHex, TxBuilder } from 'ecash-lib'
import { WalletExecutionError } from './errors'
import { DurableTransactionalExecutionLedger } from './ledger'
import {
  buildPreparedExecutionPlan,
  computeCanonicalPlanHash,
  DEFAULT_FEE_POLICY,
  validateOutputInvariants
} from './plan'
import type {
  AgentWalletExecutionEngine,
  AgentWalletExecutionEngineConfig,
  ExecutionNetwork,
  PublicExecutionStatus,
  SignedExecutionHandle,
  WalletExecutionComposition,
  WalletExecutionLedger,
  WalletExecutionReviewSession,
  WalletExecutionReviewSnapshot,
  WalletExecutionUIHost,
  WalletFeePolicy,
  WalletLocalConfirmationController,
  WalletPreparedExecutionPlan
} from './types'

// Module-private symbols for closure-encapsulated capabilities
const INTERNAL_CAPABILITY_TOKEN = Symbol('WalletExecutionCapabilityToken')
const LOCAL_CONFIRMATION_TOKEN = Symbol('LocalExecutionConfirmationToken')

interface ExecutionCapabilityBindings {
  readonly capabilityId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly approvalStatus: 'approved'
  readonly approver: string
  readonly destination: string
  readonly amountSats: bigint
  readonly network: ExecutionNetwork
  readonly contentHash: string
  readonly effectiveExpiresAt: number
}

class InternalWalletExecutionCapability {
  readonly capabilityId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly approvalStatus: 'approved'
  readonly approver: string
  readonly destination: string
  readonly amountSats: bigint
  readonly network: ExecutionNetwork
  readonly contentHash: string
  readonly effectiveExpiresAt: number

  private _boundPlanHash: string | null = null
  private _consumed = false
  private _invalidated = false

  constructor(token: symbol, bindings: ExecutionCapabilityBindings) {
    if (token !== INTERNAL_CAPABILITY_TOKEN) {
      throw new WalletExecutionError(
        'INVALID_RECEIPT',
        'Direct construction of WalletExecutionCapability is prohibited.'
      )
    }

    this.capabilityId = bindings.capabilityId
    this.approvalId = bindings.approvalId
    this.requestId = bindings.requestId
    this.intentId = bindings.intentId
    this.decisionId = bindings.decisionId
    this.approvalStatus = bindings.approvalStatus
    this.approver = bindings.approver
    this.destination = bindings.destination
    this.amountSats = bindings.amountSats
    this.network = bindings.network
    this.contentHash = bindings.contentHash
    this.effectiveExpiresAt = bindings.effectiveExpiresAt
  }

  get isConsumed(): boolean {
    return this._consumed
  }

  get isInvalidated(): boolean {
    return this._invalidated
  }

  get boundPlanHash(): string | null {
    return this._boundPlanHash
  }

  bindPlan(plan: WalletPreparedExecutionPlan): void {
    if (this._consumed || this._invalidated) {
      throw new WalletExecutionError('DUPLICATE_EXECUTION', 'Execution capability is not active.')
    }
    if (this._boundPlanHash !== null) {
      throw new WalletExecutionError('DUPLICATE_EXECUTION', 'Plan has already been bound to this capability.')
    }
    if (plan.approvalId !== this.approvalId || plan.requestId !== this.requestId) {
      throw new WalletExecutionError('PLAN_HASH_MISMATCH', 'Plan does not match capability approval or request bindings.')
    }
    this._boundPlanHash = plan.planHash
  }

  consume(): void {
    if (this._consumed || this._invalidated) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Execution capability has already been consumed or invalidated. Replay is strictly prohibited.'
      )
    }
    this._consumed = true
  }

  invalidate(): void {
    this._invalidated = true
  }
}

class InternalLocalExecutionConfirmationToken {
  readonly executionId: string
  private _consumed = false

  constructor(token: symbol, executionId: string) {
    if (token !== LOCAL_CONFIRMATION_TOKEN) {
      throw new WalletExecutionError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Direct construction of LocalExecutionConfirmationToken is prohibited.'
      )
    }
    this.executionId = executionId
  }

  get isConsumed(): boolean {
    return this._consumed
  }

  consume(): void {
    if (this._consumed) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Local confirmation token has already been consumed. Replay is prohibited.'
      )
    }
    this._consumed = true
  }
}

function formatBigIntToExactXEC(sats: bigint): string {
  if (sats < 0n) {
    throw new Error(`[formatBigIntToExactXEC] Negative satoshis not supported: ${sats}`)
  }
  const whole = sats / 100n
  const fraction = sats % 100n
  const fractionStr = fraction.toString().padStart(2, '0')
  return `${whole.toString()}.${fractionStr} XEC`
}

export function createWalletExecutionComposition(
  config: AgentWalletExecutionEngineConfig
): WalletExecutionComposition {
  const {
    approvalLedger,
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

  // Durable execution ledger by default
  const executionLedger: WalletExecutionLedger =
    config.executionLedger ??
    new DurableTransactionalExecutionLedger({ storage: config.storage })

  // Synchronous single-flight lock guards
  let isPreparing = false
  let activeExecutionId: string | null = null
  let activeCapability: InternalWalletExecutionCapability | null = null
  let activePlan: WalletPreparedExecutionPlan | null = null
  let activeController: WalletLocalConfirmationController | null = null

  const sessionPreparedListeners = new Set<
    (session: WalletExecutionReviewSession, controller: WalletLocalConfirmationController) => void
  >()

  async function executeSigningWithConfirmation(
    executionId: string,
    token: unknown
  ): Promise<SignedExecutionHandle> {
    // 1. Verify token is a valid, unconsumed local confirmation token
    if (
      !(token instanceof InternalLocalExecutionConfirmationToken) ||
      token.executionId !== executionId
    ) {
      throw new WalletExecutionError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Valid Wallet-local confirmation token required for signing.'
      )
    }

    if (token.isConsumed) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Confirmation token has already been consumed.'
      )
    }
    // 2. Look up current ledger state
    const currentRecord = await executionLedger.get(executionId)
    const currentStatus = currentRecord ? (currentRecord.status ?? (currentRecord as any).state) : undefined
    if (!currentRecord || currentStatus !== 'PREPARED') {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      activeController = null
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot execute signing from record state "${currentStatus}". Expected "PREPARED".`
      )
    }

    // 3. Verify single-flight ownership
    if (activeExecutionId !== executionId || !activeCapability || !activePlan) {
      throw new WalletExecutionError(
        'CONCURRENT_EXECUTION_ACTIVE',
        `Execution "${executionId}" is not the currently active execution session.`
      )
    }

    const capability = activeCapability
    const plan = activePlan

    if (capability.isConsumed || capability.isInvalidated) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Execution capability has already been consumed or invalidated.'
      )
    }

    const confirmNow = getNow()

    // 4. Verify approval has not expired in the interim
    if (confirmNow >= capability.effectiveExpiresAt) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Approval expired during review', confirmNow)
      throw new WalletExecutionError('APPROVAL_EXPIRED', 'Approval expired during review.')
    }

    // 5. Revalidate active custodian session immediately before signing
    const preSignSession = await sessionVerifier.verifyActiveSession()
    if (!preSignSession.authenticated || !preSignSession.activeAddress) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Session unauthenticated before signing', confirmNow)
      throw new WalletExecutionError(
        'SESSION_REVALIDATION_FAILED',
        'Custodian session revalidation failed before signing.'
      )
    }

    if (preSignSession.activeAddress !== plan.fromAddress) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Session address changed before signing', confirmNow)
      throw new WalletExecutionError(
        'SESSION_ADDRESS_MISMATCH',
        `Session address changed to "${preSignSession.activeAddress}" before signing.`
      )
    }

    // 6. Re-read and revalidate UTXOs immediately before signing
    const latestUtxos = await utxoProvider.getSpendableUtxos(plan.fromAddress)
    for (const planInput of plan.inputs) {
      const match = latestUtxos.find(
        u => u.txid === planInput.txid && u.outIdx === planInput.outIdx && u.sats === planInput.sats
      )
      if (!match) {
        activeExecutionId = null
        activeCapability = null
        activePlan = null
        await executionLedger.markFailed(executionId, 'Selected UTXO is no longer spendable', confirmNow)
        throw new WalletExecutionError(
          'UTXO_SELECTION_STALE',
          `Selected input ${planInput.txid}:${planInput.outIdx} is no longer spendable.`
        )
      }
    }

    // 7. Anti-TOCTOU: Re-verify output invariants and re-verify plan hash
    validateOutputInvariants(
      plan,
      {
        destination: currentRecord.destination,
        amountSats: currentRecord.amountSats,
        fromAddress: currentRecord.fromAddress,
        network: 'xec:mainnet'
      },
      feePolicy
    )

    const recomputedPlanHash = computeCanonicalPlanHash(plan)
    if (recomputedPlanHash !== plan.planHash || capability.boundPlanHash !== plan.planHash) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Plan hash mismatch detected', confirmNow)
      throw new WalletExecutionError(
        'PLAN_HASH_MISMATCH',
        'Plan hash mismatch. Transaction plan was modified.'
      )
    }

    // 8. Durable transition to SIGNING
    await executionLedger.transitionToSigning(executionId, confirmNow)

    // 9. Wallet-owned signing
    let rawSignedTxHex: string
    let signedTx: any
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

        signedTx = await (signatoryProvider as any).signTransaction(txBuilder)
        rawSignedTxHex = toHex(signedTx.ser())
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

        signedTx = txBuilder.sign()
        rawSignedTxHex = toHex(signedTx.ser())
      }
    } catch (signErr) {
      // Crash consistency / fail closed
      await executionLedger.markSigningUncertain(
        executionId,
        signErr instanceof Error ? signErr.message : String(signErr),
        getNow()
      )
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      throw new WalletExecutionError(
        'SIGNING_UNCERTAIN',
        'Signing error occurred. Execution marked SIGNING_UNCERTAIN to prevent automated duplicate signing.',
        signErr
      )
    }

    // 10. Post-signing verification of the actual signed transaction (P1-4)
    try {
      if (signedTx.version !== plan.transactionVersion) {
        throw new Error(`Signed tx version ${signedTx.version} !== plan ${plan.transactionVersion}`)
      }
      if (signedTx.locktime !== plan.locktime) {
        throw new Error(`Signed tx locktime ${signedTx.locktime} !== plan ${plan.locktime}`)
      }
      if (signedTx.inputs.length !== plan.inputs.length) {
        throw new Error(`Signed tx input count ${signedTx.inputs.length} !== plan ${plan.inputs.length}`)
      }
      for (let i = 0; i < plan.inputs.length; i++) {
        const txInput = signedTx.inputs[i]
        const planInput = plan.inputs[i]
        const txPrevTxid = typeof txInput.prevOut.txid === 'string'
          ? txInput.prevOut.txid
          : toHex(txInput.prevOut.txid)
        if (txPrevTxid.toLowerCase() !== planInput.txid.toLowerCase()) {
          throw new Error(`Signed tx input ${i} prevout txid "${txPrevTxid}" !== plan "${planInput.txid}"`)
        }
        if (txInput.prevOut.outIdx !== planInput.outIdx) {
          throw new Error(`Signed tx input ${i} outIdx ${txInput.prevOut.outIdx} !== plan ${planInput.outIdx}`)
        }
      }
      if (signedTx.outputs.length !== plan.outputs.length) {
        throw new Error(`Signed tx output count ${signedTx.outputs.length} !== plan ${plan.outputs.length}`)
      }
      for (let j = 0; j < plan.outputs.length; j++) {
        const txOutput = signedTx.outputs[j]
        const planOutput = plan.outputs[j]
        const txSats = txOutput.sats ?? txOutput.value
        if (BigInt(txSats) !== BigInt(planOutput.sats)) {
          throw new Error(`Signed tx output ${j} sats ${txSats} !== plan ${planOutput.sats}`)
        }
        const txScriptHex = toHex(txOutput.script.bytecode)
        if (txScriptHex.toLowerCase() !== planOutput.scriptHex.toLowerCase()) {
          throw new Error(`Signed tx output ${j} script "${txScriptHex}" !== plan "${planOutput.scriptHex}"`)
        }
      }
    } catch (verifyErr) {
      // Post-sign verification failed: adversarial or buggy signatory returned altered tx
      const mismatchReason = verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
      await executionLedger.markSigningUncertain(executionId, mismatchReason, getNow())
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      throw new WalletExecutionError(
        'SIGNED_TRANSACTION_MISMATCH',
        `Post-sign verification failed: ${mismatchReason}`
      )
    }

    // 11. Commit to SIGNED with raw tx retained inside Wallet boundary
    const signedAt = getNow()
    await executionLedger.transitionToSigned(executionId, rawSignedTxHex, signedAt)

    // Consume capability & release single-flight lock
    capability.consume()
    activeExecutionId = null
    activeCapability = null
    activePlan = null

    // 12. Return opaque SignedExecutionHandle. STOP. Zero broadcast.
    return Object.freeze({
      executionId,
      approvalId: plan.approvalId,
      requestId: plan.requestId,
      status: 'SIGNED',
      planHash: plan.planHash,
      signedAt
    })
  }

  async function prepareExecution(receipt: any): Promise<WalletExecutionReviewSession> {
    // 1. Synchronous single-flight reservation check BEFORE any await (P1-1)
    if (isPreparing || activeExecutionId !== null) {
      throw new WalletExecutionError(
        'CONCURRENT_EXECUTION_ACTIVE',
        'An execution review session is already active or being prepared.'
      )
    }
    isPreparing = true

    let reservedExecutionId: string | null = null

    try {
      // 2. Structural receipt check
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
          'UNSUPPORTED_NETWORK',
          `Network "${receipt.network}" is not supported. Only "xec:mainnet" is supported.`
        )
      }

      if (!receipt.approvalId || !receipt.requestId) {
        throw new WalletExecutionError(
          'INVALID_RECEIPT',
          'Receipt is missing required approvalId or requestId.'
        )
      }

      const now = getNow()

      // 3. Look up immutable approval record in approval ledger
      const record = await approvalLedger.get(receipt.requestId)
      if (!record) {
        throw new WalletExecutionError(
          'APPROVAL_NOT_FOUND',
          `No recorded approval found for requestId "${receipt.requestId}".`
        )
      }

      // 4. Verify active custodian session
      const activeWalletSession = await sessionVerifier.verifyActiveSession()
      if (!activeWalletSession.authenticated || !activeWalletSession.activeAddress) {
        throw new WalletExecutionError(
          'SESSION_REVALIDATION_FAILED',
          `Active wallet session unauthenticated: ${activeWalletSession.error ?? 'unknown error'}.`
        )
      }

      if (activeWalletSession.activeAddress !== record.fromAddress) {
        throw new WalletExecutionError(
          'SESSION_ADDRESS_MISMATCH',
          `Active wallet session address "${activeWalletSession.activeAddress}" does not match approved fromAddress "${record.fromAddress}".`
        )
      }

        // 5. At-most-once check: verify approval has not already been reserved or executed
        const existingByApproval = await executionLedger.getByApprovalId(record.approvalId)
        if (existingByApproval) {
          const status = existingByApproval.status ?? (existingByApproval as any).state
          throw new WalletExecutionError(
            'DUPLICATE_EXECUTION',
            `Execution already initiated for approvalId "${record.approvalId}" in state "${status}".`
          )
        }

        const existingByRequest = await executionLedger.getByRequestId(record.requestId)
        if (existingByRequest) {
          const status = existingByRequest.status ?? (existingByRequest as any).state
          throw new WalletExecutionError(
            'DUPLICATE_EXECUTION',
            `Execution already initiated for requestId "${record.requestId}" in state "${status}".`
          )
        }

        // 6. Verify receipt exact binding
        if (receipt.approvalId !== record.approvalId) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `approvalId mismatch: receipt "${receipt.approvalId}" !== ledger "${record.approvalId}".`
          )
        }
        if (receipt.requestId !== record.requestId) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `requestId mismatch: receipt "${receipt.requestId}" !== ledger "${record.requestId}".`
          )
        }
        if (receipt.intentId !== record.intentId) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `intentId mismatch: receipt "${receipt.intentId}" !== ledger "${record.intentId}".`
          )
        }
        if (receipt.decisionId !== record.decisionId) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `decisionId mismatch: receipt "${receipt.decisionId}" !== ledger "${record.decisionId}".`
          )
        }
        if (receipt.approver !== record.fromAddress) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `approver mismatch: receipt "${receipt.approver}" !== ledger "${record.fromAddress}".`
          )
        }
        if (receipt.network !== record.network) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `network mismatch: receipt "${receipt.network}" !== ledger "${record.network}".`
          )
        }
        if (receipt.presentationHash !== record.presentationHash) {
          throw new WalletExecutionError(
            'APPROVAL_FORGED',
            'presentationHash does not match recorded ledger entry.'
          )
        }
        if (receipt.contentHash !== record.contentHash) {
          throw new WalletExecutionError(
            'APPROVAL_FORGED',
            'contentHash does not match recorded ledger entry.'
          )
        }
        if (receipt.recordedAt !== record.recordedAt) {
          throw new WalletExecutionError(
            'APPROVAL_FIELD_MISMATCH',
            `recordedAt mismatch: receipt ${receipt.recordedAt} !== ledger ${record.recordedAt}.`
          )
        }
        if (now >= record.effectiveExpiresAt) {
          throw new WalletExecutionError(
            'APPROVAL_EXPIRED',
            `Approval expired at ${record.effectiveExpiresAt}; current time is ${now}.`
          )
        }

        // 7. Mint module-private execution capability
        const capabilityId = `exec_cap_${createId()}`
        const capability = new InternalWalletExecutionCapability(INTERNAL_CAPABILITY_TOKEN, {
          capabilityId,
          approvalId: record.approvalId,
          requestId: record.requestId,
          intentId: record.intentId,
          decisionId: record.decisionId,
          approvalStatus: 'approved',
          approver: record.fromAddress,
          destination: record.destination,
          amountSats: record.amountSats,
          network: record.network,
          contentHash: record.contentHash,
          effectiveExpiresAt: record.effectiveExpiresAt
        })

        // 8. Atomically reserve execution in durable ledger
        const executionId = `exec_${createId()}`
        reservedExecutionId = executionId
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

        // 9. Read UTXOs through read-only provider
        const availableUtxos = await utxoProvider.getSpendableUtxos(record.fromAddress)

        // 10. Build immutable execution plan
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
          await executionLedger.markFailed(
            executionId,
            planErr instanceof Error ? planErr.message : String(planErr),
            getNow()
          )
          throw planErr
        }

        // 11. Bind plan to capability and update ledger to PREPARED
        capability.bindPlan(plan)
        await executionLedger.setPlanPrepared(executionId, plan, now)

        // 12. Construct human-readable review snapshot
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

        // Set active single-flight state
        activeExecutionId = executionId
        activeCapability = capability
        activePlan = plan

        // 13. Construct review-only session (P0-3: NO signing method on session!)
        const session: WalletExecutionReviewSession = Object.freeze({
          executionId,
          plan,
          review,
          rejectExecution: async (reason?: string): Promise<void> => {
            if (activeExecutionId === executionId) {
              activeExecutionId = null
              activeCapability = null
              activePlan = null
              activeController = null
            }
            capability.invalidate()
            await executionLedger.markRejected(
              executionId,
              reason ?? 'Execution rejected by human custodian.',
              getNow()
            )
          },
          dismiss: async (): Promise<void> => {
            if (activeExecutionId === executionId) {
              activeExecutionId = null
              activeCapability = null
              activePlan = null
              activeController = null
            }
            capability.invalidate()
            // P0-4: Dismiss durably transitions execution to terminal REJECTED
            await executionLedger.markRejected(
              executionId,
              'Execution dismissed by custodian.',
              getNow()
            )
          }
        })

        // Wallet-owned local confirmation controller (strictly closure-confined to Wallet UI composition)
        const localController: WalletLocalConfirmationController = Object.freeze({
          executionId,
          confirm: async (): Promise<SignedExecutionHandle> => {
            const token = new InternalLocalExecutionConfirmationToken(
              LOCAL_CONFIRMATION_TOKEN,
              executionId
            )
            return executeSigningWithConfirmation(executionId, token)
          },
          reject: async (reason?: string): Promise<void> => {
            return session.rejectExecution(reason)
          },
          dismiss: async (): Promise<void> => {
            return session.dismiss()
          }
        })

        activeController = localController

        // Dispatch to Wallet UI host listeners
        for (const listener of sessionPreparedListeners) {
          try {
            listener(session, localController)
          } catch (err) {
            console.error('Wallet UI host onSessionPrepared listener failed:', err)
          }
        }

        return session
      } finally {
        isPreparing = false
      }
    }

    async function getExecutionStatus(executionId: string): Promise<PublicExecutionStatus | undefined> {
      const record = await executionLedger.get(executionId)
      if (!record) return undefined

      // P0-2: Strip raw signed tx hex from public status
      return Object.freeze({
        executionId: record.executionId,
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        decisionId: record.decisionId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: record.amountSats,
        network: record.network,
        status: record.status ?? (record as any).state,
        planHash: record.planHash,
        uncertainReason: record.uncertainReason,
        reservedAt: record.reservedAt,
        preparedAt: record.preparedAt,
        signingAt: record.signingAt,
        signedAt: record.signedAt,
        failedAt: record.failedAt
      })
    }

    const publicEngine: AgentWalletExecutionEngine = Object.freeze({
      prepareExecution,
      getExecutionStatus
    })

    const walletUIHost: WalletExecutionUIHost = Object.freeze({
      onSessionPrepared(
        handler: (
          session: WalletExecutionReviewSession,
          localController: WalletLocalConfirmationController
        ) => void
      ): () => void {
        sessionPreparedListeners.add(handler)
        return () => {
          sessionPreparedListeners.delete(handler)
        }
      },
      getActiveController(): WalletLocalConfirmationController | undefined {
        return activeController ?? undefined
      }
    })

    return {
      publicEngine,
      walletUIHost
    }
  }

  /**
   * Helper that returns the public Agent-facing engine.
   * Strictly exposes NO confirm, sign, execute, or local confirmation controller.
   */
  export function createAgentWalletExecutionEngine(
    config: AgentWalletExecutionEngineConfig
  ): AgentWalletExecutionEngine {
    return createWalletExecutionComposition(config).publicEngine
  }
