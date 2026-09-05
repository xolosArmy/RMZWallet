import { afterEach, describe, expect, test, vi } from 'vitest'
import * as portApi from './tm1AliasOwnershipVerificationPort'
import {
  Tm1AliasOwnershipVerificationPort,
  createTm1AliasOwnershipVerificationPort
} from './tm1AliasOwnershipVerificationPort'
import {
  createTm1AliasOwnershipVerificationTestFetch,
  type Tm1AliasOwnershipTestFetchResponse
} from './tm1AliasOwnershipVerificationPort.testFetch'
import * as aliasAuth from './tm1AliasPublicationAuthorization'
import {
  createTm1AliasPublicationAuthorizer
} from './tm1AliasPublicationAuthorization'

const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
const UNTRUSTED = { code: 'ALIAS_EVIDENCE_UNTRUSTED' }

function txidFrom(tag: string): string {
  const bytes = Array.from(tag, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return (bytes + 'ab'.repeat(32)).slice(0, 64)
}

function aliasRecord(tag: string, overrides: Record<string, unknown> = {}) {
  return {
    alias: `${tag}.xec`,
    address: OWNER,
    txid: txidFrom(tag),
    blockheight: 100,
    status: 'confirmed',
    ...overrides
  }
}

function callerJson(tag: string, overrides: Record<string, unknown> = {}) {
  return {
    alias: `${tag}.xec`,
    address: OWNER,
    txid: txidFrom(tag),
    blockHeight: 100,
    status: 'confirmed',
    ...overrides
  }
}

async function portWith(
  tag: string,
  response: Tm1AliasOwnershipTestFetchResponse,
  now?: number
) {
  vi.stubGlobal('fetch', createTm1AliasOwnershipVerificationTestFetch({
    [`${tag}.xec`]: response
  }))
  vi.resetModules()
  const portMod = await import('./tm1AliasOwnershipVerificationPort')
  const authMod = await import('./tm1AliasPublicationAuthorization')
  if (now !== undefined) {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  }
  return {
    alias: `${tag}.xec`,
    verifier: portMod.createTm1AliasOwnershipVerificationPort(),
    PortError: portMod.Tm1AliasOwnershipVerificationError,
    AuthError: authMod.Tm1AliasPublicationAuthorizationError,
    issue: (request: unknown) => authMod.createTm1AliasPublicationAuthorizer().issue(request),
    request: (overrides: Record<string, unknown> = {}) => ({
      alias: `${tag}.xec`,
      ownerAddress: OWNER,
      ...overrides
    })
  }
}

function ok(tag: string, overrides: Record<string, unknown> = {}): Tm1AliasOwnershipTestFetchResponse {
  return { status: 200, json: aliasRecord(tag, overrides) }
}

describe('TM1 alias ownership verification port', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('A: confirmed matching observation mints a token that issue() accepts', async () => {
    const { alias, verifier, request, issue } = await portWith('vpa', ok('vpa'))
    const token = await verifier.verify(request())
    expect(Object.isFrozen(token)).toBe(true)
    expect(Reflect.ownKeys(token)).toHaveLength(0)
    const authorization = issue({
      alias,
      ownerAddress: OWNER,
      evidence: token
    })
    expect(authorization).toMatchObject({
      alias,
      ownerAddress: OWNER,
      evidenceTxid: txidFrom('vpa'),
      evidenceBlockHeight: 100
    })
    expect(Object.isFrozen(authorization)).toBe(true)
  })

  test('B: unconfirmed observation throws, mints no token, and issue is never reached', async () => {
    const { verifier, request } = await portWith('vpb', ok('vpb', {
      status: 'pending',
      blockheight: 0
    }))
    await expect(verifier.verify(request())).rejects.toMatchObject({ code: 'ALIAS_UNCONFIRMED' })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias: 'vpb.xec',
      ownerAddress: OWNER,
      evidence: callerJson('vpb')
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('C: owner mismatch throws and does not mint', async () => {
    const { verifier, request } = await portWith('vpc', ok('vpc', {
      address: OTHER_OWNER
    }))
    await expect(verifier.verify(request())).rejects.toMatchObject({
      code: 'ALIAS_OWNER_MISMATCH'
    })
  })

  test('D: transport, invalid JSON, empty body, and timeout throw and do not mint', async () => {
    const abort = new Error('AbortError')
    abort.name = 'AbortError'
    const cases: Array<{ tag: string; response: Tm1AliasOwnershipTestFetchResponse }> = [
      { tag: 'vpdn', response: { status: 200, throw: new Error('ECONNRESET') } },
      { tag: 'vpdx', response: { status: 200, text: '{' } },
      { tag: 'vpde', response: { status: 200 } },
      { tag: 'vpdt', response: { status: 200, throw: abort } },
      { tag: 'vpd5', response: { status: 500, json: { ok: false } } }
    ]
    for (const { tag, response } of cases) {
      const { verifier, request, alias } = await portWith(tag, response)
      await expect(verifier.verify(request())).rejects.toBeInstanceOf(Error)
      expect(() => createTm1AliasPublicationAuthorizer().issue({
        alias,
        ownerAddress: OWNER,
        evidence: callerJson(tag)
      })).toThrowError(expect.objectContaining(UNTRUSTED))
    }
  })

  test('E: caller-supplied fake confirmed evidence is not a token and stays UNTRUSTED', async () => {
    const { alias, verifier, request } = await portWith('vpe', ok('vpe'))
    await verifier.verify(request())
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence: callerJson('vpe')
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('F: expiresAt on the observation is preserved; issue() past expiry throws ALIAS_PROOF_EXPIRED', async () => {
    const expiresAt = Date.now() - 1_000
    const { alias, verifier, request, issue } = await portWith(
      'vpf',
      ok('vpf', { expiresAt }),
      expiresAt - 1
    )
    const token = await verifier.verify(request())
    expect(() => issue({
      alias,
      ownerAddress: OWNER,
      evidence: token
    })).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const later = await portWith(
      'vpf',
      ok('vpf', { txid: txidFrom('vpfz'), blockheight: 50 })
    )
    const laterToken = await later.verifier.verify(request())
    const authorization = later.issue({
      alias,
      ownerAddress: OWNER,
      evidence: laterToken
    })
    expect(authorization).toMatchObject({
      alias,
      evidenceBlockHeight: 50
    })
  })

  test('G: expiry uses Date.now at request time, not request.now', async () => {
    const expiresAt = 1_800_000_000_000
    const { verifier, request } = await portWith(
      'vpg',
      ok('vpg', { expiresAt }),
      expiresAt
    )
    await expect(verifier.verify(request({ now: 0 }))).rejects.toMatchObject({
      code: 'INVALID_ALIAS_AUTHORIZATION_INPUT'
    })
    await expect(verifier.verify(request())).rejects.toMatchObject({
      code: 'ALIAS_PROOF_EXPIRED'
    })
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const future = await portWith(
      'vpgf',
      ok('vpgf', { expiresAt }),
      expiresAt - 1
    )
    const token = await future.verifier.verify(future.request())
    const authorization = future.issue({
      alias: 'vpgf.xec',
      ownerAddress: OWNER,
      evidence: token
    })
    expect(authorization).toMatchObject({ alias: 'vpgf.xec' })
  })

  test('P1: mint is not importable and cannot bypass the observer', async () => {
    const tag = 'p1mint'
    const json = callerJson(tag)
    let mintFn: ((value: unknown) => object) | undefined
    try {
      const mintSpec: string = './tm1AliasVerifiedOwnershipMint'
      const mintMod: { mintTm1VerifiedAliasOwnershipToken?: (value: unknown) => object } = await import(
        mintSpec
      )
      mintFn = mintMod.mintTm1VerifiedAliasOwnershipToken
    } catch {
      mintFn = undefined
    }
    expect(typeof mintFn).not.toBe('function')
    if (typeof mintFn !== 'function') return
    const token = mintFn(json)
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias: `${tag}.xec`,
      ownerAddress: OWNER,
      evidence: token
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('P1: post-import globalThis.fetch replacement cannot mint', async () => {
    const tag = 'p1swap'
    const alias = `${tag}.xec`
    const previous = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify(aliasRecord(tag)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    let minted: object | undefined
    try {
      const token = await createTm1AliasOwnershipVerificationPort().verify({
        alias,
        ownerAddress: OWNER
      })
      createTm1AliasPublicationAuthorizer().issue({
        alias,
        ownerAddress: OWNER,
        evidence: token
      })
      minted = token
    } catch {
      minted = undefined
    } finally {
      globalThis.fetch = previous
    }
    expect(minted).toBeUndefined()
  })

  test('P1: public factory does not accept fetch or endpointUrl', async () => {
    const tag = 'p1fetch'
    const alias = `${tag}.xec`
    const fetchImpl = (async () => new Response(JSON.stringify(aliasRecord(tag)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    let port: ReturnType<typeof createTm1AliasOwnershipVerificationPort> | undefined
    try {
      port = createTm1AliasOwnershipVerificationPort({
        fetch: fetchImpl,
        clock: () => 1,
        endpointUrl: 'https://evil.example/alias'
      })
    } catch {
      port = undefined
    }
    expect(port).toBeUndefined()
    if (port === undefined) return
    const token = await port.verify({ alias, ownerAddress: OWNER })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence: token
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('P1: ownKeys on production exports do not yield a test constructor', async () => {
    const tag = 'p1seam'
    const alias = `${tag}.xec`
    const fetchImpl = (async () => new Response(JSON.stringify(aliasRecord(tag)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const forged = {
      fetch: fetchImpl,
      clock: () => 1,
      endpointUrl: 'https://evil.example/alias'
    }
    const standard = new Set<PropertyKey>(['length', 'name', 'prototype'])
    const seams: Array<(value: unknown) => unknown> = []
    for (const target of [Tm1AliasOwnershipVerificationPort, createTm1AliasOwnershipVerificationPort]) {
      for (const key of Reflect.ownKeys(target)) {
        if (standard.has(key)) continue
        const value = Reflect.get(target, key)
        if (typeof value === 'function') {
          seams.push((value as (this: unknown, deps: unknown) => unknown).bind(target))
        }
      }
    }
    let minted: object | undefined
    for (const inject of seams) {
      try {
        const port = inject(forged) as { verify?: (request: unknown) => Promise<object> }
        if (port === null || typeof port !== 'object' || typeof port.verify !== 'function') continue
        const token = await port.verify({ alias, ownerAddress: OWNER })
        createTm1AliasPublicationAuthorizer().issue({
          alias,
          ownerAddress: OWNER,
          evidence: token
        })
        minted = token
      } catch {
        continue
      }
    }
    expect(minted).toBeUndefined()
  })

  test('P1: production factory does not accept arbitrary observe()', async () => {
    const tag = 'p1obs'
    const alias = `${tag}.xec`
    let port: ReturnType<typeof createTm1AliasOwnershipVerificationPort> | undefined
    try {
      port = createTm1AliasOwnershipVerificationPort({
        observe: async () => aliasRecord(tag),
        clock: () => 1
      })
    } catch {
      port = undefined
    }
    expect(port).toBeUndefined()
    if (port === undefined) return
    const token = await port.verify({ alias, ownerAddress: OWNER })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence: token
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('public factory rejects fetch, endpointUrl, observe, and clock', () => {
    expect(() => createTm1AliasOwnershipVerificationPort({
      fetch: createTm1AliasOwnershipVerificationTestFetch({}),
      clock: () => 1
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => createTm1AliasOwnershipVerificationPort({
      fetch: createTm1AliasOwnershipVerificationTestFetch({}),
      clock: () => 1,
      endpointUrl: 'https://evil.example/alias'
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => createTm1AliasOwnershipVerificationPort({
      observe: async () => aliasRecord('needc'),
      clock: () => 1
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => createTm1AliasOwnershipVerificationPort({
      clock: () => 1
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    const port = createTm1AliasOwnershipVerificationPort()
    expect(port).toBeInstanceOf(Tm1AliasOwnershipVerificationPort)
    expect(createTm1AliasOwnershipVerificationPort({})).toBeInstanceOf(
      Tm1AliasOwnershipVerificationPort
    )
    expect(portApi).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
    expect(portApi).not.toHaveProperty('mintVerifiedAliasOwnershipEvidence')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
  })

  test('port errors are not a sign or broadcast capability', async () => {
    const { verifier, request, PortError, AuthError } = await portWith('vperr', ok('vperr', {
      status: 'pending'
    }))
    let thrown: unknown
    try {
      await verifier.verify(request())
    } catch (error) {
      thrown = error
    }
    expect(
      thrown instanceof PortError
      || thrown instanceof AuthError
    ).toBe(true)
    expect(Reflect.ownKeys(thrown as object)).not.toContain('broadcast')
    expect(Reflect.ownKeys(thrown as object)).not.toContain('sign')
  })
})
