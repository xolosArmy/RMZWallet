import { describe, expect, test } from 'vitest'
import {
  AGENTIC_CONTRACT_VERSION,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import { encodeAgentWalletHandoffV1 } from '../agentWalletHandoff'
import {
  validateAndPresentApprovalRequest,
  recordWalletHumanDecision,
  WalletApprovalReceiverError,
  type HumanDecisionInput
} from './index'

const BASE_VALID_INTENT = {
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: 'agent_intent' as const,
  intentId: 'intent-wallet-rcv-001',
  nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
  agentId: 'agent-reviewer-402',
  agentRole: 'service_executor',
  network: 'xec:mainnet' as const,
  fromAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
  toAddress: 'ecash:qp3wjpa3tjlj042z2wv7hahvd8whzgcwvue2swknmw',
  amountSats: '150000',
  reason: 'Invoice payment for RPC access',
  memo: 'RPC query bundle',
  createdAt: 1770000000,
  expiresAt: 1770000300
}

const BASE_VALID_POLICY_DECISION = {
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: 'cae_policy_decision' as const,
  decisionId: 'cae-dec-rcv-001',
  intentId: 'intent-wallet-rcv-001',
  decision: 'needs_human_approval' as const,
  reasonCode: 'THRESHOLD_EXCEEDED',
  reason: 'Transfer amount exceeds autonomous threshold',
  policyTraceId: 'trace-rcv-policy-001',
  policyVersion: 'constitution-2026-v1.0',
  evaluatedAt: 1770000001,
  expiresAt: 1770000300
}

function createValidRequest(overrides?: Partial<WalletApprovalRequestV1>): WalletApprovalRequestV1 {
  return {
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: 'wallet_approval_request',
    requestId: 'req-rcv-test-001',
    purpose: 'xec_payment',
    intent: { ...BASE_VALID_INTENT },
    policyDecision: { ...BASE_VALID_POLICY_DECISION },
    requestedAt: 1770000002,
    expiresAt: 1770000300,
    ...overrides
  }
}

describe('agentWalletApprovalReceiver', () => {
  test('validates direct WalletApprovalRequestV1 and produces presentation', () => {
    const request = createValidRequest()
    const result = validateAndPresentApprovalRequest(request, {
      nowEpochSeconds: () => 1770000010
    })

    expect(result.request.requestId).toBe('req-rcv-test-001')
    expect(result.presentation.amountSats).toBe('150000')
    expect(result.presentation.amountXEC).toBe('1500.00 XEC')
    expect(result.presentation.destination).toBe(BASE_VALID_INTENT.toAddress)
    expect(result.presentation.network).toBe('xec:mainnet')
    expect(result.presentation.policyTraceId).toBe('trace-rcv-policy-001')
  })

  test('validates encoded byte array input via decodeAgentWalletHandoffV1', () => {
    const request = createValidRequest()
    const encodedBytes = encodeAgentWalletHandoffV1(request)

    const result = validateAndPresentApprovalRequest(encodedBytes, {
      nowEpochSeconds: () => 1770000010
    })

    expect(result.request.requestId).toBe('req-rcv-test-001')
    expect(result.presentation.amountXEC).toBe('1500.00 XEC')
  })

  test('records explicit human approval with valid approver', () => {
    const request = createValidRequest()
    const approval = recordWalletHumanDecision(
      request,
      {
        decision: 'approved',
        approver: 'wallet-custodian-xolos',
        reason: 'Confirmed valid RPC spend'
      },
      {
        nowEpochSeconds: () => 1770000025,
        idGenerator: () => 'appr-fixed-id-123'
      }
    )

    expect(approval.contractVersion).toBe(AGENTIC_CONTRACT_VERSION)
    expect(approval.kind).toBe('human_approval')
    expect(approval.status).toBe('approved')
    expect(approval.approver).toBe('wallet-custodian-xolos')
    expect(approval.approvalId).toBe('appr-fixed-id-123')
    expect(approval.requestId).toBe(request.requestId)
    expect(approval.intentId).toBe(request.intent.intentId)
    expect(approval.decisionId).toBe(request.policyDecision.decisionId)
    expect(approval.recordedAt).toBe(1770000025)

    // Security invariant: NO transaction fields present
    const approvalRecord = approval as unknown as Record<string, unknown>
    expect(approvalRecord.signedTransaction).toBeUndefined()
    expect(approvalRecord.rawTx).toBeUndefined()
    expect(approvalRecord.txid).toBeUndefined()
  })

  test('records explicit human rejection without requiring approver', () => {
    const request = createValidRequest()
    const approval = recordWalletHumanDecision(
      request,
      {
        decision: 'rejected',
        reason: 'Suspicious destination'
      },
      {
        nowEpochSeconds: () => 1770000025
      }
    )

    expect(approval.status).toBe('rejected')
    expect(approval.approver).toBeUndefined()
    expect(approval.reason).toBe('Suspicious destination')
  })

  test('fails closed if human decision is approved but approver is missing', () => {
    const request = createValidRequest()

    expect(() =>
      recordWalletHumanDecision(request, { decision: 'approved' })
    ).toThrowError(WalletApprovalReceiverError)

    try {
      recordWalletHumanDecision(request, { decision: 'approved' })
    } catch (err: unknown) {
      expect((err as WalletApprovalReceiverError).code).toBe('MISSING_HUMAN_APPROVER')
    }
  })

  test('fails closed if decision is recorded after request expiration', () => {
    const request = createValidRequest()

    expect(() =>
      recordWalletHumanDecision(
        request,
        { decision: 'approved', approver: 'alice' },
        { nowEpochSeconds: () => 1770000301 } // after expiresAt (1770000300)
      )
    ).toThrowError(WalletApprovalReceiverError)

    try {
      recordWalletHumanDecision(
        request,
        { decision: 'approved', approver: 'alice' },
        { nowEpochSeconds: () => 1770000301 }
      )
    } catch (err: unknown) {
      expect((err as WalletApprovalReceiverError).code).toBe('EXPIRED_REQUEST')
    }
  })

  test('fails closed if intentId is tampered between policyDecision and intent', () => {
    const baseReq = createValidRequest()
    const tamperedReq = {
      ...baseReq,
      policyDecision: {
        ...baseReq.policyDecision,
        intentId: 'tampered-intent-id'
      }
    }

    expect(() =>
      validateAndPresentApprovalRequest(tamperedReq, {
        nowEpochSeconds: () => 1770000010
      })
    ).toThrowError(WalletApprovalReceiverError)

    try {
      validateAndPresentApprovalRequest(tamperedReq, {
        nowEpochSeconds: () => 1770000010
      })
    } catch (err: unknown) {
      expect((err as WalletApprovalReceiverError).code).toBe('INVALID_REQUEST_SCHEMA')
    }
  })

  test('fails closed if policy trace ID is empty', () => {
    const baseReq = createValidRequest()
    const tamperedReq = {
      ...baseReq,
      policyDecision: {
        ...baseReq.policyDecision,
        policyTraceId: '   '
      }
    }

    expect(() =>
      validateAndPresentApprovalRequest(tamperedReq, {
        nowEpochSeconds: () => 1770000010
      })
    ).toThrowError(WalletApprovalReceiverError)

    try {
      validateAndPresentApprovalRequest(tamperedReq, {
        nowEpochSeconds: () => 1770000010
      })
    } catch (err: unknown) {
      expect((err as WalletApprovalReceiverError).code).toBe('INVALID_REQUEST_SCHEMA')
    }
  })

  test('fails closed if request has expired prior to validation', () => {
    const request = createValidRequest()

    expect(() =>
      validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000305 // expired
      })
    ).toThrowError(WalletApprovalReceiverError)

    try {
      validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000305
      })
    } catch (err: unknown) {
      expect((err as WalletApprovalReceiverError).code).toBe('EXPIRED_REQUEST')
    }
  })

  test('fails closed on invalid human action type', () => {
    const request = createValidRequest()
    const invalidAction = { decision: 'maybe' } as unknown as HumanDecisionInput

    expect(() =>
      recordWalletHumanDecision(request, invalidAction)
    ).toThrowError(WalletApprovalReceiverError)

    try {
      recordWalletHumanDecision(request, invalidAction)
    } catch (err: unknown) {
      expect((err as WalletApprovalReceiverError).code).toBe('INVALID_HUMAN_ACTION')
    }
  })
})
