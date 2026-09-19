/**
 * Closed TM-COMM domain model (A0).
 *
 * This module is the canonical in-process shape of private messaging.
 * It contains no wallet keys, no settlement, no broadcast, and no Memo
 * publication. Authorization is always a server-side principal resolved
 * from a session, never a browser-supplied identifier.
 */

export const TM_COMM_PROTOCOL_ID = 'tm-comm' as const
export const TM_COMM_PROTOCOL_VERSION = 1 as const

export const TM_COMM_PRINCIPAL_KINDS = Object.freeze([
  'customer',
  'operator',
  'agent'
] as const)

export type TmCommPrincipalKind = (typeof TM_COMM_PRINCIPAL_KINDS)[number]

export const TM_COMM_SENDER_KINDS = Object.freeze([
  'customer',
  'operator',
  'agent',
  'system'
] as const)

export type TmCommSenderKind = (typeof TM_COMM_SENDER_KINDS)[number]

export const TM_COMM_MESSAGE_STATUSES = Object.freeze([
  'accepted',
  'delivered',
  'read'
] as const)

export type TmCommMessageStatus = (typeof TM_COMM_MESSAGE_STATUSES)[number]

export const TM_COMM_RECEIPT_STATES = Object.freeze([
  'delivered',
  'read'
] as const)

export type TmCommReceiptState = (typeof TM_COMM_RECEIPT_STATES)[number]

export const TM_COMM_AUDIT_OUTCOMES = Object.freeze(['allow', 'deny'] as const)

export type TmCommAuditOutcome = (typeof TM_COMM_AUDIT_OUTCOMES)[number]

export type TmCommPrincipalId = string
export type TmCommReservationId = string
export type TmCommConversationId = string
export type TmCommMessageId = string
export type TmCommClientMessageId = string
export type TmCommReceiptId = string
export type TmCommBindingId = string
export type TmCommAuditEventId = string
export type TmCommEnrollmentTokenId = string
export type TmCommChallengeId = string
export type TmCommSessionId = string

export type TmCommPrincipal = Readonly<{
  id: TmCommPrincipalId
  kind: TmCommPrincipalKind
  walletAddress: string
  publicKeyHex: string
  createdAt: number
}>

export type TmCommReservationBinding = Readonly<{
  id: TmCommBindingId
  principalId: TmCommPrincipalId
  reservationId: TmCommReservationId
  enrollmentTokenId: TmCommEnrollmentTokenId
  boundAt: number
  createdBy: 'xolos-ramirez-operator'
}>

export type TmCommConversation = Readonly<{
  id: TmCommConversationId
  reservationId: TmCommReservationId
  participantPrincipalIds: readonly TmCommPrincipalId[]
  createdAt: number
}>

export type TmCommMessage = Readonly<{
  id: TmCommMessageId
  clientMessageId: TmCommClientMessageId
  conversationId: TmCommConversationId
  senderPrincipalId: TmCommPrincipalId
  senderKind: TmCommSenderKind
  body: string
  serverCreatedAt: number
  replyToId: TmCommMessageId | null
  status: TmCommMessageStatus
}>

export type TmCommMessageReceipt = Readonly<{
  id: TmCommReceiptId
  messageId: TmCommMessageId
  principalId: TmCommPrincipalId
  state: TmCommReceiptState
  recordedAt: number
}>

export type TmCommAuditEvent = Readonly<{
  id: TmCommAuditEventId
  at: number
  actorPrincipalId: TmCommPrincipalId | null
  action: string
  resourceType: string
  resourceId: string | null
  outcome: TmCommAuditOutcome
  reasonCode: string
}>

export type TmCommEnrollmentInvitation = Readonly<{
  id: TmCommEnrollmentTokenId
  reservationId: TmCommReservationId
  expectedEmail: string | null
  issuedBy: 'xolos-ramirez-operator'
  expiresAt: number
  consumedAt: number | null
  consumedByPrincipalId: TmCommPrincipalId | null
}>
