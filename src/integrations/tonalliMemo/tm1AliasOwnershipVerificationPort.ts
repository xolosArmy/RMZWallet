import { canonicalizeEcashAddress, toXecAlias } from '../../utils/alias'
import {
  Tm1AliasPublicationAuthorizationError,
  type Tm1AliasPublicationAuthorizationErrorCode
} from './tm1AliasPublicationAuthorizationError'
import { mintTm1VerifiedAliasOwnershipToken } from './tm1AliasVerifiedOwnershipMint'

/**
 * Fail-closed verification port: an injected observer plus a trusted clock
 * may mint a Tm1VerifiedAliasOwnershipToken. Caller JSON cannot.
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

export type Tm1AliasOwnershipObserver = (input: Readonly<{
  alias: string
  ownerAddress: string
  signal?: AbortSignal
}>) => Promise<unknown>

type FrozenDeps = Readonly<{
  observe: Tm1AliasOwnershipObserver
  clock: () => number
}>

const objectFreeze = Object.freeze as <T extends object>(value: T) => T

export class Tm1AliasOwnershipVerificationPort {
  private readonly observe: Tm1AliasOwnershipObserver
  private readonly clock: () => number

  private constructor(depsValue: unknown) {
    const deps = parseDeps(depsValue)
    this.observe = deps.observe
    this.clock = deps.clock
  }

  static create(depsValue: unknown): Tm1AliasOwnershipVerificationPort {
    return new Tm1AliasOwnershipVerificationPort(depsValue)
  }

  async verify(requestValue: unknown): Promise<object> {
    const request = parseVerifyRequest(requestValue)
    let observation: unknown
    try {
      observation = await this.observe(request)
    } catch (error) {
      if (error instanceof Tm1AliasOwnershipVerificationError) throw error
      if (error instanceof Tm1AliasPublicationAuthorizationError) throw error
      throw new Tm1AliasOwnershipVerificationError('ALIAS_OWNERSHIP_UNAVAILABLE')
    }
    const parsed = parseObservation(observation)
    if (parsed.alias !== request.alias || parsed.address !== request.ownerAddress) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_OWNER_MISMATCH')
    }
    if (parsed.status !== 'confirmed' || parsed.blockHeight < 1) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_UNCONFIRMED')
    }
    if (parsed.expiresAt !== undefined) {
      const trustedNow = this.clock()
      if (!Number.isFinite(trustedNow)) {
        throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
      }
      if (trustedNow >= parsed.expiresAt) {
        throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_EXPIRED')
      }
    }
    return mintTm1VerifiedAliasOwnershipToken({
      alias: parsed.alias,
      address: parsed.address,
      txid: parsed.txid,
      blockHeight: parsed.blockHeight,
      status: 'confirmed',
      ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt })
    })
  }
}

export function createTm1AliasOwnershipVerificationPort(
  depsValue: unknown
): Tm1AliasOwnershipVerificationPort {
  return Tm1AliasOwnershipVerificationPort.create(depsValue)
}

function parseDeps(value: unknown): FrozenDeps {
  const source = allowedRecord(value, ['observe', 'clock'])
  if (
    !Reflect.ownKeys(source).includes('observe') ||
    !Reflect.ownKeys(source).includes('clock')
  ) invalidInput()
  const observe = dataValue(source, 'observe')
  const clock = dataValue(source, 'clock')
  if (typeof observe !== 'function' || typeof clock !== 'function') invalidInput()
  return objectFreeze({
    observe: observe as Tm1AliasOwnershipObserver,
    clock: clock as () => number
  })
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
      'blockHeight',
      'status',
      'expiresAt'
    ])
  } catch (error) {
    if (error instanceof Tm1AliasPublicationAuthorizationError) {
      throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
    }
    throw error
  }
  const required = ['alias', 'address', 'txid', 'blockHeight', 'status']
  if (required.some(key => !Reflect.ownKeys(source).includes(key))) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const status = dataValue(source, 'status')
  if (typeof status !== 'string' || status.trim() !== status || status.length === 0) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const blockHeight = dataValue(source, 'blockHeight')
  if (!Number.isSafeInteger(blockHeight) || (blockHeight as number) < 0) {
    throw new Tm1AliasOwnershipVerificationError('ALIAS_PROOF_UNVERIFIABLE')
  }
  const txidValue = dataValue(source, 'txid')
  if (typeof txidValue !== 'string' || !/^[0-9a-f]{64}$/.test(txidValue)) {
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
