/**
 * Public TM-COMM private messaging barrel.
 *
 * Closed domain only. No wallet keys, settlement, broadcast, or Memo
 * publication leak through this module.
 */

export {
  TM_COMM_PROTOCOL_ID,
  TM_COMM_PROTOCOL_VERSION,
  TM_COMM_PRINCIPAL_KINDS,
  TM_COMM_SENDER_KINDS,
  TM_COMM_MESSAGE_STATUSES,
  TM_COMM_RECEIPT_STATES,
  TM_COMM_AUDIT_OUTCOMES
} from './types'
export type {
  TmCommPrincipalKind,
  TmCommSenderKind,
  TmCommMessageStatus,
  TmCommReceiptState,
  TmCommAuditOutcome,
  TmCommPrincipal,
  TmCommReservationBinding,
  TmCommConversation,
  TmCommMessage,
  TmCommMessageReceipt,
  TmCommAuditEvent,
  TmCommEnrollmentInvitation
} from './types'

export {
  TM_COMM_ERROR_CODES,
  TmCommError,
  tmCommForbidden,
  tmCommInvalidInput,
  tmCommUnauthenticated
} from './errors'
export type { TmCommErrorCode } from './errors'

export {
  TM_COMM_AUTH_PROTOCOL,
  TM_COMM_AUTH_PURPOSE,
  TM_COMM_AUTH_CHAIN,
  buildTmCommAuthChallengeMessage,
  createTmCommAuthChallengeView,
  isMiningGatewayConnectFlow
} from './authChallenge'
export type {
  TmCommAuthChallengeInput,
  TmCommAuthChallengeView
} from './authChallenge'

export {
  TM_COMM_MAX_MESSAGE_BODY_CHARS,
  TM_COMM_BROWSER_AUTHORITY_FIELDS
} from './contracts'
export type {
  TmCommPublicPrincipal,
  TmCommSessionProof,
  TmCommCreateChallengeRequest,
  TmCommCreateSessionRequest,
  TmCommCreateBindingRequest,
  TmCommSendMessageRequest,
  TmCommUpsertReceiptRequest,
  TmCommMeResponse,
  TmCommConversationResponse,
  TmCommMessageListResponse,
  TmCommReceiptListResponse,
  TmCommErrorBody
} from './contracts'

export {
  TM_COMM_AGENT_TOOL_CLASSES,
  TM_COMM_AGENT_READ_TOOLS,
  TM_COMM_AGENT_COMMUNICATION_TOOLS,
  TM_COMM_AGENT_PRIVILEGED_TOOLS,
  TM_COMM_AGENT_TOOL_REGISTRY,
  isTmCommAgentSendEnabled,
  agentAuthenticationGrantsWalletCapability
} from './aiAgentBoundary'
export type { TmCommAgentToolClass, TmCommAgentTool } from './aiAgentBoundary'

export {
  TM_COMM_MEMO_MILESTONE,
  TM_COMM_MEMO_PUBLICATION_PIPELINE,
  TM_COMM_AUTOMATIC_MEMO_PUBLICATION,
  assertPrivateConversationNotAutoPublished,
  isTmCommMemoInCurrentMilestone
} from './memoPublicationBoundary'
export type { TmCommMemoPublicationStage } from './memoPublicationBoundary'

export {
  TM_COMM_EMAIL_FALLBACK_MILESTONE,
  TM_COMM_EMAIL_FALLBACK_TRIGGERS,
  TM_COMM_EMAIL_ALLOWED_FIELDS,
  TM_COMM_EMAIL_FORBIDDEN_FIELDS,
  TM_COMM_EMAIL_DISPATCH_STATES,
  TM_COMM_EMAIL_FALLBACK_IMPLEMENTED,
  tmCommEmailDispatchDedupeKey
} from './emailFallbackContract'
export type {
  TmCommEmailFallbackTrigger,
  TmCommEmailDispatchState,
  TmCommEmailDispatchKey
} from './emailFallbackContract'
