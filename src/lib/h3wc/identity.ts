import type { H3wcIdentity } from './contracts'

export class H3wcIdentityError extends Error {
  readonly code: 'IDENTITY_INVALID' | 'IDENTITY_UNAVAILABLE'

  constructor(code: H3wcIdentityError['code'], message: string) {
    super(message)
    this.name = 'H3wcIdentityError'
    this.code = code
  }
}

/** Validate the public-only identity returned by an already active account. */
export function validateH3wcIdentity(value: unknown): H3wcIdentity {
  if (!value || typeof value !== 'object') {
    throw new H3wcIdentityError('IDENTITY_INVALID', 'H3WC active identity is unavailable')
  }
  const candidate = value as { address?: unknown; publicKey?: unknown }
  if (
    typeof candidate.address !== 'string'
    || !/^ecash:[qp][a-z0-9]+$/u.test(candidate.address)
    || typeof candidate.publicKey !== 'string'
    || !/^0[23][0-9a-f]{64}$/u.test(candidate.publicKey)
  ) {
    throw new H3wcIdentityError('IDENTITY_INVALID', 'H3WC active identity is not canonical')
  }
  return Object.freeze({
    address: candidate.address,
    publicKey: candidate.publicKey
  })
}

export function identityToH3wcAccount(identity: H3wcIdentity): string {
  const valid = validateH3wcIdentity(identity)
  const suffix = valid.address.slice('ecash:'.length)
  return `ecash:1:${suffix}`
}

export interface H3wcIdentityProvider {
  getActiveIdentity(): H3wcIdentity | null | Promise<H3wcIdentity | null>
}

