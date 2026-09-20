/**
 * Email fallback contract (A0). Implementation belongs to M1.
 *
 * Email is a notification channel, never the canonical message log.
 * Dedup is enforced by a unique dispatch key so a private message is
 * not emailed twice for the same recipient and channel.
 */

export const TM_COMM_EMAIL_FALLBACK_MILESTONE = 'M1' as const

export const TM_COMM_EMAIL_FALLBACK_TRIGGERS = Object.freeze([
  'no-live-session',
  'unread-after-ttl',
  'operator-initiated-notice'
] as const)

export type TmCommEmailFallbackTrigger =
  (typeof TM_COMM_EMAIL_FALLBACK_TRIGGERS)[number]

export const TM_COMM_EMAIL_ALLOWED_FIELDS = Object.freeze([
  'notificationThatAPrivateMessageExists',
  'opaqueConversationReference',
  'tonalliOpenLink',
  'enrollmentReminderToPreviouslyVerifiedEmail'
] as const)

export const TM_COMM_EMAIL_FORBIDDEN_FIELDS = Object.freeze([
  'fullMessageBody',
  'otherCustomersData',
  'sessionToken',
  'walletPrivateMaterial',
  'enrollmentTokenInClearAfterConsumption'
] as const)

export const TM_COMM_EMAIL_DISPATCH_STATES = Object.freeze([
  'pending',
  'sent',
  'failed',
  'suppressed'
] as const)

export type TmCommEmailDispatchState =
  (typeof TM_COMM_EMAIL_DISPATCH_STATES)[number]

export type TmCommEmailDispatchKey = Readonly<{
  messageId: string
  principalId: string
  channel: 'email-fallback'
}>

export function tmCommEmailDispatchDedupeKey(
  key: TmCommEmailDispatchKey
): string {
  return `${key.messageId}:${key.principalId}:${key.channel}`
}

export const TM_COMM_EMAIL_FALLBACK_IMPLEMENTED = false
