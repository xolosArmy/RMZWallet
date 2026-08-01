import type { UniversalAuthorizationEnvelopeV1 } from './contract'
import { UniversalAuthorizationError } from './contract'

export type UniversalContentHash = `sha256:${string}`

const DOMAIN = new TextEncoder().encode('tonalli.authorization/content-hash/v1')
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const canonicalEnvelope = (envelope: UniversalAuthorizationEnvelopeV1): string => JSON.stringify({
  expiresAt: envelope.expiresAt,
  issuedAt: envelope.issuedAt,
  operationId: envelope.operationId,
  profileId: envelope.profileId,
  requester: {
    displayName: envelope.requester.displayName,
    origin: envelope.requester.origin
  },
  schema: envelope.schema,
  version: envelope.version
})

const lengthPrefix = (length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
    throw new UniversalAuthorizationError('CONTENT_TOO_LARGE')
  }
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, length, false)
  return prefix
}

const assertNotAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new UniversalAuthorizationError('OPERATION_ABORTED')
}

export async function calculateUniversalContentHash(
  envelope: UniversalAuthorizationEnvelopeV1,
  effectiveContent: Uint8Array,
  signal: AbortSignal,
  cryptoRef: Pick<Crypto, 'subtle'> = globalThis.crypto
): Promise<UniversalContentHash> {
  assertNotAborted(signal)
  const envelopeBytes = new TextEncoder().encode(canonicalEnvelope(envelope))
  const preimage = new Uint8Array(
    DOMAIN.length + 1 + 4 + envelopeBytes.length + 4 + effectiveContent.length
  )
  let offset = 0
  preimage.set(DOMAIN, offset)
  offset += DOMAIN.length
  preimage[offset] = 0
  offset += 1
  preimage.set(lengthPrefix(envelopeBytes.length), offset)
  offset += 4
  preimage.set(envelopeBytes, offset)
  offset += envelopeBytes.length
  preimage.set(lengthPrefix(effectiveContent.length), offset)
  offset += 4
  preimage.set(effectiveContent, offset)
  const digest = await cryptoRef.subtle.digest('SHA-256', preimage)
  assertNotAborted(signal)
  return `sha256:${toHex(new Uint8Array(digest))}`
}

export function equalUniversalContentHashes(left: UniversalContentHash, right: UniversalContentHash): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
