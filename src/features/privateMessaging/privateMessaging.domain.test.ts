import { describe, expect, test } from 'vitest'
import {
  TM_COMM_AUTH_PROTOCOL,
  TM_COMM_AUTH_PURPOSE,
  TM_COMM_AUTOMATIC_MEMO_PUBLICATION,
  TM_COMM_BROWSER_AUTHORITY_FIELDS,
  TM_COMM_EMAIL_ALLOWED_FIELDS,
  TM_COMM_EMAIL_FALLBACK_IMPLEMENTED,
  TM_COMM_EMAIL_FALLBACK_MILESTONE,
  TM_COMM_EMAIL_FALLBACK_TRIGGERS,
  TM_COMM_EMAIL_FORBIDDEN_FIELDS,
  TM_COMM_MAX_MESSAGE_BODY_CHARS,
  TM_COMM_MEMO_MILESTONE,
  TM_COMM_MEMO_PUBLICATION_PIPELINE,
  TM_COMM_MESSAGE_STATUSES,
  TM_COMM_PROTOCOL_ID,
  agentAuthenticationGrantsWalletCapability,
  assertPrivateConversationNotAutoPublished,
  buildTmCommAuthChallengeMessage,
  createTmCommAuthChallengeView,
  isMiningGatewayConnectFlow,
  isTmCommAgentSendEnabled,
  isTmCommMemoInCurrentMilestone,
  tmCommEmailDispatchDedupeKey
} from './index'

describe('TM-COMM closed domain', () => {
  test('exposes the required A0 entities through the public barrel', () => {
    expect(TM_COMM_PROTOCOL_ID).toBe('tm-comm')
    expect(TM_COMM_MESSAGE_STATUSES).toEqual(['accepted', 'delivered', 'read'])
    expect(TM_COMM_MAX_MESSAGE_BODY_CHARS).toBe(4_000)
    expect(TM_COMM_BROWSER_AUTHORITY_FIELDS).toEqual([
      'customerId',
      'reservationId',
      'conversationId',
      'walletAddress',
      'senderPrincipalId'
    ])
  })

  test('builds a one-time challenge that is not the mining gateway connect flow', () => {
    const view = createTmCommAuthChallengeView({
      challengeId: 'chlg_1',
      nonce: 'nonce_1',
      expiresAt: 1_700_000_000_000,
      audience: 'http://127.0.0.1:5174',
      origin: 'http://127.0.0.1:5174',
      sessionContext: 'tm-comm-a0-staging:v1'
    })

    expect(view.protocol).toBe(TM_COMM_AUTH_PROTOCOL)
    expect(view.purpose).toBe(TM_COMM_AUTH_PURPOSE)
    expect(view.canonicalMessage).toBe(buildTmCommAuthChallengeMessage({
      challengeId: 'chlg_1',
      nonce: 'nonce_1',
      expiresAt: 1_700_000_000_000,
      audience: 'http://127.0.0.1:5174',
      origin: 'http://127.0.0.1:5174',
      sessionContext: 'tm-comm-a0-staging:v1'
    }))
    expect(view.canonicalMessage).toContain('expiresAt=1700000000000')
    expect(view.canonicalMessage).toContain('audience=http://127.0.0.1:5174')
    expect(isMiningGatewayConnectFlow('/connect/sign-message')).toBe(true)
    expect(isMiningGatewayConnectFlow('/tm-comm-staging')).toBe(false)
  })

  test('rejects non-canonical challenge tokens', () => {
    expect(() => buildTmCommAuthChallengeMessage({
      challengeId: 'bad nonce',
      nonce: 'ok',
      expiresAt: 1,
      audience: 'http://127.0.0.1:5174',
      origin: 'http://127.0.0.1:5174',
      sessionContext: 'ctx'
    })).toThrow(/unsupported characters/)
  })

  test('keeps AI, email, and Memo capabilities fenced', () => {
    expect(isTmCommAgentSendEnabled()).toBe(false)
    expect(agentAuthenticationGrantsWalletCapability()).toBe(false)
    expect(TM_COMM_AUTOMATIC_MEMO_PUBLICATION).toBe(false)
    expect(isTmCommMemoInCurrentMilestone('A0')).toBe(false)
    expect(isTmCommMemoInCurrentMilestone(TM_COMM_MEMO_MILESTONE)).toBe(true)
    expect(TM_COMM_MEMO_PUBLICATION_PIPELINE).toEqual([
      'private-event',
      'candidate-evidence',
      'public-preview',
      'human-approval',
      'wallet-authorization-when-applicable',
      'tonalli-memo'
    ])
    expect(TM_COMM_EMAIL_FALLBACK_IMPLEMENTED).toBe(false)
    expect(TM_COMM_EMAIL_FALLBACK_MILESTONE).toBe('M1')
    expect(TM_COMM_EMAIL_FALLBACK_TRIGGERS).toContain('no-live-session')
    expect(TM_COMM_EMAIL_ALLOWED_FIELDS).not.toContain('fullMessageBody')
    expect(TM_COMM_EMAIL_FORBIDDEN_FIELDS).toContain('fullMessageBody')
    expect(tmCommEmailDispatchDedupeKey({
      messageId: 'msg_1',
      principalId: 'prin_1',
      channel: 'email-fallback'
    })).toBe('msg_1:prin_1:email-fallback')
    expect(() => assertPrivateConversationNotAutoPublished()).not.toThrow()
  })
})
