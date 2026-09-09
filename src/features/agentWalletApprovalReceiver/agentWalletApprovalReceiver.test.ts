import { describe, expect, test } from 'vitest'
import {
  AGENTIC_CONTRACT_VERSION,
  type WalletApprovalRequestV1
} from '@xolosarmy/tonalli-core'
import { encodeAgentWalletHandoffV1 } from '../agentWalletHandoff'
import {
  formatSatsToExactXEC,
  validateAndPresentApprovalRequest,
  recordWalletHumanDecision,
  WalletApprovalReceiverError,
  ApprovalRecordCapability,
  InMemoryWalletApprovalLedger,
  type WalletHumanAction,
  type WalletHumanSessionAssertion
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

const VALID_SESSION: WalletHumanSessionAssertion = Object.freeze({
  sessionOrigin: 'wallet_local_ui',
  localSessionToken: 'sess_tok_secure_8831',
  activeAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
  authenticatedAlias: 'xolos_custodian'
})

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
  describe('exact BigInt monetary formatting', () => {
    test('formats canonical test vectors without precision loss', () => {
      // 1 sat = 0.01 XEC
      expect(formatSatsToExactXEC('1')).toBe('0.01 XEC')
      // 99 sats = 0.99 XEC
      expect(formatSatsToExactXEC('99')).toBe('0.99 XEC')
      // 100 sats = 1.00 XEC
      expect(formatSatsToExactXEC('100')).toBe('1.00 XEC')
      // 5000 sats = 50.00 XEC
      expect(formatSatsToExactXEC('5000')).toBe('50.00 XEC')
      // Leading fraction zero: 105 sats = 1.05 XEC
      expect(formatSatsToExactXEC('105')).toBe('1.05 XEC')
      expect(formatSatsToExactXEC('1005')).toBe('10.05 XEC')

      // Number.MAX_SAFE_INTEGER = 9007199254740991n
      expect(formatSatsToExactXEC('9007199254740991')).toBe('90071992547409.91 XEC')
      // Number.MAX_SAFE_INTEGER + 1 = 9007199254740992n (would lose precision with Number)
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
      expect(() => formatSatsToExactXEC('007')).toThrow()
      expect(() => formatSatsToExactXEC('abc')).toThrow()
    })
  })

  describe('fresh revalidation, presentation snapshot, and H(E,C)', () => {
    test('validates direct WalletApprovalRequestV1 and produces presentation with H(E,C) binding', async () => {
      const request = createValidRequest()
      const result = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      expect(result.request.requestId).toBe('req-rcv-test-001')
      expect(result.presentation.amountSats).toBe('150000')
      expect(result.presentation.amountXEC).toBe('1500.00 XEC')
      expect(result.presentation.destination).toBe(BASE_VALID_INTENT.toAddress)
      expect(result.presentation.network).toBe('xec:mainnet')
      expect(result.presentation.policyTraceId).toBe('trace-rcv-policy-001')

      // Normative contentHash binding
      expect(result.binding.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(result.binding.operationId).toBe(request.requestId)
      expect(result.binding.requestId).toBe(request.requestId)
      expect(result.binding.intentId).toBe(request.intent.intentId)
      expect(result.binding.decisionId).toBe(request.policyDecision.decisionId)
      expect(result.binding.effectiveExpiresAt).toBe(1770000300)

      // Capability created and fresh
      expect(result.capability).toBeInstanceOf(ApprovalRecordCapability)
      expect(result.capability.state).toBe('fresh')
      expect(result.capability.contentHash).toBe(result.binding.contentHash)
    })

    test('validates encoded byte array input via decodeAgentWalletHandoffV1', async () => {
      const request = createValidRequest()
      const encodedBytes = encodeAgentWalletHandoffV1(request)

      const result = await validateAndPresentApprovalRequest(encodedBytes, {
        nowEpochSeconds: () => 1770000010
      })

      expect(result.request.requestId).toBe('req-rcv-test-001')
      expect(result.presentation.amountXEC).toBe('1500.00 XEC')
      expect(result.binding.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    test('effectiveExpiresAt respects shortest TTL among request, intent, policy, and x402', async () => {
      const request = createValidRequest({
        expiresAt: 1770000220,
        intent: { ...BASE_VALID_INTENT, expiresAt: 1770000250 },
        policyDecision: { ...BASE_VALID_POLICY_DECISION, expiresAt: 1770000280 },
        x402: {
          x402Version: 1,
          scheme: 'exact',
          network: 'xec:mainnet',
          invoiceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          resourceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          amountSats: '150000',
          payTo: BASE_VALID_INTENT.toAddress,
          nonce: 'YWJjZGVmZ2hpamtsbW5vcA',
          issuedAt: 1770000000,
          expiresAt: 1770000240
        }
      })

      const result = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      expect(result.binding.effectiveExpiresAt).toBe(1770000220)
      expect(result.presentation.effectiveExpiresAt).toBe(1770000220)
    })
  })

  describe('anti-TOCTOU, capability mechanics, and atomic recording', () => {
    test('capability is opaque, non-serializable and non-constructible externally', () => {
      expect(() => {
        // Direct construction without token must throw
        new (ApprovalRecordCapability as unknown as new (...args: unknown[]) => ApprovalRecordCapability)(
          Symbol('fake-token'),
          'cap-fake',
          {} as never,
          {} as never
        )
      }).toThrowError(WalletApprovalReceiverError)
    })

    test('capability throws on JSON.stringify to prevent serialization leaks', async () => {
      const request = createValidRequest()
      const result = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      expect(() => JSON.stringify(result.capability)).toThrowError(
        /ApprovalRecordCapability is strictly Wallet-local and non-serializable/
      )
    })

    test('records human approval atomically with session proof and resolves approver from session', async () => {
      const request = createValidRequest()
      const ledger = new InMemoryWalletApprovalLedger()

      const { capability, binding } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      const action: WalletHumanAction = {
        decision: 'approved',
        session: VALID_SESSION,
        reason: 'Confirmed valid RPC spend'
      }

      const approval = await recordWalletHumanDecision(capability, action, {
        ledger,
        nowEpochSeconds: () => 1770000025,
        idGenerator: () => 'appr-fixed-id-123'
      })

      expect(approval.contractVersion).toBe(AGENTIC_CONTRACT_VERSION)
      expect(approval.kind).toBe('human_approval')
      expect(approval.status).toBe('approved')
      expect(approval.approver).toBe('xolos_custodian') // from session.authenticatedAlias
      expect(approval.approvalId).toBe('appr-fixed-id-123')
      expect(approval.requestId).toBe(request.requestId)
      expect(approval.intentId).toBe(request.intent.intentId)
      expect(approval.decisionId).toBe(request.policyDecision.decisionId)
      expect(approval.recordedAt).toBe(1770000025)

      // Capability is now consumed
      expect(capability.state).toBe('recorded')

      // Check atomic ledger entry
      const recorded = await ledger.get(request.requestId)
      expect(recorded).toBeDefined()
      expect(recorded?.status).toBe('approvalRecorded')
      expect(recorded?.binding.contentHash).toBe(binding.contentHash)
      expect(recorded?.humanApproval.approvalId).toBe('appr-fixed-id-123')

      // Security invariant: Zero transaction construction / signing fields
      const approvalRecord = approval as unknown as Record<string, unknown>
      expect(approvalRecord.signedTransaction).toBeUndefined()
      expect(approvalRecord.rawTx).toBeUndefined()
      expect(approvalRecord.txid).toBeUndefined()
    })

    test('prevents capability replay: second consumption throws CAPABILITY_NOT_FRESH', async () => {
      const request = createValidRequest()
      const ledger = new InMemoryWalletApprovalLedger()

      const { capability } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      const action: WalletHumanAction = {
        decision: 'approved',
        session: VALID_SESSION
      }

      await recordWalletHumanDecision(capability, action, {
        ledger,
        nowEpochSeconds: () => 1770000025
      })

      // Second attempt with same capability must fail closed
      await expect(
        recordWalletHumanDecision(capability, action, {
          ledger,
          nowEpochSeconds: () => 1770000026
        })
      ).rejects.toThrowError(WalletApprovalReceiverError)

      try {
        await recordWalletHumanDecision(capability, action, {
          ledger,
          nowEpochSeconds: () => 1770000026
        })
      } catch (err: unknown) {
        expect((err as WalletApprovalReceiverError).code).toBe('CAPABILITY_NOT_FRESH')
      }
    })

    test('prevents expired capability consumption', async () => {
      const request = createValidRequest()
      const ledger = new InMemoryWalletApprovalLedger()

      const { capability } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      const action: WalletHumanAction = {
        decision: 'approved',
        session: VALID_SESSION
      }

      // Record after effectiveExpiresAt (1770000300)
      await expect(
        recordWalletHumanDecision(capability, action, {
          ledger,
          nowEpochSeconds: () => 1770000301
        })
      ).rejects.toThrowError(WalletApprovalReceiverError)

      expect(capability.state).toBe('invalidated')
    })

    test('fails closed if human session is invalid or missing', async () => {
      const request = createValidRequest()
      const { capability } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      const invalidOriginAction = {
        decision: 'approved',
        session: {
          sessionOrigin: 'programmatic_agent',
          localSessionToken: 'tok123',
          activeAddress: 'addr123'
        }
      } as unknown as WalletHumanAction

      await expect(
        recordWalletHumanDecision(capability, invalidOriginAction, {
          nowEpochSeconds: () => 1770000025
        })
      ).rejects.toThrowError(WalletApprovalReceiverError)
    })

    test('rolls back and does not return approval if atomic ledger insertion fails', async () => {
      const request = createValidRequest()
      const { capability } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      // Faulty ledger that simulates persistence failure
      const failingLedger = {
        async recordApprovalAtomic() {
          throw new Error('Disk write I/O failure')
        },
        async has() {
          return false
        },
        async get() {
          return undefined
        }
      }

      const action: WalletHumanAction = {
        decision: 'approved',
        session: VALID_SESSION
      }

      await expect(
        recordWalletHumanDecision(capability, action, {
          ledger: failingLedger,
          nowEpochSeconds: () => 1770000025
        })
      ).rejects.toThrowError(WalletApprovalReceiverError)

      expect(capability.state).toBe('invalidated')
    })

    test('prevents concurrent double-recording of same requestId', async () => {
      const request = createValidRequest()
      const ledger = new InMemoryWalletApprovalLedger()

      const { capability: cap1 } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })
      const { capability: cap2 } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      const action: WalletHumanAction = {
        decision: 'approved',
        session: VALID_SESSION
      }

      // First succeeds
      await recordWalletHumanDecision(cap1, action, { ledger, nowEpochSeconds: () => 1770000020 })

      // Second must be rejected by ledger duplicate detection
      await expect(
        recordWalletHumanDecision(cap2, action, { ledger, nowEpochSeconds: () => 1770000021 })
      ).rejects.toThrowError(WalletApprovalReceiverError)
    })

    test('records human rejection without requiring alias', async () => {
      const request = createValidRequest()
      const ledger = new InMemoryWalletApprovalLedger()

      const { capability } = await validateAndPresentApprovalRequest(request, {
        nowEpochSeconds: () => 1770000010
      })

      const action: WalletHumanAction = {
        decision: 'rejected',
        session: {
          sessionOrigin: 'wallet_local_ui',
          localSessionToken: 'sess_tok_secure_8831',
          activeAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2'
        },
        reason: 'User rejected transaction from UI'
      }

      const approval = await recordWalletHumanDecision(capability, action, {
        ledger,
        nowEpochSeconds: () => 1770000025
      })

      expect(approval.status).toBe('rejected')
      expect(approval.approver).toBeUndefined()
      expect(approval.reason).toBe('User rejected transaction from UI')
    })
  })
})
