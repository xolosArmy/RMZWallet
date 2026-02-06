import { Core } from '@walletconnect/core'
import { Web3Wallet } from '@walletconnect/web3wallet'
import type { IWeb3Wallet, Web3WalletTypes } from '@walletconnect/web3wallet'
import type { SessionTypes } from '@walletconnect/types'
import { xolosWalletService } from '../../services/XolosWalletService'
import { updateWcDebugState } from './wcDebug'

function normalizeEcashAddressLikeYouAlreadyDid(addr: string): string {
  return addr.startsWith('ecash:') ? addr.slice('ecash:'.length) : addr
}

function ensureEcashPrefixed(addr: string): string {
  return addr.startsWith('ecash:') ? addr : `ecash:${addr}`
}

const DEFAULT_TTL_SECONDS = 300
const MIN_TTL_SECONDS = 30
const MAX_TTL_SECONDS = 900

function normalizeTtlSeconds(rawTtl: unknown): number | null {
  if (rawTtl === null || rawTtl === undefined) return null
  const numeric = typeof rawTtl === 'number' ? rawTtl : Number(rawTtl)
  if (!Number.isFinite(numeric)) return null
  let ttlSeconds = numeric
  if (ttlSeconds > 1_000_000_000_000) {
    ttlSeconds = Math.floor(ttlSeconds / 1000)
  }
  ttlSeconds = Math.floor(ttlSeconds)
  if (ttlSeconds <= 0) return null
  if (ttlSeconds < MIN_TTL_SECONDS) return MIN_TTL_SECONDS
  if (ttlSeconds > MAX_TTL_SECONDS) return MAX_TTL_SECONDS
  return ttlSeconds
}

function normalizeEpochSeconds(rawEpoch: unknown): number | null {
  if (rawEpoch === null || rawEpoch === undefined) return null
  const numeric = typeof rawEpoch === 'number' ? rawEpoch : Number(rawEpoch)
  if (!Number.isFinite(numeric)) return null
  if (numeric > 1_000_000_000_000) {
    return Math.floor(numeric / 1000)
  }
  return Math.floor(numeric)
}

export type WcState = {
  sessions: SessionTypes.Struct[]
  lastError: string | null
  lastSuccessTxid: string | null
  lastPairUri: string | null
  initialized: boolean
  pendingRequest: PendingRequest | null
  pendingRequestError: string | null
  pendingRequestBusy: boolean
  pendingRequestResolved: boolean
  pendingRequestTxid: string | null
}

export type SignAndBroadcastParams = {
  offerId: string
  userPrompt?: string
  [key: string]: unknown
}

export type PendingRequest = {
  id: number
  topic: string
  method: string
  params: SignAndBroadcastParams
  expiresAt: number
  peer?: {
    name?: string
    url?: string
    icons?: string[]
  }
}

export type OfferPublishedPayload = {
  version: 1
  kind: 'nft' | 'rmz' | 'etoken' | 'mintpass'
  offerId: string
  txid: string
  tokenId?: string
  seller: string
  priceXec: number
  amount?: string // RMZ amount in base units (token atoms)
  timestamp: number
  source: 'tonalli'
}

const defaultState: WcState = {
  sessions: [],
  lastError: null,
  lastSuccessTxid: null,
  lastPairUri: null,
  initialized: false,
  pendingRequest: null,
  pendingRequestError: null,
  pendingRequestBusy: false,
  pendingRequestResolved: false,
  pendingRequestTxid: null
}

class WcWallet {
  private core: Web3WalletTypes.Options['core'] | null = null
  private web3wallet: IWeb3Wallet | null = null
  private state: WcState = { ...defaultState }
  private listeners = new Set<(state: WcState) => void>()
  private proposalListeners = new Set<(proposal: Web3WalletTypes.SessionProposal) => void>()
  private successTimer: number | null = null
  private offerQueue: OfferPublishedPayload[] = []
  private offerQueueIds = new Set<string>()
  private offerQueueByTopic = new Map<string, Set<string>>()
  private pendingExpiryTimer: number | null = null

  getState() {
    return this.state
  }

  subscribe(listener: (state: WcState) => void) {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onSessionProposal(listener: (proposal: Web3WalletTypes.SessionProposal) => void) {
    this.proposalListeners.add(listener)
    return () => {
      this.proposalListeners.delete(listener)
    }
  }

  private setState(next: Partial<WcState>) {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private setSuccessTxid(txid: string) {
    if (this.successTimer && typeof window !== 'undefined') {
      window.clearTimeout(this.successTimer)
    }
    this.setState({ lastSuccessTxid: txid })
    if (typeof window !== 'undefined') {
      this.successTimer = window.setTimeout(() => {
        this.setState({ lastSuccessTxid: null })
        this.successTimer = null
      }, 6000)
    }
  }

  private clearPendingExpiryTimer() {
    if (this.pendingExpiryTimer && typeof window !== 'undefined') {
      window.clearTimeout(this.pendingExpiryTimer)
    }
    this.pendingExpiryTimer = null
  }

  private schedulePendingExpiry(expiresAt: number) {
    if (typeof window === 'undefined') return
    this.clearPendingExpiryTimer()
    const nowSeconds = Math.floor(Date.now() / 1000)
    const delayMs = Math.max(0, (expiresAt - nowSeconds) * 1000)
    this.pendingExpiryTimer = window.setTimeout(() => {
      void this.expirePendingRequest()
    }, delayMs)
  }

  async init(projectId: string) {
    if (this.state.initialized) return
    if (!projectId) {
      this.setState({ lastError: 'Falta VITE_WALLETCONNECT_PROJECT_ID.' })
      throw new Error('Missing WalletConnect project id')
    }

    this.core = new Core({ projectId }) as unknown as Web3WalletTypes.Options['core']
    this.web3wallet = await Web3Wallet.init({
      core: this.core,
      metadata: {
        name: 'RMZWallet',
        description: 'XolosArmy RMZWallet (eCash)',
        url:
          typeof window !== 'undefined' && import.meta.env.DEV
            ? window.location.origin
            : 'https://app.tonalli.cash',
        icons: ['https://xolosarmy.xyz/icon.png']
      }
    })

    this.registerHandlers()
    this.setState({ initialized: true })
    this.refreshSessions()
  }

  async pair(uri: string) {
    if (!this.core) {
      throw new Error('WalletConnect no está listo.')
    }
    this.setState({ lastPairUri: uri, lastError: null })
    await this.core.pairing.pair({ uri })
  }

  async disconnectSession(topic: string) {
    if (!this.web3wallet) return
    await this.web3wallet.disconnectSession({
      topic,
      reason: { code: 6000, message: 'Sesión terminada por el usuario.' }
    })
    this.refreshSessions()
  }

  async approveSession(id: number, namespaces: SessionTypes.Namespaces) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    try {
      const ecashNamespace = namespaces.ecash
      const events = Array.from(
        new Set([...(ecashNamespace?.events ?? []), 'xolos_offer_published'])
      )
      const chains = Array.from(new Set([...(ecashNamespace?.chains ?? []), 'ecash:mainnet']))
      const requestedMethods = ecashNamespace?.methods ?? []
      const baseMethods = requestedMethods.includes('ecash_getAddresses')
        ? requestedMethods
        : [...requestedMethods, 'ecash_getAddresses']
      const methods = baseMethods.includes('ecash_signAndBroadcastTransaction')
        ? baseMethods
        : [...baseMethods, 'ecash_signAndBroadcastTransaction']

      const updatedNamespaces = ecashNamespace
        ? ecashNamespace.accounts && ecashNamespace.accounts.length > 0
          ? {
              ...namespaces,
              ecash: {
                ...ecashNamespace,
                events,
                methods,
                chains,
                accounts: ecashNamespace.accounts.map((account) => {
                  // expected: "<namespace>:<chainId>:<address>"
                  const parts = account.split(':')
                  if (parts.length < 3) return account

                  const addressPart = parts.slice(2).join(':')
                  if (!addressPart) return account

                  const caipAddress = normalizeEcashAddressLikeYouAlreadyDid(addressPart)

                  return `ecash:mainnet:${caipAddress}`
                })
              }
            }
          : {
              ...namespaces,
              ecash: { ...ecashNamespace, events, methods, chains }
            }
        : namespaces

      console.info('[Tonalli][WC] approveSession namespaces', updatedNamespaces)
      await this.web3wallet.approveSession({ id, namespaces: updatedNamespaces })
      this.refreshSessions()
    } catch (err) {
      console.error('[Tonalli][WC] approveSession failed', err)
      throw err
    }
  }

  async rejectSession(id: number, reason?: { code: number; message: string }) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    try {
      await this.web3wallet.rejectSession({
        id,
        reason: reason ?? { code: 5000, message: 'User rejected' }
      })
    } catch (err) {
      console.error('[Tonalli][WC] rejectSession failed', err)
      throw err
    }
  }

  getActiveSessions() {
    return this.web3wallet?.getActiveSessions?.() ?? {}
  }

  refreshSessions() {
    if (!this.web3wallet) return
    const sessions = Object.values(this.getActiveSessions())
    this.setState({ sessions })
  }

  getOfferEventTargetsSummary() {
    const sessions = Object.values(this.getActiveSessions())
    const targets = this.getOfferEventTargets(sessions)
    const eligibleTopics = targets.map((session) => session.topic)
    const eligibleChains = new Set<string>()
    for (const session of targets) {
      for (const chain of session.namespaces?.ecash?.chains ?? []) {
        eligibleChains.add(chain)
      }
    }
    return {
      totalSessions: sessions.length,
      eligibleTopics,
      eligibleChains: Array.from(eligibleChains)
    }
  }

  queueOfferPublished(payload: OfferPublishedPayload, reason = 'no-active-sessions') {
    const normalized = this.normalizeOfferPayload(payload)
    this.enqueueOfferPayload(normalized)
    console.info('[Tonalli][WC][offerQueue] queued', {
      offerId: normalized.offerId,
      reason,
      size: this.offerQueue.length
    })
  }

  async emitOfferPublished(payload: OfferPublishedPayload) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const sessions = Object.values(this.getActiveSessions())
    const targetSummary = this.getOfferEventTargetsSummary()
    console.debug('[Tonalli][WC][emitOfferPublished] sessions=', targetSummary.totalSessions)
    if (!sessions.length) {
      console.warn('[Tonalli][WC][emitOfferPublished] no active sessions, queueing offer')
      this.queueOfferPublished(payload, 'no-active-sessions')
      return
    }
    const payloadNormalized = this.normalizeOfferPayload(payload)
    updateWcDebugState({ lastOfferPayload: payloadNormalized })
    const targets = this.getOfferEventTargets(sessions)
    if (!targets.length) {
      console.warn('[Tonalli][WC][emitOfferPublished] no eligible ecash:mainnet sessions', {
        totalSessions: targetSummary.totalSessions,
        eligibleTopics: targetSummary.eligibleTopics,
        eligibleChains: targetSummary.eligibleChains
      })
      return
    }

    const results = await Promise.allSettled(
      targets.map(async (session) => {
        try {
          console.info(
            '[Tonalli][WC][emitOfferPublished] topic=',
            session.topic,
            'offerId=',
            payloadNormalized.offerId,
            'kind=',
            payloadNormalized.kind,
            'priceXec=',
            payloadNormalized.priceXec
          )
          console.debug(
            '[Tonalli][WC][emitOfferPublished] topic=',
            session.topic,
            'chainId=ecash:mainnet',
            'payload=',
            payloadNormalized
          )
          await this.web3wallet?.emitSessionEvent({
            topic: session.topic,
            chainId: 'ecash:mainnet',
            event: { name: 'xolos_offer_published', data: payloadNormalized }
          })
          console.debug('[Tonalli][WC][emitOfferPublished] OK topic=', session.topic)
        } catch (err) {
          console.debug('[Tonalli][WC][emitOfferPublished] FAIL topic=', session.topic, err)
          throw err
        }
      })
    )

    const hasSuccess = results.some((result) => result.status === 'fulfilled')
    if (!hasSuccess) {
      const rejected = results.find((result) => result.status === 'rejected')
      const reason = rejected && rejected.status === 'rejected' ? rejected.reason : 'Failed to emit offer event'
      this.setState({ lastError: String(reason) })
    }
  }

  private registerHandlers() {
    if (!this.web3wallet) return
    const web3wallet = this.web3wallet

    web3wallet.on('session_proposal', async (proposal: Web3WalletTypes.SessionProposal) => {
      const address = xolosWalletService.getAddress()
      if (!address) {
        this.setState({ lastError: 'La billetera no está lista para aprobar sesiones.' })
        try {
          await web3wallet.rejectSession({
            id: proposal.id,
            reason: { code: 4001, message: 'Wallet not ready' }
          })
        } catch {
          // ignore
        }
        return
      }

      for (const listener of this.proposalListeners) {
        listener(proposal)
      }
    })

    web3wallet.on('session_request', async (event: Web3WalletTypes.SessionRequest) => {
      const { topic, params, id } = event
      const { request } = params
      const requestExpiryRaw =
        (params as { expiryTimestamp?: unknown }).expiryTimestamp ??
        (request as { expiryTimestamp?: unknown }).expiryTimestamp
      const ttlSeconds = normalizeTtlSeconds(requestExpiryRaw) ?? DEFAULT_TTL_SECONDS
      const nowSeconds = Math.floor(Date.now() / 1000)
      const expiryTimestamp = nowSeconds + ttlSeconds
      if (expiryTimestamp <= nowSeconds) {
        await web3wallet.respondSessionRequest({
          topic,
          response: {
            id,
            jsonrpc: '2.0',
            error: { code: 5000, message: 'Request expired' }
          }
        })
        return
      }
      console.info('[Tonalli][WC] session_request received', request.method, request.params)
      console.debug('[Tonalli][WC] session_request ttlSeconds=', ttlSeconds, 'expiryTimestamp=', expiryTimestamp)
      const address = xolosWalletService.getAddress()

      if (request.method === 'ecash_getAddresses') {
        if (!address) {
          await web3wallet.respondSessionRequest({
            topic,
            response: {
              id,
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Wallet not ready' }
            }
          })
          return
        }
        await web3wallet.respondSessionRequest({
          topic,
          response: {
            id,
            jsonrpc: '2.0',
            result: [address]
          }
        })
        return
      }

      if (request.method === 'ecash_signAndBroadcastTransaction') {
        const requestParams = (request.params ?? {}) as Partial<SignAndBroadcastParams>
        const offerId =
          typeof requestParams.offerId === 'string' && requestParams.offerId.trim().length > 0
            ? requestParams.offerId.trim()
            : ''
        const paramsSummary = {
          offerId,
          userPrompt: requestParams.userPrompt,
          keys: Object.keys(requestParams ?? {})
        }
        updateWcDebugState({ lastSignAndBroadcast: { at: Date.now(), paramsSummary } })

        console.info('[Tonalli][WC] signAndBroadcast requested', {
          offerId,
          topic,
          peer: this.getActiveSessions()[topic]?.peer?.metadata?.name
        })
        console.debug('[Tonalli][WC][signAndBroadcast] params=', paramsSummary)

        if (!offerId) {
          await web3wallet.respondSessionRequest({
            topic,
            response: {
              id,
              jsonrpc: '2.0',
              error: { code: -32602, message: 'Invalid params' }
            }
          })
          return
        }

        if (this.state.pendingRequest) {
          await web3wallet.respondSessionRequest({
            topic,
            response: {
              id,
              jsonrpc: '2.0',
              error: { code: 5000, message: 'Another request is already pending approval.' }
            }
          })
          return
        }

        const session = this.getActiveSessions()[topic]
        this.setState({
          pendingRequest: {
            id,
            topic,
            method: request.method,
            params: { ...requestParams, offerId } as SignAndBroadcastParams,
            expiresAt: expiryTimestamp,
            peer: session?.peer?.metadata
          },
          pendingRequestError: null,
          pendingRequestBusy: false,
          pendingRequestResolved: false,
          pendingRequestTxid: null
        })
        this.schedulePendingExpiry(expiryTimestamp)
        return
      }

      await web3wallet.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not supported' }
        }
      })
    })

    web3wallet.on('session_delete', () => {
      this.refreshSessions()
    })

    const wcEvents = web3wallet as unknown as { on: (event: string, cb: (event: any) => void) => void }
    wcEvents.on('session_settle', (event) => {
      const topic = event?.topic ?? event?.params?.topic
      if (!topic) return
      this.refreshSessions()
      void this.flushQueuedOffersForTopic(topic, 'session_settle')
    })

    wcEvents.on('session_update', (event) => {
      const topic = event?.topic ?? event?.params?.topic
      if (!topic) return
      this.refreshSessions()
      void this.flushQueuedOffersForTopic(topic, 'session_update')
    })
  }

  private normalizeOfferPayload(payload: OfferPublishedPayload) {
    return {
      ...payload,
      seller: ensureEcashPrefixed(payload.seller),
      timestamp: normalizeEpochSeconds(payload.timestamp) ?? payload.timestamp
    }
  }

  private getOfferEventTargets(sessions: SessionTypes.Struct[]) {
    return sessions.filter((session) => {
      const ecash = session.namespaces?.ecash
      if (!ecash) return false
      const hasEvent = (ecash.events ?? []).includes('xolos_offer_published')
      const hasChain = (ecash.chains ?? []).includes('ecash:mainnet')
      const hasAccount = (ecash.accounts ?? []).some((account) => account.startsWith('ecash:mainnet:'))
      return hasEvent && hasChain && hasAccount
    })
  }

  private enqueueOfferPayload(payload: OfferPublishedPayload) {
    if (this.offerQueueIds.has(payload.offerId)) {
      this.offerQueue = this.offerQueue.filter((item) => item.offerId !== payload.offerId)
    }
    this.offerQueue.push(payload)
    this.offerQueueIds.add(payload.offerId)
    if (this.offerQueue.length > 20) {
      const removed = this.offerQueue.shift()
      if (removed) {
        this.offerQueueIds.delete(removed.offerId)
        for (const sent of this.offerQueueByTopic.values()) {
          sent.delete(removed.offerId)
        }
      }
    }
  }

  private async flushQueuedOffersForTopic(topic: string, reason: string) {
    if (!this.web3wallet) return
    if (!this.offerQueue.length) return
    const session = this.getActiveSessions()[topic]
    if (!session) return
    const targets = this.getOfferEventTargets([session])
    if (!targets.length) {
      console.info('[Tonalli][WC][offerQueue] session not eligible for offers', { topic, reason })
      return
    }

    const sent = this.offerQueueByTopic.get(topic) ?? new Set<string>()
    if (!this.offerQueueByTopic.has(topic)) {
      this.offerQueueByTopic.set(topic, sent)
    }

    const offers = [...this.offerQueue].slice().reverse()
    console.info('[Tonalli][WC][offerQueue] flushing', {
      topic,
      reason,
      queued: offers.length
    })

    for (const offer of offers) {
      if (sent.has(offer.offerId)) continue
      try {
        await this.web3wallet.emitSessionEvent({
          topic,
          chainId: 'ecash:mainnet',
          event: { name: 'xolos_offer_published', data: offer }
        })
        sent.add(offer.offerId)
        console.debug('[Tonalli][WC][offerQueue] emitted', { topic, offerId: offer.offerId })
      } catch (err) {
        console.warn('[Tonalli][WC][offerQueue] emit failed', { topic, offerId: offer.offerId, err })
      }
    }
  }

  async approvePendingRequest() {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const pending = this.state.pendingRequest
    if (!pending || this.state.pendingRequestResolved) return

    const nowSeconds = Math.floor(Date.now() / 1000)
    if (pending.expiresAt <= nowSeconds) {
      await this.expirePendingRequest()
      return
    }

    const offerId = pending.params.offerId
    this.setState({ pendingRequestBusy: true, pendingRequestError: null })
    console.info('[Tonalli][WC] signAndBroadcast approve', offerId)

    try {
      const { acceptOfferById } = await import('../../services/agoraExchange')
      const { buyOfferById } = await import('../../services/buyOfferById')
      const { triggerWalletRefresh } = await import('../../utils/walletRefresh')

      let txid = ''
      try {
        const result = await acceptOfferById({ offerId, wallet: xolosWalletService })
        txid = result.txid
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        const canFallback = /oneshot/i.test(message)
        if (!canFallback) {
          throw err
        }
        const fallback = await buyOfferById(offerId)
        txid = fallback.txid
      }
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
        throw new Error('Invalid txid returned from broadcast')
      }

      console.debug('[Tonalli][WC][signAndBroadcast] txid=', txid)
      await this.web3wallet.respondSessionRequest({
        topic: pending.topic,
        response: {
          id: pending.id,
          jsonrpc: '2.0',
          result: { txid }
        }
      })

      this.setState({
        pendingRequestBusy: false,
        pendingRequestError: null,
        pendingRequestResolved: true,
        pendingRequestTxid: txid
      })
      this.clearPendingExpiryTimer()
      updateWcDebugState({ lastSignAndBroadcast: { at: Date.now(), txid } })
      this.setSuccessTxid(txid)
      triggerWalletRefresh({
        refreshUtxos: true,
        refreshBalances: true,
        refreshNfts: true,
        reason: 'walletconnect-buy',
        txid
      })
      updateWcDebugState({ lastRefreshAt: Date.now() })
    } catch (err) {
      console.debug('[Tonalli][WC][signAndBroadcast] error=', err)
      const message = err instanceof Error ? err.message : 'Failed to broadcast'
      await this.web3wallet.respondSessionRequest({
        topic: pending.topic,
        response: {
          id: pending.id,
          jsonrpc: '2.0',
          error: { code: 5000, message }
        }
      })
      this.setState({
        pendingRequestError: message,
        pendingRequestBusy: false,
        pendingRequestResolved: true,
        pendingRequestTxid: null
      })
      this.clearPendingExpiryTimer()
      updateWcDebugState({ lastSignAndBroadcast: { at: Date.now(), error: message } })
    }
  }

  async rejectPendingRequest() {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const pending = this.state.pendingRequest
    if (!pending) return
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (!this.state.pendingRequestResolved && pending.expiresAt <= nowSeconds) {
      await this.expirePendingRequest()
      return
    }
    if (this.state.pendingRequestResolved) {
      this.setState({
        pendingRequest: null,
        pendingRequestError: null,
        pendingRequestBusy: false,
        pendingRequestResolved: false,
        pendingRequestTxid: null
      })
      this.clearPendingExpiryTimer()
      return
    }
    await this.web3wallet.respondSessionRequest({
      topic: pending.topic,
      response: {
        id: pending.id,
        jsonrpc: '2.0',
        error: { code: 4001, message: 'User rejected' }
      }
    })
    this.setState({
      pendingRequest: null,
      pendingRequestError: null,
      pendingRequestBusy: false,
      pendingRequestResolved: false,
      pendingRequestTxid: null
    })
    this.clearPendingExpiryTimer()
  }

  async expirePendingRequest() {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const pending = this.state.pendingRequest
    if (!pending || this.state.pendingRequestResolved) return
    console.info('[Tonalli][WC] pending request expired', {
      id: pending.id,
      topic: pending.topic
    })
    await this.web3wallet.respondSessionRequest({
      topic: pending.topic,
      response: {
        id: pending.id,
        jsonrpc: '2.0',
        error: { code: 5000, message: 'Request expired. Please try again.' }
      }
    })
    this.setState({
      pendingRequestError: 'Request expired. Please try again.',
      pendingRequestBusy: false,
      pendingRequestResolved: true,
      pendingRequestTxid: null
    })
    this.clearPendingExpiryTimer()
  }
}

export const wcWallet = new WcWallet()
