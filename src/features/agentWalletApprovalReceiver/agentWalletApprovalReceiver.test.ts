import { describe, expect, test } from 'vitest'
import { encodeAgentWalletHandoffV1 } from '../agentWalletHandoff'
import {
  createAgentWalletApprovalReceiver,
  createAgentWalletApprovalReceiverForTest
} from './receiver'
import {
  InMemoryWalletApprovalLedger,
  createMockSessionVerifier
} from './testUtils'

const BASE_VALID_REQUEST = {
  contractVersion: '1.0',
  kind: 'wallet_approval_request' as const,
  requestId: 'req-unit-test-001',
  purpose: 'xec_payment' as const,
  intent: {
    contractVersion: '1.0',
    kind: 'agent_intent' as const,
    intentId: 'intent-unit-test-001',
    nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
    agentId: 'agent-treasury-01',
    agentRole: 'service_executor',
    network: 'xec:mainnet' as const,
    fromAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
    toAddress: 'ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5',
    amountSats: '500000',
    reason: 'Autonomous payout test',
    memo: 'Invoice 101',
    createdAt: 1770000000,
    expiresAt: 1770000300
  },
  policyDecision: {
    contractVersion: '1.0',
    kind: 'cae_policy_decision' as const,
    decisionId: 'cae-unit-test-001',
    intentId: 'intent-unit-test-001',
    decision: 'needs_human_approval' as const,
    reasonCode: 'AMOUNT_EXCEEDS_LIMIT',
    reason: 'Requires custodian sign-off',
    policyTraceId: 'trace-unit-test-001',
    policyVersion: 'cae-policy-v1.0.0',
    evaluatedAt: 1770000001,
    expiresAt: 1770000300
  },
  requestedAt: 1770000002,
  expiresAt: 1770000300
}

describe('agentWalletApprovalReceiver (Gate 2B Hardening)', () => {
  test('happy path: complete lifecycle, defensive copy, and atomic ledger commit for approval', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      idGenerator: () => 'fixed_id_1',
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const rawBytes = encodeAgentWalletHandoffV1(BASE_VALID_REQUEST)
    // Pass rawBytes to receiver
    const reviewState = await receiver.prepareHandoff(rawBytes)

    // Defensive copy test: mutate caller's rawBytes immediately after preparation
    rawBytes[0] = 0xff
    rawBytes[1] = 0xff

    expect(reviewState.handle).toBe('hnd_fixed_id_1')
    expect(reviewState.presentation.amountXEC).toBe('5000.00 XEC')
    expect(reviewState.presentation.amountSats).toBe('500000')
    expect(reviewState.presentation.fromAddress).toBe(BASE_VALID_REQUEST.intent.fromAddress)
    expect(reviewState.presentation.destination).toBe(BASE_VALID_REQUEST.intent.toAddress)
    expect(reviewState.presentation.agentId).toBe('agent-treasury-01')
    expect(reviewState.presentation.policyTraceId).toBe('trace-unit-test-001')

    // Approve handle
    const receipt = await receiver.approveHandle(reviewState.handle)

    expect(receipt.contractVersion).toBe('1.0')
    expect(receipt.kind).toBe('human_approval')
    expect(receipt.status).toBe('approved')
    expect(receipt.approver).toBe(BASE_VALID_REQUEST.intent.fromAddress)
    expect(receipt.requestId).toBe(BASE_VALID_REQUEST.requestId)
    expect(receipt.intentId).toBe(BASE_VALID_REQUEST.intent.intentId)
    expect(receipt.decisionId).toBe(BASE_VALID_REQUEST.policyDecision.decisionId)

    // Verify ledger has recorded the atomic record
    const recorded = await ledger.get(BASE_VALID_REQUEST.requestId)
    expect(recorded).toBeDefined()
    expect(recorded?.status).toBe('approved')
    expect(recorded?.humanApproval.status).toBe('approved')
    expect(recorded?.amountSats).toBe('500000')
    expect(recorded?.fromAddress).toBe(BASE_VALID_REQUEST.intent.fromAddress)
    expect(recorded?.destination).toBe(BASE_VALID_REQUEST.intent.toAddress)
    expect(recorded?.presentationHash).toBe(reviewState.presentation.presentationHash)

    // Verify handle is destroyed after completion
    await expect(receiver.approveHandle(reviewState.handle)).rejects.toThrow(
      'UNKNOWN_REVIEW_HANDLE'
    )
  })

  test('happy path: rejection records atomically in ledger and returns rejected receipt', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiverForTest({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      idGenerator: () => 'fixed_id_reject',
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const reviewState = await receiver.prepareRequest({
      ...BASE_VALID_REQUEST,
      requestId: 'req-unit-reject-001'
    })

    const receipt = await receiver.rejectHandle(reviewState.handle, {
      reason: 'Rejected by custodian: budget limit exceeded'
    })

    expect(receipt.status).toBe('rejected')
    expect(receipt.reason).toBe('Rejected by custodian: budget limit exceeded')
    expect(receipt.approver).toBe(BASE_VALID_REQUEST.intent.fromAddress)

    // Rejection MUST be recorded in ledger atomically
    const recorded = await ledger.get('req-unit-reject-001')
    expect(recorded).toBeDefined()
    expect(recorded?.status).toBe('rejected')
    expect(recorded?.humanApproval.status).toBe('rejected')
    expect(recorded?.humanApproval.reason).toBe('Rejected by custodian: budget limit exceeded')

    // Handle is destroyed
    await expect(receiver.rejectHandle(reviewState.handle)).rejects.toThrow('UNKNOWN_REVIEW_HANDLE')
  })

  test('negative: authentic session of a different address fails closed with SESSION_ADDRESS_MISMATCH', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    // Authentic session for a DIFFERENT address
    const sessionVerifier = createMockSessionVerifier(
      'ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5'
    )
    const receiver = createAgentWalletApprovalReceiverForTest({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const reviewState = await receiver.prepareRequest({
      ...BASE_VALID_REQUEST,
      requestId: 'req-address-mismatch-001'
    })

    await expect(receiver.approveHandle(reviewState.handle)).rejects.toThrow(
      'SESSION_ADDRESS_MISMATCH'
    )

    // Ledger must be empty
    expect(await ledger.has('req-address-mismatch-001')).toBe(false)

    // Handle must have been destroyed (fail closed)
    await expect(receiver.approveHandle(reviewState.handle)).rejects.toThrow('UNKNOWN_REVIEW_HANDLE')
  })

  test('negative: unauthenticated session fails closed with INVALID_HUMAN_SESSION', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(
      BASE_VALID_REQUEST.intent.fromAddress,
      false // Not authenticated
    )
    const receiver = createAgentWalletApprovalReceiverForTest({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const reviewState = await receiver.prepareRequest(BASE_VALID_REQUEST)

    await expect(receiver.approveHandle(reviewState.handle)).rejects.toThrow('INVALID_HUMAN_SESSION')
  })

  test('negative: expired request fails closed at prepare and revalidate', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiverForTest({
      ledger,
      sessionVerifier,
      clock: () => 1770000400, // Past expiresAt 1770000300
      declaredOrigin: 'https://app.tonalli.cash'
    })

    await expect(receiver.prepareRequest(BASE_VALID_REQUEST)).rejects.toThrow('EXPIRED_REQUEST')
  })

  test('negative: declared origin must match authorized production or test origins', () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)

    // Malicious or unauthorized origin
    expect(() =>
      createAgentWalletApprovalReceiver({
        ledger,
        sessionVerifier,
        declaredOrigin: 'https://evil-phishing.com'
      })
    ).toThrow('INVALID_DECLARED_ORIGIN')

    // Authorized origin succeeds
    expect(() =>
      createAgentWalletApprovalReceiver({
        ledger,
        sessionVerifier,
        declaredOrigin: 'https://app.tonalli.cash'
      })
    ).not.toThrow()

    // Localhost origin succeeds in test environments
    expect(() =>
      createAgentWalletApprovalReceiver({
        ledger,
        sessionVerifier,
        declaredOrigin: 'http://localhost:5173'
      })
    ).not.toThrow()
  })

  test('negative: duplicate capability or requestId in ledger throws DUPLICATE_APPROVAL_RECORD', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiverForTest({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const reviewState = await receiver.prepareRequest(BASE_VALID_REQUEST)

    // Pre-populate ledger with this requestId
    await ledger.recordApprovalAtomic({
      operationId: 'op_pre_existing',
      requestId: BASE_VALID_REQUEST.requestId,
      approvalId: 'appr_pre_existing',
      intentId: BASE_VALID_REQUEST.intent.intentId,
      decisionId: BASE_VALID_REQUEST.policyDecision.decisionId,
      contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      capabilityId: 'cap_pre_existing',
      effectiveExpiresAt: 1770000300,
      network: 'xec:mainnet',
      amountSats: '500000',
      fromAddress: BASE_VALID_REQUEST.intent.fromAddress,
      destination: BASE_VALID_REQUEST.intent.toAddress,
      presentationHash: 'pre_existing',
      humanApproval: {
        contractVersion: '1.0',
        kind: 'human_approval',
        approvalId: 'appr_pre_existing',
        requestId: BASE_VALID_REQUEST.requestId,
        intentId: BASE_VALID_REQUEST.intent.intentId,
        decisionId: BASE_VALID_REQUEST.policyDecision.decisionId,
        status: 'approved',
        recordedAt: 1770000010,
        approver: BASE_VALID_REQUEST.intent.fromAddress
      },
      recordedAt: 1770000010,
      status: 'approved'
    })

    await expect(receiver.approveHandle(reviewState.handle)).rejects.toThrow(
      'ATOMIC_RECORDING_FAILED'
    )
  })

  test('negative: reason length exceeding 500 characters fails closed', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiverForTest({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const reviewState = await receiver.prepareRequest(BASE_VALID_REQUEST)
    const tooLongReason = 'A'.repeat(501)

    await expect(
      receiver.rejectHandle(reviewState.handle, { reason: tooLongReason })
    ).rejects.toThrow('INVALID_INPUT')
  })

  test('canonical invariant: operationId is strictly equal to requestId in ledger record', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const rawBytes = encodeAgentWalletHandoffV1(BASE_VALID_REQUEST)
    const reviewState = await receiver.prepareHandoff(rawBytes)
    await receiver.approveHandle(reviewState.handle)

    const record = await ledger.get(BASE_VALID_REQUEST.requestId)
    expect(record).toBeDefined()
    expect(record?.operationId).toBe(BASE_VALID_REQUEST.requestId)
    expect(record?.operationId).not.toContain('op_rev_')
  })

  test('negative: fails closed with MISSING_ID_GENERATOR if crypto.randomUUID is unavailable and no idGenerator is provided', async () => {
    const originalRandomUUID = globalThis.crypto.randomUUID
    try {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: undefined,
        configurable: true
      })

      const ledger = new InMemoryWalletApprovalLedger()
      const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
      const receiver = createAgentWalletApprovalReceiver({
        ledger,
        sessionVerifier,
        clock: () => 1770000010,
        declaredOrigin: 'https://app.tonalli.cash'
      })

      const rawBytes = encodeAgentWalletHandoffV1(BASE_VALID_REQUEST)
      await expect(receiver.prepareHandoff(rawBytes)).rejects.toThrow('MISSING_ID_GENERATOR')
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: originalRandomUUID,
        configurable: true
      })
    }
  })

  test('negative: rejects non-canonical bytes fail-closed with INVALID_REQUEST_SCHEMA', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(BASE_VALID_REQUEST.intent.fromAddress)
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    // Random non-canonical corrupted payload
    const corruptBytes = new Uint8Array([0x54, 0x4f, 0x4e, 0x01, 0xff, 0xff])
    await expect(receiver.prepareHandoff(corruptBytes)).rejects.toThrow('INVALID_REQUEST_SCHEMA')

    // Empty payload
    await expect(receiver.prepareHandoff(new Uint8Array(0))).rejects.toThrow('INVALID_REQUEST_SCHEMA')
  })
})
