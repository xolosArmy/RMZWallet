import { describe, expect, test, vi } from 'vitest'
import {
  buildTonalliH3BAuthorizationMessage,
  buildTonalliH3BUnsignedProof,
  createRejectedH3BCallbackUrl,
  createSignedH3BCallbackUrl,
  createTonalliH3BAuthorizationSession,
  sha256CanonicalJson,
  type TonalliH3BWalletPort
} from './TonalliH3BAuthorizationProof'
import {
  decodeCanonicalBase64Url,
  encodeCanonicalBase64Url,
  parseTonalliH3BRequest,
  type TonalliH3BRequest
} from './TonalliH3BContract'

const NOW = 1_800_000_000
const CHALLENGE = 'AQIDBAUGBwgJCgsMDQ4PEA'
const PAYER = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const PUBLIC_KEY = `02${'11'.repeat(32)}`
const SIGNATURE = 'opaque-tonalli-message-signature'
const PAYMENT_REQUIRED_SHA256 = 'd865139386538ad3fddaa400d95c4074333cd52fdbbf8c1c6d42984fe214d793'

const requestFixture = (): TonalliH3BRequest => parseTonalliH3BRequest({
  hash: `#request=${encodeCanonicalBase64Url({
    type: 'x402ecash-h3b-request',
    version: 1,
    targetGate: 'H3B',
    sourceOrigin: 'https://x402.ecash.mx',
    returnUrl: 'https://x402.ecash.mx/experiments/webmcp/',
    challengeId: CHALLENGE,
    issuedAt: NOW - 10,
    expiresAt: NOW + 240,
    paymentRequired: {
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      resource: {
        url: 'https://api.x402.ecash.mx/v1/resource/demo',
        description: 'x402eCash WebMCP Challenge demo resource',
        mimeType: 'application/json',
        serviceName: 'x402eCash'
      },
      accepts: [{
        scheme: 'xec-prepaid-utxo',
        network: 'xec:mainnet',
        amount: '10000',
        asset: 'XEC',
        payTo: 'ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w',
        maxTimeoutSeconds: 60,
        extra: { displayAmount: '100 XEC', experimental: true, gate: 'H2A' }
      }],
      extensions: {}
    },
    approval: { status: 'payment_approved', gate: 'H3A', approved: true, performed: false }
  })}`,
  search: '',
  nowSeconds: NOW
})

const createWallet = (overrides: Partial<TonalliH3BWalletPort> = {}) => ({
  getX402ActiveAccount: vi.fn(() => ({ address: PAYER, publicKey: PUBLIC_KEY })),
  signX402AuthorizationMessage: vi.fn(async () => ({ signature: SIGNATURE, publicKey: PUBLIC_KEY })),
  ...overrides
})

const createSession = (wallet = createWallet(), getNow = () => NOW) => (
  createTonalliH3BAuthorizationSession(requestFixture(), wallet, { nowSeconds: getNow })
)

const EXPECTED_UNSIGNED_PROOF = Object.freeze({
  type: 'tonalli-x402-authorization-proof',
  version: 1,
  gate: 'H3B',
  mode: 'authorization-dry-run',
  challengeId: CHALLENGE,
  sourceOrigin: 'https://x402.ecash.mx',
  resourceUrl: 'https://api.x402.ecash.mx/v1/resource/demo',
  paymentRequiredSha256: PAYMENT_REQUIRED_SHA256,
  x402Version: 2,
  scheme: 'xec-prepaid-utxo',
  network: 'xec:mainnet',
  asset: 'XEC',
  amount: '10000',
  displayAmount: '100 XEC',
  payTo: 'ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w',
  payer: PAYER,
  publicKey: PUBLIC_KEY,
  issuedAt: NOW - 10,
  expiresAt: NOW + 240,
  paymentPerformed: false,
  transactionCreated: false,
  broadcasted: false
})

const EXPECTED_AUTHORIZATION_MESSAGE = 'TONALLI_X402_H3B_AUTHORIZATION_PROOF_V1\n{"amount":"10000","asset":"XEC","broadcasted":false,"challengeId":"AQIDBAUGBwgJCgsMDQ4PEA","displayAmount":"100 XEC","expiresAt":1800000240,"gate":"H3B","issuedAt":1799999990,"mode":"authorization-dry-run","network":"xec:mainnet","payTo":"ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w","payer":"ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk","paymentPerformed":false,"paymentRequiredSha256":"d865139386538ad3fddaa400d95c4074333cd52fdbbf8c1c6d42984fe214d793","publicKey":"021111111111111111111111111111111111111111111111111111111111111111","resourceUrl":"https://api.x402.ecash.mx/v1/resource/demo","scheme":"xec-prepaid-utxo","sourceOrigin":"https://x402.ecash.mx","transactionCreated":false,"type":"tonalli-x402-authorization-proof","version":1,"x402Version":2}'

describe('Tonalli H3B cryptographic binding', () => {
  test('matches the reviewed deterministic PaymentRequired SHA-256 fixture', async () => {
    expect(await sha256CanonicalJson(requestFixture().paymentRequired)).toBe(PAYMENT_REQUIRED_SHA256)
  })

  test('constructs the exact unsigned proof and exact canonical message bytes', async () => {
    const session = await createSession()

    expect(session.unsignedProof).toEqual(EXPECTED_UNSIGNED_PROOF)
    expect(session.authorizationMessage).toBe(EXPECTED_AUTHORIZATION_MESSAGE)
    expect(new TextEncoder().encode(session.authorizationMessage))
      .toEqual(new TextEncoder().encode(EXPECTED_AUTHORIZATION_MESSAGE))
  })

  test('binds requirement, challenge, payer, public key and expiration changes', async () => {
    const request = requestFixture()
    const baselineHash = await sha256CanonicalJson(request.paymentRequired)
    const changedRequirement = {
      ...request.paymentRequired,
      accepts: [{ ...request.paymentRequired.accepts[0], amount: '10001' }]
    }
    expect(await sha256CanonicalJson(changedRequirement)).not.toBe(baselineHash)

    for (const mutation of [
      { challengeId: 'AgMEBQYHCAkKCwwNDg8QEQ' },
      { payer: 'ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp' },
      { publicKey: `03${'22'.repeat(32)}` },
      { expiresAt: NOW + 239 }
    ]) {
      const changed = { ...EXPECTED_UNSIGNED_PROOF, ...mutation }
      expect(buildTonalliH3BAuthorizationMessage(changed)).not.toBe(EXPECTED_AUTHORIZATION_MESSAGE)
    }
  })

  test('signs all three false boundary flags inside the exact message', () => {
    const message = buildTonalliH3BAuthorizationMessage(EXPECTED_UNSIGNED_PROOF)
    expect(message).toContain('"paymentPerformed":false')
    expect(message).toContain('"transactionCreated":false')
    expect(message).toContain('"broadcasted":false')
  })

  test('builds deterministic allowlisted callback URLs only', () => {
    const request = requestFixture()
    expect(createSignedH3BCallbackUrl(request, 'cHJvb2Y')).toBe(
      `https://x402.ecash.mx/experiments/webmcp/#h3bStatus=signed&challengeId=${CHALLENGE}&proof=cHJvb2Y`
    )
    expect(createRejectedH3BCallbackUrl(request)).toBe(
      `https://x402.ecash.mx/experiments/webmcp/#h3bStatus=rejected&challengeId=${CHALLENGE}`
    )
  })
})

describe('Tonalli H3B wallet boundary', () => {
  test.each([
    null,
    { address: '', publicKey: PUBLIC_KEY },
    { address: PAYER, publicKey: '04deadbeef' }
  ])('fails closed before exposing a session for invalid account %j', async (account) => {
    const wallet = createWallet({ getX402ActiveAccount: vi.fn(() => account) })
    await expect(createSession(wallet)).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('resolves the active wallet only after the asynchronous requirement digest', async () => {
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined
    const digest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve
    })
    let account: { address: string; publicKey: string } | null = {
      address: PAYER,
      publicKey: PUBLIC_KEY
    }
    const wallet = createWallet({ getX402ActiveAccount: vi.fn(() => account) })
    const session = createTonalliH3BAuthorizationSession(requestFixture(), wallet, {
      nowSeconds: () => NOW,
      cryptoImplementation: {
        subtle: { digest: vi.fn(() => digest) } as unknown as SubtleCrypto
      }
    })

    expect(wallet.getX402ActiveAccount).not.toHaveBeenCalled()
    account = null
    resolveDigest?.(new Uint8Array(32).buffer)
    await expect(session).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(wallet.getX402ActiveAccount).toHaveBeenCalledTimes(1)
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('reject signs nothing and settles exactly once', async () => {
    const wallet = createWallet()
    const session = await createSession(wallet)

    expect(session.reject()).toEqual({
      status: 'authorization_rejected',
      gate: 'H3B',
      challengeId: CHALLENGE,
      signed: false,
      payment: { performed: false }
    })
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(() => session.reject()).toThrow('H3B_AUTHORIZATION_FAILED')
    await expect(session.sign()).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
  })

  test('sign calls the narrow signing primitive once and returns authorization-only state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const chronikCall = vi.fn()
    const broadcastCall = vi.fn()
    const facilitatorCall = vi.fn()
    const wallet = {
      ...createWallet(),
      chronikCall,
      broadcastCall,
      facilitatorCall
    }
    const session = await createSession(wallet)
    const result = await session.sign()

    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledWith(EXPECTED_AUTHORIZATION_MESSAGE)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(chronikCall).not.toHaveBeenCalled()
    expect(broadcastCall).not.toHaveBeenCalled()
    expect(facilitatorCall).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    expect(result).toMatchObject({
      status: 'authorization_signed',
      gate: 'H3B',
      challengeId: CHALLENGE,
      signed: true,
      mode: 'authorization-dry-run',
      payment: { performed: false },
      transaction: { created: false, broadcasted: false },
      nextGate: 'H3C'
    })
  })

  test('double sign calls the signer at most once', async () => {
    let resolveSignature: ((value: { signature: string; publicKey: string }) => void) | undefined
    const pendingSignature = new Promise<{ signature: string; publicKey: string }>((resolve) => {
      resolveSignature = resolve
    })
    const wallet = createWallet({
      signX402AuthorizationMessage: vi.fn(() => pendingSignature)
    })
    const session = await createSession(wallet)

    const first = session.sign()
    const second = session.sign()
    await expect(second).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
    resolveSignature?.({ signature: SIGNATURE, publicKey: PUBLIC_KEY })
    await expect(first).resolves.toMatchObject({ status: 'authorization_signed' })
  })

  test('fails closed when account changes immediately before signing', async () => {
    const getAccount = vi.fn()
      .mockReturnValueOnce({ address: PAYER, publicKey: PUBLIC_KEY })
      .mockReturnValueOnce({ address: 'ecash:qr03uhyuv0cen3atackpru04watjlllxtu6aqnedrp', publicKey: PUBLIC_KEY })
    const wallet = createWallet({ getX402ActiveAccount: getAccount })
    const session = await createSession(wallet)

    await expect(session.sign()).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('fails closed after expiration without invoking the signer', async () => {
    let now = NOW
    const wallet = createWallet()
    const session = await createSession(wallet, () => now)
    now = requestFixture().expiresAt

    await expect(session.sign()).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test.each([
    ['signer exception', async () => { throw new Error('internal detail') }],
    ['empty signature', async () => ({ signature: ' ', publicKey: PUBLIC_KEY })],
    ['public key mismatch', async () => ({ signature: SIGNATURE, publicKey: `03${'22'.repeat(32)}` })]
  ])('fails closed for %s', async (_name, signImplementation) => {
    const wallet = createWallet({ signX402AuthorizationMessage: vi.fn(signImplementation) })
    const session = await createSession(wallet)
    await expect(session.sign()).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(session.getState()).toBe('failed')
  })

  test('cancel makes a stale session inert', async () => {
    const wallet = createWallet()
    const session = await createSession(wallet)
    session.cancel()

    await expect(session.sign()).rejects.toThrow('H3B_AUTHORIZATION_FAILED')
    expect(() => session.reject()).toThrow('H3B_AUTHORIZATION_FAILED')
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('proof decodes to public authorization data without created transaction artifacts', async () => {
    const session = await createSession()
    const result = await session.sign()
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      decodeCanonicalBase64Url(result.proof)
    )) as Record<string, unknown>

    expect(decoded).toMatchObject({
      ...EXPECTED_UNSIGNED_PROOF,
      authorizationMessage: EXPECTED_AUTHORIZATION_MESSAGE,
      authorizationSignature: {
        type: 'tonalli-message-signature',
        publicKey: PUBLIC_KEY,
        signature: SIGNATURE
      }
    })
    expect(decoded).not.toHaveProperty('txid')
    expect(decoded).not.toHaveProperty('rawTx')
    expect(decoded).not.toHaveProperty('transactionHex')
    expect(decoded).not.toHaveProperty('signedTransaction')
    expect(decoded).not.toHaveProperty('broadcastResult')
    expect(decoded).not.toHaveProperty('paymentSignature')
  })

  test('standalone proof construction rejects an invalid fingerprint', () => {
    expect(() => buildTonalliH3BUnsignedProof(
      requestFixture(),
      { address: PAYER, publicKey: PUBLIC_KEY },
      'invalid'
    )).toThrow('H3B_AUTHORIZATION_FAILED')
  })
})
