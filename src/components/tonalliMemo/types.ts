import type { Tm1Draft02PostPreview } from '../../integrations/tonalliMemo/tm1Draft02'

/**
 * Standard eCash OP_RETURN script byte limit.
 */
export const MAX_TM1_SCRIPT_BYTES = 223

/**
 * Protocol overhead in bytes for TM1 Draft 0.2:
 * - 1 byte OP_RETURN (0x6a)
 * - 5 bytes LOKAD ID push (0x04 + 'TMM\0' [0x54, 0x4d, 0x4d, 0x00])
 * - 2 bytes Envelope push (0x4c OP_PUSHDATA1 + length byte)
 * - 3 bytes Envelope header (version [1] + eventType [1] + authorInputIndex [1])
 * Total = 11 bytes overhead.
 */
export const TM1_PROTOCOL_OVERHEAD_BYTES = 11

/**
 * Theoretical maximum event data bytes allowable by protocol: 223 - 11 = 212 bytes.
 */
export const TM1_PROTOCOL_MAX_EVENT_DATA_BYTES = 212

/**
 * Default Tonalli Wallet policy ceiling for user-entered memo text.
 * Derived from the TM1 Draft 0.2 protocol eventData capacity so the Composer
 * can use the full wire budget. NFT attachments reduce the *effective*
 * user-text budget at runtime via `tm1EffectiveUserMessageMaxBytes`.
 */
export const TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES = TM1_PROTOCOL_MAX_EVENT_DATA_BYTES

/**
 * Alias of `TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES`.
 * Historical name from when the wallet policy was a conservative 80 B subset.
 */
export const TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES = TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES

/**
 * NFT attachment directive constants.
 * Format on-chain within eventData: @nft1:<64-char lowercase hex tokenId>\n<optional user text>
 * Total overhead of directive: "@nft1:" (6) + tokenId (64) + "\n" (1) = 71 bytes UTF-8.
 */
export const TM1_NFT_DIRECTIVE_PREFIX = '@nft1:'
export const TM1_NFT_DIRECTIVE_BYTES = 71

/**
 * Effective user-text budget for the Composer.
 * `policyMaxBytes` is the configurable wallet ceiling (`options.maxBytes`).
 * An attached NFT reserves `TM1_NFT_DIRECTIVE_BYTES` of the protocol wire budget.
 * The result never exceeds the protocol eventData capacity (212 B), or 141 B with an NFT.
 */
export function tm1EffectiveUserMessageMaxBytes(
  policyMaxBytes: number,
  hasAttachedNft: boolean
): number {
  const attachmentOverhead = hasAttachedNft ? TM1_NFT_DIRECTIVE_BYTES : 0
  return Math.min(
    policyMaxBytes,
    TM1_PROTOCOL_MAX_EVENT_DATA_BYTES - attachmentOverhead
  )
}

export function buildTm1WirePayload(userMessage: string, attachedTokenId?: string | null): string {
  if (!attachedTokenId) return userMessage
  return `${TM1_NFT_DIRECTIVE_PREFIX}${attachedTokenId.toLowerCase()}\n${userMessage}`
}

export interface Tm1AttachedNft {
  tokenId: string
  name?: string
  imageUrl?: string
  collectionName?: string
}

/**
 * State machine phases for the Tonalli Memo publication flow.
 */
export type Tm1PublishPhase =
  | 'idle'
  | 'reconciling'
  | 'verifying_ownership'
  | 'requesting_authorization'
  | 'broadcasting'
  | 'success'
  | 'error'

/**
 * Identity verification status of the active .xec alias.
 */
export type Tm1VerificationStatus =
  | 'unverified'
  | 'verifying'
  | 'verified'
  | 'failed'

/**
 * Abstract executor interface decoupling UI from backend domain orchestration.
 */
export interface Tm1PublisherExecutor {
  verifyOwnership(
    alias: string,
    ownerAddress: string,
    signal?: AbortSignal
  ): Promise<object>

  requestAuthorization(
    evidenceToken: object,
    signal?: AbortSignal
  ): Promise<object>

  prepareAndSign(
    auth: object,
    message: string,
    signal?: AbortSignal
  ): Promise<{
    preparedReview: object
    signedReview: object
  }>

  broadcastAndFinalize(
    preparedReview: object,
    signedReview: object,
    signal?: AbortSignal
  ): Promise<{
    txid: string
    submissionId?: string
  }>
}

/**
 * Current state of the publish machine hook.
 */
export interface Tm1PublishState {
  readonly phase: Tm1PublishPhase
  readonly message: string
  readonly attachedNft: Tm1AttachedNft | null
  readonly wirePayload: string
  readonly userMessageByteLength: number
  readonly wirePayloadByteLength: number
  readonly alias: string
  readonly ownerAddress: string
  readonly verificationStatus: Tm1VerificationStatus
  readonly verificationError: string | null
  readonly txid: string | null
  readonly error: string | null
  readonly preview: Tm1Draft02PostPreview | null
  readonly previewData?: Tm1Draft02PostPreview | null
  readonly previewError?: string | null
  readonly byteLength: number
  readonly maxBytes: number
  readonly effectiveUserMessageMaxBytes: number
  readonly isUserMessageOverLimit: boolean
  readonly isWirePayloadOverLimit: boolean
  readonly isOverLimit: boolean
  readonly isValid: boolean
  readonly pendingRecord?: unknown | null
}
