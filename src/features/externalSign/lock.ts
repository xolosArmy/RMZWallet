import { ExternalSignError } from './contract'

export const EXTERNAL_SIGN_LOCK_NAME = 'tonalli-external-sign-v1'

export type ExternalSignLockLease = Readonly<{
  release: () => void
}>

export async function acquireExternalSignLock(locks: Pick<LockManager, 'request'>): Promise<ExternalSignLockLease> {
  let releaseHold: (() => void) | null = null
  let resolveAcquisition: ((lease: ExternalSignLockLease | null) => void) | null = null
  const acquisition = new Promise<ExternalSignLockLease | null>(resolve => {
    resolveAcquisition = resolve
  })
  const hold = new Promise<void>(resolve => {
    releaseHold = resolve
  })

  void locks.request(EXTERNAL_SIGN_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) {
      resolveAcquisition?.(null)
      return
    }
    let released = false
    resolveAcquisition?.(Object.freeze({
      release: () => {
        if (released) return
        released = true
        releaseHold?.()
      }
    }))
    await hold
  })

  const lease = await acquisition
  if (!lease) throw new ExternalSignError('EXTERNAL_SIGN_BUSY_OR_LOCK_UNAVAILABLE')
  return lease
}
