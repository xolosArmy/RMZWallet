import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  encodeTm1Draft02Post,
  Tm1Draft02EncodingError
} from '../../integrations/tonalliMemo/tm1Draft02'
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
  const [verificationStatus, setVerificationStatus] =
    useState<Tm1VerificationStatus>('unverified')
  const [verificationError, setVerificationError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const activeExecutorRef = useRef<Tm1PublisherExecutor>(options.executor)

  // Update active executor if option changes
  useEffect(() => {
    if (options.executor) {
      activeExecutorRef.current = options.executor
    }
  }, [options.executor])

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

  // Finding 3: The memo is valid ONLY if canonical preview succeeded AND it honors component byte limits:
  const isValid = preview !== null && previewError === undefined && !isOverLimit

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
   * Execute the publication flow across the state machine:
   * Idle -> Verifying Ownership -> Requesting Authorization -> Broadcasting -> Success / Error.
   */
  const publish = useCallback(async () => {
    if (!isValid || phase === 'verifying_ownership' || phase === 'requesting_authorization' || phase === 'broadcasting') {
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
    isValid
  }

  return {
    state,
    setMessage,
    setAlias,
    setOwnerAddress,
    verifyOwnership,
    publish,
    reset,
    abort: () => abortControllerRef.current?.abort()
  }
}
