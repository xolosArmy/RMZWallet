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

  // Reconcile recovery records before allowing publication.
  // If an unfinalized record (such as outcomeUnknown) is present in the durable store,
  // enter 'reconciling' phase to block the editor and prevent duplicate publishes.
  useEffect(() => {
    let active = true
    async function checkRecovery() {
      if (!recoveryStore || typeof recoveryStore.listRecoverable !== 'function') {
        return
      }
      try {
        const recoverable = await recoveryStore.listRecoverable({ address: ownerAddress })
        if (!active) return
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
        } else {
          setPendingRecord(null)
          setPhase((prev) => (prev === 'reconciling' ? 'idle' : prev))
        }
      } catch {
        // Safe fail-closed or silent
      }
    }
    checkRecovery()
    return () => {
      active = false
    }
  }, [ownerAddress, recoveryStore])

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
      const errMsg = err instanceof Error ? err.message : String(err)
      setVerificationStatus('failed')
      setVerificationError(errMsg)
      return false
    }
  }, [alias, ownerAddress])

  /**
   * Attempt to reconcile a pending recovery record against Chronik.
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
          setPendingRecord(null)
          setPhase('idle')
        }
      }
    } catch {
      // Transaction not observed or chronik query failed
    }
  }, [pendingRecord, recoveryStore])

  /**
   * Dismiss or abandon an expired unresolvable pending publication.
   */
  const dismissPending = useCallback(async () => {
    if (!pendingRecord || !recoveryStore) return
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
              stage: 'outcomeUnknown',
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
      setPhase('error')
      setError(errObj.message)
      options.onError?.(errObj)
    }
  }, [isValid, phase, alias, ownerAddress, message, options])

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
