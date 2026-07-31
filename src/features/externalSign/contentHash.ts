import type { ExternalSignWireRequestV1, OriginContextV1 } from './contract'
import type { ExternalSignTxReviewV1 } from './review'

export type ExternalSignContentHash = `sha256:${string}`

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export function canonicalizeJcs(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(',')}]`
  const object = value as { readonly [key: string]: JsonValue }
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalizeJcs(object[key])}`).join(',')}}`
}

export function createExternalSignCommitment(
  request: ExternalSignWireRequestV1,
  origin: OriginContextV1,
  review: ExternalSignTxReviewV1
): JsonValue {
  return {
    chainId: request.chainId,
    expiresAt: request.expiresAt.toString(10),
    intentId: request.intentId ?? null,
    mode: request.mode,
    origin: {
      authenticatedOrigin: origin.authenticatedOrigin,
      declaredOrigin: origin.declaredOrigin,
      status: origin.status
    },
    protocolId: request.protocolId,
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    requester: {
      applicationUrl: request.requester.applicationUrl ?? null,
      displayName: request.requester.displayName
    },
    transaction: {
      feeSats: review.feeSats,
      inputTotalSats: review.inputTotalSats,
      inputs: review.inputs.map(input => ({
        index: input.index,
        outputScript: input.outputScript,
        ownedByActiveWallet: input.ownedByActiveWallet,
        sats: input.sats,
        token: input.token,
        txid: input.txid,
        vout: input.vout
      })),
      lockTime: review.lockTime,
      outputTotalSats: review.outputTotalSats,
      outputs: review.outputs.map(output => ({
        address: output.address,
        classification: output.classification,
        index: output.index,
        opReturn: output.opReturn,
        outputScript: output.outputScript,
        sats: output.sats,
        token: output.token
      })),
      serializedSizeBytes: review.serializedSizeBytes,
      unsignedTxHex: review.unsignedTxHex,
      version: review.version
    }
  }
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

export async function calculateExternalSignContentHash(
  request: ExternalSignWireRequestV1,
  origin: OriginContextV1,
  review: ExternalSignTxReviewV1,
  cryptoRef: Pick<Crypto, 'subtle'> = globalThis.crypto
): Promise<ExternalSignContentHash> {
  const commitment = canonicalizeJcs(createExternalSignCommitment(request, origin, review))
  const domain = new TextEncoder().encode('tonalli.external-sign/content-hash/v1')
  const canonical = new TextEncoder().encode(commitment)
  const preimage = new Uint8Array(domain.length + 1 + canonical.length)
  preimage.set(domain)
  preimage[domain.length] = 0
  preimage.set(canonical, domain.length + 1)
  const digest = await cryptoRef.subtle.digest('SHA-256', preimage)
  return `sha256:${toHex(new Uint8Array(digest))}`
}

export function equalContentHashes(left: ExternalSignContentHash, right: ExternalSignContentHash): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
