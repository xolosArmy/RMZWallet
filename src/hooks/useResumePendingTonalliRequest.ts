import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EXTERNAL_SIGN_REQUEST_STORAGE_KEY, EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY } from '../utils/externalSign'
import { resolvePendingConnectTarget, TONALLI_PENDING_REQUEST_KEY } from '../utils/tonalliConnect'

type PendingResumeStorage = Pick<Storage, 'getItem' | 'removeItem'>

type PendingResumeInput = {
  backupVerified: boolean
  initialized: boolean
  localStorageRef: PendingResumeStorage
  requestedReturnTo?: string | null
  sessionStorageRef: PendingResumeStorage
}

export type PendingResumeResult =
  | { target: string; type: 'external-sign' | 'tonalli-connect' }
  | null

export function resolvePendingTonalliResume({
  backupVerified,
  initialized,
  localStorageRef,
  requestedReturnTo,
  sessionStorageRef
}: PendingResumeInput): PendingResumeResult {
  if (!initialized || !backupVerified) return null

  const pendingExternalSign = sessionStorageRef.getItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
  if (pendingExternalSign) {
    const storedReturnTo = sessionStorageRef.getItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY) ?? ''
    const cleanRequestedReturnTo = (requestedReturnTo ?? '').trim()
    const target = storedReturnTo || cleanRequestedReturnTo || '/external-sign'
    sessionStorageRef.removeItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY)
    return { target, type: 'external-sign' }
  }

  const pendingConnect = localStorageRef.getItem(TONALLI_PENDING_REQUEST_KEY)
  if (!pendingConnect) return null

  localStorageRef.removeItem(TONALLI_PENDING_REQUEST_KEY)
  return { target: resolvePendingConnectTarget(pendingConnect), type: 'tonalli-connect' }
}

export function useResumePendingTonalliRequest({
  backupVerified,
  initialized
}: {
  backupVerified: boolean
  initialized: boolean
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const resumeHandledRef = useRef(false)

  useEffect(() => {
    if (resumeHandledRef.current) return

    const pendingResume = resolvePendingTonalliResume({
      backupVerified,
      initialized,
      localStorageRef: localStorage,
      requestedReturnTo: searchParams.get('returnTo'),
      sessionStorageRef: sessionStorage
    })

    if (!pendingResume) return

    resumeHandledRef.current = true
    navigate(pendingResume.target, { replace: true })
  }, [backupVerified, initialized, navigate, searchParams])
}
