import { canonicalizeEcashAddress, toXecAlias } from '../../utils/alias'
import { Tm1AliasPublicationAuthorizationError } from './tm1AliasPublicationAuthorizationError'

const TXID_PATTERN = /^[0-9a-f]{64}$/

const weakMapGet = Function.prototype.call.bind(WeakMap.prototype.get) as <V>(
  map: WeakMap<object, V>,
  key: object
) => V | undefined
const weakMapSet = Function.prototype.call.bind(WeakMap.prototype.set) as <V>(
  map: WeakMap<object, V>,
  key: object,
  value: V
) => WeakMap<object, V>
const objectFreeze = Object.freeze as <T extends object>(value: T) => T

export type Tm1VerifiedAliasOwnershipSnapshot = Readonly<{
  alias: string
  address: string
  txid: string
  blockHeight: number
  expiresAt?: number
}>

const verifiedEvidenceSnapshots = new WeakMap<object, Tm1VerifiedAliasOwnershipSnapshot>()

/**
 * Module-internal mint. Not a public API. Wallet UI and publication
 * routes must not import this file. Ordinary caller JSON cannot obtain a token.
 */
export function mintTm1VerifiedAliasOwnershipToken(value: unknown): object {
  const parsed = parseMintObservation(value)
  if (parsed.status !== 'confirmed' || parsed.blockHeight < 1) fail('ALIAS_UNCONFIRMED')
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

function parseMintObservation(value: unknown): Readonly<{
  alias: string
  address: string
  txid: string
  blockHeight: number
  status: string
  expiresAt?: number
}> {
  const source = allowedRecord(value, [
    'alias',
    'address',
    'txid',
    'blockHeight',
    'status',
    'expiresAt'
  ])
  const required = ['alias', 'address', 'txid', 'blockHeight', 'status']
  if (required.some(key => !Reflect.ownKeys(source).includes(key))) invalidInput()
  const status = dataValue(source, 'status')
  if (typeof status !== 'string' || status.trim() !== status || status.length === 0) {
    invalidInput()
  }
  const blockHeight = dataValue(source, 'blockHeight')
  if (!Number.isSafeInteger(blockHeight) || (blockHeight as number) < 0) invalidInput()
  const txidValue = dataValue(source, 'txid')
  if (typeof txidValue !== 'string' || !TXID_PATTERN.test(txidValue)) {
    fail('ALIAS_PROOF_UNVERIFIABLE')
  }
  const expiresAt = optionalSafeInteger(source, 'expiresAt')
  const aliasValue = dataValue(source, 'alias')
  if (typeof aliasValue !== 'string') invalidInput()
  const alias = toXecAlias(aliasValue)
  if (alias === null) invalidInput()
  const addressValue = dataValue(source, 'address')
  if (typeof addressValue !== 'string') invalidInput()
  const address = canonicalizeEcashAddress(addressValue)
  if (address === null) invalidInput()
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
  fail('INVALID_ALIAS_AUTHORIZATION_INPUT')
}

function fail(code: ConstructorParameters<typeof Tm1AliasPublicationAuthorizationError>[0]): never {
  throw new Tm1AliasPublicationAuthorizationError(code)
}
