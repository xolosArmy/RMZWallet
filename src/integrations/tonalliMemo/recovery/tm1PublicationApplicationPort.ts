import type {
  Tm1PublicationRecoveryRecord
} from './tm1PublicationRecoveryModel'

export type Tm1RecoveryCommandVersion = Readonly<{
  publicationId: string
  expectedRevision: number
  expectedOwnerEpoch: number
  signal?: AbortSignal
}>

/**
 * Future UI-facing conservative recovery boundary.
 *
 * It exposes no signing, authorization-capability or transmission operation.
 * Starting and progressing a live publication remains an explicitly deferred
 * application boundary; interrupted pre-dispatch work is abandoned here.
 */
export interface Tm1PublicationApplicationPort {
  getPublication(publicationId: string): Promise<Tm1PublicationRecoveryRecord>
  listRecoverablePublications(): Promise<readonly Tm1PublicationRecoveryRecord[]>
  abandonInterruptedPublication(
    command: Tm1RecoveryCommandVersion
  ): Promise<Tm1PublicationRecoveryRecord>
  reconcile(
    command: Tm1RecoveryCommandVersion
  ): Promise<Tm1PublicationRecoveryRecord>
  observeConfirmation(
    command: Tm1RecoveryCommandVersion
  ): Promise<Tm1PublicationRecoveryRecord>
}
