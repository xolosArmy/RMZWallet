import { parseWalletApprovalRequestV1 } from '@xolosarmy/tonalli-core'
import { describe, expect, test } from 'vitest'
import {
  AGENT_WALLET_HANDOFF_B0,
  AGENT_WALLET_HANDOFF_B1,
  AGENT_WALLET_HANDOFF_B2,
  AGENT_WALLET_HANDOFF_B3,
  AGENT_WALLET_HANDOFF_B4
} from './__fixtures__/agentWalletHandoffV1.golden'
import {
  AgentWalletHandoffCodecError,
  decodeAgentWalletHandoffV1,
  encodeAgentWalletHandoffV1
} from './index'

const validMutations = Object.freeze([
  Object.freeze({
    name: 'amount',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: { ...AGENT_WALLET_HANDOFF_B0.intent, amountSats: '1001' }
    }
  }),
  Object.freeze({
    name: 'destination',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: {
        ...AGENT_WALLET_HANDOFF_B0.intent,
        toAddress: 'ecash:qq9h6u8v9z5g3p2m7k4d0c6x8n1t5y3w7s9e2r4u6q'
      }
    }
  }),
  Object.freeze({
    name: 'bound intent identifiers',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: { ...AGENT_WALLET_HANDOFF_B0.intent, intentId: 'intent-002' },
      policyDecision: {
        ...AGENT_WALLET_HANDOFF_B0.policyDecision,
        intentId: 'intent-002'
      }
    }
  }),
  Object.freeze({
    name: 'decision identifier',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      policyDecision: {
        ...AGENT_WALLET_HANDOFF_B0.policyDecision,
        decisionId: 'decision-002'
      }
    }
  }),
  Object.freeze({
    name: 'nonce',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: {
        ...AGENT_WALLET_HANDOFF_B0.intent,
        nonce: 'YWJjZGVmZ2hpamtsbW5vcA'
      }
    }
  }),
  Object.freeze({
    name: 'reason',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: { ...AGENT_WALLET_HANDOFF_B0.intent, reason: 'Alternate reason' }
    }
  }),
  Object.freeze({
    name: 'memo',
    base: AGENT_WALLET_HANDOFF_B0,
    value: {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: { ...AGENT_WALLET_HANDOFF_B0.intent, memo: 'Memo evidence' }
    }
  }),
  Object.freeze({
    name: 'x402 hashes',
    base: AGENT_WALLET_HANDOFF_B2,
    value: {
      ...AGENT_WALLET_HANDOFF_B2,
      x402: {
        ...AGENT_WALLET_HANDOFF_B2.x402,
        invoiceHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        resourceHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      }
    }
  })
])

describe('Agent Wallet Handoff v1 deterministic properties', () => {
  test('round-trips the complete certified corpus canonically', () => {
    for (const fixture of [
      AGENT_WALLET_HANDOFF_B0,
      AGENT_WALLET_HANDOFF_B1,
      AGENT_WALLET_HANDOFF_B2,
      AGENT_WALLET_HANDOFF_B3,
      AGENT_WALLET_HANDOFF_B4
    ]) {
      const parsed = parseWalletApprovalRequestV1(fixture)
      const encoded = encodeAgentWalletHandoffV1(parsed)
      const decoded = decodeAgentWalletHandoffV1(encoded)
      expect(decoded).toEqual(parsed)
      expect(encodeAgentWalletHandoffV1(decoded)).toEqual(encoded)
    }
  })

  for (const mutation of validMutations) {
    test(`preserves and distinguishes the valid ${mutation.name} mutation`, () => {
      const parsed = parseWalletApprovalRequestV1(mutation.value)
      const encoded = encodeAgentWalletHandoffV1(parsed)
      expect(decodeAgentWalletHandoffV1(encoded)).toEqual(parsed)
      expect(encodeAgentWalletHandoffV1(decodeAgentWalletHandoffV1(encoded))).toEqual(encoded)
      expect(encoded).not.toEqual(encodeAgentWalletHandoffV1(mutation.base))
    })
  }

  test('rejects an invalid one-sided intent identifier mutation', () => {
    const invalid = {
      ...AGENT_WALLET_HANDOFF_B0,
      intent: { ...AGENT_WALLET_HANDOFF_B0.intent, intentId: 'intent-002' }
    }
    expect(() => parseWalletApprovalRequestV1(invalid)).toThrow()
    expect(() => encodeAgentWalletHandoffV1(invalid)).toThrow(AgentWalletHandoffCodecError)
  })
})
