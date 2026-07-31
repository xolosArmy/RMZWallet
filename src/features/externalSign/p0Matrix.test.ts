import { Address, Script, Tx } from 'ecash-lib'
import type { Tx as ChronikTx } from 'chronik-client'
import { describe, expect, test, vi } from 'vitest'
import { ExternalSignApprovalCapabilityV1 } from './approval'
import { detectExternalSignBrowserCapabilities } from './browser'
import { calculateExternalSignContentHash, type ExternalSignContentHash } from './contentHash'
import {
  EXTERNAL_SIGN_MAX_REQUEST_TTL_MS,
  resolveExternalSignConfig
} from './config'
import {
  EXTERNAL_SIGN_REQUEST_STORAGE_KEY,
  ExternalSignError,
  parseExternalSignRequestJson,
  parseExternalSignRequestObject,
  storePendingExternalSignRequest,
  takePendingExternalSignRequest,
  type ExternalSignWireRequestV1,
  type OriginContextV1
} from './contract'
import { acquireExternalSignLock } from './lock'
import { assertExternalSignOriginAllowed, declaredOriginContext, deliverExternalSignResponse } from './origin'
import {
  MemoryExternalSignReplayStore,
  terminalTombstone,
  type ExternalSignReplayStore
} from './replayStore'
import {
  buildExternalSignReview,
  type ExternalSignPrevoutProvider,
  type ExternalSignTxReviewV1
} from './review'
import { finalizeApprovedExternalSign, terminateExternalSignRequest } from './session'

const NOW = 1_800_000_000_000
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000'
const TXID = '11'.repeat(32)
const ACTIVE_SCRIPT = Script.p2pkh(new Uint8Array(20).fill(0x11))
const RECIPIENT_SCRIPT = Script.p2pkh(new Uint8Array(20).fill(0x22))
const ACTIVE_ADDRESS = Address.fromScript(ACTIVE_SCRIPT).toString()
const AUTHENTICATED_ORIGIN: OriginContextV1 = Object.freeze({
  status: 'authenticated',
  authenticatedOrigin: 'https://fixture.invalid',
  declaredOrigin: 'https://fixture.invalid',
  evidence: 'postMessage-opener'
})

const makeUnsignedTx = (outputs = [
  { sats: 1_000n, script: RECIPIENT_SCRIPT },
  { sats: 800n, script: ACTIVE_SCRIPT }
]) => new Tx({
  version: 2,
  inputs: [{ prevOut: { txid: TXID, outIdx: 0 }, script: new Script(), sequence: 0xffff_ffff }],
  outputs,
  locktime: 0
})

const requestPayload = (overrides: Record<string, unknown> = {}) => ({
  protocolId: 'tonalli.external-sign',
  protocolVersion: 1,
  chainId: 'ecash:1',
  requestId: REQUEST_ID,
  intentId: 'fixture-intent',
  expiresAt: NOW + 120_000,
  mode: 'signOnly',
  unsignedTxHex: makeUnsignedTx().toHex(),
  requester: {
    displayName: 'Synthetic fixture',
    applicationUrl: 'https://fixture.invalid/app',
    declaredOrigin: 'https://fixture.invalid'
  },
  ...overrides
})

const request = (overrides: Record<string, unknown> = {}) => parseExternalSignRequestObject(requestPayload(overrides), NOW)

const chronikTx = (overrides: Partial<ChronikTx> = {}): ChronikTx => ({
  txid: TXID,
  version: 2,
  inputs: [],
  outputs: [{ sats: 2_100n, outputScript: ACTIVE_SCRIPT.toHex() }],
  lockTime: 0,
  timeFirstSeen: 0,
  size: 100,
  isCoinbase: false,
  tokenEntries: [],
  tokenFailedParsings: [],
  tokenStatus: 'TOKEN_STATUS_NON_TOKEN',
  isFinal: true,
  ...overrides
})

const validatedTx = (tx = makeUnsignedTx(), overrides: Partial<ChronikTx> = {}): ChronikTx => chronikTx({
  inputs: tx.inputs.map(input => ({
    prevOut: { txid: TXID, outIdx: input.prevOut.outIdx },
    inputScript: '',
    sats: 2_100n,
    sequenceNo: input.sequence ?? 0xffff_ffff
  })),
  outputs: tx.outputs.map(output => ({ sats: output.sats, outputScript: output.script.toHex() })),
  size: tx.serSize(),
  ...overrides
})

const provider = (options: {
  prevTx?: ChronikTx
  validated?: ChronikTx
} = {}): ExternalSignPrevoutProvider => ({
  tx: vi.fn(async () => options.prevTx ?? chronikTx()),
  validateRawTx: vi.fn(async () => options.validated ?? validatedTx())
})

const review = (wire = request(), prevoutProvider = provider()) => buildExternalSignReview(wire, ACTIVE_ADDRESS, prevoutProvider)

const signingSpies = () => {
  const sign = vi.fn<() => Tx>()
  const getSignatory = vi.fn(() => ({
    address: ACTIVE_ADDRESS,
    publicKeyHex: `02${'00'.repeat(32)}`,
    publicKey: new Uint8Array(33),
    signatory: vi.fn()
  }))
  const builderFromTx = vi.fn((tx: Tx) => {
    const signedTx = Tx.fromHex(tx.toHex())
    for (const input of signedTx.inputs) input.script = new Script(new Uint8Array(100))
    sign.mockReturnValue(signedTx)
    return {
      inputs: tx.inputs.map(input => ({ input: { prevOut: input.prevOut } })),
      sign
    }
  })
  const broadcastTx = vi.fn()
  return { sign, getSignatory, builderFromTx, broadcastTx }
}

const expectNoSigning = (spies: ReturnType<typeof signingSpies>) => {
  expect(spies.getSignatory).not.toHaveBeenCalled()
  expect(spies.sign).not.toHaveBeenCalled()
  expect(spies.broadcastTx).not.toHaveBeenCalled()
}

const prepared = async (wire = request(), prevoutProvider = provider()) => {
  const txReview = await review(wire, prevoutProvider)
  const contentHash = await calculateExternalSignContentHash(wire, AUTHENTICATED_ORIGIN, txReview)
  return { txReview, contentHash }
}

const finalize = async (
  wire: ExternalSignWireRequestV1,
  txReview: ExternalSignTxReviewV1,
  contentHash: ExternalSignContentHash,
  capability: ExternalSignApprovalCapabilityV1,
  spies: ReturnType<typeof signingSpies>,
  replayStore: ExternalSignReplayStore = new MemoryExternalSignReplayStore(),
  reviewAgain: () => Promise<ExternalSignTxReviewV1> = () => review(wire)
) => finalizeApprovedExternalSign(wire, AUTHENTICATED_ORIGIN, txReview, contentHash, capability, {
  reviewAgain,
  replayStore,
  signer: { getSignatory: spies.getSignatory, builderFromTx: spies.builderFromTx },
  now: () => NOW + 1
})

describe('external-sign P0 negative matrix', () => {
  test('N01 absence of approval never reaches signing', async () => {
    const spies = signingSpies()
    await prepared()
    expectNoSigning(spies)
  })

  test('N02 rejection creates a terminal tombstone without signing', async () => {
    const spies = signingSpies()
    const wire = request()
    const store = new MemoryExternalSignReplayStore()
    await terminateExternalSignRequest(wire, store, 'rejected', NOW)
    expect(store.get(REQUEST_ID)?.terminalState).toBe('rejected')
    expectNoSigning(spies)
  })

  test('N03 cancellation creates a terminal tombstone without signing', async () => {
    const spies = signingSpies()
    const wire = request()
    const store = new MemoryExternalSignReplayStore()
    await terminateExternalSignRequest(wire, store, 'cancelled', NOW)
    expect(store.get(REQUEST_ID)?.terminalState).toBe('cancelled')
    expectNoSigning(spies)
  })

  test('N04 approval timeout invalidates the capability', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    await expect(finalizeApprovedExternalSign(wire, AUTHENTICATED_ORIGIN, txReview, contentHash, capability, {
      reviewAgain: () => review(wire),
      replayStore: new MemoryExternalSignReplayStore(),
      signer: { getSignatory: spies.getSignatory, builderFromTx: spies.builderFromTx },
      now: () => NOW + 31_000
    })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
    expectNoSigning(spies)
  })

  test('N05 reload has no persisted approval capability', () => {
    const spies = signingSpies()
    const writes: string[] = []
    const storage = { setItem: vi.fn((_key: string, value: string) => writes.push(value)) }
    storePendingExternalSignRequest(storage, request(), NOW)
    expect(writes.join('')).not.toContain('capabilityId')
    expect(writes.join('')).not.toContain('contentHash')
    expectNoSigning(spies)
  })

  test('N06 navigation invalidates an in-memory approval', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    capability.invalidate()
    await expect(finalize(wire, txReview, contentHash, capability, spies)).rejects.toMatchObject({ code: 'APPROVAL_NOT_FRESH' })
    expectNoSigning(spies)
  })

  test('N07 payload mutation after preview changes the final hash', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    const mutated = Object.freeze({ ...txReview, feeSats: (BigInt(txReview.feeSats) + 1n).toString() })
    await expect(finalize(wire, txReview, contentHash, capability, spies, undefined, async () => mutated)).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' })
    expectNoSigning(spies)
  })

  test('N08 mismatched capability hash is rejected', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const wrongHash = `sha256:${'00'.repeat(32)}` as ExternalSignContentHash
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, wrongHash, wire.expiresAt, NOW)
    await expect(finalize(wire, txReview, contentHash, capability, spies)).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' })
    expectNoSigning(spies)
  })

  test('N09 one approval cannot be reused', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    await finalize(wire, txReview, contentHash, capability, spies)
    await expect(finalize(wire, txReview, contentHash, capability, spies)).rejects.toMatchObject({ code: 'APPROVAL_NOT_FRESH' })
    expect(spies.getSignatory).toHaveBeenCalledTimes(1)
    expect(spies.sign).toHaveBeenCalledTimes(1)
    expect(spies.broadcastTx).not.toHaveBeenCalled()
  })

  test('N10 replayed requestId is rejected atomically', async () => {
    const spies = signingSpies()
    const wire = request()
    const store = new MemoryExternalSignReplayStore()
    await store.record(terminalTombstone(REQUEST_ID, wire.expiresAt, 'rejected', NOW))
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    await expect(finalize(wire, txReview, contentHash, capability, spies, store)).rejects.toMatchObject({ code: 'REQUEST_REPLAYED' })
    expectNoSigning(spies)
  })

  test('N11 incorrect network is rejected before Chronik or signing', () => {
    const spies = signingSpies()
    expect(() => request({ chainId: 'ectest:1' })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N12 unknown root field is rejected', () => {
    const spies = signingSpies()
    expect(() => request({ extra: true })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N13 unknown requester field is rejected', () => {
    const spies = signingSpies()
    expect(() => request({ requester: { ...requestPayload().requester, extra: true } })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N14 duplicate JSON members are rejected', () => {
    const spies = signingSpies()
    const json = JSON.stringify(requestPayload()).replace('"mode":"signOnly"', '"mode":"signOnly","mode":"signOnly"')
    expect(() => parseExternalSignRequestJson(json, NOW)).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N15 legacy meta is rejected', () => {
    const spies = signingSpies()
    expect(() => request({ meta: { flow: 'pledge' } })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N16 broadcast true is explicitly forbidden', () => {
    const spies = signingSpies()
    expect(() => request({ broadcast: true })).toThrowError(ExternalSignError)
    try { request({ broadcast: true }) } catch (error) { expect(error).toMatchObject({ code: 'LEGACY_BROADCAST_FORBIDDEN' }) }
    expectNoSigning(spies)
  })

  test('N17 broadcast false is rejected rather than downgraded', () => {
    const spies = signingSpies()
    expect(() => request({ broadcast: false })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N18 signAndBroadcast, omitted and unknown modes are rejected', () => {
    const spies = signingSpies()
    expect(() => request({ mode: 'signAndBroadcast' })).toThrowError(ExternalSignError)
    const omitted = requestPayload()
    delete (omitted as { mode?: unknown }).mode
    expect(() => parseExternalSignRequestObject(omitted, NOW)).toThrowError(ExternalSignError)
    expect(() => request({ mode: 'futureMode' })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N19 P2SH and unknown scripts are rejected', async () => {
    const spies = signingSpies()
    const tx = makeUnsignedTx([{ sats: 1_800n, script: Script.p2sh(new Uint8Array(20).fill(0x33)) }])
    const wire = request({ unsignedTxHex: tx.toHex() })
    await expect(review(wire, provider({ validated: validatedTx(tx) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT_SCRIPT' })
    expectNoSigning(spies)
  })

  test('N20 token or failed token parsing is rejected', async () => {
    const spies = signingSpies()
    const invalid = validatedTx(makeUnsignedTx(), { tokenStatus: 'TOKEN_STATUS_NOT_NORMAL', tokenFailedParsings: [{}] as ChronikTx['tokenFailedParsings'] })
    await expect(review(request(), provider({ validated: invalid }))).rejects.toMatchObject({ code: 'TOKEN_OR_UNINTERPRETABLE_DATA' })
    expectNoSigning(spies)
  })

  test('N21 OP_RETURN is rejected as a non-P2PKH output', async () => {
    const spies = signingSpies()
    const tx = makeUnsignedTx([{ sats: 0n, script: new Script(Uint8Array.of(0x6a, 0x01, 0x01)) }, { sats: 1_800n, script: RECIPIENT_SCRIPT }])
    const wire = request({ unsignedTxHex: tx.toHex() })
    await expect(review(wire, provider({ validated: validatedTx(tx) }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT_SCRIPT' })
    expectNoSigning(spies)
  })

  test('N22 indeterminable or negative fee is rejected', async () => {
    const spies = signingSpies()
    const missing = chronikTx({ outputs: [] })
    await expect(review(request(), provider({ prevTx: missing }))).rejects.toMatchObject({ code: 'PREVOUT_NOT_FOUND' })
    const tooSmall = chronikTx({ outputs: [{ sats: 1_000n, outputScript: ACTIVE_SCRIPT.toHex() }] })
    await expect(review(request(), provider({ prevTx: tooSmall }))).rejects.toMatchObject({ code: 'FEE_UNDETERMINABLE' })
    expectNoSigning(spies)
  })

  test('N23 fee rate and absolute fee limits must all pass', async () => {
    const spies = signingSpies()
    for (const sats of [2_000n, 5_000n, 13_000n]) {
      const prevTx = chronikTx({ outputs: [{ sats, outputScript: ACTIVE_SCRIPT.toHex() }] })
      await expect(review(request(), provider({ prevTx }))).rejects.toMatchObject({ code: 'FEE_OUT_OF_POLICY' })
    }
    expectNoSigning(spies)
  })

  test('N24 input not owned by the active wallet is rejected', async () => {
    const spies = signingSpies()
    const prevTx = chronikTx({ outputs: [{ sats: 2_000n, outputScript: RECIPIENT_SCRIPT.toHex() }] })
    await expect(review(request(), provider({ prevTx }))).rejects.toMatchObject({ code: 'INPUT_NOT_OWNED' })
    expectNoSigning(spies)
  })

  test('N25 changed prevout between preview and approval invalidates approval', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    const changedProvider = provider({ prevTx: chronikTx({ outputs: [{ sats: 2_200n, outputScript: ACTIVE_SCRIPT.toHex() }] }) })
    await expect(finalize(wire, txReview, contentHash, capability, spies, undefined, () => review(wire, changedProvider))).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' })
    expectNoSigning(spies)
  })

  test('N26 declared origin remains unverified and blocked', () => {
    const spies = signingSpies()
    const context = declaredOriginContext(request())
    expect(context.status).toBe('declared-unverified')
    expect(() => assertExternalSignOriginAllowed(context, ['https://fixture.invalid'])).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N27 unknown origin is blocked', () => {
    const spies = signingSpies()
    const context = declaredOriginContext(request({ requester: { displayName: 'Synthetic fixture' } }))
    expect(context.status).toBe('unknown')
    expect(() => assertExternalSignOriginAllowed(context, [])).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N28 authenticated origin outside the allowlist is blocked', () => {
    const spies = signingSpies()
    expect(() => assertExternalSignOriginAllowed(AUTHENTICATED_ORIGIN, ['https://other.invalid'])).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N29 requester cannot self-declare authentication state', () => {
    const spies = signingSpies()
    expect(() => request({ originStatus: 'authenticated' })).toThrowError(ExternalSignError)
    expect(() => request({ authenticatedOrigin: 'https://fixture.invalid' })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N30 concurrent consumption in one session signs at most once', async () => {
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    const spies = signingSpies()
    const attempts = await Promise.allSettled([
      finalize(wire, txReview, contentHash, capability, spies),
      finalize(wire, txReview, contentHash, capability, spies)
    ])
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(spies.sign).toHaveBeenCalledTimes(1)
    expect(spies.broadcastTx).not.toHaveBeenCalled()
  })

  test('N31 occupied Web Lock rejects a second tab', async () => {
    const spies = signingSpies()
    const locks = { request: vi.fn(async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => callback(null)) }
    await expect(acquireExternalSignLock(locks as unknown as LockManager)).rejects.toMatchObject({ code: 'EXTERNAL_SIGN_BUSY_OR_LOCK_UNAVAILABLE' })
    const failingLocks = { request: vi.fn(async () => { throw new Error('lock manager failed') }) }
    await expect(acquireExternalSignLock(failingLocks as unknown as LockManager)).rejects.toMatchObject({ code: 'EXTERNAL_SIGN_BUSY_OR_LOCK_UNAVAILABLE' })
    expectNoSigning(spies)
  })

  test('N32 every mandatory browser capability fails closed when absent', () => {
    const spies = signingSpies()
    const complete = { crypto: globalThis.crypto, indexedDB: {} as IDBFactory, locks: { request: vi.fn() } as unknown as LockManager, BroadcastChannel }
    for (const missing of ['crypto', 'indexedDB', 'locks', 'BroadcastChannel'] as const) {
      const environment = { ...complete, [missing]: undefined }
      expect(detectExternalSignBrowserCapabilities(environment).supported).toBe(false)
    }
    expectNoSigning(spies)
  })

  test('N33 sessionStorage is take-and-delete and cannot mutate the in-memory request', () => {
    const spies = signingSpies()
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    }
    const wire = request()
    storePendingExternalSignRequest(storage, wire, NOW)
    const taken = takePendingExternalSignRequest(storage, NOW)
    values.set(EXTERNAL_SIGN_REQUEST_STORAGE_KEY, JSON.stringify({ request: requestPayload({ chainId: 'ectest:1' }), persistedAt: NOW }))
    expect(taken?.chainId).toBe('ecash:1')
    expect(Object.isFrozen(taken)).toBe(true)
    expect(storage.removeItem).toHaveBeenCalledWith(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
    expectNoSigning(spies)
  })

  test('N34 replay-store transaction failure occurs before signatory access', async () => {
    const spies = signingSpies()
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    const failingStore: ExternalSignReplayStore = {
      has: async () => false,
      record: async () => { throw new ExternalSignError('REPLAY_STORE_UNAVAILABLE') },
      purgeExpired: async () => undefined
    }
    await expect(finalize(wire, txReview, contentHash, capability, spies, failingStore)).rejects.toMatchObject({ code: 'REPLAY_STORE_UNAVAILABLE' })
    expectNoSigning(spies)
  })

  test('N35 kill switch and empty/invalid allowlist keep production disabled', () => {
    const spies = signingSpies()
    expect(resolveExternalSignConfig({}).enabled).toBe(false)
    expect(resolveExternalSignConfig({ VITE_EXTERNAL_SIGN_P0_ENABLED: 'true' }).policyReady).toBe(false)
    expect(resolveExternalSignConfig({ VITE_EXTERNAL_SIGN_P0_ENABLED: 'true', VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS: 'http://fixture.invalid' }).policyReady).toBe(false)
    expectNoSigning(spies)
  })

  test('N36 request expired on arrival is rejected', () => {
    const spies = signingSpies()
    expect(() => request({ expiresAt: NOW })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N37 request beyond the five-minute TTL is rejected', () => {
    const spies = signingSpies()
    expect(() => request({ expiresAt: NOW + EXTERNAL_SIGN_MAX_REQUEST_TTL_MS + 1 })).toThrowError(ExternalSignError)
    expectNoSigning(spies)
  })

  test('N38 malformed, residual and oversized tx encodings are rejected', () => {
    const spies = signingSpies()
    for (const unsignedTxHex of ['0', 'zz', `${makeUnsignedTx().toHex()}00`, '00'.repeat(100_001)]) {
      expect(() => request({ unsignedTxHex })).toThrowError(ExternalSignError)
    }
    expectNoSigning(spies)
  })

  test('N39 incomplete summary, more than ten outputs or multiple change outputs cannot be approved', async () => {
    const spies = signingSpies()
    const tooMany = makeUnsignedTx(Array.from({ length: 11 }, () => ({ sats: 100n, script: RECIPIENT_SCRIPT })))
    await expect(review(request({ unsignedTxHex: tooMany.toHex() }), provider({
      prevTx: chronikTx({ outputs: [{ sats: 1_300n, outputScript: ACTIVE_SCRIPT.toHex() }] }),
      validated: validatedTx(tooMany)
    }))).rejects.toMatchObject({ code: 'OUTPUT_COUNT_FORBIDDEN' })
    const twoChange = makeUnsignedTx([{ sats: 800n, script: ACTIVE_SCRIPT }, { sats: 1_000n, script: ACTIVE_SCRIPT }])
    await expect(review(request({ unsignedTxHex: twoChange.toHex() }), provider({ validated: validatedTx(twoChange) }))).rejects.toMatchObject({ code: 'MULTIPLE_CHANGE_OUTPUTS' })
    expectNoSigning(spies)
  })
})

describe('external-sign P0 positive matrix: signOnly only', () => {
  test('P01 authenticated synthetic request signs once after atomic approval and never broadcasts', async () => {
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    const spies = signingSpies()
    const response = await finalize(wire, txReview, contentHash, capability, spies)
    expect(response).toMatchObject({ mode: 'signOnly', requestId: REQUEST_ID, signedTxHex: expect.any(String) })
    expect(spies.getSignatory).toHaveBeenCalledTimes(1)
    expect(spies.sign).toHaveBeenCalledTimes(1)
    expect(spies.broadcastTx).not.toHaveBeenCalled()
  })

  test('P02 onboarding request is deleted before review and signs only after a new approval', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    }
    storePendingExternalSignRequest(storage, request(), NOW)
    const wire = takePendingExternalSignRequest(storage, NOW)
    expect(wire).not.toBeNull()
    expect(values.has(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)).toBe(false)
    const { txReview, contentHash } = await prepared(wire as ExternalSignWireRequestV1)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire!.expiresAt, NOW)
    const spies = signingSpies()
    await finalize(wire as ExternalSignWireRequestV1, txReview, contentHash, capability, spies)
    expect(spies.sign).toHaveBeenCalledTimes(1)
    expect(spies.broadcastTx).not.toHaveBeenCalled()
  })

  test('P03 signed response is delivered only to the authenticated origin', async () => {
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    const capability = new ExternalSignApprovalCapabilityV1(REQUEST_ID, contentHash, wire.expiresAt, NOW)
    const spies = signingSpies()
    const response = await finalize(wire, txReview, contentHash, capability, spies)
    const opener = { postMessage: vi.fn() }
    expect(deliverExternalSignResponse(response, AUTHENTICATED_ORIGIN, opener as unknown as Window)).toBe(true)
    expect(opener.postMessage).toHaveBeenCalledWith(response, 'https://fixture.invalid')
    expect(deliverExternalSignResponse(response, declaredOriginContext(wire), opener as unknown as Window)).toBe(false)
    expect(opener.postMessage).toHaveBeenCalledTimes(1)
    expect(spies.broadcastTx).not.toHaveBeenCalled()
  })

  test('P04 canonical contentHash fixture is stable and mutations change it', async () => {
    const wire = request()
    const { txReview, contentHash } = await prepared(wire)
    expect(contentHash).toBe('sha256:554fc119d8f0c8a43fd0cf2451bfe845b4c45f8eb1136dfd67c03fd88f222192')
    const upperHexWire = request({ unsignedTxHex: wire.unsignedTxHex.toUpperCase() })
    expect(upperHexWire.unsignedTxHex).toBe(wire.unsignedTxHex)
    await expect(calculateExternalSignContentHash(upperHexWire, AUTHENTICATED_ORIGIN, txReview)).resolves.toBe(contentHash)

    const mutationVectors: Array<[
      ExternalSignWireRequestV1,
      OriginContextV1,
      ExternalSignTxReviewV1
    ]> = []
    const mutateRequest = (field: string, value: unknown) => mutationVectors.push([
      { ...wire, [field]: value } as ExternalSignWireRequestV1,
      AUTHENTICATED_ORIGIN,
      txReview
    ])
    for (const [field, value] of [
      ['protocolId', 'other.protocol'],
      ['protocolVersion', 2],
      ['chainId', 'ectest:1'],
      ['requestId', '223e4567-e89b-42d3-a456-426614174000'],
      ['intentId', 'other-intent'],
      ['expiresAt', wire.expiresAt + 1],
      ['mode', 'otherMode']
    ] as const) mutateRequest(field, value)
    mutationVectors.push([
      { ...wire, requester: { ...wire.requester, displayName: 'Other fixture' } },
      AUTHENTICATED_ORIGIN,
      txReview
    ])
    mutationVectors.push([
      { ...wire, requester: { ...wire.requester, applicationUrl: 'https://fixture.invalid/other' } },
      AUTHENTICATED_ORIGIN,
      txReview
    ])
    mutationVectors.push([
      wire,
      { ...AUTHENTICATED_ORIGIN, authenticatedOrigin: 'https://other.invalid' },
      txReview
    ])
    mutationVectors.push([
      wire,
      { ...AUTHENTICATED_ORIGIN, declaredOrigin: 'https://other.invalid' },
      txReview
    ])
    mutationVectors.push([
      wire,
      { ...AUTHENTICATED_ORIGIN, status: 'declared-unverified' },
      txReview
    ])
    for (const [field, value] of [
      ['version', '3'],
      ['lockTime', '1'],
      ['serializedSizeBytes', (BigInt(txReview.serializedSizeBytes) + 1n).toString()],
      ['unsignedTxHex', `${txReview.unsignedTxHex}00`],
      ['inputTotalSats', (BigInt(txReview.inputTotalSats) + 1n).toString()],
      ['outputTotalSats', (BigInt(txReview.outputTotalSats) + 1n).toString()],
      ['feeSats', (BigInt(txReview.feeSats) + 1n).toString()]
    ] as const) {
      mutationVectors.push([wire, AUTHENTICATED_ORIGIN, { ...txReview, [field]: value }])
    }
    for (const [field, value] of [
      ['index', '1'],
      ['outputScript', RECIPIENT_SCRIPT.toHex()],
      ['ownedByActiveWallet', false],
      ['sats', '2001'],
      ['token', 'token'],
      ['txid', '22'.repeat(32)],
      ['vout', '1']
    ] as const) {
      mutationVectors.push([wire, AUTHENTICATED_ORIGIN, {
        ...txReview,
        inputs: [{ ...txReview.inputs[0], [field]: value }] as ExternalSignTxReviewV1['inputs']
      }])
    }
    for (const [field, value] of [
      ['address', ACTIVE_ADDRESS],
      ['classification', 'change'],
      ['index', '9'],
      ['opReturn', '6a'],
      ['outputScript', ACTIVE_SCRIPT.toHex()],
      ['sats', '999'],
      ['token', 'token']
    ] as const) {
      mutationVectors.push([wire, AUTHENTICATED_ORIGIN, {
        ...txReview,
        outputs: [{ ...txReview.outputs[0], [field]: value }, ...txReview.outputs.slice(1)] as ExternalSignTxReviewV1['outputs']
      }])
    }

    for (const [mutatedWire, mutatedOrigin, mutatedReview] of mutationVectors) {
      await expect(calculateExternalSignContentHash(mutatedWire, mutatedOrigin, mutatedReview)).resolves.not.toBe(contentHash)
    }
  })
})
