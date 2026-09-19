import type {
  TmCommClientMessageId,
  TmCommConversation,
  TmCommConversationId,
  TmCommMessage,
  TmCommMessageId,
  TmCommMessageReceipt,
  TmCommPrincipal,
  TmCommReceiptState,
  TmCommReservationBinding,
  TmCommReservationId
} from './types'

export const TM_COMM_MAX_MESSAGE_BODY_CHARS = 4_000

export type TmCommPublicPrincipal = Readonly<{
  id: TmCommPrincipal['id']
  kind: TmCommPrincipal['kind']
  walletAddress: TmCommPrincipal['walletAddress']
}>

export type TmCommSessionProof = Readonly<{
  challengeId: string
  address: string
  publicKeyHex: string
  signature: string
}>

export type TmCommCreateChallengeRequest = Readonly<{
  origin?: string
}>

export type TmCommCreateSessionRequest = TmCommSessionProof

export type TmCommCreateBindingRequest = Readonly<{
  enrollmentToken: string
  reservationId?: TmCommReservationId
}>

export type TmCommSendMessageRequest = Readonly<{
  clientMessageId: TmCommClientMessageId
  body: string
  replyToId?: TmCommMessageId | null
  senderPrincipalId?: string
  conversationId?: TmCommConversationId
  reservationId?: TmCommReservationId
  customerId?: string
  walletAddress?: string
}>

export type TmCommUpsertReceiptRequest = Readonly<{
  state: TmCommReceiptState
}>

export type TmCommMeResponse = Readonly<{
  principal: TmCommPublicPrincipal
  bindings: readonly TmCommReservationBinding[]
}>

export type TmCommConversationResponse = TmCommConversation

export type TmCommMessageListResponse = Readonly<{
  conversationId: TmCommConversationId
  messages: readonly TmCommMessage[]
}>

export type TmCommReceiptListResponse = Readonly<{
  messageId: TmCommMessageId
  receipts: readonly TmCommMessageReceipt[]
}>

export type TmCommErrorBody = Readonly<{
  error: Readonly<{
    code: string
    reasonCode: string
    message: string
  }>
}>

export const TM_COMM_BROWSER_AUTHORITY_FIELDS = Object.freeze([
  'customerId',
  'reservationId',
  'conversationId',
  'walletAddress',
  'senderPrincipalId'
] as const)
