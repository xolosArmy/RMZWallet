import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  encodeTm1Draft02Post,
  Tm1Draft02EncodingError
} from '../../integrations/tonalliMemo/tm1Draft02'
import type { Tm1PublicationRecoveryStore } from '../../integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import { getChronik } from '../../services/ChronikClient'
import {
  TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES,
  type Tm1PublisherExecutor,
  type Tm1PublishPhase,
  type Tm1PublishState,
  type Tm1VerificationStatus
} from './types'

export interface UseTm1PublishMachineOptions {
  initialMessage?: string
  initialAlias?: string
  initialOwnerAddress?: string
  maxBytes?: number
  executor: Tm1PublisherExecutor
  recoveryStore?: Tm1PublicationRecoveryStore
  onSuccess?: (txid: string) => void
  onError?: (error: Error) => void
}

export function useTm1PublishMachine(options: UseTm1PublishMachineOptions) {
  if (!options?.executor) {
    throw new Error('EXECUTOR_REQUIRED: useTm1PublishMachine requires an explicit Tm1PublisherExecutor')
  }

  const maxBytes = options.maxBytes ?? TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES
  const [message, setMessage] = useState(options.initialMessage ?? '')
  const [alias, setAlias] = useState(options.initialAlias ?? '')
  const [ownerAddress, setOwnerAddress] = useState(options.initialOwnerAddress ?? '')
  const [phase, setPhase] = useState<Tm1PublishPhase>('idle')
  const [pendingRecord, setPendingRecord] = useState<any | null>(null)
  const [verificationStatus, setVerificationStatus] =
    useState<Tm1VerificationStatus>('unverified')
  const [verificationError, setVerificationError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const activeExecutorRef = useRef<Tm1PublisherExecutor>(options.executor)
  const recoveryStore =
    options.recoveryStore ?? (options.executor as any)?.recoveryStore

  // Update active executor if option changes
  useEffect(() => {
    if (options.executor) {
      activeExecutorRef.current = options.executor
    }
  }, [options.executor])

  const checkRecovery = useCallback(async (): Promise<boolean> => {
    if (!recoveryStore || typeof recoveryStore.listRecoverable !== 'function') {
      return false
    }
    try {
      const recoverable = await recoveryStore.listRecoverable({ address: ownerAddress })
      const list = Array.isArray(recoverable) ? recoverable : []
      const pending = list.find(
        (rec: any) =>
          rec &&
          (rec.phase === 'outcomeUnknown' ||
            (rec.phase === 'preDispatch' && rec.dispatchIntent))
      )
      if (pending) {
        setPendingRecord(pending)
        setPhase('reconciling')
        return true
      } else {
        setPendingRecord(null)
        setPhase((prev) => (prev === 'reconciling' ? 'idle' : prev))
        return false
      }
    } catch {
      return false
    }
  }, [ownerAddress, recoveryStore])

  // Reconcile recovery records before allowing publication.
  // If an unfinalized record (such as outcomeUnknown) is present in the durable store,
  // enter 'reconciling' phase to block the editor and prevent duplicate publishes.
  useEffect(() => {
    let active = true
    void (async () => {
      if (active) {
        await checkRecovery()
      }
    })()
    return () => {
      active = false
    }
  }, [checkRecovery])

  // Real-time byte length calculation via TextEncoder (handles UTF-8 multi-byte characters)
  const byteLength = useMemo(() => {
    return new TextEncoder().encode(message).length
  }, [message])

  const isOverLimit = byteLength > maxBytes

  // Canonical payload preview calculation in real time using the canonical encoder as sole authority
  const { preview, previewError } = useMemo<{
    preview: ReturnType<typeof encodeTm1Draft02Post> | null
    previewError: string | undefined
  }>(() => {
    if (!message || message.length === 0) {
      return { preview: null, previewError: undefined }
    }
    try {
      const encoded = encodeTm1Draft02Post({
        eventData: message,
        authorInputIndex: 0
      })
      return { preview: encoded, previewError: undefined }
    } catch (err) {
      const msg =
        err instanceof Tm1Draft02EncodingError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Error al codificar el mensaje canónico TM1.'
      return {
        preview: null,
        previewError: msg
      }
    }
  }, [message])

  // Finding 3: The memo is valid ONLY if canonical preview succeeded, it honors component byte limits, and not reconciling:
  const isValid =
    preview !== null &&
    previewError === undefined &&
    !isOverLimit &&
    phase !== 'reconciling'

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  /**
   * Standalone ownership verification (Step 1 & Step 2).
   */
  const verifyOwnership = useCallback(async (): Promise<boolean> => {
    setVerificationStatus('verifying')
    setVerificationError(null)

    try {
      const controller = new AbortController()
      await activeExecutorRef.current.verifyOwnership(
        alias,
        ownerAddress,
        controller.signal
      )
      setVerificationStatus('verified')
      return true
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Error al verificar la propiedad del alias.'
      setVerificationStatus('failed')
      setVerificationError(errMsg)
      return false
    }
  }, [alias, ownerAddress])

  /**
   * Attempt to reconcile a pending recovery record against Chronik.
   * Finding 2: Absence of evidence is not evidence of absence. A 404 from Chronik
   * MUST NOT delete or remove an outcomeUnknown record.
   */
  const reconcilePending = useCallback(async () => {
    if (!pendingRecord || !recoveryStore) return
    const txid = pendingRecord.dispatchIntent?.txid
    if (!txid) return

    try {
      const chronik =
        (activeExecutorRef.current as any)?.signer?.chronik ??
        (activeExecutorRef.current as any)?.transport?.chronik ??
        (typeof getChronik === 'function' ? getChronik() : undefined)

      if (chronik && typeof chronik.tx === 'function') {
        const tx = await chronik.tx(txid)
        if (tx && tx.txid) {
          if (typeof recoveryStore.commitTransportAcknowledgement === 'function') {
            await recoveryStore.commitTransportAcknowledgement({
              publicationId: pendingRecord.publicationId,
              expectedRevision: pendingRecord.revision,
              expectedOwnerEpoch: pendingRecord.ownerEpoch,
              acknowledgement: {
                submissionId: pendingRecord.dispatchIntent.submissionId,
                signedId:
                  (pendingRecord.signed as any)?.signedId ??
                  pendingRecord.dispatchIntent.submissionId,
                txid: tx.txid,
                signedArtifactHash: pendingRecord.dispatchIntent.signedArtifactHash,
                disposition: 'accepted',
                acknowledgedAt: Date.now()
              } as any
            })
          }
          // Finding 2 (Recheck all pending records - P1):
          // After acknowledging one pending record, do not blindly transition to idle.
          // Re-query the recovery store to check if any other pending records exist (e.g. from concurrent tabs).
          const stillHasPending = await checkRecovery()
          if (!stillHasPending) {
            setPendingRecord(null)
            setPhase('idle')
          }
        }
      }
    } catch {
      // Finding 2 (Keep absent outcome-unknown fenced):
      // Chronik query failed, returned 404, or tx is not yet confirmed.
      // Absence of evidence is not evidence of absence. The record MUST remain fenced.
    }
  }, [pendingRecord, recoveryStore, checkRecovery])

  /**
   * Dismiss or abandon an expired unresolvable pending publication.
   * Arbitrary dismissal of outcomeUnknown records without network proof is strictly forbidden.
   */
  const dismissPending = useCallback(async () => {
    if (!pendingRecord || !recoveryStore) return
    if (pendingRecord.phase === 'outcomeUnknown') {
      throw new Error(
        'CANNOT_DISCARD_OUTCOME_UNKNOWN: outcomeUnknown records cannot be dismissed arbitrarily without proof'
      )
    }
    if (typeof (recoveryStore as any).remove === 'function') {
      await (recoveryStore as any).remove(pendingRecord.publicationId)
    } else if (typeof recoveryStore.commitRecoveryTransition === 'function') {
      try {
        await recoveryStore.commitRecoveryTransition({
          publicationId: pendingRecord.publicationId,
          expectedRevision: pendingRecord.revision,
          expectedOwnerEpoch: pendingRecord.ownerEpoch,
          nextRecord: {
            ...pendingRecord,
            revision: pendingRecord.revision + 1,
            phase: 'abandoned',
            terminal: {
              status: 'abandoned',
              stage: 'preDispatch',
              code: 'DISMISSED_BY_USER',
              recordedAt: Date.now()
            }
          }
        })
      } catch {
        // fallback
      }
    }
    setPendingRecord(null)
    setPhase('idle')
  }, [pendingRecord, recoveryStore])

  /**
   * Execute the publication flow across the state machine:
   * Idle -> Verifying Ownership -> Requesting Authorization -> Broadcasting -> Success / Error.
   */
  const publish = useCallback(async () => {
    if (
      !isValid ||
      phase === 'verifying_ownership' ||
      phase === 'requesting_authorization' ||
      phase === 'broadcasting'
    ) {
      return
    }

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const signal = controller.signal

    setError(null)
    setTxid(null)

    try {
      // 1. Verifying Ownership
      setPhase('verifying_ownership')
      setVerificationStatus('verifying')
      setVerificationError(null)

      const evidenceToken = await activeExecutorRef.current.verifyOwnership(
        alias,
        ownerAddress,
        signal
      )
      setVerificationStatus('verified')

      // 2. Requesting Authorization
      setPhase('requesting_authorization')
      const auth = await activeExecutorRef.current.requestAuthorization(
        evidenceToken,
        signal
      )
      const { preparedReview, signedReview } =
        await activeExecutorRef.current.prepareAndSign(auth, message, signal)

      // 3. Broadcasting
      setPhase('broadcasting')
      const result = await activeExecutorRef.current.broadcastAndFinalize(
        preparedReview,
        signedReview,
        signal
      )
      if (!result || !result.txid) {
        throw new Error('NO_TXID_RETURNED: La difusión no devolvió un identificador de transacción válido.')
      }

      // 4. Success
      setPhase('success')
      setTxid(result.txid)
      try {
        options.onSuccess?.(result.txid)
      } catch (uiError) {
        console.error('Error executing onSuccess callback:', uiError)
      }
    } catch (err) {
      if (signal.aborted) {
        setPhase('idle')
        return
      }
      const errObj = err instanceof Error ? err : new Error(String(err))

      // Finding 1 (Fence retries after dispatch - P1):
      // If an error occurs after commitDispatchIntent has succeeded,
      // a pending record (such as outcomeUnknown) exists in durable storage.
      // Do not transition to plain 'error'. Invoke checkRecovery to transition
      // to 'reconciling' with the freshly persisted record, blocking the retry button.
      if (recoveryStore && typeof recoveryStore.listRecoverable === 'function') {
        try {
          const hasPending = await checkRecovery()
          if (hasPending) {
            setError(errObj.message)
            options.onError?.(errObj)
            return
          }
        } catch {
          // fallback to error phase
        }
      }

      setPhase('error')
      setError(errObj.message)
      options.onError?.(errObj)
    }
  }, [isValid, phase, alias, ownerAddress, message, options, checkRecovery, recoveryStore])

  /**
   * Reset machine back to idle state.
   */
  const reset = useCallback(() => {
    abortControllerRef.current?.abort()
    setPhase('idle')
    setTxid(null)
    setError(null)
  }, [])

  const state: Tm1PublishState = {
    phase,
    message,
    alias,
    ownerAddress,
    verificationStatus,
    verificationError,
    txid,
    error,
    preview,
    previewData: preview,
    previewError: previewError ?? null,
    byteLength,
    maxBytes,
    isOverLimit,
    isValid,
    pendingRecord
  }

  return {
    state,
    setMessage,
    setAlias,
    setOwnerAddress,
    verifyOwnership,
    reconcilePending,
    dismissPending,
    publish,
    reset,
    abort: () => abortControllerRef.current?.abort()
  }
}
