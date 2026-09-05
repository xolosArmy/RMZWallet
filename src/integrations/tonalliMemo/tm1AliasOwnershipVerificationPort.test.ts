import { describe, expect, test, vi } from 'vitest'
import * as portApi from './tm1AliasOwnershipVerificationPort'
import {
  createTm1AliasOwnershipVerificationPort,
  Tm1AliasOwnershipVerificationError
} from './tm1AliasOwnershipVerificationPort'
import * as aliasAuth from './tm1AliasPublicationAuthorization'
import {
  createTm1AliasPublicationAuthorizer,
  Tm1AliasPublicationAuthorizationError
} from './tm1AliasPublicationAuthorization'

const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const OTHER_OWNER = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'
const UNTRUSTED = { code: 'ALIAS_EVIDENCE_UNTRUSTED' }

function txidFrom(tag: string): string {
  const bytes = Array.from(tag, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return (bytes + 'ab'.repeat(32)).slice(0, 64)
}

function observation(tag: string, overrides: Record<string, unknown> = {}) {
  const alias = `${tag}.xec`
  return {
    alias,
    address: OWNER,
    txid: txidFrom(tag),
    blockHeight: 100,
    status: 'confirmed',
    ...overrides
  }
}

function portWith(
  tag: string,
  observeImpl: (input: { alias: string; ownerAddress: string }) => unknown | Promise<unknown>,
  clock: () => number = () => 1_700_000_000_000
) {
  const observe = vi.fn(async (input: { alias: string; ownerAddress: string }) => observeImpl(input))
  const verifier = createTm1AliasOwnershipVerificationPort({ observe, clock })
  return {
    alias: `${tag}.xec`,
    observe,
    verifier,
    request: (overrides: Record<string, unknown> = {}) => ({
      alias: `${tag}.xec`,
      ownerAddress: OWNER,
      ...overrides
    })
  }
}

describe('TM1 alias ownership verification port', () => {
  test('A: confirmed matching observation mints a token that issue() accepts', async () => {
    const { alias, verifier, request } = portWith('vpa', () => observation('vpa'))
    const token = await verifier.verify(request())
    expect(Object.isFrozen(token)).toBe(true)
    expect(Reflect.ownKeys(token)).toHaveLength(0)
    const authorization = createTm1AliasPublicationAuthorizer().issue({
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
    const { verifier, request } = portWith('vpb', () => observation('vpb', {
      status: 'pending',
      blockHeight: 0
    }))
    await expect(verifier.verify(request())).rejects.toMatchObject({ code: 'ALIAS_UNCONFIRMED' })
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias: 'vpb.xec',
      ownerAddress: OWNER,
      evidence: observation('vpb')
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('C: owner mismatch throws and does not mint', async () => {
    const { verifier, request } = portWith('vpc', () => observation('vpc', {
      address: OTHER_OWNER
    }))
    await expect(verifier.verify(request())).rejects.toMatchObject({
      code: 'ALIAS_OWNER_MISMATCH'
    })
  })

  test('D: transport, invalid JSON, empty body, and timeout throw and do not mint', async () => {
    const cases: Array<{ tag: string; observe: () => Promise<unknown> }> = [
      { tag: 'vpdn', observe: async () => { throw new Error('ECONNRESET') } },
      { tag: 'vpdx', observe: async () => { throw new SyntaxError('Unexpected end of JSON') } },
      { tag: 'vpde', observe: async () => null },
      { tag: 'vpdt', observe: async () => {
        const error = new Error('AbortError')
        error.name = 'AbortError'
        throw error
      } }
    ]
    for (const { tag, observe } of cases) {
      const { verifier, request, alias } = portWith(tag, observe)
      await expect(verifier.verify(request())).rejects.toBeInstanceOf(Error)
      expect(() => createTm1AliasPublicationAuthorizer().issue({
        alias,
        ownerAddress: OWNER,
        evidence: observation(tag)
      })).toThrowError(expect.objectContaining(UNTRUSTED))
    }
  })

  test('E: caller-supplied fake confirmed evidence is not a token and stays UNTRUSTED', async () => {
    const { alias, verifier, request } = portWith('vpe', () => observation('vpe'))
    await verifier.verify(request())
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence: observation('vpe')
    })).toThrowError(expect.objectContaining(UNTRUSTED))
  })

  test('F: expiresAt on the observation is preserved; issue() past expiry throws ALIAS_PROOF_EXPIRED', async () => {
    const expiresAt = Date.now() - 1_000
    const { alias, verifier, request } = portWith(
      'vpf',
      () => observation('vpf', { expiresAt }),
      () => expiresAt - 1
    )
    const token = await verifier.verify(request())
    expect(() => createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence: token
    })).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
    const later = createTm1AliasOwnershipVerificationPort({
      observe: async () => observation('vpf', { txid: txidFrom('vpfz'), blockHeight: 50 }),
      clock: () => Date.now()
    })
    const laterToken = await later.verify(request())
    const authorization = createTm1AliasPublicationAuthorizer().issue({
      alias,
      ownerAddress: OWNER,
      evidence: laterToken
    })
    expect(authorization).toMatchObject({
      alias,
      evidenceBlockHeight: 50
    })
  })

  test('G: expiry uses the injected clock, not request.now', async () => {
    const expiresAt = 1_800_000_000_000
    const { verifier, request } = portWith(
      'vpg',
      () => observation('vpg', { expiresAt }),
      () => expiresAt
    )
    await expect(verifier.verify(request({ now: 0 }))).rejects.toMatchObject({
      code: 'INVALID_ALIAS_AUTHORIZATION_INPUT'
    })
    await expect(verifier.verify(request())).rejects.toMatchObject({
      code: 'ALIAS_PROOF_EXPIRED'
    })
    const future = portWith(
      'vpgf',
      () => observation('vpgf', { expiresAt }),
      () => expiresAt - 1
    )
    const token = await future.verifier.verify(future.request())
    const authorization = createTm1AliasPublicationAuthorizer().issue({
      alias: 'vpgf.xec',
      ownerAddress: OWNER,
      evidence: token
    })
    expect(authorization).toMatchObject({ alias: 'vpgf.xec' })
  })

  test('P1: mint is not importable and cannot bypass the observer', async () => {
    const tag = 'p1mint'
    const json = observation(tag)
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

  test('factory requires observe and clock and has no silent network default', () => {
    expect(() => createTm1AliasOwnershipVerificationPort({}))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => createTm1AliasOwnershipVerificationPort({
      observe: async () => observation('needc')
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(() => createTm1AliasOwnershipVerificationPort({
      clock: () => 1
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' }))
    expect(portApi).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
    expect(portApi).not.toHaveProperty('mintVerifiedAliasOwnershipEvidence')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
  })

  test('port errors are not a sign or broadcast capability', async () => {
    const { verifier, request } = portWith('vperr', () => observation('vperr', {
      status: 'pending'
    }))
    let thrown: unknown
    try {
      await verifier.verify(request())
    } catch (error) {
      thrown = error
    }
    expect(
      thrown instanceof Tm1AliasOwnershipVerificationError
      || thrown instanceof Tm1AliasPublicationAuthorizationError
    ).toBe(true)
    expect(Reflect.ownKeys(thrown as object)).not.toContain('broadcast')
    expect(Reflect.ownKeys(thrown as object)).not.toContain('sign')
  })
})
