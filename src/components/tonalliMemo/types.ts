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
 * Standard Tonalli Wallet Draft 0.2 client limit for ordinary memo posts.
 */
export const TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES = 80

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
  readonly isOverLimit: boolean
  readonly isValid: boolean
  readonly pendingRecord?: unknown | null
}
