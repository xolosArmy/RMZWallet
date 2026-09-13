import { H3WC_OWNER_LOCK_NAME } from './contracts'

export class H3wcOwnershipError extends Error {
  readonly code = 'H3WC_OWNERSHIP_UNAVAILABLE'

  constructor(message = 'H3WC Web Locks ownership is unavailable') {
    super(message)
    this.name = 'H3wcOwnershipError'
  }
}

export type H3wcOwnerLease = Readonly<{
  ownerEpoch: string
  lockName: typeof H3WC_OWNER_LOCK_NAME
}>

export type H3wcOwnerRuntime = H3wcOwnerLease & Readonly<{
  withRequestLock<T>(requestKey: string, action: () => Promise<T> | T): Promise<T>
}>

type LockManagerLike = Pick<LockManager, 'request'>
type NavigatorLike = Pick<Navigator, 'locks'>

const getNavigator = (): NavigatorLike | null => (
  typeof navigator === 'undefined' ? null : navigator
)

const getLocks = (navigatorLike: NavigatorLike | null): LockManagerLike => {
  if (!navigatorLike?.locks || typeof navigatorLike.locks.request !== 'function') {
    throw new H3wcOwnershipError()
  }
  return navigatorLike.locks
}

export function isH3wcWebLocksAvailable(navigatorLike: NavigatorLike | null = getNavigator()): boolean {
  return Boolean(navigatorLike?.locks && typeof navigatorLike.locks.request === 'function')
}

export function createH3wcOwnerEpoch(cryptoLike: Crypto = globalThis.crypto): string {
  if (typeof cryptoLike.randomUUID !== 'function') {
    throw new H3wcOwnershipError('H3WC owner epoch generator is unavailable')
  }
  return cryptoLike.randomUUID()
}

export async function runAsH3wcOwner<T>(
  action: (owner: H3wcOwnerRuntime) => Promise<T> | T,
  options: Readonly<{
    ifAvailable?: boolean
    navigatorLike?: NavigatorLike | null
    cryptoLike?: Crypto
  }> = {}
): Promise<T | null> {
  const locks = getLocks(options.navigatorLike === undefined ? getNavigator() : options.navigatorLike)
  return locks.request(
    H3WC_OWNER_LOCK_NAME,
    { mode: 'exclusive', ifAvailable: options.ifAvailable ?? false },
    async (lock) => {
      if (!lock) return null
      const ownerEpoch = createH3wcOwnerEpoch(options.cryptoLike)
      const owner: H3wcOwnerRuntime = {
        ownerEpoch,
        lockName: H3WC_OWNER_LOCK_NAME,
        withRequestLock: async <R>(requestKey: string, requestAction: () => Promise<R> | R) => {
          if (!requestKey || typeof requestKey !== 'string') {
            throw new H3wcOwnershipError('H3WC request lock key is invalid')
          }
          const requestLockName = `tonalli:wc:request:${requestKey}`
          return locks.request(requestLockName, { mode: 'exclusive' }, async (requestLock) => {
            if (!requestLock) throw new H3wcOwnershipError('H3WC request lock was not acquired')
            return requestAction()
          })
        }
      }
      return action(owner)
    }
  )
}

export async function deriveH3wcRequestKey(
  topic: string,
  requestId: number,
  cryptoLike: Crypto = globalThis.crypto
): Promise<string> {
  if (!topic || !Number.isSafeInteger(requestId) || requestId < 0) {
    throw new H3wcOwnershipError('H3WC request identity is invalid')
  }
  if (!cryptoLike.subtle) throw new H3wcOwnershipError('H3WC digest primitive is unavailable')
  const canonical = `${topic}\u0000${requestId}`
  const digest = await cryptoLike.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function waitForH3wcAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
