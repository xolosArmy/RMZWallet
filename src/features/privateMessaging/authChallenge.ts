/**
 * Canonical TM-COMM wallet challenge.
 *
 * Tonalli may sign this exact string with its existing message-signing
 * capability. This protocol is not the Mining Gateway connect flow and
 * is not a productive reuse of `/connect/sign-message`.
 *
 * Private keys never enter this module. The wallet signs; the server
 * verifies nonce, expiry, audience/origin, address, public key, and
 * signature before creating a server-side session.
 */

export const TM_COMM_AUTH_PROTOCOL = 'TM-COMM-AUTH-V1' as const
export const TM_COMM_AUTH_PURPOSE = 'tm-comm-private-messaging-session' as const
export const TM_COMM_AUTH_CHAIN = 'ecash' as const

export type TmCommAuthChallengeInput = Readonly<{
  challengeId: string
  nonce: string
  expiresAt: number
  audience: string
  origin: string
  sessionContext: string
}>

export type TmCommAuthChallengeView = Readonly<{
  protocol: typeof TM_COMM_AUTH_PROTOCOL
  purpose: typeof TM_COMM_AUTH_PURPOSE
  challengeId: string
  nonce: string
  expiresAt: number
  audience: string
  origin: string
  sessionContext: string
  chain: typeof TM_COMM_AUTH_CHAIN
  canonicalMessage: string
}>

const REQUIRED_CHALLENGE_LINE = /^[A-Za-z0-9._:~/=+-]+$/

const assertToken = (label: string, value: string): string => {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed !== value) {
    throw new Error(`${label} must be a non-empty canonical token.`)
  }
  if (!REQUIRED_CHALLENGE_LINE.test(trimmed)) {
    throw new Error(`${label} contains unsupported characters.`)
  }
  return trimmed
}

export function buildTmCommAuthChallengeMessage(
  input: TmCommAuthChallengeInput
): string {
  const challengeId = assertToken('challengeId', input.challengeId)
  const nonce = assertToken('nonce', input.nonce)
  const audience = assertToken('audience', input.audience)
  const origin = assertToken('origin', input.origin)
  const sessionContext = assertToken('sessionContext', input.sessionContext)
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error('expiresAt must be a positive unix millisecond timestamp.')
  }

  return [
    TM_COMM_AUTH_PROTOCOL,
    `purpose=${TM_COMM_AUTH_PURPOSE}`,
    `audience=${audience}`,
    `origin=${origin}`,
    `challengeId=${challengeId}`,
    `nonce=${nonce}`,
    `expiresAt=${input.expiresAt}`,
    `sessionContext=${sessionContext}`,
    `chain=${TM_COMM_AUTH_CHAIN}`
  ].join('\n')
}

export function createTmCommAuthChallengeView(
  input: TmCommAuthChallengeInput
): TmCommAuthChallengeView {
  return Object.freeze({
    protocol: TM_COMM_AUTH_PROTOCOL,
    purpose: TM_COMM_AUTH_PURPOSE,
    challengeId: input.challengeId,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    audience: input.audience,
    origin: input.origin,
    sessionContext: input.sessionContext,
    chain: TM_COMM_AUTH_CHAIN,
    canonicalMessage: buildTmCommAuthChallengeMessage(input)
  })
}

export function isMiningGatewayConnectFlow(pathname: string): boolean {
  return pathname === '/connect/sign-message' || pathname === '/connect'
}
