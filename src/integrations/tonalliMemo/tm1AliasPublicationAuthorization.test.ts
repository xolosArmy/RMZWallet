import { describe, expect, test } from 'vitest'
import {
  Tm1AliasPublicationAuthorizationError,
  createTm1AliasPublicationAuthorizer,
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

describe('TM1 alias publication authorization', () => {
  test('confirmed alias with matching owner issues a bound authorization', () => {
    const authorizer = createTm1AliasPublicationAuthorizer()
    const authorization = authorizer.issue(request())
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
    const authorizer = createTm1AliasPublicationAuthorizer()
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({ status: 'pending' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_UNCONFIRMED' }))
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({ blockHeight: 0, status: 'confirmed' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_UNCONFIRMED' }))
  })

  test('alias or owner mismatch does not issue authorization', () => {
    const authorizer = createTm1AliasPublicationAuthorizer()
    expect(() => authorizer.issue(request({
      ownerAddress: OTHER_OWNER
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_OWNER_MISMATCH' }))
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({ alias: 'other.xec' })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_OWNER_MISMATCH' }))
  })

  test('stale or replayed proof does not issue authorization', () => {
    const authorizer = createTm1AliasPublicationAuthorizer()
    authorizer.issue(request())

    expect(() => authorizer.issue(request())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({ txid: LATER_TXID, blockHeight: 50 })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_STALE' }))
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({
        txid: LATER_TXID,
        blockHeight: 120,
        expiresAt: 10
      }),
      now: 10
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_EXPIRED' }))
  })

  test('authorization object cannot call broadcast or sign', () => {
    const authorization = createTm1AliasPublicationAuthorizer().issue(request())
    const keys = Reflect.ownKeys(authorization)

    expect(keys).not.toContain('broadcast')
    expect(keys).not.toContain('sign')
    expect(keys).not.toContain('broadcastTx')
    expect(typeof (authorization as { broadcast?: unknown }).broadcast).toBe('undefined')
    expect(typeof (authorization as { sign?: unknown }).sign).toBe('undefined')
    expect(Object.values(authorization).every(value => typeof value !== 'function')).toBe(true)
  })

  test('missing, extra, or unverifiable evidence fails closed', () => {
    const authorizer = createTm1AliasPublicationAuthorizer()
    expect(() => authorizer.issue({
      alias: ALIAS,
      ownerAddress: OWNER
    })).toThrowError(Tm1AliasPublicationAuthorizationError)
    expect(() => authorizer.issue(request({ extra: true }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({ txid: 'zz'.repeat(32) })
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_UNVERIFIABLE' }))
    expect(() => authorizer.issue(request({
      evidence: confirmedEvidence({ blockHeight: 200 }),
      tipHeight: 150
    }))).toThrowError(expect.objectContaining({ code: 'ALIAS_PROOF_UNVERIFIABLE' }))
  })
})
