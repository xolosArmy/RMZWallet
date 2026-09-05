import { describe, expect, test } from 'vitest'
import * as aliasAuth from './tm1AliasPublicationAuthorization'
import {
  Tm1AliasPublicationAuthorizationError,
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer,
  parseTm1AliasPublicationAuthorization
} from './tm1AliasPublicationAuthorization'

const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'

function txidFrom(tag: string): string {
  const bytes = Array.from(tag, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return (bytes + 'ab'.repeat(32)).slice(0, 64)
}

function fixture(tag: string) {
  const alias = `${tag}.xec`
  const txid = txidFrom(tag)
  const laterTxid = txidFrom(`${tag}z`)
  const evidence = (overrides: Record<string, unknown> = {}) => ({
    alias,
    address: OWNER,
    txid,
    blockHeight: 100,
    status: 'confirmed',
    ...overrides
  })
  const request = (overrides: Record<string, unknown> = {}) => {
    const evidenceValue = overrides.evidence
    const rest = { ...overrides }
    delete rest.evidence
    return {
      alias,
      ownerAddress: OWNER,
      evidence: evidenceValue === undefined ? evidence() : evidenceValue,
      ...rest
    }
  }
  return { alias, txid, laterTxid, evidence, request }
}

function authorizer() {
  return createTm1AliasPublicationAuthorizer()
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

function patchIntrinsicsRecordingReceivers(receivers: object[]): () => void {
  const originals = {
    weakMapGet: WeakMap.prototype.get,
    weakMapHas: WeakMap.prototype.has,
    weakMapSet: WeakMap.prototype.set,
    setHas: Set.prototype.has,
    setAdd: Set.prototype.add,
    mapGet: Map.prototype.get,
    mapSet: Map.prototype.set
  }
  WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
    receivers.push(this)
    const value = originals.weakMapGet.call(this, key)
    if (typeof value === 'object' && value !== null) receivers.push(value)
    return value
  } as typeof WeakMap.prototype.get
  WeakMap.prototype.has = function (this: WeakMap<object, unknown>, key: object) {
    receivers.push(this)
    return originals.weakMapHas.call(this, key)
  } as typeof WeakMap.prototype.has
  WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
    receivers.push(this)
    if (typeof value === 'object' && value !== null) receivers.push(value)
    return originals.weakMapSet.call(this, key, value)
  } as typeof WeakMap.prototype.set
  Set.prototype.has = function (this: Set<unknown>, value: unknown) {
    receivers.push(this)
    return originals.setHas.call(this, value)
  } as typeof Set.prototype.has
  Set.prototype.add = function (this: Set<unknown>, value: unknown) {
    receivers.push(this)
    return originals.setAdd.call(this, value)
  } as typeof Set.prototype.add
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    receivers.push(this)
    return originals.mapGet.call(this, key)
  } as typeof Map.prototype.get
  Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    receivers.push(this)
    return originals.mapSet.call(this, key, value)
  } as typeof Map.prototype.set
  return () => {
    WeakMap.prototype.get = originals.weakMapGet
    WeakMap.prototype.has = originals.weakMapHas
    WeakMap.prototype.set = originals.weakMapSet
    Set.prototype.has = originals.setHas
    Set.prototype.add = originals.setAdd
    Map.prototype.get = originals.mapGet
    Map.prototype.set = originals.mapSet
  }
}

function clearRecordedCollections(receivers: readonly object[]): void {
  for (const receiver of receivers) {
    if (receiver instanceof Set || receiver instanceof Map) {
      receiver.clear()
    } else if (typeof receiver === 'object' && receiver !== null) {
      const state = receiver as {
        consumedProofs?: Set<unknown>
        latestBlockHeightByAlias?: Map<unknown, unknown>
      }
      state.consumedProofs?.clear()
      state.latestBlockHeightByAlias?.clear()
    }
  }
}

describe('TM1 alias publication authorization', () => {
  test('confirmed alias with matching owner issues a bound authorization', () => {
    const { alias, txid, request } = fixture('ok1')
    const authorization = authorizer().issue(request())
    const parsed = parseTm1AliasPublicationAuthorization(authorization)

    expect(parsed).toMatchObject({
      alias,
      ownerAddress: OWNER,
      evidenceTxid: txid,
      evidenceBlockHeight: 100
    })
    expect(parsed.authorizationId).toContain(alias)
    expect(parsed.authorizationId).toContain(txid)
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  test('unconfirmed alias does not issue authorization', () => {
    const { request, evidence } = fixture('unconf')
    const issuer = authorizer()
    expect(() => issuer.issue(request({
      evidence: evidence({ status: 'pending' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_UNCONFIRMED' }))
    expect(() => issuer.issue(request({
      evidence: evidence({ blockHeight: 0, status: 'confirmed' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_UNCONFIRMED' }))
  })

  test('alias or owner mismatch does not issue authorization', () => {
    const { request, evidence } = fixture('mismatch')
    const issuer = authorizer()
    expect(() => issuer.issue(request({
      ownerAddress: OTHER_OWNER
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_OWNER_MISMATCH' }))
    expect(() => issuer.issue(request({
      evidence: evidence({ alias: 'other.xec' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_OWNER_MISMATCH' }))
  })

  test('stale or replayed proof does not issue authorization', () => {
    const { request, evidence, laterTxid } = fixture('stale1')
    const issuer = authorizer()
    issuer.issue(request())

    expect(() => issuer.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
    expect(() => issuer.issue(request({
      evidence: evidence({ txid: laterTxid, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_STALE' }))
    expect(() => issuer.issue(request({
      evidence: evidence({
        txid: laterTxid,
        blockHeight: 120,
        expiresAt: 10
      }),
      now: 10
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
  })

  test('authorization object cannot call broadcast or sign', () => {
    const { request } = fixture('nosign')
    const authorization = authorizer().issue(request())
    const keys = Reflect.ownKeys(authorization)

    expect(keys).not.toContain('broadcast')
    expect(keys).not.toContain('sign')
    expect(keys).not.toContain('broadcastTx')
    expect(typeof (authorization as { broadcast?: unknown }).broadcast).toBe('undefined')
    expect(typeof (authorization as { sign?: unknown }).sign).toBe('undefined')
    expect(Object.values(authorization).every(value => typeof value !== 'function')).toBe(true)
  })

  test('two factory() calls share replay of the same proof', () => {
    const { request } = fixture('share1')
    const first = createTm1AliasPublicationAuthorizer()
    const second = createTm1AliasPublicationAuthorizer()
    first.issue(request())
    expect(() => second.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })

  test('canonical CashAddr casing of the same owner issues authorization', () => {
    const { request, evidence } = fixture('canon1')
    const authorization = authorizer().issue(request({
      ownerAddress: OWNER.toUpperCase(),
      evidence: evidence()
    }))
    expect(authorization.ownerAddress).toBe(OWNER)
    expect(parseTm1AliasPublicationAuthorization(authorization).ownerAddress).toBe(OWNER)
  })

  test('missing, extra, or unverifiable evidence fails closed', () => {
    const { alias, request, evidence } = fixture('extra1')
    const issuer = authorizer()
    expect(() => issuer.issue({
      alias,
      ownerAddress: OWNER
    })).toThrowError(Tm1AliasPublicationAuthorizationError)
    expect(() => issuer.issue(request({ extra: true }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => issuer.issue(request({
      evidence: evidence({ txid: 'zz'.repeat(32) })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_UNVERIFIABLE' }))
    expect(() => issuer.issue(request({
      evidence: evidence({ blockHeight: 200 }),
      tipHeight: 150
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_UNVERIFIABLE' }))
  })

  test('raw Set/Map bag does not construct a usable issuer', () => {
    const bag = rawLedgerBag()
    const Stolen = Tm1AliasPublicationAuthorizer as unknown as {
      new (ledger: unknown): unknown
    }
    expect(() => new Stolen(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => new Stolen({})).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => new Stolen(undefined)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
  })

  test('after issue(), authorizer has no clearable collections that re-issue the same proof', () => {
    const { request, evidence, laterTxid } = fixture('opaque1')
    const issuer = authorizer()
    issuer.issue(request())

    expect('consumedProofs' in issuer).toBe(false)
    expect('latestBlockHeightByAlias' in issuer).toBe(false)
    expect('clear' in issuer).toBe(false)
    expect('reset' in issuer).toBe(false)

    const leaked = (issuer as unknown as {
      consumedProofs?: Set<string>
      latestBlockHeightByAlias?: Map<string, number>
      ledger?: {
        consumedProofs?: Set<string>
        latestBlockHeightByAlias?: Map<string, number>
      }
    })
    leaked.consumedProofs?.clear()
    leaked.latestBlockHeightByAlias?.clear()
    leaked.ledger?.consumedProofs?.clear()
    leaked.ledger?.latestBlockHeightByAlias?.clear()

    for (const collection of [
      ...collectClearableCollections(issuer),
      ...collectClearableCollections(JSON.parse(JSON.stringify(issuer))),
      ...collectClearableCollections(Object.create(issuer as object)),
      ...collectClearableCollections(new Proxy(issuer as object, {}))
    ]) {
      collection.clear()
    }

    expect(() => createTm1AliasPublicationAuthorizer().issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
    expect(() => issuer.issue(request({
      evidence: evidence({ txid: laterTxid, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_STALE' }))
  })

  test('Object.create, Proxy, and prototype walk cannot yield a clearable shared ledger', () => {
    const { request } = fixture('proxy1')
    const issuer = createTm1AliasPublicationAuthorizer()
    issuer.issue(request())

    const Stolen = Tm1AliasPublicationAuthorizer as unknown as {
      new (ledger: unknown): unknown
    }
    expect(() => new Stolen(Object.create(issuer))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => new Stolen(new Proxy(issuer, {}))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => new Stolen(Object.create(null))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )

    let cursor: object | null = issuer as object
    const walked = new Set<object>()
    while (cursor !== null && !walked.has(cursor)) {
      walked.add(cursor)
      for (const collection of collectClearableCollections(cursor)) {
        collection.clear()
      }
      cursor = Object.getPrototypeOf(cursor)
    }

    expect(() => createTm1AliasPublicationAuthorizer().issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })

  test('P1-A: patched WeakMap/Set/Map prototypes cannot re-issue after clear', () => {
    const { request } = fixture('p1a')
    const issuer = authorizer()
    issuer.issue(request())
    const receivers: object[] = []
    const restore = patchIntrinsicsRecordingReceivers(receivers)
    try {
      try {
        issuer.issue(request())
      } catch {
        /* first replay attempt records receivers if prototype-dispatched */
      }
      clearRecordedCollections(receivers)
      expect(() => issuer.issue(request())).toThrowError(
        expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
      )
    } finally {
      restore()
    }
  })

  test('P1-B: a normal consumer cannot obtain a second ledger identity', () => {
    const { request } = fixture('p1b')
    expect(aliasAuth).not.toHaveProperty('createTm1InMemoryAliasPublicationAuthorizationLedger')
    const first = createTm1AliasPublicationAuthorizer()
    const second = createTm1AliasPublicationAuthorizer()
    first.issue(request())
    expect(() => second.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
    const extra = (
      createTm1AliasPublicationAuthorizer as (ledger?: unknown) => ReturnType<
        typeof createTm1AliasPublicationAuthorizer
      >
    )(rawLedgerBag())
    expect(() => extra.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })
})
