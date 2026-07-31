import type { ExternalSignWireRequestV1, OriginContextV1 } from './contract'
import { ExternalSignError } from './contract'
import type { ExternalSignResponseV1 } from './signOnly'

export const EXTERNAL_SIGN_READY_MESSAGE = 'TONALLI_EXTERNAL_SIGN_READY_V1'
export const EXTERNAL_SIGN_ORIGIN_PROOF_MESSAGE = 'TONALLI_EXTERNAL_SIGN_ORIGIN_PROOF_V1'

type OriginWindow = Pick<Window, 'addEventListener' | 'removeEventListener' | 'opener' | 'setTimeout' | 'clearTimeout'>

export function declaredOriginContext(request: ExternalSignWireRequestV1): OriginContextV1 {
  const declaredOrigin = request.requester.declaredOrigin ?? null
  return Object.freeze({
    status: declaredOrigin ? 'declared-unverified' : 'unknown',
    authenticatedOrigin: null,
    declaredOrigin,
    evidence: declaredOrigin ? 'metadata-only' : 'none'
  })
}

const nonceBase64Url = (cryptoRef: Pick<Crypto, 'getRandomValues'>): string => {
  const bytes = cryptoRef.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function authenticateExternalSignOrigin(
  request: ExternalSignWireRequestV1,
  cryptoRef: Pick<Crypto, 'getRandomValues'>,
  windowRef: OriginWindow,
  timeoutMs = 1_500
): Promise<OriginContextV1> {
  const opener = windowRef.opener
  if (!opener) return declaredOriginContext(request)
  const nonce = nonceBase64Url(cryptoRef)

  return new Promise(resolve => {
    const fallback = declaredOriginContext(request)
    const cleanup = () => {
      windowRef.removeEventListener('message', onMessage)
      windowRef.clearTimeout(timer)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener || !event.data || typeof event.data !== 'object') return
      const data = event.data as Record<string, unknown>
      if (data.type !== EXTERNAL_SIGN_ORIGIN_PROOF_MESSAGE || data.requestId !== request.requestId || data.nonce !== nonce) return
      let authenticatedOrigin: string
      try {
        const parsed = new URL(event.origin)
        if (parsed.protocol !== 'https:' || parsed.origin !== event.origin) return
        authenticatedOrigin = parsed.origin
      } catch {
        return
      }
      cleanup()
      resolve(Object.freeze({
        status: 'authenticated',
        authenticatedOrigin,
        declaredOrigin: request.requester.declaredOrigin ?? null,
        evidence: 'postMessage-opener'
      }))
    }
    const timer = windowRef.setTimeout(() => {
      cleanup()
      resolve(fallback)
    }, timeoutMs)
    windowRef.addEventListener('message', onMessage)
    opener.postMessage({ type: EXTERNAL_SIGN_READY_MESSAGE, requestId: request.requestId, nonce }, '*')
  })
}

export function assertExternalSignOriginAllowed(origin: OriginContextV1, allowedOrigins: readonly string[]): void {
  if (origin.status !== 'authenticated' || !origin.authenticatedOrigin) {
    throw new ExternalSignError('ORIGIN_NOT_AUTHENTICATED')
  }
  if (!allowedOrigins.includes(origin.authenticatedOrigin)) {
    throw new ExternalSignError('ORIGIN_NOT_ALLOWED')
  }
}

export function deliverExternalSignResponse(
  response: ExternalSignResponseV1,
  origin: OriginContextV1,
  opener: Pick<Window, 'postMessage'> | null
): boolean {
  if (origin.status !== 'authenticated' || !origin.authenticatedOrigin || !opener) return false
  opener.postMessage(response, origin.authenticatedOrigin)
  return true
}
