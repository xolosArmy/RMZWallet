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

export type TmCommAuthChallengePayload = Readonly<{
  protocol?: unknown
  purpose?: unknown
  challengeId?: unknown
  nonce?: unknown
  expiresAt?: unknown
  audience?: unknown
  origin?: unknown
  sessionContext?: unknown
  chain?: unknown
  canonicalMessage?: unknown
}>

export type TmCommAuthChallengeValidationOptions = Readonly<{
  expectedOrigin: string
  now?: number
}>

export function verifyAndReconstructAuthChallenge(
  payload: unknown,
  options: TmCommAuthChallengeValidationOptions
): { canonicalMessage: string; challengeId: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Challenge payload must be a non-null object.')
  }
  const raw = payload as Record<string, unknown>

  if (raw.protocol !== TM_COMM_AUTH_PROTOCOL) {
    throw new Error(`Invalid protocol: expected ${TM_COMM_AUTH_PROTOCOL}, got ${String(raw.protocol)}.`)
  }
  if (raw.purpose !== TM_COMM_AUTH_PURPOSE) {
    throw new Error(`Invalid purpose: expected ${TM_COMM_AUTH_PURPOSE}, got ${String(raw.purpose)}.`)
  }
  if (raw.chain !== TM_COMM_AUTH_CHAIN) {
    throw new Error(`Invalid chain: expected ${TM_COMM_AUTH_CHAIN}, got ${String(raw.chain)}.`)
  }
  if (typeof raw.challengeId !== 'string' || !REQUIRED_CHALLENGE_LINE.test(raw.challengeId)) {
    throw new Error('challengeId must be a valid non-empty canonical token.')
  }
  if (typeof raw.nonce !== 'string' || !REQUIRED_CHALLENGE_LINE.test(raw.nonce)) {
    throw new Error('nonce must be a valid non-empty canonical token.')
  }
  if (typeof raw.sessionContext !== 'string' || !REQUIRED_CHALLENGE_LINE.test(raw.sessionContext)) {
    throw new Error('sessionContext must be a valid non-empty canonical token.')
  }
  if (typeof raw.audience !== 'string' || raw.audience !== options.expectedOrigin) {
    throw new Error(`audience mismatch: expected ${options.expectedOrigin}, got ${String(raw.audience)}.`)
  }
  if (typeof raw.origin !== 'string' || raw.origin !== options.expectedOrigin) {
    throw new Error(`origin mismatch: expected ${options.expectedOrigin}, got ${String(raw.origin)}.`)
  }
  if (
    typeof raw.expiresAt !== 'number' ||
    !Number.isInteger(raw.expiresAt) ||
    raw.expiresAt <= 0
  ) {
    throw new Error('expiresAt must be a positive integer unix millisecond timestamp.')
  }

  const now = options.now ?? Date.now()
  if (now >= raw.expiresAt) {
    throw new Error(`Challenge has expired: now=${now} >= expiresAt=${raw.expiresAt}.`)
  }

  const localCanonical = buildTmCommAuthChallengeMessage({
    challengeId: raw.challengeId,
    nonce: raw.nonce,
    expiresAt: raw.expiresAt,
    audience: raw.audience,
    origin: raw.origin,
    sessionContext: raw.sessionContext
  })

  if (typeof raw.canonicalMessage !== 'string' || raw.canonicalMessage !== localCanonical) {
    throw new Error('canonicalMessage does not match locally reconstructed canonical message.')
  }

  return {
    canonicalMessage: localCanonical,
    challengeId: raw.challengeId
  }
}

export function isMiningGatewayConnectFlow(pathname: string): boolean {
  return pathname === '/connect/sign-message' || pathname === '/connect'
}
