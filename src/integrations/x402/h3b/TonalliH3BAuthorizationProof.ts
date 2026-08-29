import { isValidEcashAddress } from '../../../utils/alias'
import {
  canonicalizeJson,
  encodeCanonicalBase64Url,
  type TonalliH3BRequest
} from './TonalliH3BContract'

export const H3B_AUTHORIZATION_PREFIX = 'TONALLI_X402_H3B_AUTHORIZATION_PROOF_V1'

export type TonalliH3BWalletAccount = Readonly<{
  address: string
  publicKey: string
}>

export type TonalliH3BWalletPort = Readonly<{
  getX402ActiveAccount(): TonalliH3BWalletAccount | null
  signX402AuthorizationMessage(message: string): Promise<Readonly<{
    signature: string
    publicKey: string
  }>>
}>

export type TonalliH3BUnsignedProof = Readonly<{
  type: 'tonalli-x402-authorization-proof'
  version: 1
  gate: 'H3B'
  mode: 'authorization-dry-run'
  challengeId: string
  sourceOrigin: 'https://x402.ecash.mx'
  resourceUrl: 'https://api.x402.ecash.mx/v1/resource/demo'
  paymentRequiredSha256: string
  x402Version: 2
  scheme: 'xec-prepaid-utxo'
  network: 'xec:mainnet'
  asset: 'XEC'
  amount: '10000'
  displayAmount: '100 XEC'
  payTo: 'ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w'
  payer: string
  publicKey: string
  issuedAt: number
  expiresAt: number
  paymentPerformed: false
  transactionCreated: false
  broadcasted: false
}>

export type TonalliH3BSignedProof = Readonly<TonalliH3BUnsignedProof & {
  authorizationMessage: string
  authorizationSignature: Readonly<{
    type: 'tonalli-message-signature'
    publicKey: string
    signature: string
  }>
}>

export type TonalliH3BRejectedResult = Readonly<{
  status: 'authorization_rejected'
  gate: 'H3B'
  challengeId: string
  signed: false
  payment: Readonly<{ performed: false }>
}>

export type TonalliH3BSignedResult = Readonly<{
  status: 'authorization_signed'
  gate: 'H3B'
  challengeId: string
  signed: true
  mode: 'authorization-dry-run'
  payment: Readonly<{ performed: false }>
  transaction: Readonly<{ created: false; broadcasted: false }>
  proof: string
  nextGate: 'H3C'
}>

export type TonalliH3BSessionState =
  | 'ready'
  | 'signing'
  | 'signed'
  | 'rejected'
  | 'cancelled'
  | 'failed'

export class TonalliH3BAuthorizationError extends Error {
  constructor() {
    super('H3B_AUTHORIZATION_FAILED')
    this.name = 'TonalliH3BAuthorizationError'
  }
}

type CryptoWithDigest = Readonly<Pick<Crypto, 'subtle'>>

const fail = (): never => {
  throw new TonalliH3BAuthorizationError()
}

const isCompressedPublicKey = (value: string): boolean => /^(02|03)[0-9a-f]{64}$/u.test(value)

const requireAccount = (account: TonalliH3BWalletAccount | null): TonalliH3BWalletAccount => {
  if (account === null) return fail()
  if (
    account.address !== account.address.trim() ||
    !isValidEcashAddress(account.address) ||
    !isCompressedPublicKey(account.publicKey)
  ) {
    fail()
  }
  return Object.freeze({ address: account.address, publicKey: account.publicKey })
}

const readAccount = (wallet: TonalliH3BWalletPort): TonalliH3BWalletAccount => {
  try {
    return requireAccount(wallet.getX402ActiveAccount())
  } catch {
    return fail()
  }
}

export const sha256CanonicalJson = async (
  value: unknown,
  cryptoImplementation: CryptoWithDigest = globalThis.crypto
): Promise<string> => {
  if (!cryptoImplementation?.subtle) fail()
  const digest = await cryptoImplementation.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalizeJson(value))
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const buildTonalliH3BUnsignedProof = (
  request: TonalliH3BRequest,
  account: TonalliH3BWalletAccount,
  paymentRequiredSha256: string
): TonalliH3BUnsignedProof => {
  if (!/^[0-9a-f]{64}$/u.test(paymentRequiredSha256)) fail()
  const acceptance = request.paymentRequired.accepts[0]
  return Object.freeze({
    type: 'tonalli-x402-authorization-proof',
    version: 1,
    gate: 'H3B',
    mode: 'authorization-dry-run',
    challengeId: request.challengeId,
    sourceOrigin: request.sourceOrigin,
    resourceUrl: request.paymentRequired.resource.url,
    paymentRequiredSha256,
    x402Version: request.paymentRequired.x402Version,
    scheme: acceptance.scheme,
    network: acceptance.network,
    asset: acceptance.asset,
    amount: acceptance.amount,
    displayAmount: acceptance.extra.displayAmount,
    payTo: acceptance.payTo,
    payer: account.address,
    publicKey: account.publicKey,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    paymentPerformed: false,
    transactionCreated: false,
    broadcasted: false
  })
}

export const buildTonalliH3BAuthorizationMessage = (
  unsignedProof: TonalliH3BUnsignedProof
): string => `${H3B_AUTHORIZATION_PREFIX}\n${canonicalizeJson(unsignedProof)}`

export const createSignedH3BCallbackUrl = (
  request: TonalliH3BRequest,
  proof: string
): string => {
  if (!/^[A-Za-z0-9_-]+$/u.test(proof)) fail()
  return `${request.returnUrl}#h3bStatus=signed&challengeId=${request.challengeId}&proof=${proof}`
}

export const createRejectedH3BCallbackUrl = (request: TonalliH3BRequest): string => (
  `${request.returnUrl}#h3bStatus=rejected&challengeId=${request.challengeId}`
)

export type TonalliH3BAuthorizationSession = Readonly<{
  request: TonalliH3BRequest
  account: TonalliH3BWalletAccount
  paymentRequiredSha256: string
  unsignedProof: TonalliH3BUnsignedProof
  authorizationMessage: string
  getState(): TonalliH3BSessionState
  sign(): Promise<TonalliH3BSignedResult>
  reject(): TonalliH3BRejectedResult
  cancel(): void
}>

export const createTonalliH3BAuthorizationSession = async (
  request: TonalliH3BRequest,
  wallet: TonalliH3BWalletPort,
  options: Readonly<{
    cryptoImplementation?: CryptoWithDigest
    nowSeconds?: () => number
  }> = {}
): Promise<TonalliH3BAuthorizationSession> => {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const paymentRequiredSha256 = await sha256CanonicalJson(
    request.paymentRequired,
    options.cryptoImplementation
  )
  const account = readAccount(wallet)
  const preparedAt = nowSeconds()
  if (!Number.isSafeInteger(preparedAt) || preparedAt >= request.expiresAt) fail()
  const unsignedProof = buildTonalliH3BUnsignedProof(request, account, paymentRequiredSha256)
  const authorizationMessage = buildTonalliH3BAuthorizationMessage(unsignedProof)
  let state: TonalliH3BSessionState = 'ready'

  const reject = (): TonalliH3BRejectedResult => {
    if (state !== 'ready') fail()
    state = 'rejected'
    return Object.freeze({
      status: 'authorization_rejected',
      gate: 'H3B',
      challengeId: request.challengeId,
      signed: false,
      payment: Object.freeze({ performed: false })
    })
  }

  const sign = async (): Promise<TonalliH3BSignedResult> => {
    if (state !== 'ready') fail()
    state = 'signing'

    try {
      const now = nowSeconds()
      if (!Number.isSafeInteger(now) || now >= request.expiresAt) fail()

      const currentAccount = readAccount(wallet)
      if (
        currentAccount.address !== account.address ||
        currentAccount.publicKey !== account.publicKey
      ) {
        fail()
      }

      const signed = await wallet.signX402AuthorizationMessage(authorizationMessage)
      if (state !== 'signing') fail()
      if (
        typeof signed.signature !== 'string' ||
        signed.signature.trim() === '' ||
        !isCompressedPublicKey(signed.publicKey) ||
        signed.publicKey !== account.publicKey
      ) {
        fail()
      }

      const signedProof: TonalliH3BSignedProof = Object.freeze({
        ...unsignedProof,
        authorizationMessage,
        authorizationSignature: Object.freeze({
          type: 'tonalli-message-signature',
          publicKey: signed.publicKey,
          signature: signed.signature
        })
      })
      const proof = encodeCanonicalBase64Url(signedProof)
      state = 'signed'
      return Object.freeze({
        status: 'authorization_signed',
        gate: 'H3B',
        challengeId: request.challengeId,
        signed: true,
        mode: 'authorization-dry-run',
        payment: Object.freeze({ performed: false }),
        transaction: Object.freeze({ created: false, broadcasted: false }),
        proof,
        nextGate: 'H3C'
      })
    } catch {
      if (state === 'signing') state = 'failed'
      return fail()
    }
  }

  const cancel = () => {
    if (state === 'ready' || state === 'signing') state = 'cancelled'
  }

  return Object.freeze({
    request,
    account,
    paymentRequiredSha256,
    unsignedProof,
    authorizationMessage,
    getState: () => state,
    sign,
    reject,
    cancel
  })
}
