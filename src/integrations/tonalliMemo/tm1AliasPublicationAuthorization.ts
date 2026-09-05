/// <reference types="vitest/importMeta" />
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
  | 'ALIAS_EVIDENCE_UNTRUSTED'

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
  map: WeakMap<object, unknown>,
  key: object
) => boolean
const weakMapGet = Function.prototype.call.bind(WeakMap.prototype.get) as <V>(
  map: WeakMap<object, V>,
  key: object
) => V | undefined
const weakMapSet = Function.prototype.call.bind(WeakMap.prototype.set) as <V>(
  map: WeakMap<object, V>,
  key: object,
  value: V
) => WeakMap<object, V>
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
const objectFreeze = Object.freeze as <T extends object>(value: T) => T
const arrayJoin = Function.prototype.call.bind(Array.prototype.join) as (
  items: readonly unknown[],
  separator: string
) => string
const applyString = Function.prototype.call.bind(String) as (
  thisArg: unknown,
  value: unknown
) => string

const ledgerStates = new WeakMap<object, LedgerState>()

/**
 * Single process-local replay/stale ledger. It is not durable: a crash
 * loses it. It is not a publication store and grants no transport capability.
 * Ordinary callers cannot mint a replacement identity.
 */
function createProcessLocalLedger(): Tm1AliasPublicationAuthorizationLedger {
  const ledger = objectFreeze(Object.create(null)) as Tm1AliasPublicationAuthorizationLedger
  weakMapSet(ledgerStates, ledger, {
    consumedProofs: new Set<string>(),
    latestBlockHeightByAlias: new Map<string, number>()
  })
  return ledger
}

const processLocalLedger = createProcessLocalLedger()

type VerifiedEvidenceSnapshot = Readonly<{
  alias: string
  address: string
  txid: string
  blockHeight: number
  expiresAt?: number
}>

const verifiedEvidenceSnapshots = new WeakMap<object, VerifiedEvidenceSnapshot>()

/**
 * Unexported mint for the future verification port (slice 4).
 * Not on the public export surface. Ordinary callers cannot obtain it.
 */
function mintVerifiedAliasPublicationEvidence(
  value: unknown
): object {
  const parsed = parseEvidence(value)
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

const internalVerifiedEvidencePort = objectFreeze({
  mint: mintVerifiedAliasPublicationEvidence
})

function lookupVerifiedEvidence(value: unknown): VerifiedEvidenceSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (value === internalVerifiedEvidencePort) invalidInput()
  return weakMapGet(verifiedEvidenceSnapshots, value)
}

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

function commitVerifiedAuthorization(
  ledger: Tm1AliasPublicationAuthorizationLedger,
  request: ParsedRequest
): Tm1AliasPublicationAuthorization {
  const evidence = request.evidence
  const previousHeight = lastHeight(ledger, request.alias)
  if (previousHeight !== undefined && evidence.blockHeight < previousHeight) {
    fail('ALIAS_PROOF_STALE')
  }
  const proofKey = `${request.alias}\0${evidence.txid}`
  if (hasProof(ledger, proofKey)) fail('ALIAS_PROOF_REPLAYED')
  recordProof(ledger, proofKey)
  recordHeight(ledger, request.alias, evidence.blockHeight)
  const authorizationId = arrayJoin([
    'tm1-alias-auth:v1',
    request.alias,
    request.ownerAddress,
    evidence.txid,
    applyString(undefined, evidence.blockHeight)
  ], ':')
  return objectFreeze({
    protocol: TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL,
    protocolVersion: TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION,
    alias: request.alias,
    ownerAddress: request.ownerAddress,
    evidenceTxid: evidence.txid,
    evidenceBlockHeight: evidence.blockHeight,
    authorizationId
  })
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
    if (!request.verified) fail('ALIAS_EVIDENCE_UNTRUSTED')
    return commitVerifiedAuthorization(this.ledger, request)
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
  const expectedId = arrayJoin([
    'tm1-alias-auth:v1',
    alias,
    ownerAddress,
    evidenceTxid,
    applyString(undefined, evidenceBlockHeight)
  ], ':')
  if (
    dataValue(source, 'protocol') !== TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL ||
    dataValue(source, 'protocolVersion') !==
      TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION ||
    authorizationId !== expectedId
  ) fail('INVALID_ALIAS_AUTHORIZATION_INPUT')
  return objectFreeze({
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
  verified: boolean
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
  const alias = requireAlias(dataValue(source, 'alias'))
  const ownerAddress = requireOwnerAddress(dataValue(source, 'ownerAddress'))
  const evidenceValue = dataValue(source, 'evidence')
  const verifiedSnapshot = lookupVerifiedEvidence(evidenceValue)
  const evidence = verifiedSnapshot === undefined
    ? parseEvidence(evidenceValue)
    : objectFreeze({
      alias: verifiedSnapshot.alias,
      address: verifiedSnapshot.address,
      txid: verifiedSnapshot.txid,
      blockHeight: verifiedSnapshot.blockHeight,
      status: 'confirmed',
      ...(verifiedSnapshot.expiresAt === undefined ? {} : { expiresAt: verifiedSnapshot.expiresAt })
    })
  return objectFreeze({
    alias,
    ownerAddress,
    evidence,
    verified: verifiedSnapshot !== undefined,
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
  return objectFreeze({
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

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest
  const owner = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
  const now = 1_700_000_000_000
  const uniqueTxid = (tag: string): string => {
    const bytes = Array.from(tag, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return (bytes + 'cd'.repeat(32)).slice(0, 64)
  }
  const mintAndIssue = (
    tag: string,
    evidenceOverrides: Record<string, unknown>,
    requestOverrides: Record<string, unknown> = {}
  ) => {
    const alias = `${tag}.xec`
    const evidence = mintVerifiedAliasPublicationEvidence({
      alias,
      address: owner,
      txid: uniqueTxid(tag),
      blockHeight: 100,
      status: 'confirmed',
      ...evidenceOverrides
    })
    return createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: owner,
      evidence,
      ...requestOverrides
    })
  }

  describe('TM1 verified evidence expiry (unexported mint)', () => {
    test('P2: verified evidence with expiresAt in the past is expired', () => {
      expect(() => mintAndIssue('vexp', {
        expiresAt: now - 60_000
      }, { now })).toThrowError(
        expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' })
      )
    })

    test('verified evidence with expiresAt in the future can reach commit', () => {
      const authorization = mintAndIssue('vfut', {
        expiresAt: now + 60_000
      }, { now })
      expect(authorization).toMatchObject({
        alias: 'vfut.xec',
        ownerAddress: owner,
        evidenceBlockHeight: 100
      })
      expect(Object.isFrozen(authorization)).toBe(true)
    })

    test('verified evidence without expiresAt does not take the expiry branch', () => {
      const authorization = mintAndIssue('vnexp', {}, { now })
      expect(authorization).toMatchObject({ alias: 'vnexp.xec' })
    })

    test('expired verified evidence does not write replay or height', () => {
      expect(() => mintAndIssue('vled', {
        expiresAt: now - 60_000,
        blockHeight: 500
      }, { now })).toThrowError(
        expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' })
      )
      const later = mintAndIssue('vled', {
        txid: uniqueTxid('vledz'),
        blockHeight: 50
      }, { now })
      expect(later).toMatchObject({
        alias: 'vled.xec',
        evidenceBlockHeight: 50
      })
    })
  })
}
