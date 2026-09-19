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
  TM_COMM_EXPECTED_SESSION_CONTEXT,
  agentAuthenticationGrantsWalletCapability,
  assertPrivateConversationNotAutoPublished,
  buildTmCommAuthChallengeMessage,
  createTmCommAuthChallengeView,
  isMiningGatewayConnectFlow,
  isTmCommAgentSendEnabled,
  isTmCommMemoInCurrentMilestone,
  tmCommEmailDispatchDedupeKey,
  verifyAndReconstructAuthChallenge
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

  describe('verifyAndReconstructAuthChallenge (P2-1 local challenge validation)', () => {
    const validView = createTmCommAuthChallengeView({
      challengeId: 'chlg_test_123',
      nonce: 'nonce_secret_abc',
      expiresAt: 2_000_000_000_000,
      audience: 'http://127.0.0.1:5174',
      origin: 'http://127.0.0.1:5174',
      sessionContext: 'tm-comm-a0-staging:v1'
    })

    test('accepts and verifies a legitimate challenge', () => {
      const result = verifyAndReconstructAuthChallenge(validView, {
        expectedOrigin: 'http://127.0.0.1:5174',
        now: 1_900_000_000_000
      })
      expect(result.challengeId).toBe('chlg_test_123')
      expect(result.canonicalMessage).toBe(validView.canonicalMessage)
    })

    test('rejects altered protocol', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, protocol: 'TM-COMM-AUTH-V2' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/Invalid protocol/)
    })

    test('rejects altered purpose', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, purpose: 'mining-gateway-connect' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/Invalid purpose/)
    })

    test('rejects altered chain', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, chain: 'btc' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/Invalid chain/)
    })

    test('rejects audience mismatch', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, audience: 'http://evil.site.com' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/audience mismatch/)
    })

    test('rejects origin mismatch', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, origin: 'http://evil.site.com' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/origin mismatch/)
    })

    test('rejects invalid or non-canonical nonce tokens', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, nonce: 'spaces in nonce' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/nonce must be a valid non-empty canonical token/)
    })

    test('rejects expired challenge', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(validView, {
          expectedOrigin: 'http://127.0.0.1:5174',
          now: 2_000_000_000_001
        })
      ).toThrow(/Challenge has expired/)
    })

    test('rejects invalid expiry timestamps', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, expiresAt: -1 },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/expiresAt must be a positive integer/)
    })

    test('rejects manipulated canonicalMessage that does not match local reconstruction', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(
          { ...validView, canonicalMessage: validView.canonicalMessage + '\nextra=evil' },
          { expectedOrigin: 'http://127.0.0.1:5174', now: 1_900_000_000_000 }
        )
      ).toThrow(/canonicalMessage does not match locally reconstructed/)
    })

    test('rejects non-object or null payloads', () => {
      expect(() =>
        verifyAndReconstructAuthChallenge(null, {
          expectedOrigin: 'http://127.0.0.1:5174'
        })
      ).toThrow(/Challenge payload must be a non-null object/)
      expect(() =>
        verifyAndReconstructAuthChallenge('arbitrary string', {
          expectedOrigin: 'http://127.0.0.1:5174'
        })
      ).toThrow(/Challenge payload must be a non-null object/)
    })

    describe('P2-5 sessionContext pinning', () => {
      test('permits exact expected session context (tm-comm-a0-staging:v1)', () => {
        const result = verifyAndReconstructAuthChallenge(validView, {
          expectedOrigin: 'http://127.0.0.1:5174',
          expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
          now: 1_900_000_000_000
        })
        expect(result.canonicalMessage).toBe(validView.canonicalMessage)
      })

      test('rejects another syntactically valid TM-COMM context', () => {
        expect(() =>
          verifyAndReconstructAuthChallenge(
            { ...validView, sessionContext: 'tm-comm-production:v1' },
            {
              expectedOrigin: 'http://127.0.0.1:5174',
              expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
              now: 1_900_000_000_000
            }
          )
        ).toThrow(/sessionContext mismatch: expected tm-comm-a0-staging:v1, got tm-comm-production:v1/)
      })

      test('rejects same prefix with different version', () => {
        expect(() =>
          verifyAndReconstructAuthChallenge(
            { ...validView, sessionContext: 'tm-comm-a0-staging:v2' },
            {
              expectedOrigin: 'http://127.0.0.1:5174',
              expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
              now: 1_900_000_000_000
            }
          )
        ).toThrow(/sessionContext mismatch: expected tm-comm-a0-staging:v1, got tm-comm-a0-staging:v2/)
      })

      test('rejects empty sessionContext', () => {
        expect(() =>
          verifyAndReconstructAuthChallenge(
            { ...validView, sessionContext: '' },
            {
              expectedOrigin: 'http://127.0.0.1:5174',
              expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
              now: 1_900_000_000_000
            }
          )
        ).toThrow(/sessionContext must be a valid non-empty canonical token/)
      })

      test('rejects omitted sessionContext', () => {
        const withoutContext = { ...validView } as Record<string, unknown>
        delete withoutContext.sessionContext
        expect(() =>
          verifyAndReconstructAuthChallenge(
            withoutContext,
            {
              expectedOrigin: 'http://127.0.0.1:5174',
              expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
              now: 1_900_000_000_000
            }
          )
        ).toThrow(/sessionContext must be a valid non-empty canonical token/)
      })

      test('rejects leading or trailing whitespace added to sessionContext', () => {
        expect(() =>
          verifyAndReconstructAuthChallenge(
            { ...validView, sessionContext: ' tm-comm-a0-staging:v1' },
            {
              expectedOrigin: 'http://127.0.0.1:5174',
              expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
              now: 1_900_000_000_000
            }
          )
        ).toThrow(/sessionContext must be a valid non-empty canonical token/)

        expect(() =>
          verifyAndReconstructAuthChallenge(
            { ...validView, sessionContext: 'tm-comm-a0-staging:v1 ' },
            {
              expectedOrigin: 'http://127.0.0.1:5174',
              expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
              now: 1_900_000_000_000
            }
          )
        ).toThrow(/sessionContext must be a valid non-empty canonical token/)
      })

      test('rejects canonicalMessage that is perfectly consistent with incorrect context', () => {
        const wrongContextView = createTmCommAuthChallengeView({
          challengeId: 'chlg_test_123',
          nonce: 'nonce_secret_abc',
          expiresAt: 2_000_000_000_000,
          audience: 'http://127.0.0.1:5174',
          origin: 'http://127.0.0.1:5174',
          sessionContext: 'tm-comm-a0-staging:v2'
        })

        expect(() =>
          verifyAndReconstructAuthChallenge(wrongContextView, {
            expectedOrigin: 'http://127.0.0.1:5174',
            expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT,
            now: 1_900_000_000_000
          })
        ).toThrow(/sessionContext mismatch/)
      })

      test('rejects empty or invalid expectedSessionContext in options', () => {
        expect(() =>
          verifyAndReconstructAuthChallenge(validView, {
            expectedOrigin: 'http://127.0.0.1:5174',
            expectedSessionContext: '   '
          })
        ).toThrow(/expectedSessionContext must be a valid non-empty canonical token/)
      })
    })
  })
})
