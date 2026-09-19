/**
 * Tonalli Memo frontier contract (M3). Explicitly out of A0/M0/M1/M2.
 *
 * A private conversation is never published automatically.
 */

export const TM_COMM_MEMO_MILESTONE = 'M3' as const

export const TM_COMM_MEMO_PUBLICATION_PIPELINE = Object.freeze([
  'private-event',
  'candidate-evidence',
  'public-preview',
  'human-approval',
  'wallet-authorization-when-applicable',
  'tonalli-memo'
] as const)

export type TmCommMemoPublicationStage =
  (typeof TM_COMM_MEMO_PUBLICATION_PIPELINE)[number]

export const TM_COMM_AUTOMATIC_MEMO_PUBLICATION = false

export function assertPrivateConversationNotAutoPublished(): void {
  if (TM_COMM_AUTOMATIC_MEMO_PUBLICATION) {
    throw new Error('A private conversation must never be published automatically.')
  }
}

export function isTmCommMemoInCurrentMilestone(milestone: string): boolean {
  return milestone === TM_COMM_MEMO_MILESTONE
}
