import { describe, expect, test } from 'vitest'
import {
  Tm1AliasPublicationAuthorizationError,
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer,
  createTm1InMemoryAliasPublicationAuthorizationLedger,
  parseTm1AliasPublicationAuthorization
} from './tm1AliasPublicationAuthorization'

const ALIAS = 'xolosarmy.xec'
const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
const TXID = 'ab'.repeat(32)
const LATER_TXID = 'cd'.repeat(32)

function confirmedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    alias: ALIAS,
    address: OWNER,
    txid: TXID,
    blockHeight: 100,
    status: 'confirmed',
    ...overrides
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    alias: ALIAS,
    ownerAddress: OWNER,
    evidence: confirmedEvidence(),
    ...overrides
  }
}

function authorizer(
  ledger = createTm1InMemoryAliasPublicationAuthorizationLedger()
) {
  return createTm1AliasPublicationAuthorizer(ledger)
}

function rawLedgerBag() {
  return {
    consumedProofs: new Set<string>(),
    latestBlockHeightByAlias: new Map<string, number>()
  }
}

function collectClearableCollections(root: unknown): Array<Set<unknown> | Map<unknown, unknown>> {
  const found: Array<Set<unknown> | Map<unknown, unknown>> = []
  const seen = new Set<object>()
  const visit = (value: unknown) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value)) return
    seen.add(value)
    if (value instanceof Set || value instanceof Map) {
      found.push(value)
      return
    }
    try {
      for (const key of Reflect.ownKeys(value)) {
        try {
          visit(Reflect.get(value, key))
        } catch {
          /* ignore inaccessible */
        }
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (descriptor !== undefined) {
            visit(descriptor.value)
            visit(descriptor.get)
            visit(descriptor.set)
          }
        } catch {
          /* ignore inaccessible */
        }
      }
    } catch {
      /* ignore */
    }
    try {
      visit(Object.getPrototypeOf(value))
    } catch {
      /* ignore */
    }
    try {
      visit((value as { constructor?: unknown }).constructor)
    } catch {
      /* ignore */
    }
  }
  visit(root)
  return found
}

describe('TM1 alias publication authorization', () => {
  test('confirmed alias with matching owner issues a bound authorization', () => {
    const authorization = authorizer().issue(request())
    const parsed = parseTm1AliasPublicationAuthorization(authorization)

    expect(parsed).toMatchObject({
      alias: ALIAS,
      ownerAddress: OWNER,
      evidenceTxid: TXID,
      evidenceBlockHeight: 100
    })
    expect(parsed.authorizationId).toContain(ALIAS)
    expect(parsed.authorizationId).toContain(TXID)
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  test('unconfirmed alias does not issue authorization', () => {
    const issuer = authorizer()
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ status: 'pending' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_UNCONFIRMED' }))
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ blockHeight: 0, status: 'confirmed' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_UNCONFIRMED' }))
  })

  test('alias or owner mismatch does not issue authorization', () => {
    const issuer = authorizer()
    expect(() => issuer.issue(request({
      ownerAddress: OTHER_OWNER
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_OWNER_MISMATCH' }))
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ alias: 'other.xec' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_OWNER_MISMATCH' }))
  })

  test('stale or replayed proof does not issue authorization', () => {
    const issuer = authorizer()
    issuer.issue(request())

    expect(() => issuer.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ txid: LATER_TXID, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_STALE' }))
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({
        txid: LATER_TXID,
        blockHeight: 120,
        expiresAt: 10
      }),
      now: 10
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
  })

  test('authorization object cannot call broadcast or sign', () => {
    const authorization = authorizer().issue(request())
    const keys = Reflect.ownKeys(authorization)

    expect(keys).not.toContain('broadcast')
    expect(keys).not.toContain('sign')
    expect(keys).not.toContain('broadcastTx')
    expect(typeof (authorization as { broadcast?: unknown }).broadcast).toBe('undefined')
    expect(typeof (authorization as { sign?: unknown }).sign).toBe('undefined')
    expect(Object.values(authorization).every(value => typeof value !== 'function')).toBe(true)
  })

  test('two authorizer instances sharing a ledger reject replay of the same proof', () => {
    const ledger = createTm1InMemoryAliasPublicationAuthorizationLedger()
    const first = createTm1AliasPublicationAuthorizer(ledger)
    const second = createTm1AliasPublicationAuthorizer(ledger)
    first.issue(request())
    expect(() => second.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })

  test('canonical CashAddr casing of the same owner issues authorization', () => {
    const authorization = authorizer().issue({
      alias: ALIAS,
      ownerAddress: OWNER.toUpperCase(),
      evidence: confirmedEvidence()
    })
    expect(authorization.ownerAddress).toBe(OWNER)
    expect(parseTm1AliasPublicationAuthorization(authorization).ownerAddress).toBe(OWNER)
  })

  test('missing ledger fails closed', () => {
    expect(() => createTm1AliasPublicationAuthorizer(undefined))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => createTm1AliasPublicationAuthorizer({}))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => Tm1AliasPublicationAuthorizer.create(undefined))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
  })

  test('missing, extra, or unverifiable evidence fails closed', () => {
    const issuer = authorizer()
    expect(() => issuer.issue({
      alias: ALIAS,
      ownerAddress: OWNER
    })).toThrowError(Tm1AliasPublicationAuthorizationError)
    expect(() => issuer.issue(request({ extra: true }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ txid: 'zz'.repeat(32) })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_UNVERIFIABLE' }))
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ blockHeight: 200 }),
      tipHeight: 150
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_UNVERIFIABLE' }))
  })

  test('raw Set/Map bag does not construct a usable issuer', () => {
    const bag = rawLedgerBag()
    expect(() => createTm1AliasPublicationAuthorizer(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => Tm1AliasPublicationAuthorizer.create(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    const Stolen = Tm1AliasPublicationAuthorizer as unknown as {
      new (ledger: unknown): unknown
    }
    expect(() => new Stolen(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
  })

  test('after issue(), ledger has no clearable collections that re-issue the same proof', () => {
    const ledger = createTm1InMemoryAliasPublicationAuthorizationLedger()
    const issuer = createTm1AliasPublicationAuthorizer(ledger)
    issuer.issue(request())

    expect(Reflect.ownKeys(ledger)).toEqual([])
    expect('consumedProofs' in ledger).toBe(false)
    expect('latestBlockHeightByAlias' in ledger).toBe(false)
    expect('clear' in ledger).toBe(false)
    expect('reset' in ledger).toBe(false)
    expect(JSON.stringify(ledger)).toBe('{}')

    const leaked = (ledger as {
      consumedProofs?: Set<string>
      latestBlockHeightByAlias?: Map<string, number>
    })
    leaked.consumedProofs?.clear()
    leaked.latestBlockHeightByAlias?.clear()

    for (const collection of [
      ...collectClearableCollections(ledger),
      ...collectClearableCollections(issuer),
      ...collectClearableCollections(JSON.parse(JSON.stringify(ledger))),
      ...collectClearableCollections(Object.create(ledger as object)),
      ...collectClearableCollections(new Proxy(ledger as object, {}))
    ]) {
      collection.clear()
    }

    expect(() => createTm1AliasPublicationAuthorizer(ledger).issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
    expect(() => issuer.issue(request({
      evidence: confirmedEvidence({ txid: LATER_TXID, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_STALE' }))
  })

  test('Object.create, Proxy, and prototype walk cannot yield a clearable shared ledger', () => {
    const ledger = createTm1InMemoryAliasPublicationAuthorizationLedger()
    createTm1AliasPublicationAuthorizer(ledger).issue(request())

    expect(() => createTm1AliasPublicationAuthorizer(Object.create(ledger))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => createTm1AliasPublicationAuthorizer(new Proxy(ledger, {}))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => Tm1AliasPublicationAuthorizer.create(Object.create(null))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )

    let cursor: object | null = ledger as object
    const walked = new Set<object>()
    while (cursor !== null && !walked.has(cursor)) {
      walked.add(cursor)
      for (const collection of collectClearableCollections(cursor)) {
        collection.clear()
      }
      cursor = Object.getPrototypeOf(cursor)
    }

    expect(() => createTm1AliasPublicationAuthorizer(ledger).issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })

  test('distinct opaque ledgers do not share replay state', () => {
    const first = createTm1AliasPublicationAuthorizer(
      createTm1InMemoryAliasPublicationAuthorizationLedger()
    )
    const second = createTm1AliasPublicationAuthorizer(
      createTm1InMemoryAliasPublicationAuthorizationLedger()
    )
    first.issue(request())
    expect(second.issue(request()).evidenceTxid).toBe(TXID)
  })
})
