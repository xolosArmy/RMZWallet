import { canonicalizeEcashAddress, toXecAlias } from '../../utils/alias'

export const TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL =
  'tonalli.tm1-alias-publication-authorization'
export const TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION = 1

const TXID_PATTERN = /^[0-9a-f]{64}$/

export type Tm1AliasPublicationAuthorization = Readonly<{
  protocol: typeof TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL
  protocolVersion: typeof TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION
  alias: string
  ownerAddress: string
  evidenceTxid: string
  evidenceBlockHeight: number
  authorizationId: string
}>

export type Tm1AliasPublicationAuthorizationErrorCode =
  | 'INVALID_ALIAS_AUTHORIZATION_INPUT'
  | 'ALIAS_UNCONFIRMED'
  | 'ALIAS_OWNER_MISMATCH'
  | 'ALIAS_PROOF_UNVERIFIABLE'
  | 'ALIAS_PROOF_EXPIRED'
  | 'ALIAS_PROOF_REPLAYED'
  | 'ALIAS_PROOF_STALE'

export class Tm1AliasPublicationAuthorizationError extends Error {
  readonly code: Tm1AliasPublicationAuthorizationErrorCode

  constructor(code: Tm1AliasPublicationAuthorizationErrorCode) {
    super(code)
    this.name = 'Tm1AliasPublicationAuthorizationError'
    this.code = code
  }
}

export type Tm1AliasPublicationAuthorizationLedger = Readonly<{
  consumedProofs: Set<string>
  latestBlockHeightByAlias: Map<string, number>
}>

/**
 * Process-local replay/stale ledger. It is not durable: a crash loses it.
 * It is not a publication store and grants no transport capability.
 */
export function createTm1InMemoryAliasPublicationAuthorizationLedger():
  Tm1AliasPublicationAuthorizationLedger {
  return Object.freeze({
    consumedProofs: new Set<string>(),
    latestBlockHeightByAlias: new Map<string, number>()
  })
}

/**
 * Fail-closed publication authorization from confirmed .xec ownership evidence.
 * It is not a signer, transport, or broadcast capability.
 */
export class Tm1AliasPublicationAuthorizer {
  private readonly ledger: Tm1AliasPublicationAuthorizationLedger

  private constructor(ledger: Tm1AliasPublicationAuthorizationLedger) {
    this.ledger = ledger
  }

  static create(ledger: Tm1AliasPublicationAuthorizationLedger): Tm1AliasPublicationAuthorizer {
    return new Tm1AliasPublicationAuthorizer(ledger)
  }

  issue(requestValue: unknown): Tm1AliasPublicationAuthorization {
    const request = parseRequest(requestValue)
    const evidence = request.evidence
    if (evidence.alias !== request.alias || evidence.address !== request.ownerAddress) {
      fail('ALIAS_OWNER_MISMATCH')
    }
    if (evidence.status !== 'confirmed' || evidence.blockHeight < 1) {
      fail('ALIAS_UNCONFIRMED')
    }
    if (request.tipHeight !== undefined && evidence.blockHeight > request.tipHeight) {
      fail('ALIAS_PROOF_UNVERIFIABLE')
    }
    if (evidence.expiresAt !== undefined) {
      if (request.now === undefined) fail('ALIAS_PROOF_UNVERIFIABLE')
      if (request.now >= evidence.expiresAt) fail('ALIAS_PROOF_EXPIRED')
    }
    const previousHeight = this.ledger.latestBlockHeightByAlias.get(request.alias)
    if (previousHeight !== undefined && evidence.blockHeight < previousHeight) {
      fail('ALIAS_PROOF_STALE')
    }
    const proofKey = `${request.alias}\0${evidence.txid}`
    if (this.ledger.consumedProofs.has(proofKey)) fail('ALIAS_PROOF_REPLAYED')

    const authorization = Object.freeze({
      protocol: TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL,
      protocolVersion: TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION,
      alias: request.alias,
      ownerAddress: request.ownerAddress,
      evidenceTxid: evidence.txid,
      evidenceBlockHeight: evidence.blockHeight,
      authorizationId: [
        'tm1-alias-auth:v1',
        request.alias,
        request.ownerAddress,
        evidence.txid,
        String(evidence.blockHeight)
      ].join(':')
    }) satisfies Tm1AliasPublicationAuthorization

    this.ledger.consumedProofs.add(proofKey)
    this.ledger.latestBlockHeightByAlias.set(request.alias, evidence.blockHeight)
    return authorization
  }
}

export function createTm1AliasPublicationAuthorizer(
  ledgerValue: unknown
): Tm1AliasPublicationAuthorizer {
  return Tm1AliasPublicationAuthorizer.create(parseLedger(ledgerValue))
}

export function parseTm1AliasPublicationAuthorization(
  value: unknown
): Tm1AliasPublicationAuthorization {
  const source = exactRecord(value, [
    'protocol',
    'protocolVersion',
    'alias',
    'ownerAddress',
    'evidenceTxid',
    'evidenceBlockHeight',
    'authorizationId'
  ])
  const alias = requireAlias(dataValue(source, 'alias'))
  const ownerAddress = requireOwnerAddress(dataValue(source, 'ownerAddress'))
  const evidenceTxid = requireTxid(dataValue(source, 'evidenceTxid'))
  const evidenceBlockHeight = requireConfirmedHeight(
    dataValue(source, 'evidenceBlockHeight')
  )
  const authorizationId = dataValue(source, 'authorizationId')
  const expectedId = [
    'tm1-alias-auth:v1',
    alias,
    ownerAddress,
    evidenceTxid,
    String(evidenceBlockHeight)
  ].join(':')
  if (
    dataValue(source, 'protocol') !== TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL ||
    dataValue(source, 'protocolVersion') !==
      TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION ||
    authorizationId !== expectedId
  ) fail('INVALID_ALIAS_AUTHORIZATION_INPUT')
  return Object.freeze({
    protocol: TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL,
    protocolVersion: TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION,
    alias,
    ownerAddress,
    evidenceTxid,
    evidenceBlockHeight,
    authorizationId: expectedId
  })
}

type ParsedEvidence = Readonly<{
  alias: string
  address: string
  txid: string
  blockHeight: number
  status: string
  expiresAt?: number
}>

type ParsedRequest = Readonly<{
  alias: string
  ownerAddress: string
  evidence: ParsedEvidence
  now?: number
  tipHeight?: number
}>

function parseRequest(value: unknown): ParsedRequest {
  const source = allowedRecord(value, [
    'alias',
    'ownerAddress',
    'evidence',
    'now',
    'tipHeight'
  ])
  if (
    !Reflect.ownKeys(source).includes('alias') ||
    !Reflect.ownKeys(source).includes('ownerAddress') ||
    !Reflect.ownKeys(source).includes('evidence')
  ) invalidInput()
  const now = optionalSafeInteger(source, 'now')
  const tipHeight = optionalSafeInteger(source, 'tipHeight')
  if (tipHeight !== undefined && tipHeight < 0) fail('ALIAS_PROOF_UNVERIFIABLE')
  return Object.freeze({
    alias: requireAlias(dataValue(source, 'alias')),
    ownerAddress: requireOwnerAddress(dataValue(source, 'ownerAddress')),
    evidence: parseEvidence(dataValue(source, 'evidence')),
    ...(now === undefined ? {} : { now }),
    ...(tipHeight === undefined ? {} : { tipHeight })
  })
}

function parseEvidence(value: unknown): ParsedEvidence {
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
  return Object.freeze({
    alias: requireAlias(dataValue(source, 'alias')),
    address: requireOwnerAddress(dataValue(source, 'address')),
    txid: txidValue,
    blockHeight: blockHeight as number,
    status,
    ...(expiresAt === undefined ? {} : { expiresAt })
  })
}

function requireAlias(value: unknown): string {
  if (typeof value !== 'string') invalidInput()
  const alias = toXecAlias(value)
  if (alias === null) invalidInput()
  return alias
}

function requireOwnerAddress(value: unknown): string {
  if (typeof value !== 'string') invalidInput()
  const canonical = canonicalizeEcashAddress(value)
  if (canonical === null) invalidInput()
  return canonical
}

function parseLedger(value: unknown): Tm1AliasPublicationAuthorizationLedger {
  const source = exactRecord(value, ['consumedProofs', 'latestBlockHeightByAlias'])
  const consumedProofs = dataValue(source, 'consumedProofs')
  const latestBlockHeightByAlias = dataValue(source, 'latestBlockHeightByAlias')
  if (!(consumedProofs instanceof Set) || !(latestBlockHeightByAlias instanceof Map)) {
    invalidInput()
  }
  return Object.freeze({
    consumedProofs,
    latestBlockHeightByAlias
  })
}

function requireTxid(value: unknown): string {
  if (typeof value !== 'string' || !TXID_PATTERN.test(value)) invalidInput()
  return value
}

function requireConfirmedHeight(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidInput()
  return value as number
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

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = allowedRecord(value, keys)
  const actualKeys = Reflect.ownKeys(source)
  if (keys.some(key => !actualKeys.includes(key))) invalidInput()
  return source
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

function fail(code: Tm1AliasPublicationAuthorizationErrorCode): never {
  throw new Tm1AliasPublicationAuthorizationError(code)
}
