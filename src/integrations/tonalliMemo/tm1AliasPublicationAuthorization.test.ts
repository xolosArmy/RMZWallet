import { describe, expect, test } from 'vitest'
import { createTm1AliasOwnershipVerificationPort } from './tm1AliasOwnershipVerificationPort'
import * as aliasAuth from './tm1AliasPublicationAuthorization'
import {
  Tm1AliasPublicationAuthorizationError,
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer,
  parseTm1AliasPublicationAuthorization
} from './tm1AliasPublicationAuthorization'

const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
const UNTRUSTED = { code: 'ALIAS_EVIDENCE_UNTRUSTED' }

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
  test('confirmed caller-supplied evidence is untrusted and does not issue', () => {
    const { request } = fixture('ok1')
    expect(() => authorizer().issue(request())).toThrowError(
      expect.objectContaining(UNTRUSTED)
    )
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

  test('caller-supplied confirmed evidence does not consume or stale the singleton', () => {
    const { request, evidence, laterTxid } = fixture('stale1')
    const issuer = authorizer()
    expect(() => issuer.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    expect(() => issuer.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    expect(() => issuer.issue(request({
      evidence: evidence({ txid: laterTxid, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining(UNTRUSTED))
    expect(() => issuer.issue(request({
      evidence: evidence({
        txid: laterTxid,
        blockHeight: 120,
        expiresAt: 10
      }),
      now: 10
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
  })

  test('failed issue does not return a sign or broadcast capability', () => {
    const { request } = fixture('nosign')
    let thrown: unknown
    try {
      authorizer().issue(request())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Tm1AliasPublicationAuthorizationError)
    const keys = Reflect.ownKeys(thrown as object)
    expect(keys).not.toContain('broadcast')
    expect(keys).not.toContain('sign')
    expect(keys).not.toContain('broadcastTx')
  })

  test('two factory() calls share the still-empty singleton', () => {
    const { request } = fixture('share1')
    const first = createTm1AliasPublicationAuthorizer()
    const second = createTm1AliasPublicationAuthorizer()
    expect(() => first.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    expect(() => second.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('caller-supplied expiresAt does not skip UNTRUSTED', () => {
    const { request, evidence } = fixture('expun')
    expect(() => authorizer().issue(request({
      evidence: evidence({ expiresAt: 1_800_000_000_000 })
    }))).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('caller-supplied confirmed evidence with now:0 is rejected extra input', () => {
    const { request } = fixture('now0')
    expect(() => authorizer().issue(request({ now: 0 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
  })

  test('extra field now does not mint', () => {
    const { request } = fixture('nowx')
    expect(() => authorizer().issue(request({ now: 1_700_000_000_000 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
  })

  test('canonical CashAddr casing is parsed then rejected as untrusted', () => {
    const { request, evidence } = fixture('canon1')
    expect(() => authorizer().issue(request({
      ownerAddress: OWNER.toUpperCase(),
      evidence: evidence()
    }))).toThrowError(expect.objectContaining(UNTRUSTED))
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

  test('after untrusted issue(), authorizer has no clearable collections', () => {
    const { request, evidence, laterTxid } = fixture('opaque1')
    const issuer = authorizer()
    expect(() => issuer.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))

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
      expect.objectContaining(UNTRUSTED)
    )
    expect(() => issuer.issue(request({
      evidence: evidence({ txid: laterTxid, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('Object.create, Proxy, and prototype walk cannot yield a clearable shared ledger', () => {
    const { request } = fixture('proxy1')
    const issuer = createTm1AliasPublicationAuthorizer()
    expect(() => issuer.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))

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
      expect.objectContaining(UNTRUSTED)
    )
  })

  test('P1-A: patched WeakMap/Set/Map prototypes cannot mint from untrusted evidence', () => {
    const { request } = fixture('p1a')
    const issuer = authorizer()
    expect(() => issuer.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    const receivers: object[] = []
    const restore = patchIntrinsicsRecordingReceivers(receivers)
    try {
      try {
        issuer.issue(request())
      } catch {
        /* records receivers if prototype-dispatched */
      }
      clearRecordedCollections(receivers)
      expect(() => issuer.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    } finally {
      restore()
    }
  })

  test('P1-B: a normal consumer cannot obtain a second ledger identity or verified mint', () => {
    const { request } = fixture('p1b')
    expect(aliasAuth).not.toHaveProperty('createTm1InMemoryAliasPublicationAuthorizationLedger')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
    const first = createTm1AliasPublicationAuthorizer()
    const second = createTm1AliasPublicationAuthorizer()
    expect(() => first.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    expect(() => second.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
    const extra = (
      createTm1AliasPublicationAuthorizer as (ledger?: unknown) => ReturnType<
        typeof createTm1AliasPublicationAuthorizer
      >
    )(rawLedgerBag())
    expect(() => extra.issue(request())).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('P1-C: freeze/join/String reentry cannot mint two authorizations', () => {
    const { request } = fixture('p1c')
    const issuer = authorizer()
    const req = request()
    const auths: unknown[] = []
    const originalFreeze = Object.freeze
    const originalJoin = Array.prototype.join
    const OriginalString = String
    let reentering = false
    const looksLikeAuth = (value: unknown): boolean => (
      value !== null
      && typeof value === 'object'
      && 'authorizationId' in value
      && 'evidenceTxid' in value
    )
    const reenter = () => {
      if (reentering) return
      reentering = true
      try {
        auths.push(issuer.issue(req))
      } catch {
        /* fail-closed nested issue */
      }
    }
    try {
      Object.freeze = ((value: unknown) => {
        if (looksLikeAuth(value)) reenter()
        return originalFreeze(value as object)
      }) as typeof Object.freeze
      Array.prototype.join = function (this: unknown[], separator?: string) {
        const result = originalJoin.call(this, separator)
        if (typeof result === 'string' && result.startsWith('tm1-alias-auth:v1:')) reenter()
        return result
      }
      const wrappedString = function String(value?: unknown) {
        if (new.target) return new OriginalString(value as string)
        return OriginalString(value)
      } as unknown as StringConstructor
      Object.defineProperty(wrappedString, 'prototype', { value: OriginalString.prototype })
      globalThis.String = wrappedString
      try {
        auths.push(issuer.issue(req))
      } catch {
        /* fail-closed outer issue */
      }
    } finally {
      Object.freeze = originalFreeze
      Array.prototype.join = originalJoin
      globalThis.String = OriginalString
    }
    expect(auths).toHaveLength(0)
  })

  test('P1-D: MAX_SAFE_INTEGER caller height cannot poison later T2', () => {
    const { request, evidence, laterTxid } = fixture('p1d')
    const issuer = authorizer()
    expect(() => issuer.issue(request({
      evidence: evidence({ blockHeight: Number.MAX_SAFE_INTEGER })
    }))).toThrowError(expect.objectContaining(UNTRUSTED))
    expect(() => issuer.issue(request({
      evidence: evidence({ txid: laterTxid, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('forged brand, Object.create, and extra fields cannot enter the success path', () => {
    const { alias, request, evidence } = fixture('forged')
    const issuer = authorizer()
    const json = evidence()
    const created = Object.create(null, {
      alias: { value: alias, enumerable: true },
      address: { value: OWNER, enumerable: true },
      txid: { value: json.txid, enumerable: true },
      blockHeight: { value: 100, enumerable: true },
      status: { value: 'confirmed', enumerable: true }
    })
    expect(() => issuer.issue(request({ evidence: created }))).toThrowError(
      expect.objectContaining(UNTRUSTED)
    )
    expect(() => issuer.issue(request({
      evidence: Object.create(json)
    }))).toThrowError(Tm1AliasPublicationAuthorizationError)
    expect(() => issuer.issue(request({
      evidence: { ...json, brand: 'verified' }
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
  })

  test('parse of a frozen authorization record is not an issue capability', () => {
    const { alias, txid } = fixture('parse1')
    expect(() => parseTm1AliasPublicationAuthorization({
      protocol: aliasAuth.TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL,
      protocolVersion: aliasAuth.TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION,
      alias,
      ownerAddress: OWNER,
      evidenceTxid: txid,
      evidenceBlockHeight: 100,
      authorizationId: [
        'tm1-alias-auth:v1',
        alias,
        OWNER,
        txid,
        '100'
      ].join(':')
    })).not.toThrow()
    expect(() => authorizer().issue(fixture('parse1b').request())).toThrowError(
      expect.objectContaining(UNTRUSTED)
    )
  })
})

describe('TM1 verified evidence expiry via verification port', () => {
  const uniqueTxid = (tag: string): string => {
    const bytes = Array.from(tag, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return (bytes + 'cd'.repeat(32)).slice(0, 64)
  }
  const mintViaPort = async (
    tag: string,
    evidenceOverrides: Record<string, unknown> = {}
  ) => {
    const alias = `${tag}.xec`
    const expiresAt = evidenceOverrides.expiresAt
    const port = createTm1AliasOwnershipVerificationPort({
      observe: async () => ({
        alias,
        address: OWNER,
        txid: uniqueTxid(tag),
        blockHeight: 100,
        status: 'confirmed',
        ...evidenceOverrides
      }),
      clock: () => typeof expiresAt === 'number' ? expiresAt - 1 : Date.now()
    })
    const evidence = await port.verify({ alias, ownerAddress: OWNER })
    return { alias, evidence }
  }

  test('P2: verified evidence with expiresAt in the past is expired at issue()', async () => {
    const { alias, evidence } = await mintViaPort('vexp', {
      expiresAt: Date.now() - 60_000
    })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence
    })).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
  })

  test('P2 clock: expired verified evidence with now:0 is rejected', async () => {
    const { alias, evidence } = await mintViaPort('clk0', {
      expiresAt: Date.now() - 60_000
    })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence,
      now: 0
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
  })

  test('verified evidence with expiresAt in the future can reach commit', async () => {
    const { alias, evidence } = await mintViaPort('vfut', {
      expiresAt: Date.now() + 60_000
    })
    const authorization = createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence
    })
    expect(authorization).toMatchObject({
      alias: 'vfut.xec',
      ownerAddress: OWNER,
      evidenceBlockHeight: 100
    })
    expect(Object.isFrozen(authorization)).toBe(true)
  })

  test('verified evidence without expiresAt does not take the expiry branch', async () => {
    const { alias, evidence } = await mintViaPort('vnexp')
    const authorization = createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence
    })
    expect(authorization).toMatchObject({ alias: 'vnexp.xec' })
  })

  test('expired verified evidence does not write replay or height', async () => {
    const expired = await mintViaPort('vled', {
      expiresAt: Date.now() - 60_000,
      blockHeight: 500
    })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias: expired.alias,
      ownerAddress: OWNER,
      evidence: expired.evidence
    })).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
    const later = await mintViaPort('vled', {
      txid: uniqueTxid('vledz'),
      blockHeight: 50
    })
    const authorization = createTm1AliasPublicationAuthorizer().issue({
      alias: later.alias,
      ownerAddress: OWNER,
      evidence: later.evidence
    })
    expect(authorization).toMatchObject({
      alias: 'vled.xec',
      evidenceBlockHeight: 50
    })
  })

  test('Date.now replaced after import does not move expiry', async () => {
    const originalNow = Date.now
    const { alias, evidence } = await mintViaPort('clkcap', {
      expiresAt: originalNow() - 60_000
    })
    Date.now = () => 0
    try {
      expect(() => createTm1AliasPublicationAuthorizer().issue({
        alias,
        ownerAddress: OWNER,
        evidence
      })).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
    } finally {
      Date.now = originalNow
    }
  })

  test('captured clock still commits future expiresAt after Date.now is replaced', async () => {
    const originalNow = Date.now
    const expiresAt = originalNow() + 60_000
    const { alias, evidence } = await mintViaPort('clkfut', { expiresAt })
    Date.now = () => Number.MAX_SAFE_INTEGER
    try {
      const authorization = createTm1AliasPublicationAuthorizer().issue({
        alias,
        ownerAddress: OWNER,
        evidence
      })
      expect(authorization).toMatchObject({ alias: 'clkfut.xec' })
    } finally {
      Date.now = originalNow
    }
  })
})
