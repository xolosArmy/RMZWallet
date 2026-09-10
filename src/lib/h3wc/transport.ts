import { Core } from '@xolosarmy/h3wc-core'
import {
  WalletKit,
  type WalletKitTypes
} from '@xolosarmy/h3wc-walletkit'
import {
  H3WC_CHAIN,
  H3WC_COORDINATION_CHANNEL,
  H3WC_GRANT_VERSION,
  H3WC_IDENTITY_UNAVAILABLE,
  H3WC_IDENTITY_UNAVAILABLE_CODE,
  H3WC_INVALID_SESSION,
  H3WC_INVALID_SESSION_CODE,
  H3WC_METHOD_IDENTITY,
  H3WC_METHODS,
  H3WC_PROFILE,
  H3WC_SIGNING_NOT_ENABLED,
  H3WC_SIGNING_NOT_ENABLED_CODE,
  H3WC_STORAGE_PREFIX,
  type H3wcIdentity,
  type H3wcPeerExpectation,
  type H3wcProposal,
  type H3wcQualificationResult,
  type H3wcRpcResponse,
  type H3wcSession,
  type H3wcSessionCandidate
} from './contracts'
import { H3WC_PRODUCTION_WALLET_ORIGIN } from './config'
import { identityToH3wcAccount, validateH3wcIdentity, type H3wcIdentityProvider } from './identity'
import { qualifyExactH3wcSession, qualifyH3wcProposal } from './qualify'

export type H3wcWalletMetadata = Readonly<{
  name: string
  description: string
  url: string
  icons: readonly string[]
}>

export const DEFAULT_H3WC_WALLET_METADATA: H3wcWalletMetadata = Object.freeze({
  name: 'Tonalli H3WC',
  description: 'Tonalli authorization-only WalletConnect transport',
  url: H3WC_PRODUCTION_WALLET_ORIGIN,
  icons: []
})

export type H3wcProposalDecision = Readonly<{
  proposal: H3wcProposal
  approve(identity: H3wcIdentity): Promise<unknown>
  reject(): Promise<void>
}>

export type H3wcTransportOptions = Readonly<{
  projectId: string
  expectedPeer: H3wcPeerExpectation
  ownerEpoch?: string
  identityProvider?: H3wcIdentityProvider
  metadata?: H3wcWalletMetadata
  nowSeconds?: () => number
  onProposal?: (decision: H3wcProposalDecision) => Promise<void> | void
}>

export type H3wcRestoredSession = Readonly<{
  session: H3wcSession
  qualification: H3wcQualificationResult
}>

export interface H3wcWalletTransport {
  readonly storagePrefix: typeof H3WC_STORAGE_PREFIX
  readonly coordinationChannelName: typeof H3WC_COORDINATION_CHANNEL
  restore(): Promise<readonly H3wcRestoredSession[]>
  approveProposal(proposal: H3wcProposal, identity: H3wcIdentity): Promise<unknown>
  rejectProposal(proposal: H3wcProposal): Promise<void>
  getActiveSessions(): readonly H3wcSession[]
  disconnect(topic: string): Promise<void>
  stop(): void
}

export class H3wcTransportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'H3wcTransportError'
    this.code = code
  }
}

type WalletKitLike = Awaited<ReturnType<typeof WalletKit.init>>
type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

function asSession(value: unknown): H3wcSession | null {
  if (!isRecord(value) || typeof value.topic !== 'string' || typeof value.expiry !== 'number') return null
  return Object.freeze({
    topic: value.topic,
    expiry: value.expiry,
    namespaces: value.namespaces,
    peer: isRecord(value.peer) ? {
      publicKey: typeof value.peer.publicKey === 'string' ? value.peer.publicKey : undefined,
      metadata: isRecord(value.peer.metadata) ? {
        name: typeof value.peer.metadata.name === 'string' ? value.peer.metadata.name : undefined,
        description: typeof value.peer.metadata.description === 'string' ? value.peer.metadata.description : undefined,
        url: typeof value.peer.metadata.url === 'string' ? value.peer.metadata.url : undefined,
        icons: Array.isArray(value.peer.metadata.icons)
          ? value.peer.metadata.icons.filter((item): item is string => typeof item === 'string')
          : undefined,
        publicKey: typeof value.peer.metadata.publicKey === 'string' ? value.peer.metadata.publicKey : undefined
      } : undefined
    } : undefined,
    acknowledged: value.acknowledged === true,
    controller: typeof value.controller === 'string' ? value.controller : undefined
  })
}

function asProposal(value: unknown): H3wcProposal | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) return null
  const id = value.id
  if (typeof id !== 'number') return null
  const proposer = isRecord(value.params) && isRecord(value.params.proposer)
    ? value.params.proposer
    : isRecord(value.proposer) ? value.proposer : undefined
  const metadata = proposer && isRecord(proposer.metadata) ? proposer.metadata : undefined
  return Object.freeze({
    id,
    requiredNamespaces: isRecord(value.params) ? value.params.requiredNamespaces : value.requiredNamespaces,
    optionalNamespaces: isRecord(value.params) ? value.params.optionalNamespaces : value.optionalNamespaces,
    proposer: proposer ? {
      publicKey: typeof proposer.publicKey === 'string' ? proposer.publicKey : undefined,
      metadata: metadata ? {
        name: typeof metadata.name === 'string' ? metadata.name : undefined,
        description: typeof metadata.description === 'string' ? metadata.description : undefined,
        url: typeof metadata.url === 'string' ? metadata.url : undefined,
        icons: Array.isArray(metadata.icons)
          ? metadata.icons.filter((item): item is string => typeof item === 'string')
          : undefined,
        publicKey: typeof metadata.publicKey === 'string' ? metadata.publicKey : undefined
      } : undefined
    } : undefined
  })
}

function asSessionRequest(value: unknown): Readonly<{
  id: number
  topic: string
  chainId: string
  method: string
  params: unknown
}> | null {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || typeof value.topic !== 'string') return null
  const request = isRecord(value.params) ? value.params.request : undefined
  if (!isRecord(request) || typeof request.method !== 'string') return null
  return {
    id: value.id,
    topic: value.topic,
    chainId: typeof request.chainId === 'string' ? request.chainId : typeof value.chainId === 'string' ? value.chainId : '',
    method: request.method,
    params: request.params
  }
}

function rpcError(code: number, message: string): H3wcRpcResponse {
  return {
    id: 0,
    jsonrpc: '2.0',
    error: { code, message }
  }
}

export function createH3wcSigningDisabledResponse(requestId: number): H3wcRpcResponse {
  return {
    id: requestId,
    jsonrpc: '2.0',
    error: { code: H3WC_SIGNING_NOT_ENABLED_CODE, message: H3WC_SIGNING_NOT_ENABLED }
  }
}

class H3wcWalletTransportImpl implements H3wcWalletTransport {
  readonly storagePrefix = H3WC_STORAGE_PREFIX
  readonly coordinationChannelName = H3WC_COORDINATION_CHANNEL
  private qualificationEpoch = 0
  private active = true
  private readonly listeners: Array<() => void> = []

  private readonly walletKit: WalletKitLike
  private readonly options: H3wcTransportOptions

  constructor(walletKit: WalletKitLike, options: H3wcTransportOptions) {
    this.walletKit = walletKit
    this.options = options
    this.walletKit.on('session_proposal', event => {
      void this.handleProposal(event)
    })
    this.walletKit.on('session_request', event => {
      void this.handleRequest(event)
    })
    this.walletKit.on('session_delete', () => {
      this.qualificationEpoch += 1
    })
    this.walletKit.on('proposal_expire', () => {
      this.qualificationEpoch += 1
    })
    this.walletKit.engine.signClient.events.on('session_update', this.handleSessionMutation)
    this.walletKit.engine.signClient.events.on('session_expire', this.handleSessionMutation)
    this.listeners.push(
      () => this.walletKit.off('session_proposal', this.handleProposal),
      () => this.walletKit.off('session_request', this.handleRequest),
      () => this.walletKit.engine.signClient.events.off('session_update', this.handleSessionMutation),
      () => this.walletKit.engine.signClient.events.off('session_expire', this.handleSessionMutation)
    )
  }

  private readonly handleSessionMutation = (): void => {
    this.qualificationEpoch += 1
  }

  private readonly handleProposal = async (event: WalletKitTypes.EventArguments['session_proposal']): Promise<void> => {
    const proposal = asProposal(event)
    if (!proposal) return
    const qualification = qualifyH3wcProposal(proposal, this.options.expectedPeer)
    if (qualification.status !== 'QUALIFIED' || !this.options.onProposal) {
      await this.rejectProposal(proposal)
      return
    }
    await this.options.onProposal({
      proposal,
      approve: identity => this.approveProposal(proposal, identity),
      reject: () => this.rejectProposal(proposal)
    })
  }

  private readonly handleRequest = async (event: WalletKitTypes.EventArguments['session_request']): Promise<void> => {
    const request = asSessionRequest(event)
    if (!request) return
    const operationEpoch = this.qualificationEpoch
    if (!this.active) return
    const session = asSession(this.walletKit.getActiveSessions()[request.topic])
    if (!session) {
      await this.respond(request.topic, request.id, rpcError(H3WC_INVALID_SESSION_CODE, H3WC_INVALID_SESSION))
      return
    }
    const identity = this.options.identityProvider
      ? await this.options.identityProvider.getActiveIdentity()
      : null
    if (!this.active || operationEpoch !== this.qualificationEpoch) return
    if (!identity) {
      await this.respond(request.topic, request.id, rpcError(H3WC_IDENTITY_UNAVAILABLE_CODE, H3WC_IDENTITY_UNAVAILABLE))
      return
    }
    let validatedIdentity: H3wcIdentity
    try {
      validatedIdentity = validateH3wcIdentity(identity)
    } catch {
      await this.respond(request.topic, request.id, rpcError(H3WC_IDENTITY_UNAVAILABLE_CODE, H3WC_IDENTITY_UNAVAILABLE))
      return
    }

    const candidate: H3wcSessionCandidate = {
      session,
      grantVersion: H3WC_GRANT_VERSION,
      profile: H3WC_PROFILE,
      live: true,
      revoked: false,
      qualificationEpoch: this.qualificationEpoch
    }
    const qualification = qualifyExactH3wcSession(candidate, {
      nowSeconds: this.nowSeconds(),
      expectedTopic: request.topic,
      peer: this.options.expectedPeer,
      expectedAccount: identityToH3wcAccount(validatedIdentity),
      expectedIdentity: validatedIdentity,
      qualificationEpoch: this.qualificationEpoch
    })
    if (!this.active || operationEpoch !== this.qualificationEpoch) return
    if (qualification.status !== 'QUALIFIED' || request.chainId !== H3WC_CHAIN) {
      await this.respond(request.topic, request.id, rpcError(H3WC_INVALID_SESSION_CODE, H3WC_INVALID_SESSION))
      return
    }

    if (request.method === H3WC_METHOD_IDENTITY) {
      await this.respond(request.topic, request.id, {
        id: request.id,
        jsonrpc: '2.0',
        result: validatedIdentity
      })
      return
    }
    if (request.method === 'ecash_signMessage') {
      // B1 intentionally stops at this boundary.  No signing primitive is
      // imported or reachable through this transport candidate.
      await this.respond(request.topic, request.id, createH3wcSigningDisabledResponse(request.id))
      return
    }
    await this.respond(request.topic, request.id, rpcError(H3WC_INVALID_SESSION_CODE, H3WC_INVALID_SESSION))
  }

  private nowSeconds(): number {
    return this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1000)
  }

  private async respond(topic: string, requestId: number, response: H3wcRpcResponse): Promise<void> {
    const normalized = response.id === 0 ? { ...response, id: requestId } : response
    await this.walletKit.respondSessionRequest({ topic, response: normalized })
  }

  async restore(): Promise<readonly H3wcRestoredSession[]> {
    if (!this.active) return Object.freeze([])
    this.qualificationEpoch += 1
    const identity = this.options.identityProvider
      ? await this.options.identityProvider.getActiveIdentity()
      : null
    const validatedIdentity = identity ? validateH3wcIdentity(identity) : null
    const expectedAccount = validatedIdentity ? identityToH3wcAccount(validatedIdentity) : ''
    const sessions = this.getActiveSessions()
    return Object.freeze(sessions.map(session => {
      const candidate: H3wcSessionCandidate = {
        session,
        grantVersion: H3WC_GRANT_VERSION,
        profile: H3WC_PROFILE,
        live: true,
        revoked: false,
        qualificationEpoch: this.qualificationEpoch
      }
      const qualification = qualifyExactH3wcSession(candidate, {
        nowSeconds: this.nowSeconds(),
        expectedTopic: session.topic,
        peer: this.options.expectedPeer,
        expectedAccount,
        expectedIdentity: validatedIdentity ?? undefined,
        qualificationEpoch: this.qualificationEpoch
      })
      return Object.freeze({ session, qualification })
    }))
  }

  async approveProposal(proposal: H3wcProposal, identity: H3wcIdentity): Promise<unknown> {
    const proposalQualification = qualifyH3wcProposal(proposal, this.options.expectedPeer)
    if (proposalQualification.status !== 'QUALIFIED') {
      throw new H3wcTransportError(proposalQualification.code, proposalQualification.detail)
    }
    const validatedIdentity = validateH3wcIdentity(identity)
    const account = identityToH3wcAccount(validatedIdentity)
    const session = await this.walletKit.approveSession({
      id: proposal.id,
      namespaces: {
        ecash: {
          chains: [H3WC_CHAIN],
          methods: [...H3WC_METHODS],
          events: [],
          accounts: [account]
        }
      }
    })
    const normalizedSession = asSession(session)
    if (!normalizedSession) throw new H3wcTransportError('INVALID_SESSION', 'WalletKit returned no H3WC session')
    const qualification = qualifyExactH3wcSession({
      session: normalizedSession,
      grantVersion: H3WC_GRANT_VERSION,
      profile: H3WC_PROFILE,
      live: true,
      revoked: false,
      qualificationEpoch: this.qualificationEpoch
    }, {
      nowSeconds: this.nowSeconds(),
      expectedTopic: normalizedSession.topic,
      peer: this.options.expectedPeer,
      expectedAccount: account,
      expectedIdentity: validatedIdentity,
      qualificationEpoch: this.qualificationEpoch
    })
    if (qualification.status !== 'QUALIFIED') {
      throw new H3wcTransportError(qualification.code, qualification.detail)
    }
    return normalizedSession
  }

  async rejectProposal(proposal: H3wcProposal): Promise<void> {
    await this.walletKit.rejectSession({
      id: proposal.id,
      reason: { code: 5000, message: 'H3WC_SESSION_REJECTED' }
    })
  }

  getActiveSessions(): readonly H3wcSession[] {
    return Object.freeze(Object.values(this.walletKit.getActiveSessions())
      .map(asSession)
      .filter((session): session is H3wcSession => session !== null))
  }

  async disconnect(topic: string): Promise<void> {
    if (!topic) throw new H3wcTransportError('INVALID_TOPIC', 'H3WC session topic is empty')
    await this.walletKit.disconnectSession({
      topic,
      reason: { code: 6000, message: 'H3WC_SESSION_DISCONNECTED' }
    })
    this.qualificationEpoch += 1
  }

  stop(): void {
    this.active = false
    this.qualificationEpoch += 1
    for (const remove of this.listeners.splice(0)) remove()
  }
}

export async function createH3wcWalletTransport(options: H3wcTransportOptions): Promise<H3wcWalletTransport> {
  if (!options.projectId || !options.expectedPeer.origin) {
    throw new H3wcTransportError('H3WC_CONFIGURATION_INVALID', 'H3WC project and peer configuration are required')
  }
  const core = new Core({
    projectId: options.projectId,
    customStoragePrefix: H3WC_STORAGE_PREFIX
  })
  const walletKit = await WalletKit.init({
    core,
    metadata: options.metadata
      ? { ...options.metadata, icons: [...options.metadata.icons] }
      : { ...DEFAULT_H3WC_WALLET_METADATA, icons: [...DEFAULT_H3WC_WALLET_METADATA.icons] }
  })
  return new H3wcWalletTransportImpl(walletKit, options)
}
