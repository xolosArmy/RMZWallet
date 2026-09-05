import { canonicalizeEcashAddress, toXecAlias } from '../../utils/alias'
import {
  Tm1AliasPublicationAuthorizationError,
  type Tm1AliasPublicationAuthorizationErrorCode
} from './tm1AliasPublicationAuthorizationError'

/**
 * Fail-closed verification port bound to alias.ecash.mx (same protocol as
 * useAliasResolution). Caller JSON and caller observe() lambdas cannot mint.
 * mintVerifiedAliasOwnershipToken is file-private. It is not exported.
 *
 * NOT SUFFICIENT TO ENABLE PUBLICATION
 * This module is not a signer, transport, wallet root, or UI wire.
 */

export type Tm1AliasOwnershipVerificationErrorCode =
  | Tm1AliasPublicationAuthorizationErrorCode
  | 'ALIAS_OWNERSHIP_UNAVAILABLE'

export class Tm1AliasOwnershipVerificationError extends Error {
  readonly code: Tm1AliasOwnershipVerificationErrorCode

  constructor(code: Tm1AliasOwnershipVerificationErrorCode) {
    super(code)
    this.name = 'Tm1AliasOwnershipVerificationError'
    this.code = code
  }
}

const TRUSTED_ALIAS_ENDPOINT = 'https://alias.ecash.mx/alias'
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 65_536
const TXID_PATTERN = /^[0-9a-f]{64}$/
const fetchImpl = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : undefined

const objectFreeze = Object.freeze as <T extends object>(value: T) => T
const weakMapGet = Function.prototype.call.bind(WeakMap.prototype.get) as <V>(
  map: WeakMap<object, V>,
  key: object
) => V | undefined
const weakMapSet = Function.prototype.call.bind(WeakMap.prototype.set) as <V>(
  map: WeakMap<object, V>,
  key: object,
  value: V
) => WeakMap<object, V>
const weakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object
) => WeakSet<object>
const weakSetHas = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object
) => boolean
const authenticPorts = new WeakSet<object>()

export type Tm1VerifiedAliasOwnershipSnapshot = Readonly<{
  alias: string
  address: string
  txid: string
  blockHeight: number
  expiresAt?: number
}>

const verifiedEvidenceSnapshots = new WeakMap<object, Tm1VerifiedAliasOwnershipSnapshot>()

function mintVerifiedAliasOwnershipToken(
  parsed: Tm1VerifiedAliasOwnershipSnapshot
): object {
  const token = objectFreeze(Object.create(null))
  weakMapSet(verifiedEvidenceSnapshots, token, objectFreeze({
    alias: parsed.alias,
    address: parsed.address,
    txid: parsed.txid,
    blockHeight: parsed.blockHeight,
    ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt })
  }))
  return token
}

export function lookupTm1VerifiedAliasOwnershipToken(
  value: unknown
): Tm1VerifiedAliasOwnershipSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return weakMapGet(verifiedEvidenceSnapshots, value)
}

export class Tm1AliasOwnershipVerificationPort {
  readonly #authentic = true

  private constructor() {
    weakSetAdd(authenticPorts, this)
  }

  static create(depsValue?: unknown): Tm1AliasOwnershipVerificationPort {
    parsePublicCreate(depsValue)
    return new Tm1AliasOwnershipVerificationPort()
  }

  async verify(requestValue: unknown): Promise<object> {
    try {
      if (this.#authentic !== true) invalidInput()
    } catch {
      invalidInput()
    }
    requireAuthenticPort(this)
    const request = parseVerifyRequest(requestValue)
    const observation = await observeAliasOwnership(request.alias, request.signal)
    const parsed = parseObservation(observation)
    if (parsed.alias !== request.alias || parsed.address !== request.ownerAddress) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_OWNER_MISMATCH')
    }
    if (parsed.status !== 'confirmed' || parsed.blockHeight < 1) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_UNCONFIRMED')
    }
    if (parsed.expiresAt !== undefined) {
      const trustedNow = readTrustedNow()
      if (trustedNow >= parsed.expiresAt) {
        throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_EXPIRED')
      }
    }
    return mintVerifiedAliasOwnershipToken({
      alias: parsed.alias,
      address: parsed.address,
      txid: parsed.txid,
      blockHeight: parsed.blockHeight,
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt })
    })
  }
}

export function createTm1AliasOwnershipVerificationPort(
  depsValue?: unknown
): Tm1AliasOwnershipVerificationPort {
  return Tm1AliasOwnershipVerificationPort.create(depsValue)
}

function parsePublicCreate(value: unknown): void {
  if (value === undefined || value === null) return
  allowedRecord(value, [])
}

function requireAuthenticPort(value: unknown): asserts value is Tm1AliasOwnershipVerificationPort {
  if (value === null || typeof value !== 'object' || !weakSetHas(authenticPorts, value)) {
    invalidInput()
  }
}

async function observeAliasOwnership(alias: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) unavailable()
  if (typeof fetchImpl !== 'function') unavailable()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const onAbort = (): void => {
    controller.abort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetchImpl(`${TRUSTED_ALIAS_ENDPOINT}/${encodeURIComponent(alias)}`, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: Object.freeze({ accept: 'application/json' })
    })
    return await decodeAliasResponse(response, controller.signal)
  } catch (error) {
    if (error instanceof Tm1AliasOwnershipVerificationError) throw error
    if (error instanceof Tm1AliasPublicationAuthorizationError) throw error
    unavailable()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function readTrustedNow(): number {
  const trustedNow = (Function.prototype.call.bind(Date.now) as () => number)()
  if (!Number.isFinite(trustedNow)) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  return trustedNow
}

async function decodeAliasResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status === 404) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_UNCONFIRMED')
  }
  const body = await readLimitedBody(response, signal)
  if (!response.ok) unavailable()
  if (body.length === 0) unverifiable()
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    unverifiable()
  }
  if (parsed === null) unverifiable()
  return parsed
}

async function readLimitedBody(response: Response, signal: AbortSignal): Promise<string> {
  const stream = response.body
  if (stream === null) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let received = 0
  const parts: string[] = []
  const abortRead = (): void => {
    void reader.cancel()
  }
  if (signal.aborted) {
    abortRead()
    unavailable()
  }
  signal.addEventListener('abort', abortRead, { once: true })
  try {
    while (true) {
      if (signal.aborted) unavailable()
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_RESPONSE_BYTES) unavailable()
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    signal.removeEventListener('abort', abortRead)
  }
}

function unavailable(): never {
  throw new Tm1AliasOwnershipVerificationError('ALIAS_OWNERSHIP_UNAVAILABLE')
}

function unverifiable(): never {
  throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
}

function parseVerifyRequest(value: unknown): Readonly<{
  alias: string
  ownerAddress: string
  signal?: AbortSignal
}> {
  const source = allowedRecord(value, ['alias', 'ownerAddress', 'signal'])
  if (
    !Reflect.ownKeys(source).includes('alias') ||
    !Reflect.ownKeys(source).includes('ownerAddress')
  ) invalidInput()
  const aliasValue = dataValue(source, 'alias')
  if (typeof aliasValue !== 'string') invalidInput()
  const alias = toXecAlias(aliasValue)
  if (alias === null) invalidInput()
  const ownerValue = dataValue(source, 'ownerAddress')
  if (typeof ownerValue !== 'string') invalidInput()
  const ownerAddress = canonicalizeEcashAddress(ownerValue)
  if (ownerAddress === null) invalidInput()
  if (!Reflect.ownKeys(source).includes('signal')) {
    return objectFreeze({ alias, ownerAddress })
  }
  const signal = dataValue(source, 'signal')
  if (!(signal instanceof AbortSignal)) invalidInput()
  return objectFreeze({ alias, ownerAddress, signal })
}

function parseObservation(value: unknown): Readonly<{
  alias: string
  address: string
  txid: string
  blockHeight: number
  status: string
  expiresAt?: number
}> {
  if (value === null || value === undefined) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  let source: Record<string, unknown>
  try {
    source = allowedRecord(value, [
      'alias',
      'address',
      'txid',
      'blockheight',
      'status',
      'source',
      'expiresAt'
    ])
  } catch (error) {
    if (error instanceof Tm1AliasPublicationAuthorizationError) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
    }
    throw error
  }
  const required = ['alias', 'address', 'txid', 'status']
  if (required.some(key => !Reflect.ownKeys(source).includes(key))) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const status = dataValue(source, 'status')
  if (typeof status !== 'string' || status.trim() !== status || status.length === 0) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  if (!Reflect.ownKeys(source).includes('blockheight')) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_UNCONFIRMED')
  }
  const blockHeight = dataValue(source, 'blockheight')
  if (!Number.isSafeInteger(blockHeight) || (blockHeight as number) < 0) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const txidValue = dataValue(source, 'txid')
  if (typeof txidValue !== 'string' || !TXID_PATTERN.test(txidValue)) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  let expiresAt: number | undefined
  try {
    expiresAt = optionalSafeInteger(source, 'expiresAt')
  } catch {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const aliasValue = dataValue(source, 'alias')
  const addressValue = dataValue(source, 'address')
  if (typeof aliasValue !== 'string' || typeof addressValue !== 'string') {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const alias = toXecAlias(aliasValue)
  const address = canonicalizeEcashAddress(addressValue)
  if (alias === null || address === null) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  return objectFreeze({
    alias,
    address,
    txid: txidValue,
    blockHeight: blockHeight as number,
    status,
    ...(expiresAt === undefined ? {} : { expiresAt })
  })
}

function optionalSafeInteger(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  if (!Reflect.ownKeys(source).includes(key)) return undefined
  const value = dataValue(source, key)
  if (!Number.isSafeInteger(value)) invalidInput()
  return value as number
}

function allowedRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidInput()
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidInput()
  }
  if (
    prototype !== Object.prototype && prototype !== null ||
    keys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))
  ) invalidInput()
  return value as Record<string, unknown>
}

function dataValue(source: Record<string, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key)
  } catch {
    return invalidInput()
  }
  if (descriptor === undefined || !('value' in descriptor)) invalidInput()
  return descriptor.value
}

function invalidInput(): never {
  throw new Tm1AliasPublicationAuthorizationError('INVALID_ALIAS_AUTHORIZATION_INPUT')
}
