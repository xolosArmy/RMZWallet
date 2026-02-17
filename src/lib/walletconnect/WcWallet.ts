import { Core } from '@walletconnect/core'
import { Web3Wallet } from '@walletconnect/web3wallet'
import type { IWeb3Wallet, Web3WalletTypes } from '@walletconnect/web3wallet'
import type { SessionTypes } from '@walletconnect/types'
import { ALL_BIP143, Address, P2PKHSignatory, Script, Tx, TxBuilder, fromHex, toHexRev } from 'ecash-lib'
import { getChronik } from '../../services/ChronikClient'
import { xolosWalletService } from '../../services/XolosWalletService'
import { XEC_DUST_SATS } from '../../config/xecFees'
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
const WC_METHOD_SIGN_AND_BROADCAST_ALIAS = 'ecash_signAndBroadcast'
const WC_EVENT_OFFER_PUBLISHED = 'xolos_offer_published'
const WC_EVENT_OFFER_CONSUMED = 'xolos_offer_consumed'
const WC_EVENT_ACCOUNTS_CHANGED = 'accountsChanged'
const WC_STORED_TOPIC_KEY = 'tonalli_wc_topic'
const WC_PURGE_STORAGE_KEYS = ['tonalli_wc_topic', 'tonalli_wc_offer_queue', 'tonalli_wc_request_history']

const DEFAULT_TTL_SECONDS = 300
const MIN_TTL_SECONDS = 30
const MAX_TTL_SECONDS = 900
const MAX_PENDING_AGE_SECONDS = 300
const MAX_PENDING_QUEUE_SIZE = 20
const MIN_WC_FEE_RATE = 5
const MIN_MEMPOOL_POLICY_FEE_RATE = 3

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

function resolveConfiguredWcFeeRate(): number | null {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  const raw =
    viteEnv.VITE_WC_FEE_RATE_SAT_PER_BYTE ??
    (typeof process !== 'undefined' ? process.env?.VITE_WC_FEE_RATE_SAT_PER_BYTE : undefined)
  if (!raw) return null
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) return null
  return Math.floor(numeric)
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

function parseLegacyOutpointString(value: string): { txid: string; vout: number } | null {
  const trimmed = value.trim()
  const [txid, voutRaw] = trimmed.split(':')
  if (!txid || !voutRaw) return null
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return null
  if (!/^\d+$/.test(voutRaw)) return null
  const vout = Number(voutRaw)
  if (!Number.isSafeInteger(vout) || vout < 0) return null
  return { txid: txid.toLowerCase(), vout }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unwrapWcParams(input: unknown): Record<string, unknown> {
  if (Array.isArray(input)) {
    const [first] = input
    return isRecord(first) ? first : {}
  }
  if (!isRecord(input)) return {}
  if (isRecord(input.request) && 'params' in input.request) {
    return unwrapWcParams(input.request.params)
  }
  if ('params' in input) {
    return unwrapWcParams(input.params)
  }
  return input
}

function detectWcParamsShape(input: unknown): 'array' | 'object' | 'unknown' {
  if (Array.isArray(input)) return 'array'
  if (isRecord(input)) return 'object'
  return 'unknown'
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
  offerId?: string
  rawHex?: string
  unsignedTxHex?: string
  outputs?: Array<{ address: string; valueSats: string | number | bigint }>
  inputsUsed?: string[]
  outpoints?: string[]
  valueSats?: number | string | bigint
  sats?: number | string | bigint
  value?: number | string | bigint
  mode?: 'legacy' | 'intent' | 'tx'
  message?: string
  userPrompt?: string
  requestMode?: 'legacy' | 'intent' | 'tx'
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

type EcashProposalNamespace = {
  chains?: string[]
  methods?: string[]
}

function isSignAndBroadcastMethod(method: unknown): boolean {
  return method === WC_METHOD_SIGN_AND_BROADCAST || method === WC_METHOD_SIGN_AND_BROADCAST_ALIAS
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
  private static instance: WcWallet | null = null
  private initPromise: Promise<void> | null = null
  public core: Web3WalletTypes.Options['core'] | null = null
  public web3wallet: IWeb3Wallet | null = null
  private state: WcState = { ...defaultState }
  private listeners = new Set<(state: WcState) => void>()
  private proposalListeners = new Set<(proposal: Web3WalletTypes.SessionProposal) => void>()
  private successTimer: number | null = null
  private pendingExpiryTimer: number | null = null
  private pendingQueue: SessionRequestPayload[] = []
  private handlersRegistered = false

  private constructor() {}

  public static getInstance(): WcWallet {
    if (!WcWallet.instance) {
      WcWallet.instance = new WcWallet()
    }
    return WcWallet.instance
  }

  private isStaleTopicError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '')
    const normalized = message.toLowerCase()
    return normalized.includes('no matching key') || normalized.includes("session topic doesn't exist")
  }

  private resetPendingState() {
    this.clearPendingExpiryTimer()
    this.pendingQueue = []
    this.setState({
      sessions: [],
      pendingRequest: null,
      pendingRequestError: null,
      pendingRequestBusy: false,
      pendingRequestResolved: false,
      pendingRequestTxid: null,
      pendingRequestStatus: 'idle',
      pendingQueueSize: 0
    })
  }

  private clearStoredTopic() {
    if (typeof window === 'undefined') return
    try {
      localStorage.removeItem(WC_STORED_TOPIC_KEY)
    } catch {
      // ignore storage errors
    }
  }

  private readStoredTopic(): string | null {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(WC_STORED_TOPIC_KEY)
      const trimmed = raw?.trim() ?? ''
      return trimmed || null
    } catch {
      return null
    }
  }

  private writeStoredTopic(topic: string | null) {
    if (typeof window === 'undefined') return
    try {
      if (!topic) {
        localStorage.removeItem(WC_STORED_TOPIC_KEY)
        return
      }
      localStorage.setItem(WC_STORED_TOPIC_KEY, topic)
    } catch {
      // ignore storage errors
    }
  }

  private purgeWalletConnectStorage() {
    if (typeof window === 'undefined') return
    try {
      const keys = new Set(WC_PURGE_STORAGE_KEYS)
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (!key) continue
        const lower = key.toLowerCase()
        if (lower.includes('walletconnect') || lower.startsWith('wc@2:') || lower.startsWith('wc:')) {
          keys.add(key)
        }
      }
      for (const key of keys) {
        localStorage.removeItem(key)
      }
    } catch {
      // ignore storage errors
    }
  }

  private purgeStaleTopic(reason: string) {
    console.warn('[WC] stale topic detected → purging', { reason })
    this.purgeWalletConnectStorage()
    this.clearStoredTopic()
    this.resetPendingState()
  }

  private syncStoredTopic(sessions: SessionTypes.Struct[]) {
    const firstTopic = sessions[0]?.topic ?? null
    this.writeStoredTopic(firstTopic)
  }

  private validateStoredTopicOnRestore() {
    const storedTopic = this.readStoredTopic()
    if (!storedTopic) return
    const sessions = this.getActiveSessions()
    if (!sessions[storedTopic]) {
      this.purgeStaleTopic(`missing stored topic ${storedTopic}`)
    }
  }

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

  private selectPreferredChain(chains: string[]): string | null {
    if (chains.includes(WC_CHAIN_ID)) return WC_CHAIN_ID
    if (chains.includes(WC_CHAIN_ID_LEGACY)) return WC_CHAIN_ID_LEGACY
    return null
  }

  private getProposalEcashDetails(proposal: Web3WalletTypes.SessionProposal): { chains: string[]; methods: string[] } {
    const requiredEcash = proposal.params.requiredNamespaces?.[WC_NAMESPACE] as EcashProposalNamespace | undefined
    const optionalEcash = proposal.params.optionalNamespaces?.[WC_NAMESPACE] as EcashProposalNamespace | undefined
    const chains = Array.from(new Set([...(requiredEcash?.chains ?? []), ...(optionalEcash?.chains ?? [])]))
    const methods = Array.from(new Set([...(requiredEcash?.methods ?? []), ...(optionalEcash?.methods ?? [])]))
    return { chains, methods }
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
    if (kind === 'params') return { code: -32602, message: 'Params inválidos: offerId o outputs requeridos' }
    if (kind === 'method') return { code: -32601, message: 'Método no soportado' }
    if (kind === 'expired') return { code: -32000, message: 'Request expired' }
    if (kind === 'busy') return { code: -32000, message: 'Request busy' }
    return { code: -32000, message: 'Error al firmar/transmitir' }
  }

  private async respondError(topic: string, id: number, error: JsonRpcError) {
    if (!this.web3wallet) return
    try {
      await this.web3wallet.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          error
        }
      })
    } catch (err) {
      if (this.isStaleTopicError(err)) {
        this.purgeStaleTopic(err instanceof Error ? err.message : String(err))
        return
      }
      throw err
    }
  }

  private async respondSuccess(topic: string, id: number, result: unknown) {
    if (!this.web3wallet) return
    try {
      await this.web3wallet.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          result
        }
      })
    } catch (err) {
      if (this.isStaleTopicError(err)) {
        this.purgeStaleTopic(err instanceof Error ? err.message : String(err))
        return
      }
      throw err
    }
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
    const requestParams = unwrapWcParams(input) as Partial<SignAndBroadcastParams>
    const offerId =
      typeof requestParams.offerId === 'string' && requestParams.offerId.trim().length > 0
        ? requestParams.offerId.trim()
        : ''

    const rawHexInput = requestParams.rawHex ?? requestParams.unsignedTxHex
    if (rawHexInput !== undefined && typeof rawHexInput !== 'string') {
      return {
        params: null,
        error: { code: -32602, message: 'Params inválidos: rawHex/unsignedTxHex debe ser string' }
      }
    }
    if (requestParams.userPrompt !== undefined && typeof requestParams.userPrompt !== 'string') {
      return {
        params: null,
        error: { code: -32602, message: 'Params inválidos: userPrompt debe ser string' }
      }
    }
    const normalizedMessage =
      requestParams.message === undefined
        ? undefined
        : typeof requestParams.message === 'string'
          ? requestParams.message.trim()
          : null
    if (normalizedMessage === null) {
      return {
        params: null,
        error: { code: -32602, message: 'Params inválidos: message debe ser string' }
      }
    }

    const normalizePositiveIntString = (value: unknown): string | null => {
      if (typeof value === 'bigint') {
        if (value <= 0n) return null
        return value.toString()
      }
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value <= 0) return null
        return value.toString()
      }
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!/^\d+$/.test(trimmed)) return null
        try {
          const normalized = BigInt(trimmed)
          if (normalized <= 0n) return null
          return normalized.toString()
        } catch {
          return null
        }
      }
      return null
    }

    const topLevelOutputValueRaw =
      requestParams.valueSats !== undefined
        ? requestParams.valueSats
        : requestParams.sats !== undefined
          ? requestParams.sats
          : requestParams.value
    const normalizedTopLevelValue = topLevelOutputValueRaw === undefined ? undefined : normalizePositiveIntString(topLevelOutputValueRaw)
    if (topLevelOutputValueRaw !== undefined && !normalizedTopLevelValue) {
      return {
        params: null,
        error: { code: -32602, message: 'Params inválidos: valueSats/sats/value debe ser entero > 0' }
      }
    }

    const normalizedOutputs: Array<{ address: string; valueSats: string }> = []
    if (requestParams.outputs !== undefined) {
      if (!Array.isArray(requestParams.outputs)) {
        return {
          params: null,
          error: { code: -32602, message: 'Params inválidos: outputs debe ser un arreglo' }
        }
      }
      for (const output of requestParams.outputs) {
        if (!output || typeof output !== 'object') {
          return {
            params: null,
            error: { code: -32602, message: 'Params inválidos: cada output debe ser objeto' }
          }
        }
        const candidate = output as { address?: unknown; valueSats?: unknown; sats?: unknown; value?: unknown }
        if (typeof candidate.address !== 'string' || candidate.address.trim().length === 0) {
          return {
            params: null,
            error: { code: -32602, message: 'Params inválidos: output.address debe ser string' }
          }
        }
        const rawValueSats =
          candidate.valueSats !== undefined ? candidate.valueSats : candidate.sats !== undefined ? candidate.sats : candidate.value
        const normalizedValueSats =
          rawValueSats === undefined && normalizedTopLevelValue !== undefined
            ? normalizedTopLevelValue
            : normalizePositiveIntString(rawValueSats)
        if (!normalizedValueSats) {
          return {
            params: null,
            error: { code: -32602, message: 'Params inválidos: output.valueSats/sats/value debe ser entero > 0' }
          }
        }
        normalizedOutputs.push({
          address: candidate.address.trim(),
          valueSats: normalizedValueSats
        })
      }
    }

    const hasOutputs = normalizedOutputs.length > 0
    const normalizedRawHex = (rawHexInput as string | undefined)?.trim() || undefined
    const hasRawHex = Boolean(normalizedRawHex)
    const modeCandidate = requestParams.mode ?? requestParams.requestMode
    const explicitMode =
      modeCandidate === 'intent' || modeCandidate === 'legacy' || modeCandidate === 'tx' ? modeCandidate : undefined
    const requestMode: 'legacy' | 'intent' | 'tx' = explicitMode ?? (hasOutputs ? 'intent' : hasRawHex ? 'tx' : 'legacy')

    const normalizeOutpointValue = (item: unknown): string | null => {
      if (typeof item === 'string') return item.trim()
      if (!item || typeof item !== 'object') return null
      const candidate = item as { txid?: unknown; hash?: unknown; vout?: unknown; outIdx?: unknown; index?: unknown }
      const txid = typeof candidate.txid === 'string' ? candidate.txid.trim() : ''
      const hash = typeof candidate.hash === 'string' ? candidate.hash.trim() : ''
      const txidLike = txid || hash
      const outpointIdx =
        candidate.vout !== undefined
          ? candidate.vout
          : candidate.outIdx !== undefined
            ? candidate.outIdx
            : candidate.index
      const parsedOutpointIdx = typeof outpointIdx === 'string' ? Number(outpointIdx) : outpointIdx
      if (!txidLike || typeof parsedOutpointIdx !== 'number' || !Number.isSafeInteger(parsedOutpointIdx) || parsedOutpointIdx < 0) {
        return null
      }
      return `${txidLike}:${parsedOutpointIdx}`
    }

    const parseLegacyOutpoints = (key: 'inputsUsed' | 'outpoints'): { outpoints: string[] | null; error: JsonRpcError | null } => {
      const value = requestParams[key]
      if (value === undefined) return { outpoints: null, error: null }
      if (!Array.isArray(value)) {
        return {
          outpoints: null,
          error: { code: -32602, message: `Params inválidos: ${key} debe ser un arreglo` }
        }
      }
      const normalized: string[] = []
      for (const item of value) {
        const normalizedOutpoint = normalizeOutpointValue(item)
        if (!normalizedOutpoint || !parseLegacyOutpointString(normalizedOutpoint)) {
          const itemLabel =
            typeof item === 'string'
              ? item
              : (() => {
                  try {
                    return JSON.stringify(item)
                  } catch {
                    return String(item)
                  }
                })()
          return {
            outpoints: null,
            error: {
              code: -32602,
              message: `Params inválidos: ${key} contiene outpoint inválido "${itemLabel}". Usa formato txid:vout.`
            }
          }
        }
        normalized.push(normalizedOutpoint.toLowerCase())
      }
      return { outpoints: normalized, error: null }
    }

    const shouldParseLegacyOutpoints = requestMode === 'legacy' && !hasRawHex
    const parsedInputsUsed = shouldParseLegacyOutpoints ? parseLegacyOutpoints('inputsUsed') : { outpoints: null, error: null }
    if (parsedInputsUsed.error) return { params: null, error: parsedInputsUsed.error }

    const parsedOutpoints = shouldParseLegacyOutpoints ? parseLegacyOutpoints('outpoints') : { outpoints: null, error: null }
    if (parsedOutpoints.error) return { params: null, error: parsedOutpoints.error }
    if (!offerId && !hasOutputs && !hasRawHex) {
      return { params: null, error: this.normalizeJsonRpcError('params') }
    }

    return {
      params: {
        ...requestParams,
        mode: requestMode,
        offerId: offerId || undefined,
        rawHex: normalizedRawHex,
        outputs: normalizedOutputs.length > 0 ? normalizedOutputs : undefined,
        inputsUsed: parsedInputsUsed.outpoints ?? undefined,
        outpoints: parsedOutpoints.outpoints ?? undefined,
        message: normalizedMessage || undefined,
        userPrompt: requestParams.userPrompt?.trim() || undefined,
        requestMode
      },
      error: null
    }
  }

  private isUnsignedRawHex(rawHex: string): boolean {
    const normalizedRawHex = rawHex.trim()
    if (!isHexString(normalizedRawHex)) return false
    try {
      const parsedTx = Tx.fromHex(normalizedRawHex)
      return parsedTx.inputs.some((input) => (input.script?.bytecode.length ?? 0) === 0)
    } catch {
      return false
    }
  }

  private deriveOutputsFromRawHex(rawHex: string): Array<{ address: string; valueSats: number }> {
    const normalizedRawHex = rawHex.trim()
    if (!isHexString(normalizedRawHex)) {
      throw new Error('rawHex inválido')
    }
    const parsedTx = Tx.fromHex(normalizedRawHex)
    const outputs = parsedTx.outputs.map((output, index) => {
      const sats = typeof output.sats === 'bigint' ? Number(output.sats) : Number(output.sats)
      if (!Number.isSafeInteger(sats) || sats <= 0) {
        throw new Error(`No se pudo reconstruir output ${index}: sats inválidos`)
      }
      try {
        const address = Address.fromScript(output.script).cash().toString()
        return {
          address: ensureEcashPrefixed(address),
          valueSats: sats
        }
      } catch {
        throw new Error(
          `No se pudo reconstruir output ${index} desde rawHex. Incluye params.outputs para rawHex unsigned.`
        )
      }
    })
    if (!outputs.length) {
      throw new Error('No se pudo reconstruir outputs desde rawHex unsigned')
    }
    return outputs
  }

  private outputAddressToScript(address: string): Script {
    return Script.fromAddress(normalizeEcashAddressLikeYouAlreadyDid(ensureEcashPrefixed(address.trim())))
  }

  private getWalletConnectFeeRate(): number {
    const feeRate = resolveConfiguredWcFeeRate()
    return Math.max(feeRate ?? 0, MIN_WC_FEE_RATE)
  }

  private async inspectFeeStats(tx: Tx): Promise<{ txSize: number; fee: bigint; feeRate: number }> {
    const txSize = tx.serSize()
    const outputSats = tx.outputs.reduce((sum, output) => sum + BigInt(output.sats), 0n)
    const prevTxCache = new Map<string, Awaited<ReturnType<ReturnType<typeof getChronik>['tx']>>>()
    let inputSats = 0n
    for (const input of tx.inputs) {
      const prevTxid = typeof input.prevOut.txid === 'string' ? input.prevOut.txid : toHexRev(input.prevOut.txid)
      let prevTx = prevTxCache.get(prevTxid)
      if (!prevTx) {
        prevTx = await getChronik().tx(prevTxid)
        prevTxCache.set(prevTxid, prevTx)
      }
      const prevOutput = prevTx.outputs[input.prevOut.outIdx]
      if (!prevOutput) {
        throw new Error(`No se encontró el output previo ${prevTxid}:${input.prevOut.outIdx}`)
      }
      inputSats += BigInt(prevOutput.sats)
    }
    const fee = inputSats - outputSats
    if (fee < 0n) {
      throw new Error('Fee inválido: outputs exceden inputs')
    }
    const feeRate = txSize > 0 ? Number(fee) / txSize : 0
    return { txSize, fee, feeRate }
  }

  private async assertBroadcastFeePolicy(tx: Tx) {
    const { txSize, fee, feeRate } = await this.inspectFeeStats(tx)
    console.debug('[WCv2][Fee]', {
      size: txSize,
      feeSats: Number(fee),
      feeRate
    })
    if (fee < BigInt(txSize * MIN_MEMPOOL_POLICY_FEE_RATE)) {
      throw new Error('Fee too low for mempool policy')
    }
    if (feeRate < this.getWalletConnectFeeRate()) {
      throw new Error(`Fee rate too low for WalletConnect policy: ${feeRate.toFixed(2)} sat/byte`)
    }
  }

  private async signAndBroadcastRawHex(rawHex: string): Promise<{ txid: string }> {
    const normalizedRawHex = rawHex.trim()
    if (!isHexString(normalizedRawHex)) {
      throw new Error('rawHex inválido')
    }

    let parsedTx: Tx
    try {
      parsedTx = Tx.fromHex(normalizedRawHex)
    } catch {
      await getChronik().validateRawTx(normalizedRawHex)
      return getChronik().broadcastTx(normalizedRawHex)
    }
    const unsignedInputs = parsedTx.inputs
      .map((input, idx) => ({ input, idx }))
      .filter(({ input }) => (input.script?.bytecode.length ?? 0) === 0)

    // If all scriptSigs are already present, treat as signed tx and only validate+broadcast.
    if (unsignedInputs.length === 0) {
      await this.assertBroadcastFeePolicy(parsedTx)
      await getChronik().validateRawTx(normalizedRawHex)
      return getChronik().broadcastTx(normalizedRawHex)
    }

    const walletKeyInfo = xolosWalletService.getKeyInfo()
    const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
    if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
      throw new Error('No pudimos acceder a las llaves de tu billetera.')
    }

    const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
    const walletUtxos = await getChronik().address(xecAddress).utxos()
    const walletScript = new Script(fromHex(walletUtxos.outputScript))
    const walletUtxoMap = new Map<string, bigint>()
    for (const utxo of walletUtxos.utxos) {
      if (utxo.token) continue
      walletUtxoMap.set(`${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`, utxo.sats)
    }

    const builder = TxBuilder.fromTx(parsedTx)
    for (const { input, idx } of unsignedInputs) {
      const prevTxid = typeof input.prevOut.txid === 'string' ? input.prevOut.txid : toHexRev(input.prevOut.txid)
      const lookupKey = `${prevTxid}:${input.prevOut.outIdx}`
      const inputSats = walletUtxoMap.get(lookupKey)
      if (inputSats === undefined) {
        throw new Error(`No pudimos firmar input ${idx}: UTXO no encontrado en la billetera activa.`)
      }
      builder.inputs[idx].input.signData = {
        sats: inputSats,
        outputScript: walletScript
      }
      builder.inputs[idx].signatory = signer
    }

    const signedTx = builder.sign()
    const signedHex = signedTx.toHex()
    await this.assertBroadcastFeePolicy(signedTx)
    await getChronik().validateRawTx(signedHex)
    return getChronik().broadcastTx(signedHex)
  }

  private buildOpReturnScript(message: string): Script | null {
    const trimmed = message.trim()
    if (!trimmed) return null

    const payloadBytes = new TextEncoder().encode(trimmed)
    if (payloadBytes.length > 220) {
      throw new Error('message OP_RETURN excede 220 bytes')
    }

    const payloadHex =
      '6d02' +
      Array.from(payloadBytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    const payloadLength = payloadHex.length / 2

    let pushOpHex = ''
    if (payloadLength <= 75) {
      pushOpHex = payloadLength.toString(16).padStart(2, '0')
    } else if (payloadLength <= 0xff) {
      pushOpHex = `4c${payloadLength.toString(16).padStart(2, '0')}`
    } else {
      throw new Error('message OP_RETURN demasiado grande')
    }

    return new Script(fromHex(`6a${pushOpHex}${payloadHex}`))
  }

  private async buildSignBroadcastFromOutputs(
    outputs: Array<{ address: string; valueSats: string | number | bigint }>,
    message?: string
  ): Promise<{ txid: string }> {
    if (!outputs.length) {
      throw new Error('outputs vacío')
    }

    const walletKeyInfo = xolosWalletService.getKeyInfo()
    const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
    if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
      throw new Error('No pudimos acceder a las llaves de tu billetera.')
    }

    const recipientOutputs = outputs.map((output) => ({
      sats: BigInt(output.valueSats),
      script: this.outputAddressToScript(output.address)
    }))
    const opReturnScript = message ? this.buildOpReturnScript(message) : null
    const outputsWithMessage = opReturnScript ? [...recipientOutputs, { sats: 0n, script: opReturnScript }] : recipientOutputs
    const addressUtxos = await getChronik().address(xecAddress).utxos()
    const xecUtxos = addressUtxos.utxos
      .filter((utxo) => !utxo.token)
      .sort((a, b) => {
        if (a.sats === b.sats) return 0
        return a.sats > b.sats ? -1 : 1
      })

    if (!xecUtxos.length) {
      throw new Error('No hay UTXOs XEC disponibles para construir la transacción.')
    }

    const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
    const walletScript = this.outputAddressToScript(xecAddress)
    const feeRate = this.getWalletConnectFeeRate()
    const feePerKb = BigInt(feeRate) * 1000n
    let signedTxHex: string | null = null
    let signedTx: Tx | null = null
    let lastError: Error | null = null
    const selectedUtxos: typeof xecUtxos = []

    for (const utxo of xecUtxos) {
      selectedUtxos.push(utxo)
      const inputs = selectedUtxos.map((selected) => ({
        input: {
          prevOut: selected.outpoint,
          signData: {
            sats: selected.sats,
            outputScript: walletScript
          }
        },
        signatory: signer
      }))
      const builder = new TxBuilder({
        inputs,
        outputs: [...outputsWithMessage, walletScript]
      })

      try {
        signedTx = builder.sign({
          feePerKb,
          dustSats: BigInt(XEC_DUST_SATS)
        })
        signedTxHex = signedTx.toHex()
        break
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('Insufficient input sats') || err.message.includes('can only pay for'))
        ) {
          lastError = err
          continue
        }
        throw err
      }
    }

    if (!signedTxHex || !signedTx) {
      throw lastError ?? new Error('No hay suficiente XEC para cubrir outputs + fees.')
    }

    await this.assertBroadcastFeePolicy(signedTx)
    await getChronik().validateRawTx(signedTxHex)
    return getChronik().broadcastTx(signedTxHex)
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
          offerId: next.params.offerId ?? '',
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

  public async initialize(projectId?: string): Promise<void> {
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      if (this.web3wallet) return

      const resolvedProjectId =
        projectId?.trim() ||
        (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ||
        (import.meta.env.VITE_WC_PROJECT_ID as string | undefined)
      if (!resolvedProjectId) {
        this.setState({
          lastError: 'Falta WalletConnect Project ID (VITE_WALLETCONNECT_PROJECT_ID o VITE_WC_PROJECT_ID).'
        })
        throw new Error('Missing WalletConnect project id')
      }

      console.log('[WC] Initializing Web3Wallet Singleton...')
      this.core = new Core({ projectId: resolvedProjectId }) as unknown as Web3WalletTypes.Options['core']
      this.web3wallet = await Web3Wallet.init({
        core: this.core,
        metadata: {
          name: 'RMZ Wallet',
          description: 'eCash Wallet for Xolos Army',
          url: typeof window !== 'undefined' ? window.location.origin : 'https://app.tonalli.cash',
          icons: ['https://avatars.githubusercontent.com/u/37784886']
        }
      })
      this.setupEventListeners()
      this.setState({ initialized: true })
      this.validateStoredTopicOnRestore()
      this.refreshSessions()
      console.log('[WC] Web3Wallet initialized successfully.')
    })().catch((error) => {
      this.initPromise = null
      throw error
    })

    return this.initPromise
  }

  async init(projectId: string) {
    await this.initialize(projectId)
  }

  async pair(uri: string) {
    if (!this.core) {
      await this.initialize()
    }
    if (!this.core) {
      throw new Error('WalletConnect no está listo.')
    }
    this.setState({ lastPairUri: uri, lastError: null })
    await this.core.pairing.pair({ uri })
  }

  async disconnectSession(topic: string) {
    if (!this.web3wallet) return
    try {
      await this.web3wallet.disconnectSession({
        topic,
        reason: { code: 6000, message: 'Sesión terminada por el usuario.' }
      })
    } catch (err) {
      if (this.isStaleTopicError(err)) {
        this.purgeStaleTopic(err instanceof Error ? err.message : String(err))
        return
      }
      throw err
    }
    this.refreshSessions()
  }

  async approveSession(id: number, namespaces: SessionTypes.Namespaces, proposalChains?: string[]) {
    if (!this.web3wallet) {
      throw new Error('WalletConnect no está listo.')
    }
    try {
      const ecashNamespace = namespaces.ecash
      const activeAddress = xolosWalletService.getAddress()
      const fallbackAccount = ecashNamespace?.accounts?.[0]
      const fallbackAddressPart = fallbackAccount ? fallbackAccount.split(':').slice(2).join(':') : null
      const addressSource = activeAddress ?? fallbackAddressPart
      if (!addressSource) {
        throw new Error('Wallet not ready')
      }
      const normalizedAddress = normalizeEcashAddressLikeYouAlreadyDid(addressSource)
      if (normalizedAddress !== addressSource) {
        console.log('[wc] sanitized session account address', {
          from: addressSource,
          to: normalizedAddress
        })
      }

      const updatedNamespaces: SessionTypes.Namespaces = {
        ...namespaces,
        ecash: {
          ...ecashNamespace,
          chains: [WC_CHAIN_ID, WC_CHAIN_ID_LEGACY],
          methods: [WC_METHOD_SIGN_AND_BROADCAST, WC_METHOD_SIGN_AND_BROADCAST_ALIAS, WC_METHOD_GET_ADDRESSES],
          events: [WC_EVENT_ACCOUNTS_CHANGED],
          accounts: [`${WC_CHAIN_ID}:${normalizedAddress}`, `${WC_CHAIN_ID_LEGACY}:${normalizedAddress}`]
        }
      }

      console.log('[wc] approving session namespaces', updatedNamespaces)

      console.info('[WCv2] proposal approved', {
        id,
        proposalChains: proposalChains ?? ecashNamespace?.chains ?? [],
        selectedChain: WC_CHAIN_ID,
        approvedNamespaces: updatedNamespaces
      })
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
    if (!this.web3wallet) return {}
    try {
      return this.web3wallet.getActiveSessions?.() ?? {}
    } catch (err) {
      if (this.isStaleTopicError(err)) {
        this.purgeStaleTopic(err instanceof Error ? err.message : String(err))
        return {}
      }
      throw err
    }
  }

  refreshSessions() {
    if (!this.web3wallet) return
    const sessions = Object.values(this.getActiveSessions())
    this.setState({ sessions })
    this.syncStoredTopic(sessions)
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
    const { chains, methods } = this.getProposalEcashDetails(proposal)
    const selectedChain = this.selectPreferredChain(chains)
    const hasMethod = methods.includes(WC_METHOD_SIGN_AND_BROADCAST)
    return Boolean(selectedChain) && hasMethod
  }

  private setupEventListeners() {
    if (!this.web3wallet || this.handlersRegistered) return
    this.handlersRegistered = true
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
        const { chains, methods } = this.getProposalEcashDetails(proposal)
        const selectedChain = this.selectPreferredChain(chains)
        const errorMessage = selectedChain ? 'Unsupported method' : 'Unsupported chain'
        console.warn('[WCv2] proposal rejected by namespace/chains/methods', {
          id: proposal.id,
          proposalChains: chains,
          selectedChain,
          proposalMethods: methods,
          requiredNamespaces: proposal.params.requiredNamespaces
        })
        await this.rejectSession(proposal.id, { code: 5100, message: errorMessage })
        return
      }

      const { chains } = this.getProposalEcashDetails(proposal)
      const selectedChain = this.selectPreferredChain(chains)
      console.info('[WCv2] proposal received', {
        id: proposal.id,
        proposer: proposal.params.proposer.metadata,
        proposalChains: chains,
        selectedChain
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

      if (!isSignAndBroadcastMethod(request.method)) {
        await this.respondError(topic, id, this.normalizeJsonRpcError('method'))
        return
      }

      const session = this.getActiveSessions()[topic]
      const sessionChainId = session ? this.getChainForSession(session) : null
      const resolvedChainId = chainFromEvent ?? sessionChainId ?? WC_CHAIN_ID
      if (chainFromEvent && !this.isSupportedChain(chainFromEvent)) {
        await this.respondError(topic, id, { code: -32000, message: 'Unsupported chain' })
        return
      }
      if (chainFromEvent && sessionChainId && chainFromEvent !== sessionChainId) {
        await this.respondError(topic, id, { code: -32000, message: 'Unsupported chain' })
        return
      }
      if (!this.isSupportedChain(resolvedChainId)) {
        await this.respondError(topic, id, { code: -32000, message: 'Unsupported chain' })
        return
      }

      const paramsShape = detectWcParamsShape(request.params)
      const parsed = this.parseSignAndBroadcastParams(request.params)
      if (!parsed.params || parsed.error) {
        await this.respondError(topic, id, parsed.error ?? this.normalizeJsonRpcError('params'))
        return
      }

      if ((import.meta as unknown as { env?: Record<string, unknown> }).env?.DEV) {
        console.info('[WCv2] paramsShape', { shape: paramsShape })
      }
      console.info('[WCv2] normalized request', {
        method: request.method,
        mode: parsed.params.requestMode,
        outputsCount: parsed.params.outputs?.length ?? 0,
        hasRawHex: Boolean(parsed.params.rawHex),
        hasOutpoints: Boolean((parsed.params.inputsUsed?.length ?? 0) > 0 || (parsed.params.outpoints?.length ?? 0) > 0)
      })

      const verifyContext = this.validatePeer(session?.peer?.metadata)
      const payload: SessionRequestPayload = {
        id,
        topic,
        method: WC_METHOD_SIGN_AND_BROADCAST,
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
            hasOutputs: Boolean(parsed.params.outputs?.length),
            outputsCount: parsed.params.outputs?.length ?? 0,
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

    const offerId = pending.params.offerId ?? ''
    this.setState({ pendingRequestBusy: true, pendingRequestError: null, pendingRequestStatus: 'signing' })
    console.info('[WCv2] signAndBroadcast approve', { offerId, topic: pending.topic })

    try {
      let txid = ''
      const mode = pending.params.requestMode ?? (pending.params.outputs?.length ? 'intent' : pending.params.rawHex ? 'tx' : 'legacy')
      const outputsCount = pending.params.outputs?.length ?? 0
      const totalSats = (pending.params.outputs ?? []).reduce((sum, output) => sum + BigInt(output.valueSats), 0n)
      console.info('[WCv2] signAndBroadcast summary', {
        mode,
        outputsCount,
        totalSats: totalSats.toString()
      })
      if (mode === 'intent' && pending.params.outputs?.length) {
        console.info('[WC] intent-only flow')
        this.setState({ pendingRequestStatus: 'broadcasting' })
        const broadcast = await this.buildSignBroadcastFromOutputs(pending.params.outputs, pending.params.message)
        txid = broadcast.txid
      } else if (mode === 'tx' && pending.params.rawHex) {
        console.info('[WC] tx rawHex flow')
        this.setState({ pendingRequestStatus: 'broadcasting' })
        if (this.isUnsignedRawHex(pending.params.rawHex)) {
          const outputsForRebuild =
            pending.params.outputs && pending.params.outputs.length > 0
              ? pending.params.outputs
              : this.deriveOutputsFromRawHex(pending.params.rawHex)
          const broadcast = await this.buildSignBroadcastFromOutputs(outputsForRebuild, pending.params.message)
          txid = broadcast.txid
        } else {
          const broadcast = await this.signAndBroadcastRawHex(pending.params.rawHex)
          txid = broadcast.txid
        }
      } else {
        if (pending.params.rawHex) {
          console.info('[WC] legacy rawHex flow')
          this.setState({ pendingRequestStatus: 'broadcasting' })
          if (this.isUnsignedRawHex(pending.params.rawHex)) {
            const outputsForRebuild =
              pending.params.outputs && pending.params.outputs.length > 0
                ? pending.params.outputs
                : this.deriveOutputsFromRawHex(pending.params.rawHex)
            const broadcast = await this.buildSignBroadcastFromOutputs(outputsForRebuild, pending.params.message)
            txid = broadcast.txid
          } else {
            const broadcast = await this.signAndBroadcastRawHex(pending.params.rawHex)
            txid = broadcast.txid
          }
        } else if (pending.params.outputs?.length) {
          this.setState({ pendingRequestStatus: 'broadcasting' })
          const broadcast = await this.buildSignBroadcastFromOutputs(pending.params.outputs, pending.params.message)
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
      }

      if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
        throw new Error('Invalid txid returned from broadcast')
      }

      await this.respondSuccess(pending.topic, pending.id, { txid })
      console.info(`[WC] broadcast success txid=${txid}`)
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
      console.info('[WCv2] sign success / broadcast success', {
        offerId,
        mode,
        outputsCount,
        totalSats: totalSats.toString(),
        txid
      })
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
      offerId: pending.params.offerId ?? '',
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
      offerId: pending.params.offerId ?? '',
      peer: pending.peer?.name ?? pending.peer?.url ?? 'unknown',
      topic: pending.topic,
      status: 'error',
      error: 'Request expired',
      createdAt: pending.createdAt,
      method: pending.method
    })
  }
}

export const wcWallet = WcWallet.getInstance()
