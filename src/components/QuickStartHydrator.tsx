import { useEffect, useRef } from 'react'
import { useWallet } from '../context/useWallet'
import { loadQuickStartMnemonic } from '../services/quickStartStorage'

export default function QuickStartHydrator() {
  const { initialized, backupVerified, restoreWallet } = useWallet()
  const attempted = useRef(false)

  useEffect(() => {
    if (initialized || backupVerified || attempted.current) return
    attempted.current = true
    let cancelled = false

    void (async () => {
      try {
        const mnemonic = await loadQuickStartMnemonic()
        if (!mnemonic || cancelled) return
        const result = await restoreWallet(mnemonic)
        if (result.status === 'choice-required') {
          console.warn('[QuickStart] unexpected derivation choice required during local recovery')
        }
      } catch (error) {
        console.warn('[QuickStart] secure local recovery unavailable', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [backupVerified, initialized, restoreWallet])

  return null
}
