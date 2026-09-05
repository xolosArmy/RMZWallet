/**
 * Transport-only H3WC contract.
 *
 * This module deliberately contains no wallet implementation and no signing
 * primitive.  It is the narrow boundary shared by the feature-flagged
 * WalletKit adapter and the future x402eCash client.
 */

export const H3WC_CHAIN = 'ecash:1' as const
export const H3WC_METHOD_IDENTITY = 'ecash_getAccountIdentity' as const
export const H3WC_METHOD_SIGN_MESSAGE = 'ecash_signMessage' as const
export const H3WC_METHODS = Object.freeze([
  H3WC_METHOD_IDENTITY,
  H3WC_METHOD_SIGN_MESSAGE
] as const)
export const H3WC_EVENTS = Object.freeze([] as const)

export const H3WC_GRANT_VERSION = 1 as const
export const H3WC_PROFILE = 'x402-h3b-authorization-v1' as const
export const H3WC_STORAGE_PREFIX = 'tonalli-h3wc-v1' as const
export const H3WC_OWNER_LOCK_NAME = 'tonalli:wc:owner:v1' as const
export const H3WC_COORDINATION_CHANNEL = 'tonalli:wc:coordination:v1' as const
export const H3WC_JOURNAL_DATABASE = 'tonalli-h3wc-journal-v1' as const
export const H3WC_JOURNAL_STORE = 'requests' as const

/** Stable JSON-RPC application error for the pre-crypto candidate. */
export const H3WC_SIGNING_NOT_ENABLED_CODE = -32098 as const
export const H3WC_SIGNING_NOT_ENABLED = 'H3WC_SIGNING_NOT_ENABLED' as const
export const H3WC_IDENTITY_UNAVAILABLE_CODE = -32097 as const
export const H3WC_IDENTITY_UNAVAILABLE = 'H3WC_IDENTITY_UNAVAILABLE' as const
export const H3WC_INVALID_SESSION_CODE = -32096 as const
export const H3WC_INVALID_SESSION = 'H3WC_INVALID_SESSION' as const

export type H3wcMethod = (typeof H3WC_METHODS)[number]
export type H3wcChain = typeof H3WC_CHAIN

export type H3wcIdentity = Readonly<{
  address: string
  publicKey: string
}>

export type H3wcNamespace = Readonly<{
  chains: readonly string[]
  methods: readonly string[]
  events: readonly string[]
  accounts: readonly string[]
}>

export type H3wcPeerMetadata = Readonly<{
  name?: string
  description?: string
  url?: string
  icons?: readonly string[]
  publicKey?: string
}>

export type H3wcPeer = Readonly<{
  metadata?: H3wcPeerMetadata
  publicKey?: string
}> 

/** The subset of a WalletConnect proposal that the qualifier reads. */
export type H3wcProposal = Readonly<{
  id: number
  requiredNamespaces?: unknown
  optionalNamespaces?: unknown
  proposer?: Readonly<{
    publicKey?: string
    metadata?: H3wcPeerMetadata
  }>
  verifyContext?: unknown
}>

/** The subset of a restored/approved SDK session that the qualifier reads. */
export type H3wcSession = Readonly<{
  topic: string
  expiry: number
  namespaces: unknown
  peer?: H3wcPeer
  acknowledged?: boolean
  controller?: string
}> 

/**
 * Local profile metadata is intentionally kept outside the SDK session
 * namespace.  It is persisted in the H3WC journal and must be rechecked on
 * every restore; it is never treated as a capability by itself.
 */
export type H3wcSessionCandidate = Readonly<{
  session: H3wcSession
  grantVersion: unknown
  profile: unknown
  live: boolean
  revoked: boolean
  qualificationEpoch: number
}>

export type H3wcPeerExpectation = Readonly<{
  origin: string
  publicKey?: string
}>

export type H3wcQualificationContext = Readonly<{
  nowSeconds: number
  expectedTopic: string
  peer: H3wcPeerExpectation
  expectedAccount: string
  expectedIdentity?: H3wcIdentity
  qualificationEpoch: number
  expectedGrantVersion?: typeof H3WC_GRANT_VERSION
  expectedProfile?: typeof H3WC_PROFILE
}>

export type H3wcQualificationCode =
  | 'INVALID_SESSION'
  | 'INVALID_TOPIC'
  | 'INVALID_EXPIRY'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_NOT_LIVE'
  | 'QUALIFICATION_EPOCH_MISMATCH'
  | 'GRANT_VERSION_MISMATCH'
  | 'PROFILE_MISMATCH'
  | 'NAMESPACE_SET_MISMATCH'
  | 'NAMESPACE_INVALID'
  | 'CHAIN_SET_MISMATCH'
  | 'METHOD_SET_MISMATCH'
  | 'EVENT_SET_MISMATCH'
  | 'ACCOUNT_SET_MISMATCH'
  | 'DUPLICATE_VALUE'
  | 'PEER_MISSING'
  | 'PEER_ORIGIN_INVALID'
  | 'PEER_ORIGIN_MISMATCH'
  | 'PEER_KEY_MISMATCH'
  | 'IDENTITY_INVALID'

export type H3wcQualificationFailure = Readonly<{
  status: 'REJECTED'
  code: H3wcQualificationCode
  detail: string
}>

export type H3wcQualificationSuccess = Readonly<{
  status: 'QUALIFIED'
  topic: string
  account: string
  peerOrigin: string
  expiresAt: number
  qualificationEpoch: number
}>

export type H3wcQualificationResult = H3wcQualificationSuccess | H3wcQualificationFailure

export type H3wcRpcError = Readonly<{
  code: number
  message: string
  data?: string
}>

export type H3wcRpcResponse = Readonly<{
  id: number
  jsonrpc: '2.0'
  result: unknown
}> | Readonly<{
  id: number
  jsonrpc: '2.0'
  error: H3wcRpcError
}>

export type H3wcSessionRequest = Readonly<{
  id: number
  topic: string
  chainId: string
  request: Readonly<{
    method: string
    params: unknown
  }>
}> 
