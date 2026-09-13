import type { H3wcPeer, H3wcPeerExpectation } from './contracts'

export class H3wcPeerError extends Error {
  readonly code: 'PEER_ORIGIN_INVALID' | 'PEER_ORIGIN_MISMATCH' | 'PEER_MISSING' | 'PEER_KEY_MISMATCH'

  constructor(code: H3wcPeerError['code'], message: string) {
    super(message)
    this.name = 'H3wcPeerError'
    this.code = code
  }
}

/**
 * Canonicalize only an HTTPS origin.  Paths, credentials, queries, hashes,
 * wildcards and suffix matches are intentionally rejected.
 */
export function canonicalizeH3wcOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new H3wcPeerError('PEER_ORIGIN_INVALID', 'H3WC peer URL is missing or malformed')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new H3wcPeerError('PEER_ORIGIN_INVALID', 'H3WC peer URL is not a valid URL')
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new H3wcPeerError('PEER_ORIGIN_INVALID', 'H3WC peer URL must be an HTTPS origin')
  }
  if (url.pathname !== '/' || url.port) {
    throw new H3wcPeerError('PEER_ORIGIN_INVALID', 'H3WC peer URL must not contain a path or explicit port')
  }
  if (url.hostname.includes('*') || url.hostname.startsWith('.') || url.hostname.endsWith('.')) {
    throw new H3wcPeerError('PEER_ORIGIN_INVALID', 'H3WC peer hostname is not canonical')
  }

  return `https://${url.hostname.toLowerCase()}`
}

export function readPeerOrigin(peer: H3wcPeer | undefined): string {
  if (!peer?.metadata?.url) {
    throw new H3wcPeerError('PEER_MISSING', 'H3WC peer metadata is missing')
  }
  return canonicalizeH3wcOrigin(peer.metadata.url)
}

export function qualifyH3wcPeer(peer: H3wcPeer | undefined, expected: H3wcPeerExpectation): string {
  const actual = readPeerOrigin(peer)
  const expectedOrigin = canonicalizeH3wcOrigin(expected.origin)
  if (actual !== expectedOrigin) {
    throw new H3wcPeerError('PEER_ORIGIN_MISMATCH', 'H3WC peer origin does not match the allowlist')
  }

  const actualKey = peer?.publicKey ?? peer?.metadata?.publicKey
  if (expected.publicKey !== undefined && actualKey !== expected.publicKey) {
    throw new H3wcPeerError('PEER_KEY_MISMATCH', 'H3WC peer identity key does not match')
  }
  return actual
}

