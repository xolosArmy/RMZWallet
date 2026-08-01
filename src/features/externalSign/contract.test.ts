import { describe, expect, test, vi } from 'vitest'
import { calculateUniversalContentHash } from './contentHash'
import {
  parseUniversalAuthorizationEnvelope,
  parseUniversalAuthorizationEnvelopeJson
} from './contract'

const rawEnvelope = () => ({
  schema: 'tonalli.authorization-envelope',
  version: 1,
  operationId: 'operation-contract',
  profileId: 'synthetic.authorization.v1',
  issuedAt: 999,
  expiresAt: 2_000,
  requester: {
    origin: 'https://fixture.invalid',
    displayName: 'Fixture'
  }
})

describe('universal envelope and content binding', () => {
  test('the universal envelope schema is closed at both levels', () => {
    expect(() => parseUniversalAuthorizationEnvelope({ ...rawEnvelope(), extra: true }, 1_000))
      .toThrowError('extra')
    expect(() => parseUniversalAuthorizationEnvelope({
      ...rawEnvelope(),
      requester: { ...rawEnvelope().requester, extra: true }
    }, 1_000)).toThrowError('extra')
    const duplicated = JSON.stringify(rawEnvelope()).replace(
      '"operationId":"operation-contract"',
      '"operationId":"operation-contract","operationId":"replacement"'
    )
    expect(() => parseUniversalAuthorizationEnvelopeJson(duplicated, 1_000))
      .toThrowError('DUPLICATE_JSON_MEMBER')
  })

  test('domain-separated hash binds only the universal envelope and effective bytes', async () => {
    const signal = new AbortController().signal
    const parsed = parseUniversalAuthorizationEnvelope(rawEnvelope(), 1_000)
    const first = await calculateUniversalContentHash(parsed, new Uint8Array([1, 2, 3]), signal)
    const same = await calculateUniversalContentHash(parsed, new Uint8Array([1, 2, 3]), signal)
    const mutatedContent = await calculateUniversalContentHash(parsed, new Uint8Array([1, 2, 4]), signal)
    const mutatedEnvelope = await calculateUniversalContentHash(
      { ...parsed, operationId: 'operation-contract-mutated' },
      new Uint8Array([1, 2, 3]),
      signal
    )
    expect(first).toBe(same)
    expect(first).not.toBe(mutatedContent)
    expect(first).not.toBe(mutatedEnvelope)
  })

  test('hashing consults AbortSignal before asynchronous work', async () => {
    const controller = new AbortController()
    controller.abort()
    const digest = vi.fn()
    await expect(calculateUniversalContentHash(
      parseUniversalAuthorizationEnvelope(rawEnvelope(), 1_000),
      new Uint8Array([1]),
      controller.signal,
      { subtle: { digest } as unknown as SubtleCrypto }
    )).rejects.toThrowError('OPERATION_ABORTED')
    expect(digest).not.toHaveBeenCalled()
  })
})
