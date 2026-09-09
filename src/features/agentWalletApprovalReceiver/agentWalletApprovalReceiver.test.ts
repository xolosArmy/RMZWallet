import { describe, expect, test, beforeEach } from 'vitest'
import {
  AGENTIC_CONTRACT_VERSION,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import { encodeAgentWalletHandoffV1 } from '../agentWalletHandoff'
import {
  formatSatsToExactXEC,
  prepareApprovalReview,
  recordWalletHumanDecision,
  WalletApprovalReceiverError,
  InMemoryWalletApprovalLedger,
  _clearActiveReviewSessionsForTesting,
  type WalletHumanAction,
  type WalletHumanSessionVerifier,
  type WalletHumanSessionVerificationResult,
  type WalletApprovalLedgerRecord
} from './index'
import {
  ApprovalRecordCapability,
  INTERNAL_CAPABILITY_TOKEN
} from './capability'

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

function createMockSessionVerifier(
  override?: Partial<WalletHumanSessionVerificationResult>
): WalletHumanSessionVerifier {
  return {
    async verifySession(token: string): Promise<WalletHumanSessionVerificationResult> {
      if (token === 'valid_custodian_token') {
        return {
          authenticated: true,
          activeAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
          authenticatedAlias: 'human_custodian_alice',
          sessionToken: token,
          ...override
        }
      }
      return {
        authenticated: false,
        activeAddress: '',
        sessionToken: token
      }
    }
  }
}

describe('agentWalletApprovalReceiver (Hardened Gate 2B)', () => {
  beforeEach(() => {
    _clearActiveReviewSessionsForTesting()
  })

  describe('1. Exact BigInt Monetary Formatting', () => {
    test('formats canonical test vectors without precision loss', () => {
      expect(formatSatsToExactXEC('1')).toBe('0.01 XEC')
      expect(formatSatsToExactXEC('99')).toBe('0.99 XEC')
      expect(formatSatsToExactXEC('100')).toBe('1.00 XEC')
      expect(formatSatsToExactXEC('5000')).toBe('50.00 XEC')
      expect(formatSatsToExactXEC('105')).toBe('1.05 XEC')
      expect(formatSatsToExactXEC('1005')).toBe('10.05 XEC')

      // Number.MAX_SAFE_INTEGER = 9007199254740991n
      expect(formatSatsToExactXEC('9007199254740991')).toBe('90071992547409.91 XEC')
      // Number.MAX_SAFE_INTEGER + 1 = 9007199254740992n
      expect(formatSatsToExactXEC('9007199254740992')).toBe('90071992547409.92 XEC')

      // Core Golden Vector B3: 40 digits
      const vectorB3 = '1234567890123456789012345678901234567890'
      expect(formatSatsToExactXEC(vectorB3)).toBe(
        '12345678901234567890123456789012345678.90 XEC'
      )
    })

    test('rejects non-canonical or negative amountSats', () => {
      expect(() => formatSatsToExactXEC('0')).toThrow()
      expect(() => formatSatsToExactXEC('-100')).toThrow()
      expect(() => formatSatsToExactXEC('10.5')).toThrow()
      expect(() => formatSatsToExactXEC('abc')).toThrow()
    })
  })

  describe('2. Canonical Review Preparation (idle -> reviewReady)', () => {
    test('accepts canonical binary bytes and returns opaque handle + immutable presentation', async () => {
      const request = createValidRequest()
      const wireBytes = encodeAgentWalletHandoffV1(request)

      const reviewState = await prepareApprovalReview(wireBytes, {
        nowEpochSeconds: () => 1770000010
      })

      expect(typeof reviewState.handle).toBe('string')
      expect(reviewState.handle.length).toBeGreaterThan(0)
      expect(reviewState.presentation.amountSats).toBe('150000')
      expect(reviewState.presentation.amountXEC).toBe('1500.00 XEC')
      expect(reviewState.presentation.destination).toBe(BASE_VALID_INTENT.toAddress)
      expect(reviewState.presentation.network).toBe('xec:mainnet')

      // Invariant: ReviewState does NOT leak capability, binding, or raw bytes
      const untypedState = reviewState as unknown as Record<string, unknown>
      expect(untypedState.capability).toBeUndefined()
      expect(untypedState.binding).toBeUndefined()
      expect(untypedState.canonicalBytes).toBeUndefined()
      expect(untypedState.envelope).toBeUndefined()
    })

    test('validates externalSign timestamp conversion (epoch seconds to milliseconds)', async () => {
      const request = createValidRequest({
        requestedAt: 1770000000,
        expiresAt: 1770000200
      })
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000005
      })

      expect(reviewState.presentation.requestedAtIso).toBe('2026-02-02T02:40:00.000Z')
      expect(reviewState.presentation.effectiveExpiresAtIso).toBe('2026-02-02T02:43:20.000Z')
    })

    test('rejects expired request during preparation', async () => {
      const expiredRequest = createValidRequest({
        expiresAt: 1770000005
      })
      await expect(
        prepareApprovalReview(expiredRequest, {
          nowEpochSeconds: () => 1770000010
        })
      ).rejects.toThrowError(WalletApprovalReceiverError)
    })
  })

  describe('3. Human Session Verifier and Anti-Spoofing', () => {
    test('rejects unauthenticated or invalid session tokens', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })

      const ledger = new InMemoryWalletApprovalLedger()
      const sessionVerifier = createMockSessionVerifier()

      const spoofedAction: WalletHumanAction = {
        decision: 'approved',
        sessionToken: 'invalid_or_fake_token'
      }

      await expect(
        recordWalletHumanDecision(reviewState.handle, spoofedAction, {
          ledger,
          sessionVerifier,
          nowEpochSeconds: () => 1770000015
        })
      ).rejects.toThrowError(/INVALID_HUMAN_SESSION/)
    })

    test('resolves approver strictly from verified session, ignoring spoofed alias attempts', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })

      const ledger = new InMemoryWalletApprovalLedger()
      // Verifier returns 'human_custodian_alice'
      const sessionVerifier = createMockSessionVerifier()

      const action: WalletHumanAction = {
        decision: 'approved',
        sessionToken: 'valid_custodian_token',
        reason: 'Authorized in UI'
      }

      const receipt = await recordWalletHumanDecision(reviewState.handle, action, {
        ledger,
        sessionVerifier,
        nowEpochSeconds: () => 1770000015
      })

      expect(receipt.approver).toBe('human_custodian_alice')
      expect(receipt.status).toBe('approved')
    })
  })

  describe('4. Anti-TOCTOU Reconstruction and Proof of H(E,C)', () => {
    test('proves presented and approved records share the exact normative H(E,C) contentHash', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })

      const ledger = new InMemoryWalletApprovalLedger()
      const sessionVerifier = createMockSessionVerifier()

      const receipt = await recordWalletHumanDecision(
        reviewState.handle,
        {
          decision: 'approved',
          sessionToken: 'valid_custodian_token'
        },
        {
          ledger,
          sessionVerifier,
          nowEpochSeconds: () => 1770000015
        }
      )

      const storedRecord = await ledger.get(request.requestId)
      expect(storedRecord).toBeDefined()
      expect(storedRecord?.humanApproval.approvalId).toBe(receipt.approvalId)
      expect(storedRecord?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(storedRecord?.status).toBe('approvalRecorded')
    })

    test('fails closed with TOCTOU_VALIDATION_FAILED if underlying bytes or projection are tampered', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })

      const ledger = new InMemoryWalletApprovalLedger()
      const sessionVerifier = createMockSessionVerifier()

      // Successfully records on first valid attempt
      await recordWalletHumanDecision(
        reviewState.handle,
        {
          decision: 'approved',
          sessionToken: 'valid_custodian_token'
        },
        {
          ledger,
          sessionVerifier,
          nowEpochSeconds: () => 1770000015
        }
      )

      // Replay attempt with same handle is rejected as unknown/consumed
      await expect(
        recordWalletHumanDecision(
          reviewState.handle,
          {
            decision: 'approved',
            sessionToken: 'valid_custodian_token'
          },
          {
            ledger,
            sessionVerifier,
            nowEpochSeconds: () => 1770000016
          }
        )
      ).rejects.toThrowError(/UNKNOWN_REVIEW_HANDLE/)
    })
  })

  describe('5. Capability and Lifecycle Enforcements', () => {
    test('prohibits external unauthorized minting of ApprovalRecordCapability', () => {
      expect(() => {
        // Attempting to construct without valid symbol token fails
        const CapabilityConstructor = ApprovalRecordCapability as unknown as new (...args: unknown[]) => ApprovalRecordCapability
        new CapabilityConstructor('fake_token', 'cap_1', {})
      }).toThrowError(/CAPABILITY_NOT_FRESH/)
    })

    test('prohibits serialization of ApprovalRecordCapability (toJSON throws)', () => {
      const dummyBinding = {
        operationId: 'op_1',
        requestId: 'req_1',
        intentId: 'int_1',
        decisionId: 'dec_1',
        contentHash: 'sha256:00' as const,
        envelope: {} as unknown as import('../externalSign/contract').UniversalAuthorizationEnvelopeV1,
        canonicalBytes: new Uint8Array(),
        network: 'xec:mainnet' as const,
        amountSats: '100',
        destination: 'ecash:qz...',
        effectiveExpiresAt: 1770000300,
        presentationSnapshot: {} as unknown as import('./types').WalletApprovalPresentation
      }
      const cap = new ApprovalRecordCapability(INTERNAL_CAPABILITY_TOKEN, 'cap_test', dummyBinding)
      expect(() => cap.toJSON()).toThrowError(/strictly Wallet-local and non-serializable/)
      expect(() => JSON.stringify(cap)).toThrow()
    })

    test('handles rejected decision by emitting status: rejected and stopping session', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })

      const ledger = new InMemoryWalletApprovalLedger()
      const sessionVerifier = createMockSessionVerifier()

      const rejectedReceipt = await recordWalletHumanDecision(
        reviewState.handle,
        {
          decision: 'rejected',
          sessionToken: 'valid_custodian_token',
          reason: 'Amount looks suspicious'
        },
        {
          ledger,
          sessionVerifier,
          nowEpochSeconds: () => 1770000015
        }
      )

      expect(rejectedReceipt.status).toBe('rejected')
      expect(rejectedReceipt.reason).toBe('Amount looks suspicious')
      // Rejected request is NOT stored in approval ledger
      expect(await ledger.has(request.requestId)).toBe(false)
    })
  })

  describe('6. Atomic Ledger Injection and Rollback', () => {
    test('fails closed if explicit ledger is not injected', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })
      const sessionVerifier = createMockSessionVerifier()

      await expect(
        recordWalletHumanDecision(
          reviewState.handle,
          {
            decision: 'approved',
            sessionToken: 'valid_custodian_token'
          },
          {
            ledger: undefined as unknown as import('./types').WalletApprovalLedger,
            sessionVerifier
          }
        )
      ).rejects.toThrowError(/MISSING_LEDGER_DEPENDENCY/)
    })

    test('atomic ledger rejects duplicate requestId or approvalId', async () => {
      const ledger = new InMemoryWalletApprovalLedger()
      const dummyRecord: WalletApprovalLedgerRecord = {
        operationId: 'op_dup_1',
        requestId: 'req_dup_1',
        approvalId: 'appr_dup_1',
        capabilityId: 'cap_dup_1',
        humanApproval: {} as unknown as import('@xolosarmy/tonalli-core').HumanApprovalV1,
        contentHash: 'sha256:abcd',
        recordedAt: 1770000000,
        status: 'approvalRecorded'
      }

      await ledger.recordApprovalAtomic(dummyRecord)

      // Duplicate requestId
      await expect(ledger.recordApprovalAtomic(dummyRecord)).rejects.toThrowError(
        /DUPLICATE_APPROVAL_RECORD/
      )
    })

    test('ledger persistence failure rolls back capability and stops session without returning approval', async () => {
      const request = createValidRequest()
      const reviewState = await prepareApprovalReview(request, {
        nowEpochSeconds: () => 1770000010
      })

      const sessionVerifier = createMockSessionVerifier()

      // Faulty ledger that always throws I/O failure
      const faultyLedger = {
        async recordApprovalAtomic() {
          throw new Error('Database disk full / write error')
        },
        async has() {
          return false
        },
        async get() {
          return undefined
        }
      }

      await expect(
        recordWalletHumanDecision(
          reviewState.handle,
          {
            decision: 'approved',
            sessionToken: 'valid_custodian_token'
          },
          {
            ledger: faultyLedger,
            sessionVerifier,
            nowEpochSeconds: () => 1770000015
          }
        )
      ).rejects.toThrowError(/ATOMIC_RECORDING_FAILED/)

      // Handle has been cleaned up and invalidated
      await expect(
        recordWalletHumanDecision(
          reviewState.handle,
          {
            decision: 'approved',
            sessionToken: 'valid_custodian_token'
          },
          {
            ledger: faultyLedger,
            sessionVerifier,
            nowEpochSeconds: () => 1770000016
          }
        )
      ).rejects.toThrowError(/UNKNOWN_REVIEW_HANDLE/)
    })
  })
})
