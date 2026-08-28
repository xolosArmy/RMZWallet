import { H3WC_COORDINATION_CHANNEL } from './contracts'
import type { H3wcIdentityProvider } from './identity'
import { H3WC_PRODUCTION_REQUESTER_ORIGIN } from './config'
import { canonicalizeH3wcOrigin } from './peer'
import { readH3wcProjectId, readH3wcRequesterOrigin } from './config'
import { openH3wcJournal } from './journal'
import {
  isH3wcWebLocksAvailable,
  runAsH3wcOwner,
  waitForH3wcAbort,
  type H3wcOwnerRuntime
} from './ownership'
import {
  createH3wcWalletTransport,
  type H3wcProposalDecision,
  type H3wcWalletMetadata,
  type H3wcWalletTransport
} from './transport'

export type H3wcBootstrapResult = Readonly<{
  status: 'disabled' | 'follower' | 'owner' | 'failed'
  ownerEpoch?: string
  errorCode?: string
  stop(): void
}>

export type H3wcBootstrapOptions = Readonly<{
  enabled?: boolean
  projectId?: unknown
  mode?: string
  requesterOrigin?: unknown
  identityProvider?: H3wcIdentityProvider
  metadata?: H3wcWalletMetadata
  onProposal?: (decision: H3wcProposalDecision) => Promise<void> | void
  nowSeconds?: () => number
  navigatorLike?: Navigator | null
  cryptoLike?: Crypto
  indexedDb?: IDBFactory
  broadcastChannelFactory?: typeof BroadcastChannel
}>

const NOOP = () => undefined

function runtimeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'H3WC_INITIALIZATION_FAILED'
}

function publish(channel: BroadcastChannel, type: string, ownerEpoch: string): void {
  channel.postMessage({
    type,
    ownerEpoch,
    sentAt: Date.now()
  })
}

/**
 * Start H3WC only when explicitly enabled.  The dynamic import in main.tsx
 * keeps this entire module, and therefore WalletKit/Core, out of the runtime
 * path while the production flag is false.
 */
export async function initializeH3wc(options: H3wcBootstrapOptions = {}): Promise<H3wcBootstrapResult> {
  if (options.enabled !== true) {
    return { status: 'disabled', stop: NOOP }
  }

  const projectId = readH3wcProjectId(options.projectId)
  if (!projectId) return { status: 'failed', errorCode: 'H3WC_PROJECT_ID_REQUIRED', stop: NOOP }

  const requesterOriginValue = options.requesterOrigin ?? readH3wcRequesterOrigin(options.mode)
  if (typeof requesterOriginValue !== 'string' || requesterOriginValue.length === 0) {
    return { status: 'failed', errorCode: 'H3WC_REQUESTER_ORIGIN_REQUIRED', stop: NOOP }
  }

  let requesterOrigin: string
  try {
    requesterOrigin = canonicalizeH3wcOrigin(requesterOriginValue)
  } catch {
    return { status: 'failed', errorCode: 'H3WC_REQUESTER_ORIGIN_INVALID', stop: NOOP }
  }
  const navigatorLike = options.navigatorLike === undefined
    ? (typeof navigator === 'undefined' ? null : navigator)
    : options.navigatorLike
  if (!isH3wcWebLocksAvailable(navigatorLike)) {
    return { status: 'failed', errorCode: 'H3WC_WEB_LOCKS_REQUIRED', stop: NOOP }
  }
  const Channel = options.broadcastChannelFactory ?? globalThis.BroadcastChannel
  if (typeof Channel !== 'function') return { status: 'failed', errorCode: 'H3WC_BROADCASTCHANNEL_REQUIRED', stop: NOOP }
  const factory = options.indexedDb ?? globalThis.indexedDB
  if (!factory || typeof factory.open !== 'function') return { status: 'failed', errorCode: 'H3WC_INDEXEDDB_REQUIRED', stop: NOOP }

  const abortController = new AbortController()
  const stopRuntime = () => abortController.abort()
  let resolveStarted: (result: H3wcBootstrapResult) => void = NOOP
  const started = new Promise<H3wcBootstrapResult>(resolve => {
    resolveStarted = resolve
  })

  const ownerTask = runAsH3wcOwner(async (owner: H3wcOwnerRuntime) => {
    let journal: Awaited<ReturnType<typeof openH3wcJournal>> | null = null
    let channel: BroadcastChannel | null = null
    let transport: H3wcWalletTransport | null = null
    try {
      journal = await openH3wcJournal(factory)
      channel = new Channel(H3WC_COORDINATION_CHANNEL)
      transport = await createH3wcWalletTransport({
        projectId,
        expectedPeer: { origin: requesterOrigin },
        ownerEpoch: owner.ownerEpoch,
        identityProvider: options.identityProvider,
        metadata: options.metadata,
        nowSeconds: options.nowSeconds,
        onProposal: options.onProposal
      })
      await transport.restore()
      publish(channel, 'OWNER_ACTIVE', owner.ownerEpoch)
      resolveStarted({ status: 'owner', ownerEpoch: owner.ownerEpoch, stop: stopRuntime })
      await waitForH3wcAbort(abortController.signal)
    } catch (error) {
      resolveStarted({ status: 'failed', ownerEpoch: owner.ownerEpoch, errorCode: runtimeErrorCode(error), stop: stopRuntime })
    } finally {
      transport?.stop()
      if (channel) {
        publish(channel, 'OWNER_CHANGED', owner.ownerEpoch)
        channel.close()
      }
      journal?.close()
    }
  }, {
    ifAvailable: true,
    navigatorLike,
    cryptoLike: options.cryptoLike
  })

  void ownerTask.then(result => {
    if (result === null) {
      resolveStarted({ status: 'follower', stop: stopRuntime })
    }
  }).catch(error => {
    resolveStarted({ status: 'failed', errorCode: runtimeErrorCode(error), stop: stopRuntime })
  })

  return started
}

export const H3WC_DEFAULT_REQUESTER_ORIGIN = H3WC_PRODUCTION_REQUESTER_ORIGIN
