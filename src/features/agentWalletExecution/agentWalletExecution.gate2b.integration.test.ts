/**
 * @file agentWalletExecution.gate2b.integration.test.ts
 *
 * REAL Gate 2B → Gate C2 contract integration.
 *
 * The primary fixture is produced by the actual Gate 2B receiver:
 * WalletApprovalRequestV1 → human approve/reject → canonical HumanApprovalV1
 * → recorded WalletApprovalLedgerRecord → C2 prepareExecution.
 */

import { describe, expect, it } from 'vitest'
import { Script, toHex } from 'ecash-lib'
import { humanApprovalV1Schema, type HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import { encodeAgentWalletHandoffV1 } from '../agentWalletHandoff'
import { createAgentWalletApprovalReceiver } from '../agentWalletApprovalReceiver/receiver'
import {
  InMemoryWalletApprovalLedger,
  createMockSessionVerifier
} from '../agentWalletApprovalReceiver/testUtils'
import { createWalletExecutionComposition } from '../../internal/agentWalletExecutionHost'
import { ALL_BIP143, Ecc, P2PKHSignatory } from 'ecash-lib'
import { DurableTransactionalExecutionLedger } from './ledger'
import { MockStorage, TestExecutionLockCoordinator } from './testUtils'
import type { ExecutionUtxoInput } from './types'

const FROM_ADDRESS = 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv'
const DESTINATION_ADDRESS = 'ecash:qr4upmst92u7sfm6vqxz29r4ug4rysdpcyk8hcgvqm'
const CLOCK_NOW = 1_770_000_010

const BASE_VALID_REQUEST = {
  contractVersion: '1.0',
  kind: 'wallet_approval_request' as const,
  requestId: 'req-c2-g2b-approved-001',
  purpose: 'xec_payment' as const,
  intent: {
    contractVersion: '1.0',
    kind: 'agent_intent' as const,
    intentId: 'intent-c2-g2b-approved-001',
    nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
    agentId: 'agent-treasury-01',
    agentRole: 'service_executor',
    network: 'xec:mainnet' as const,
    fromAddress: FROM_ADDRESS,
    toAddress: DESTINATION_ADDRESS,
    amountSats: '500000',
    reason: 'Autonomous payout test',
    memo: 'Invoice 101',
    createdAt: 1770000000,
    expiresAt: 1770000300
  },
  policyDecision: {
    contractVersion: '1.0',
    kind: 'cae_policy_decision' as const,
    decisionId: 'cae-c2-g2b-approved-001',
    intentId: 'intent-c2-g2b-approved-001',
    decision: 'needs_human_approval' as const,
    reasonCode: 'AMOUNT_EXCEEDS_LIMIT',
    reason: 'Requires custodian sign-off',
    policyTraceId: 'trace-c2-g2b-approved-001',
    policyVersion: 'cae-policy-v1.0.0',
    evaluatedAt: 1770000001,
    expiresAt: 1770000300
  },
  requestedAt: 1770000002,
  expiresAt: 1770000300
}

function createSignatory() {
  const ecc = new Ecc()
  const secretKey = new Uint8Array(32).fill(9)
  const publicKey = ecc.derivePubkey(secretKey)
  return P2PKHSignatory(secretKey, publicKey, ALL_BIP143)
}

function createFundingUtxos(): ExecutionUtxoInput[] {
  return [
    {
      txid: '33'.repeat(32),
      outIdx: 0,
      sats: 1_000_000n,
      lockingScriptHex: toHex(Script.fromAddress(FROM_ADDRESS).bytecode)
    }
  ]
}

describe('Gate 2B → Gate C2 real contract integration', () => {
  it('feeds a real Gate 2B approved HumanApprovalV1 into C2 and reaches PREPARED', async () => {
    const approvalLedger = new InMemoryWalletApprovalLedger()
    let receiverSeq = 0
    const receiver = createAgentWalletApprovalReceiver({
      ledger: approvalLedger,
      sessionVerifier: createMockSessionVerifier(FROM_ADDRESS),
      clock: () => CLOCK_NOW,
      idGenerator: () => `g2b_appr_${++receiverSeq}`,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const review = await receiver.prepareHandoff(encodeAgentWalletHandoffV1(BASE_VALID_REQUEST))
    const receipt = await receiver.approveHandle(review.handle)

    expect(humanApprovalV1Schema.parse(receipt).status).toBe('approved')
    expect(receipt).not.toHaveProperty('network')
    expect(receipt).not.toHaveProperty('presentationHash')
    expect(receipt).not.toHaveProperty('contentHash')
    expect(receipt).not.toHaveProperty('schema')
    expect(receipt.kind).toBe('human_approval')
    expect(receipt.contractVersion).toBe('1.0')

    const recorded = await approvalLedger.get(BASE_VALID_REQUEST.requestId)
    expect(recorded).toBeDefined()
    expect(recorded!.status).toBe('approved')
    expect(recorded!.humanApproval.status).toBe('approved')
    expect(recorded!.network).toBe('xec:mainnet')
    expect(recorded!.amountSats).toBe('500000')

    const storage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const composition = createWalletExecutionComposition({
      approvalLedger,
      executionLedger: new DurableTransactionalExecutionLedger({ storage, lockCoordinator }),
      sessionVerifier: {
        async verifyActiveSession() {
          return { authenticated: true, activeAddress: FROM_ADDRESS }
        }
      },
      utxoProvider: {
        async getSpendableUtxos() {
          return createFundingUtxos()
        }
      },
      signatoryProvider: {
        async getSignatory() {
          return createSignatory()
        }
      },
      storage,
      lockCoordinator,
      clock: () => CLOCK_NOW,
      idGenerator: () => 'c2_from_g2b'
    })

    const session = await composition.publicEngine.prepareExecution(receipt)
    expect(session.plan.network).toBe('xec:mainnet')
    expect(session.plan.destination).toBe(DESTINATION_ADDRESS)
    expect(session.plan.paymentAmountSats).toBe(500_000n)
    expect(session.review.network).toBe('xec:mainnet')

    const status = await composition.publicEngine.getExecutionStatus(session.executionId)
    expect(status?.status).toBe('PREPARED')
  })

  it('rejects a real Gate 2B rejected decision, including a receipt whose status was flipped to approved', async () => {
    const approvalLedger = new InMemoryWalletApprovalLedger()
    let receiverSeq = 0
    const rejectRequest = {
      ...BASE_VALID_REQUEST,
      requestId: 'req-c2-g2b-rejected-001',
      intent: {
        ...BASE_VALID_REQUEST.intent,
        intentId: 'intent-c2-g2b-rejected-001'
      },
      policyDecision: {
        ...BASE_VALID_REQUEST.policyDecision,
        decisionId: 'cae-c2-g2b-rejected-001',
        intentId: 'intent-c2-g2b-rejected-001'
      }
    }

    const receiver = createAgentWalletApprovalReceiver({
      ledger: approvalLedger,
      sessionVerifier: createMockSessionVerifier(FROM_ADDRESS),
      clock: () => CLOCK_NOW,
      idGenerator: () => `g2b_rej_${++receiverSeq}`,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const review = await receiver.prepareHandoff(encodeAgentWalletHandoffV1(rejectRequest))
    const rejectedReceipt = await receiver.rejectHandle(review.handle, {
      reason: 'Custodian rejected the payment'
    })

    expect(humanApprovalV1Schema.parse(rejectedReceipt).status).toBe('rejected')
    const recorded = await approvalLedger.get(rejectRequest.requestId)
    expect(recorded).toBeDefined()
    expect(recorded!.status).toBe('rejected')
    expect(recorded!.humanApproval.status).toBe('rejected')

    const storage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const composition = createWalletExecutionComposition({
      approvalLedger,
      executionLedger: new DurableTransactionalExecutionLedger({ storage, lockCoordinator }),
      sessionVerifier: {
        async verifyActiveSession() {
          return { authenticated: true, activeAddress: FROM_ADDRESS }
        }
      },
      utxoProvider: {
        async getSpendableUtxos() {
          return createFundingUtxos()
        }
      },
      signatoryProvider: {
        async getSignatory() {
          return createSignatory()
        }
      },
      storage,
      lockCoordinator,
      clock: () => CLOCK_NOW,
      idGenerator: () => 'c2_from_g2b_rej'
    })

    await expect(composition.publicEngine.prepareExecution(rejectedReceipt)).rejects.toMatchObject({
      code: 'RECEIPT_NOT_APPROVED'
    })

    const forgedApproved: HumanApprovalV1 = humanApprovalV1Schema.parse({
      ...rejectedReceipt,
      status: 'approved'
    }) as HumanApprovalV1

    await expect(composition.publicEngine.prepareExecution(forgedApproved)).rejects.toMatchObject({
      code: 'RECEIPT_NOT_APPROVED'
    })

    expect(await composition.publicEngine.getExecutionStatus('exec_c2_from_g2b_rej')).toBeUndefined()
  })
})
