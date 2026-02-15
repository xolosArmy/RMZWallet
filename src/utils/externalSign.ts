import { Tx, toHexRev } from 'ecash-lib'

export const EXTERNAL_SIGN_REQUEST_STORAGE_KEY = 'rmz_external_sign_request'
export const EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY = 'rmz_external_sign_return_to'

export type ExternalSignFlow = 'pledge' | 'activation'

export type ExternalSignRequest = {
  unsignedTxHex: string
  broadcast?: boolean
  meta?: {
    flow?: ExternalSignFlow | string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type ExternalSignOutpoint = {
  txid: string
  vout: number
}

function isHexString(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
}

function decodeBase64ToUtf8(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)

  if (typeof atob === 'function') {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }

  const globalWithBuffer = globalThis as typeof globalThis & {
    Buffer?: {
      from: (value: string, encoding: string) => { toString: (encoding: string) => string }
    }
  }
  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(padded, 'base64').toString('utf8')
  }

  throw new Error('No se pudo decodificar base64 en este entorno.')
}

function parseRequestPayload(payload: unknown): ExternalSignRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request inválido: se esperaba un objeto JSON.')
  }

  const candidate = payload as ExternalSignRequest
  if (typeof candidate.unsignedTxHex !== 'string' || candidate.unsignedTxHex.trim().length === 0) {
    throw new Error('Request inválido: falta unsignedTxHex.')
  }

  const normalizedUnsignedTxHex = candidate.unsignedTxHex.trim()
  if (!isHexString(normalizedUnsignedTxHex)) {
    throw new Error('Request inválido: unsignedTxHex no es hex válido.')
  }

  if (candidate.broadcast !== undefined && typeof candidate.broadcast !== 'boolean') {
    throw new Error('Request inválido: broadcast debe ser boolean.')
  }

  return {
    ...candidate,
    unsignedTxHex: normalizedUnsignedTxHex
  }
}

function tryJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

export function parseExternalSignRequestParam(paramValue: string): ExternalSignRequest {
  const trimmed = paramValue.trim()
  if (!trimmed) {
    throw new Error('Request inválido: parámetro vacío.')
  }

  const directJson = tryJsonParse(trimmed)
  if (directJson) {
    return parseRequestPayload(directJson)
  }

  let decodedComponent = trimmed
  try {
    decodedComponent = decodeURIComponent(trimmed)
  } catch {
    decodedComponent = trimmed
  }

  const decodedJson = tryJsonParse(decodedComponent)
  if (decodedJson) {
    return parseRequestPayload(decodedJson)
  }

  const decodedBase64 = decodeBase64ToUtf8(decodedComponent)
  const decodedBase64Json = tryJsonParse(decodedBase64)
  if (!decodedBase64Json) {
    throw new Error('Request inválido: no se pudo decodificar JSON desde request.')
  }

  return parseRequestPayload(decodedBase64Json)
}

export function parseExternalSignRequestStored(rawStored: string): ExternalSignRequest {
  const parsed = tryJsonParse(rawStored)
  if (!parsed) {
    throw new Error('Request guardado inválido en sessionStorage.')
  }
  return parseRequestPayload(parsed)
}

export function extractOutpointsFromUnsignedTxHex(unsignedTxHex: string): ExternalSignOutpoint[] {
  const normalized = unsignedTxHex.trim()
  if (!isHexString(normalized)) {
    throw new Error('unsignedTxHex inválido: no es hex válido.')
  }

  const tx = Tx.fromHex(normalized)
  if (!tx.inputs.length) {
    throw new Error('unsignedTxHex inválido: no contiene inputs.')
  }

  return tx.inputs.map((input, index) => {
    const txid = typeof input.prevOut.txid === 'string' ? input.prevOut.txid : toHexRev(input.prevOut.txid)
    const vout = Number(input.prevOut.outIdx)
    if (!Number.isSafeInteger(vout) || vout < 0) {
      throw new Error(`unsignedTxHex inválido: input ${index} tiene vout inválido.`)
    }
    return {
      txid: txid.toLowerCase(),
      vout
    }
  })
}
