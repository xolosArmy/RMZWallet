import { describe, expect, test } from 'vitest'
import {
  AGENT_WALLET_HANDOFF_B0,
  AGENT_WALLET_HANDOFF_B2
} from './__fixtures__/agentWalletHandoffV1.golden'
import {
  AgentWalletHandoffCodecError,
  encodeAgentWalletHandoffV1
} from './index'

const expectInvalidValue = (value: unknown, code = 'INVALID_VALUE'): void => {
  try {
    encodeAgentWalletHandoffV1(value)
    throw new Error('Expected encodeAgentWalletHandoffV1 to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(AgentWalletHandoffCodecError)
    if (!(error instanceof AgentWalletHandoffCodecError)) throw error
    expect(error.code).toBe(code)
  }
}

const withIntent = (patch: Readonly<Record<string, unknown>>): unknown => ({
  ...AGENT_WALLET_HANDOFF_B0,
  intent: { ...AGENT_WALLET_HANDOFF_B0.intent, ...patch }
})

const withPolicyDecision = (patch: Readonly<Record<string, unknown>>): unknown => ({
  ...AGENT_WALLET_HANDOFF_B0,
  policyDecision: { ...AGENT_WALLET_HANDOFF_B0.policyDecision, ...patch }
})

describe('Agent Wallet Handoff v1 invalid value domain', () => {
  test('rejects unsupported input types before Core parsing', () => {
    expectInvalidValue(null, 'INVALID_INPUT_TYPE')
    expectInvalidValue('wallet request', 'INVALID_INPUT_TYPE')
    expectInvalidValue([], 'INVALID_INPUT_TYPE')
  })

  test('rejects incorrect root literals and unknown fields', () => {
    expectInvalidValue({ ...AGENT_WALLET_HANDOFF_B0, kind: 'agent_intent' })
    expectInvalidValue({ ...AGENT_WALLET_HANDOFF_B0, purpose: 'sign_message' })
    expectInvalidValue({ ...AGENT_WALLET_HANDOFF_B0, unexpected: true })
  })

  test('rejects incorrect intent literals, network, and nonce', () => {
    expectInvalidValue(withIntent({ kind: 'wallet_approval_request' }))
    expectInvalidValue(withIntent({ network: 'xec:regtest' }))
    expectInvalidValue(withIntent({ nonce: 'too-short' }))
  })

  test('rejects non-human CAE decisions and broken intent binding', () => {
    expectInvalidValue(withPolicyDecision({ decision: 'approved' }))
    expectInvalidValue(withPolicyDecision({ intentId: 'intent-002' }))
  })

  test('rejects invalid temporal relationships', () => {
    expectInvalidValue(withIntent({ expiresAt: AGENT_WALLET_HANDOFF_B0.intent.createdAt }))
    expectInvalidValue(withPolicyDecision({
      expiresAt: AGENT_WALLET_HANDOFF_B0.policyDecision.evaluatedAt
    }))
    expectInvalidValue({
      ...AGENT_WALLET_HANDOFF_B0,
      requestedAt: AGENT_WALLET_HANDOFF_B0.intent.createdAt - 1
    })
    expectInvalidValue({
      ...AGENT_WALLET_HANDOFF_B0,
      expiresAt: AGENT_WALLET_HANDOFF_B0.requestedAt
    })
  })

  test('rejects broken x402 amount and destination bindings', () => {
    expectInvalidValue({
      ...AGENT_WALLET_HANDOFF_B2,
      x402: { ...AGENT_WALLET_HANDOFF_B2.x402, amountSats: '1001' }
    })
    expectInvalidValue({
      ...AGENT_WALLET_HANDOFF_B2,
      x402: {
        ...AGENT_WALLET_HANDOFF_B2.x402,
        payTo: AGENT_WALLET_HANDOFF_B0.intent.fromAddress
      }
    })
  })
})
