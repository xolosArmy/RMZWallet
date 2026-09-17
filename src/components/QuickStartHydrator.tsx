import { useEffect, useRef } from 'react'
import { useWallet } from '../context/useWallet'

export default function QuickStartHydrator() {
  const { initialized, backupVerified, activateQuickStartFromDevice } = useWallet()
  const attempted = useRef(false)

  useEffect(() => {
    if (initialized || backupVerified || attempted.current) return
    attempted.current = true
    let cancelled = false

    void (async () => {
      try {
        const restored = await activateQuickStartFromDevice()
        if (cancelled || !restored) return
      } catch {
        // Fail closed: the user can still unlock or recreate. Never log secrets.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activateQuickStartFromDevice, backupVerified, initialized])

  return null
}
