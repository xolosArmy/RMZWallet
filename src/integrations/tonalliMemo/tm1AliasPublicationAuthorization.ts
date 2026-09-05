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

declare const tm1AliasPublicationAuthorizationLedgerBrand: unique symbol

/**
 * Process-local replay/stale ledger identity. Collections are not own
 * properties. It is not durable: a crash loses it. It is not a publication
 * store and grants no transport capability.
 */
type Tm1AliasPublicationAuthorizationLedger = Readonly<{
  readonly [tm1AliasPublicationAuthorizationLedgerBrand]: never
}>

type LedgerState = {
  consumedProofs: Set<string>
  latestBlockHeightByAlias: Map<string, number>
}

const weakMapHas = Function.prototype.call.bind(WeakMap.prototype.has) as (
  map: WeakMap<object, LedgerState>,
  key: object
) => boolean
const weakMapGet = Function.prototype.call.bind(WeakMap.prototype.get) as (
  map: WeakMap<object, LedgerState>,
  key: object
) => LedgerState | undefined
const weakMapSet = Function.prototype.call.bind(WeakMap.prototype.set) as (
  map: WeakMap<object, LedgerState>,
  key: object,
  value: LedgerState
) => WeakMap<object, LedgerState>
const setHas = Function.prototype.call.bind(Set.prototype.has) as (
  set: Set<string>,
  value: string
) => boolean
const setAdd = Function.prototype.call.bind(Set.prototype.add) as (
  set: Set<string>,
  value: string
) => Set<string>
const mapGet = Function.prototype.call.bind(Map.prototype.get) as (
  map: Map<string, number>,
  key: string
) => number | undefined
const mapSet = Function.prototype.call.bind(Map.prototype.set) as (
  map: Map<string, number>,
  key: string,
  value: number
) => Map<string, number>

const ledgerStates = new WeakMap<object, LedgerState>()

/**
 * Single process-local replay/stale ledger. It is not durable: a crash
 * loses it. It is not a publication store and grants no transport capability.
 * Ordinary callers cannot mint a replacement identity.
 */
function createProcessLocalLedger(): Tm1AliasPublicationAuthorizationLedger {
  const ledger = Object.freeze(Object.create(null)) as Tm1AliasPublicationAuthorizationLedger
  weakMapSet(ledgerStates, ledger, {
    consumedProofs: new Set<string>(),
    latestBlockHeightByAlias: new Map<string, number>()
  })
  return ledger
}

const processLocalLedger = createProcessLocalLedger()

function parseLedger(value: unknown): Tm1AliasPublicationAuthorizationLedger {
  if (value === null || typeof value !== 'object') invalidInput()
  if (!weakMapHas(ledgerStates, value)) invalidInput()
  return value as Tm1AliasPublicationAuthorizationLedger
}

function requireLedgerState(ledger: Tm1AliasPublicationAuthorizationLedger): LedgerState {
  const state = weakMapGet(ledgerStates, ledger)
  if (state === undefined) invalidInput()
  return state
}

function hasProof(ledger: Tm1AliasPublicationAuthorizationLedger, proofKey: string): boolean {
  return setHas(requireLedgerState(ledger).consumedProofs, proofKey)
}

function recordProof(ledger: Tm1AliasPublicationAuthorizationLedger, proofKey: string): void {
  setAdd(requireLedgerState(ledger).consumedProofs, proofKey)
}

function lastHeight(
  ledger: Tm1AliasPublicationAuthorizationLedger,
  alias: string
): number | undefined {
  return mapGet(requireLedgerState(ledger).latestBlockHeightByAlias, alias)
}

function recordHeight(
  ledger: Tm1AliasPublicationAuthorizationLedger,
  alias: string,
  height: number
): void {
  mapSet(requireLedgerState(ledger).latestBlockHeightByAlias, alias, height)
}

/**
 * Fail-closed publication authorization from confirmed .xec ownership evidence.
 * It is not a signer, transport, or broadcast capability.
 *
 * Caller-supplied evidence is not on-chain verification.
 * NOT SUFFICIENT TO ENABLE PUBLICATION
 */
export class Tm1AliasPublicationAuthorizer {
  private readonly ledger: Tm1AliasPublicationAuthorizationLedger

  private constructor(ledgerValue: unknown) {
    this.ledger = parseLedger(ledgerValue)
  }

  static create(): Tm1AliasPublicationAuthorizer {
    return new Tm1AliasPublicationAuthorizer(parseLedger(processLocalLedger))
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
    const previousHeight = lastHeight(this.ledger, request.alias)
    if (previousHeight !== undefined && evidence.blockHeight < previousHeight) {
      fail('ALIAS_PROOF_STALE')
    }
    const proofKey = `${request.alias}\0${evidence.txid}`
    if (hasProof(this.ledger, proofKey)) fail('ALIAS_PROOF_REPLAYED')

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

    recordProof(this.ledger, proofKey)
    recordHeight(this.ledger, request.alias, evidence.blockHeight)
    return authorization
  }
}

export function createTm1AliasPublicationAuthorizer(): Tm1AliasPublicationAuthorizer {
  parseLedger(processLocalLedger)
  return Tm1AliasPublicationAuthorizer.create()
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
