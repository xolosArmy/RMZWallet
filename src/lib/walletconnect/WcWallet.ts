import { Core } from '@walletconnect/core'
import { Web3Wallet } from '@walletconnect/web3wallet'
import type { IWeb3Wallet, Web3WalletTypes } from '@walletconnect/web3wallet'
import type { SessionTypes } from '@walletconnect/types'
import { getChronik } from '../../services/ChronikClient'
import { xolosWalletService } from '../../services/XolosWalletService'
import { updateWcDebugState } from './wcDebug'
import * as offerQueue from './offerQueue'
import { appendWcRequestHistory } from './requestHistory'

function normalizeEcashAddressLikeYouAlreadyDid(addr: string): string {
  return addr.startsWith('ecash:') ? addr.slice('ecash:'.length) : addr
}

function ensureEcashPrefixed(addr: string): string {
  return addr.startsWith('ecash:') ? addr : `ecash:${addr}`
}

const WC_NAMESPACE = 'ecash'
const WC_CHAIN_ID = 'ecash:1'
const WC_CHAIN_ID_LEGACY = 'ecash:mainnet'
const WC_METHOD_GET_ADDRESSES = 'ecash_getAddresses'
const WC_METHOD_SIGN_AND_BROADCAST = 'ecash_signAndBroadcastTransaction'
const WC_EVENT_OFFER_PUBLISHED = 'xolos_offer_published'
const WC_EVENT_OFFER_CONSUMED = 'xolos_offer_consumed'
const WC_EVENT_ACCOUNTS_CHANGED = 'accountsChanged'

const DEFAULT_TTL_SECONDS = 300
const MIN_TTL_SECONDS = 30
const MAX_TTL_SECONDS = 900
const MAX_PENDING_AGE_SECONDS = 300
const MAX_PENDING_QUEUE_SIZE = 20

const WC_ALLOWED_DOMAINS = (
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_WC_ALLOWED_DOMAINS ??
    (typeof process !== 'undefined' ? process.env?.VITE_WC_ALLOWED_DOMAINS : undefined)) as string | undefined
)
  ?.split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean)

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

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function isHexString(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
}

function formatXecFromSats(sats: bigint): string {
  const abs = sats < 0n ? -sats : sats
  const whole = abs / 100n
  const fraction = abs % 100n
  const formatted = `${whole.toString()}.${fraction.toString().padStart(2, '0')}`
  return sats < 0n ? `-${formatted}` : formatted
}

export type PendingRequestStatus = 'idle' | 'pending' | 'signing' | 'broadcasting' | 'done' | 'error'

export type RawTxPreview = {
  bytes: number
  inputs: number
  outputs: number
  totalOutputSats: string
  totalOutputXec: string
  feeSats?: string
  feeXec?: string
  outputSummary: Array<{ sats: string; xec: string; script: string }>
  summaryError?: string
}

export type PeerVerifyContext = {
  warning: string | null
  host: string | null
  allowlisted: boolean
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
  pendingRequestStatus: PendingRequestStatus
  pendingQueueSize: number
}

export type SignAndBroadcastParams = {
  offerId: string
  rawHex?: string
  userPrompt?: string
  [key: string]: unknown
}

export type PendingRequest = {
  id: number
  topic: string
  method: string
  chainId: string
  params: SignAndBroadcastParams
  expiresAt: number
  createdAt: number
  peer?: {
    name?: string
    url?: string
    icons?: string[]
  }
  verifyContext?: PeerVerifyContext
  rawTxPreview?: RawTxPreview
}

export type OfferPublishedPayload = {
  version: 1
  kind: 'nft' | 'rmz' | 'etoken' | 'mintpass'
  offerId: string
  txid: string
  tokenId?: string
  seller: string
  priceXec: number
  amount?: string
  timestamp: number
  source: 'tonalli'
}

export type OfferConsumedPayload = {
  version: 1
  offerId: string
  txid: string
  kind: 'rmz' | 'nft' | 'mintpass' | string
  buyer?: string
  timestamp: number
  source: 'rmzwallet'
}

type JsonRpcError = {
  code: number
  message: string
}

type SessionRequestPayload = {
  id: number
  topic: string
  method: string
  chainId: string
  params: SignAndBroadcastParams
  expiresAt: number
  createdAt: number
  peer?: {
    name?: string
    url?: string
    icons?: string[]
  }
  verifyContext?: PeerVerifyContext
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
  pendingRequestTxid: null,
  pendingRequestStatus: 'idle',
  pendingQueueSize: 0
}

export class WcWallet {
  private core: Web3WalletTypes.Options['core'] | null = null
  private web3wallet: IWeb3Wallet | null = null
  private state: WcState = { ...defaultState }
  private listeners = new Set<(state: WcState) => void>()
  private proposalListeners = new Set<(proposal: Web3WalletTypes.SessionProposal) => void>()
  private successTimer: number | null = null
  private pendingExpiryTimer: number | null = null
  private pendingQueue: SessionRequestPayload[] = []

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
    const delayMs = Math.max(0, (expiresAt - nowSeconds()) * 1000)
    this.pendingExpiryTimer = window.setTimeout(() => {
      void this.expirePendingRequest()
    }, delayMs)
  }

  private getChainForSession(session: SessionTypes.Struct): string {
    const chains = session.namespaces?.ecash?.chains ?? []
    if (chains.includes(WC_CHAIN_ID)) return WC_CHAIN_ID
    if (chains.includes(WC_CHAIN_ID_LEGACY)) return WC_CHAIN_ID_LEGACY
    return WC_CHAIN_ID
  }

  private isSupportedChain(chainId: string): boolean {
    return chainId === WC_CHAIN_ID || chainId === WC_CHAIN_ID_LEGACY
  }

  private validatePeer(metadata: { url?: string } | undefined): PeerVerifyContext {
    const rawUrl = metadata?.url?.trim()
    if (!rawUrl) {
      return {
        warning: 'La dApp no proporcionó URL. Verifica manualmente el origen antes de aprobar.',
        host: null,
        allowlisted: false
      }
    }

    try {
      const host = new URL(rawUrl).hostname.toLowerCase()
      if (!WC_ALLOWED_DOMAINS || WC_ALLOWED_DOMAINS.length === 0) {
        return { warning: null, host, allowlisted: false }
      }
      const allowlisted = WC_ALLOWED_DOMAINS.includes(host)
      return {
        warning: allowlisted ? null : `Dominio fuera de allowlist: ${host}`,
        host,
        allowlisted
      }
    } catch {
      return {
        warning: 'La URL de la dApp es inválida. Verifica el origen antes de aprobar.',
        host: null,
        allowlisted: false
      }
    }
  }

  private normalizeJsonRpcError(kind: 'user' | 'params' | 'method' | 'internal' | 'expired' | 'busy'): JsonRpcError {
    if (kind === 'user') return { code: 4001, message: 'Rechazado por el usuario.' }
    if (kind === 'params') return { code: -32602, message: 'Params inválidos: offerId requerido' }
    if (kind === 'method') return { code: -32601, message: 'Método no soportado' }
    if (kind === 'expired') return { code: -32000, message: 'Request expired' }
    if (kind === 'busy') return { code: -32000, message: 'Request busy' }
    return { code: -32000, message: 'Error al firmar/transmitir' }
  }

  private async respondError(topic: string, id: number, error: JsonRpcError) {
    if (!this.web3wallet) return
    await this.web3wallet.respondSessionRequest({
      topic,
      response: {
        id,
        jsonrpc: '2.0',
        error
      }
    })
  }

  private async respondSuccess(topic: string, id: number, result: unknown) {
    if (!this.web3wallet) return
    await this.web3wallet.respondSessionRequest({
      topic,
      response: {
        id,
        jsonrpc: '2.0',
        result
      }
    })
  }

  private resolveRequestExpiry(event: Web3WalletTypes.SessionRequest): number {
    const { params } = event
    const request = params.request as Record<string, unknown>

    const explicitExpiry =
      normalizeEpochSeconds((params as Record<string, unknown>).expiryTimestamp) ??
      normalizeEpochSeconds(request.expiryTimestamp) ??
      normalizeEpochSeconds(request.expiresAt)

    const now = nowSeconds()
    if (explicitExpiry && explicitExpiry > now) {
      return Math.min(explicitExpiry, now + MAX_PENDING_AGE_SECONDS)
    }

    const ttl =
      normalizeTtlSeconds((params as Record<string, unknown>).ttl) ??
      normalizeTtlSeconds(request.ttl) ??
      DEFAULT_TTL_SECONDS

    return now + Math.min(ttl, MAX_PENDING_AGE_SECONDS)
  }

  private parseSignAndBroadcastParams(input: unknown): { params: SignAndBroadcastParams | null; error: JsonRpcError | null } {
    if (!input || typeof input !== 'object') {
      return { params: null, error: this.normalizeJsonRpcError('params') }
    }
    const requestParams = input as Partial<SignAndBroadcastParams>
    const offerId =
      typeof requestParams.offerId === 'string' && requestParams.offerId.trim().length > 0
        ? requestParams.offerId.trim()
        : ''

    if (!offerId) {
      return { params: null, error: this.normalizeJsonRpcError('params') }
    }
    if (requestParams.rawHex !== undefined && typeof requestParams.rawHex !== 'string') {
      return {
        params: null,
        error: { code: -32602, message: 'Params inválidos: rawHex debe ser string' }
      }
    }
    if (requestParams.userPrompt !== undefined && typeof requestParams.userPrompt !== 'string') {
      return {
        params: null,
        error: { code: -32602, message: 'Params inválidos: userPrompt debe ser string' }
      }
    }

    return {
      params: {
        ...requestParams,
        offerId,
        rawHex: requestParams.rawHex?.trim() || undefined,
        userPrompt: requestParams.userPrompt?.trim() || undefined
      },
      error: null
    }
  }

  private cleanupQueuedRequests() {
    const now = nowSeconds()
    this.pendingQueue = this.pendingQueue.filter((request) => request.expiresAt > now)
    this.setState({ pendingQueueSize: this.pendingQueue.length })
  }

  private async enqueuePendingRequest(payload: SessionRequestPayload): Promise<boolean> {
    this.cleanupQueuedRequests()
    if (this.pendingQueue.length >= MAX_PENDING_QUEUE_SIZE) {
      return false
    }
    this.pendingQueue.push(payload)
    this.setState({ pendingQueueSize: this.pendingQueue.length })
    console.info('[WCv2] session_request enqueued', {
      topic: payload.topic,
      id: payload.id,
      method: payload.method,
      offerId: payload.params.offerId,
      queueSize: this.pendingQueue.length
    })
    return true
  }

  private async flushNextPendingRequest() {
    if (this.state.pendingRequest) return
    this.cleanupQueuedRequests()

    while (this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift() as SessionRequestPayload
      this.setState({ pendingQueueSize: this.pendingQueue.length })
      if (next.expiresAt <= nowSeconds()) {
        await this.respondError(next.topic, next.id, this.normalizeJsonRpcError('expired'))
        appendWcRequestHistory({
          offerId: next.params.offerId,
          peer: next.peer?.name ?? next.peer?.url ?? 'unknown',
          topic: next.topic,
          status: 'error',
          error: 'Request expired',
          createdAt: next.createdAt,
          method: next.method
        })
        continue
      }
      await this.activatePendingRequest(next)
      return
    }
  }

  private async activatePendingRequest(payload: SessionRequestPayload) {
    const request: PendingRequest = {
      ...payload,
      createdAt: payload.createdAt,
      rawTxPreview: payload.params.rawHex
        ? {
            bytes: Math.floor(payload.params.rawHex.length / 2),
            inputs: 0,
            outputs: 0,
            totalOutputSats: '0',
            totalOutputXec: '0.00',
            outputSummary: []
          }
        : undefined
    }

    this.setState({
      pendingRequest: request,
      pendingRequestError: null,
      pendingRequestBusy: false,
      pendingRequestResolved: false,
      pendingRequestTxid: null,
      pendingRequestStatus: 'pending'
    })
    this.schedulePendingExpiry(payload.expiresAt)

    if (request.params.rawHex) {
      const preview = await this.buildRawTxPreview(request.params.rawHex)
      const active = this.state.pendingRequest
      if (active && active.id === request.id && active.topic === request.topic) {
        this.setState({
          pendingRequest: {
            ...active,
            rawTxPreview: preview
          }
        })
      }
    }
  }

  private async buildRawTxPreview(rawHex: string): Promise<RawTxPreview> {
    const normalized = rawHex.trim()
    const fallback: RawTxPreview = {
      bytes: Math.floor(normalized.length / 2),
      inputs: 0,
      outputs: 0,
      totalOutputSats: '0',
      totalOutputXec: '0.00',
      outputSummary: []
    }

    if (!normalized || !isHexString(normalized)) {
      return {
        ...fallback,
        summaryError: 'rawHex inválido'
      }
    }

    try {
      const tx = await getChronik().validateRawTx(normalized)
      const totalOutputSats = tx.outputs.reduce((acc, output) => acc + output.sats, 0n)
      const totalInputSats = tx.inputs.reduce((acc, input) => acc + input.sats, 0n)
      const feeSats = totalInputSats >= totalOutputSats ? totalInputSats - totalOutputSats : undefined

      return {
        bytes: tx.size,
        inputs: tx.inputs.length,
        outputs: tx.outputs.length,
        totalOutputSats: totalOutputSats.toString(),
        totalOutputXec: formatXecFromSats(totalOutputSats),
        feeSats: feeSats?.toString(),
        feeXec: feeSats !== undefined ? formatXecFromSats(feeSats) : undefined,
        outputSummary: tx.outputs.slice(0, 4).map((output) => ({
          sats: output.sats.toString(),
          xec: formatXecFromSats(output.sats),
          script: output.outputScript.slice(0, 32)
        }))
      }
    } catch (err) {
      return {
        ...fallback,
        summaryError: err instanceof Error ? err.message : 'No se pudo validar rawHex'
      }
    }
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
        new Set([
          ...(ecashNamespace?.events ?? []),
          WC_EVENT_ACCOUNTS_CHANGED,
          WC_EVENT_OFFER_PUBLISHED,
          WC_EVENT_OFFER_CONSUMED
        ])
      )
      const chainsRequested = ecashNamespace?.chains ?? []
      const chains = chainsRequested.includes(WC_CHAIN_ID)
        ? [WC_CHAIN_ID]
        : chainsRequested.includes(WC_CHAIN_ID_LEGACY)
          ? [WC_CHAIN_ID_LEGACY]
          : [WC_CHAIN_ID]
      const requestedMethods = ecashNamespace?.methods ?? []
      const baseMethods = requestedMethods.includes(WC_METHOD_GET_ADDRESSES)
        ? requestedMethods
        : [...requestedMethods, WC_METHOD_GET_ADDRESSES]
      const methods = baseMethods.includes(WC_METHOD_SIGN_AND_BROADCAST)
        ? baseMethods
        : [...baseMethods, WC_METHOD_SIGN_AND_BROADCAST]

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
                  const parts = account.split(':')
                  if (parts.length < 3) return account
                  const addressPart = parts.slice(2).join(':')
                  if (!addressPart) return account
                  const caipAddress = normalizeEcashAddressLikeYouAlreadyDid(addressPart)
                  return `${chains[0]}:${caipAddress}`
                })
              }
            }
          : {
              ...namespaces,
              ecash: { ...ecashNamespace, events, methods, chains }
            }
        : namespaces

      console.info('[WCv2] proposal approved', { id, chains, methods })
      const approved = await this.web3wallet.approveSession({ id, namespaces: updatedNamespaces })
      this.refreshSessions()
      if (approved?.topic) {
        await this.replayQueuedOffersToTopic(approved.topic)
      }
    } catch (err) {
      console.error('[WCv2] approveSession failed', err)
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
      console.info('[WCv2] proposal rejected', { id })
    } catch (err) {
      console.error('[WCv2] rejectSession failed', err)
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

  getEligibleSessions(): SessionTypes.Struct[] {
    const sessions = Object.values(this.getActiveSessions())
    return this.getOfferEventTargets(sessions)
  }

  async emitOfferPublished(payload: OfferPublishedPayload) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const payloadNormalized = this.normalizeOfferPayload(payload)
    const sessions = Object.values(this.getActiveSessions())
    const targetSummary = this.getOfferEventTargetsSummary()
    console.debug('[WCv2] emitOfferPublished sessions=', targetSummary.totalSessions)
    if (!sessions.length) {
      console.warn('[WCv2] no active sessions, queue offer', payloadNormalized.offerId)
      offerQueue.enqueue(payloadNormalized)
      return
    }
    updateWcDebugState({ lastOfferPayload: payloadNormalized })
    const targets = this.getOfferEventTargets(sessions)
    if (!targets.length) {
      console.warn('[WCv2] no eligible ecash sessions for offer event', {
        totalSessions: targetSummary.totalSessions,
        eligibleTopics: targetSummary.eligibleTopics,
        eligibleChains: targetSummary.eligibleChains
      })
      return
    }

    const results = await Promise.allSettled(
      targets.map(async (session) => {
        try {
          const chainId = this.getChainForSession(session)
          await this.web3wallet?.emitSessionEvent({
            topic: session.topic,
            chainId,
            event: { name: WC_EVENT_OFFER_PUBLISHED, data: payloadNormalized }
          })
          console.debug('[WCv2] offer_published ok', { topic: session.topic, chainId })
        } catch (err) {
          console.debug('[WCv2] offer_published fail', { topic: session.topic, err })
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

  async emitOfferConsumed(params: {
    offerId: string
    txid: string
    kind: 'rmz' | 'nft' | 'mintpass' | string
    buyer?: string
  }) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const offerId = params.offerId?.trim?.() ?? ''
    if (!offerId) {
      console.warn('[WCv2] offer_consumed missing offerId, skip emit')
      return
    }
    const sessions = Object.values(this.getActiveSessions())
    if (!sessions.length) {
      console.info('[WCv2] offer_consumed no active sessions, skip emit')
      return
    }

    const buyer = params.buyer ? ensureEcashPrefixed(params.buyer) : undefined
    const payload: OfferConsumedPayload = {
      version: 1,
      offerId,
      txid: params.txid,
      kind: params.kind,
      buyer,
      timestamp: nowSeconds(),
      source: 'rmzwallet'
    }

    await Promise.allSettled(
      sessions.map(async (session) => {
        try {
          const chainId = this.getChainForSession(session)
          await this.web3wallet?.emitSessionEvent({
            topic: session.topic,
            chainId,
            event: { name: WC_EVENT_OFFER_CONSUMED, data: payload }
          })
        } catch (err) {
          console.debug('[WCv2] offer_consumed emit failed', {
            topic: session.topic,
            offerId: payload.offerId,
            err
          })
        }
      })
    )
  }

  private proposalSupportsEcashV2(proposal: Web3WalletTypes.SessionProposal): boolean {
    const ecash = proposal.params.requiredNamespaces?.[WC_NAMESPACE]
    if (!ecash) return false
    const hasChain = (ecash.chains ?? []).includes(WC_CHAIN_ID)
    const hasMethod = (ecash.methods ?? []).includes(WC_METHOD_SIGN_AND_BROADCAST)
    return hasChain && hasMethod
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

      if (!this.proposalSupportsEcashV2(proposal)) {
        console.warn('[WCv2] proposal rejected by namespace/chains/methods', {
          id: proposal.id,
          requiredNamespaces: proposal.params.requiredNamespaces
        })
        await this.rejectSession(proposal.id, { code: 5100, message: 'Unsupported chains or methods' })
        return
      }

      console.info('[WCv2] proposal received', {
        id: proposal.id,
        proposer: proposal.params.proposer.metadata
      })
      for (const listener of this.proposalListeners) {
        listener(proposal)
      }
    })

    web3wallet.on('session_request', async (event: Web3WalletTypes.SessionRequest) => {
      const { topic, params, id } = event
      const { request, chainId: chainFromEvent } = params
      const expiryTimestamp = this.resolveRequestExpiry(event)

      console.info('[WCv2] session_request received', {
        topic,
        id,
        method: request.method,
        chainFromEvent,
        expiresAt: expiryTimestamp
      })

      if (expiryTimestamp <= nowSeconds()) {
        await this.respondError(topic, id, this.normalizeJsonRpcError('expired'))
        return
      }

      const address = xolosWalletService.getAddress()
      if (request.method === WC_METHOD_GET_ADDRESSES) {
        if (!address) {
          await this.respondError(topic, id, { code: -32000, message: 'Wallet not ready' })
          return
        }
        await this.respondSuccess(topic, id, [address])
        return
      }

      if (request.method !== WC_METHOD_SIGN_AND_BROADCAST) {
        await this.respondError(topic, id, this.normalizeJsonRpcError('method'))
        return
      }

      const session = this.getActiveSessions()[topic]
      const sessionChainId = session ? this.getChainForSession(session) : null
      const resolvedChainId = chainFromEvent ?? sessionChainId ?? WC_CHAIN_ID
      if (chainFromEvent && chainFromEvent !== WC_CHAIN_ID) {
        await this.respondError(topic, id, { code: -32000, message: `Unsupported chainId: ${chainFromEvent}` })
        return
      }
      if (!this.isSupportedChain(resolvedChainId)) {
        await this.respondError(topic, id, { code: -32000, message: 'Unsupported chain' })
        return
      }

      const parsed = this.parseSignAndBroadcastParams(request.params)
      if (!parsed.params || parsed.error) {
        await this.respondError(topic, id, parsed.error ?? this.normalizeJsonRpcError('params'))
        return
      }

      const verifyContext = this.validatePeer(session?.peer?.metadata)
      const payload: SessionRequestPayload = {
        id,
        topic,
        method: request.method,
        chainId: resolvedChainId,
        params: parsed.params,
        expiresAt: expiryTimestamp,
        createdAt: nowSeconds(),
        peer: session?.peer?.metadata,
        verifyContext
      }

      updateWcDebugState({
        lastSignAndBroadcast: {
          at: Date.now(),
          paramsSummary: {
            offerId: parsed.params.offerId,
            hasRawHex: Boolean(parsed.params.rawHex),
            userPrompt: parsed.params.userPrompt,
            chainId: resolvedChainId
          }
        }
      })

      if (this.state.pendingRequest && !this.state.pendingRequestResolved) {
        const enqueued = await this.enqueuePendingRequest(payload)
        if (!enqueued) {
          await this.respondError(topic, id, this.normalizeJsonRpcError('busy'))
        }
        return
      }

      await this.activatePendingRequest(payload)
    })

    web3wallet.on('session_delete', () => {
      this.refreshSessions()
    })

    type WcSessionEvent = { topic?: string; params?: { topic?: string } }
    const wcEvents = web3wallet as unknown as { on: (event: string, cb: (event: WcSessionEvent) => void) => void }
    wcEvents.on('session_settle', (event) => {
      const topic = event?.topic ?? event?.params?.topic
      if (!topic) return
      this.refreshSessions()
      void this.replayQueuedOffersToAllSessions()
    })

    wcEvents.on('session_update', (event) => {
      const topic = event?.topic ?? event?.params?.topic
      if (!topic) return
      this.refreshSessions()
      void this.replayQueuedOffersToAllSessions()
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
      const hasEvent = (ecash.events ?? []).includes(WC_EVENT_OFFER_PUBLISHED)
      const chainId = this.getChainForSession(session)
      const hasChain = (ecash.chains ?? []).includes(chainId)
      const hasAccount = (ecash.accounts ?? []).some((account) => account.startsWith(`${chainId}:`))
      return hasEvent && hasChain && hasAccount
    })
  }

  async publishOrQueueOffer(payload: OfferPublishedPayload) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const normalized = this.normalizeOfferPayload(payload)
    const sessions = this.getEligibleSessions()
    if (!sessions.length) {
      console.warn('[WCv2] no active sessions, queue offer', {
        offerId: normalized.offerId,
        kind: normalized.kind
      })
      offerQueue.enqueue(normalized)
      return
    }

    const topics = sessions.map((session) => session.topic)
    console.info('[WCv2] emit offer', { offerId: normalized.offerId, topics })
    let hasFailure = false
    await Promise.all(
      sessions.map(async (session) => {
        try {
          const chainId = this.getChainForSession(session)
          await this.web3wallet?.emitSessionEvent({
            topic: session.topic,
            chainId,
            event: { name: WC_EVENT_OFFER_PUBLISHED, data: normalized }
          })
        } catch (err) {
          hasFailure = true
          console.warn('[WCv2] emit offer failed', {
            offerId: normalized.offerId,
            topic: session.topic,
            err
          })
        }
      })
    )
    if (hasFailure) {
      offerQueue.enqueue(normalized)
    }
  }

  async replayQueuedOffersToTopic(topic: string) {
    if (!this.web3wallet) return
    const session = this.getActiveSessions()[topic]
    if (!session) return
    const ecash = session.namespaces?.ecash
    if (!ecash) return
    const chainId = this.getChainForSession(session)
    if (!(ecash.chains ?? []).includes(chainId)) return
    if (!(ecash.events ?? []).includes(WC_EVENT_OFFER_PUBLISHED)) return

    const offers = offerQueue.peekAll()
    if (!offers.length) return

    console.info('[WCv2] replay queued offers', { topic, countBefore: offers.length })

    for (const offer of offers) {
      try {
        await this.web3wallet.emitSessionEvent({
          topic,
          chainId,
          event: { name: WC_EVENT_OFFER_PUBLISHED, data: offer }
        })
        offerQueue.removeByOfferId(offer.offerId)
      } catch (err) {
        console.warn('[WCv2] replay offer failed', {
          topic,
          offerId: offer.offerId,
          err
        })
      }
    }
    console.info('[WCv2] replay queued offers', { topic, countAfter: offerQueue.peekAll().length })
  }

  async replayQueuedOffersToAllSessions() {
    const sessions = this.getEligibleSessions()
    if (!sessions.length) return
    await Promise.all(sessions.map((session) => this.replayQueuedOffersToTopic(session.topic)))
  }

  async approvePendingRequest() {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const pending = this.state.pendingRequest
    if (!pending || this.state.pendingRequestResolved) return

    if (pending.expiresAt <= nowSeconds()) {
      await this.expirePendingRequest()
      return
    }

    const offerId = pending.params.offerId
    this.setState({ pendingRequestBusy: true, pendingRequestError: null, pendingRequestStatus: 'signing' })
    console.info('[WCv2] signAndBroadcast approve', { offerId, topic: pending.topic })

    try {
      let txid = ''
      if (pending.params.rawHex) {
        if (!isHexString(pending.params.rawHex)) {
          throw new Error('rawHex inválido')
        }
        this.setState({ pendingRequestStatus: 'broadcasting' })
        const broadcast = await getChronik().broadcastTx(pending.params.rawHex)
        txid = broadcast.txid
      } else {
        const { acceptOfferById } = await import('../../services/agoraExchange')
        const { buyOfferById } = await import('../../services/buyOfferById')

        try {
          this.setState({ pendingRequestStatus: 'signing' })
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
      }

      if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
        throw new Error('Invalid txid returned from broadcast')
      }

      await this.respondSuccess(pending.topic, pending.id, { txid })
      const buyer = xolosWalletService.getAddress() ?? undefined
      const rawKind = pending.params?.kind
      const kind = typeof rawKind === 'string' && rawKind.trim().length > 0 ? rawKind.trim() : 'rmz'
      await this.emitOfferConsumed({ offerId, txid, kind, buyer })

      this.setState({
        pendingRequestBusy: false,
        pendingRequestError: null,
        pendingRequestResolved: true,
        pendingRequestTxid: txid,
        pendingRequestStatus: 'done'
      })
      this.clearPendingExpiryTimer()
      updateWcDebugState({ lastSignAndBroadcast: { at: Date.now(), txid } })
      this.setSuccessTxid(txid)

      const { triggerWalletRefresh } = await import('../../utils/walletRefresh')
      triggerWalletRefresh({
        refreshUtxos: true,
        refreshBalances: true,
        refreshNfts: true,
        reason: 'walletconnect-buy',
        txid
      })
      updateWcDebugState({ lastRefreshAt: Date.now() })
      appendWcRequestHistory({
        offerId,
        peer: pending.peer?.name ?? pending.peer?.url ?? 'unknown',
        topic: pending.topic,
        status: 'success',
        txid,
        createdAt: pending.createdAt,
        method: pending.method
      })
      console.info('[WCv2] sign success / broadcast success', { offerId, txid })
    } catch (err) {
      const message = err instanceof Error ? err.message : this.normalizeJsonRpcError('internal').message
      await this.respondError(pending.topic, pending.id, {
        ...this.normalizeJsonRpcError('internal'),
        message: `${this.normalizeJsonRpcError('internal').message}: ${message}`
      })
      this.setState({
        pendingRequestError: message,
        pendingRequestBusy: false,
        pendingRequestResolved: true,
        pendingRequestTxid: null,
        pendingRequestStatus: 'error'
      })
      this.clearPendingExpiryTimer()
      updateWcDebugState({ lastSignAndBroadcast: { at: Date.now(), error: message } })
      appendWcRequestHistory({
        offerId,
        peer: pending.peer?.name ?? pending.peer?.url ?? 'unknown',
        topic: pending.topic,
        status: 'error',
        error: message,
        createdAt: pending.createdAt,
        method: pending.method
      })
    }
  }

  async rejectPendingRequest() {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const pending = this.state.pendingRequest
    if (!pending) return
    if (!this.state.pendingRequestResolved && pending.expiresAt <= nowSeconds()) {
      await this.expirePendingRequest()
      return
    }
    if (this.state.pendingRequestResolved) {
      this.setState({
        pendingRequest: null,
        pendingRequestError: null,
        pendingRequestBusy: false,
        pendingRequestResolved: false,
        pendingRequestTxid: null,
        pendingRequestStatus: 'idle'
      })
      this.clearPendingExpiryTimer()
      await this.flushNextPendingRequest()
      return
    }

    await this.respondError(pending.topic, pending.id, this.normalizeJsonRpcError('user'))
    this.setState({
      pendingRequest: null,
      pendingRequestError: null,
      pendingRequestBusy: false,
      pendingRequestResolved: false,
      pendingRequestTxid: null,
      pendingRequestStatus: 'idle'
    })
    this.clearPendingExpiryTimer()
    appendWcRequestHistory({
      offerId: pending.params.offerId,
      peer: pending.peer?.name ?? pending.peer?.url ?? 'unknown',
      topic: pending.topic,
      status: 'rejected',
      error: 'Rechazado por el usuario.',
      createdAt: pending.createdAt,
      method: pending.method
    })
    await this.flushNextPendingRequest()
  }

  async expirePendingRequest() {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    const pending = this.state.pendingRequest
    if (!pending || this.state.pendingRequestResolved) return

    await this.respondError(pending.topic, pending.id, this.normalizeJsonRpcError('expired'))
    this.setState({
      pendingRequestError: 'Request expired',
      pendingRequestBusy: false,
      pendingRequestResolved: true,
      pendingRequestTxid: null,
      pendingRequestStatus: 'error'
    })
    this.clearPendingExpiryTimer()
    appendWcRequestHistory({
      offerId: pending.params.offerId,
      peer: pending.peer?.name ?? pending.peer?.url ?? 'unknown',
      topic: pending.topic,
      status: 'error',
      error: 'Request expired',
      createdAt: pending.createdAt,
      method: pending.method
    })
  }
}

export const wcWallet = new WcWallet()
