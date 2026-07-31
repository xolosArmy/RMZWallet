export type ExternalSignBrowserCapabilities = Readonly<{
  webCrypto: boolean
  indexedDb: boolean
  webLocks: boolean
  broadcastChannel: boolean
  supported: boolean
  missing: readonly string[]
}>

type BrowserEnvironment = Readonly<{
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'>
  indexedDB?: IDBFactory
  locks?: LockManager
  BroadcastChannel?: typeof globalThis.BroadcastChannel
}>

export function detectExternalSignBrowserCapabilities(environment: BrowserEnvironment): ExternalSignBrowserCapabilities {
  const webCrypto = Boolean(environment.crypto?.subtle && environment.crypto?.getRandomValues)
  const indexedDb = Boolean(environment.indexedDB)
  const webLocks = Boolean(environment.locks?.request)
  const broadcastChannel = Boolean(environment.BroadcastChannel)
  const missing = [
    !webCrypto ? 'Web Crypto' : null,
    !indexedDb ? 'IndexedDB' : null,
    !webLocks ? 'Web Locks' : null,
    !broadcastChannel ? 'BroadcastChannel' : null
  ].filter((value): value is string => value !== null)

  return Object.freeze({
    webCrypto,
    indexedDb,
    webLocks,
    broadcastChannel,
    supported: missing.length === 0,
    missing: Object.freeze(missing)
  })
}

export function getCurrentBrowserCapabilities(): ExternalSignBrowserCapabilities {
  return detectExternalSignBrowserCapabilities({
    crypto: globalThis.crypto,
    indexedDB: globalThis.indexedDB,
    locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
    BroadcastChannel: globalThis.BroadcastChannel
  })
}
