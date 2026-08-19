import type { ApprovalConsumptionLedger } from '../../features/externalSign/approval'
import type { calculateUniversalContentHash } from '../../features/externalSign/contentHash'
import {
  UniversalAuthorizationCore
} from '../../features/externalSign/core'
import type { UniversalOperationLock } from '../../features/externalSign/lock'
import {
  Tm1RegtestAuthorizationAdapter,
  type Tm1RegtestAuthorizationDecisionProvider,
  type Tm1RegtestAuthorizationRequester
} from './tm1RegtestAuthorizationAdapter'
import {
  Tm1RegtestBroadcastAuthorizationAdapter,
  type Tm1RegtestBroadcastAuthorizationDecisionProvider,
  type Tm1RegtestBroadcastAuthorizationRequester
} from './tm1RegtestBroadcastAuthorizationAdapter'
import type {
  Tm1BroadcastAuthorizationPort,
  Tm1SigningAuthorizationPort
} from './tm1RegtestPublicationOrchestrator'

export const TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX =
  'tm1-regtest.signing-authorization:'

export const TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX =
  'tm1-regtest.broadcast-authorization:'

export type Tm1RegtestDualAuthorizationCoreDependencies = Readonly<{
  enabled: boolean
  lock: UniversalOperationLock
  approvalLedger: ApprovalConsumptionLedger
  createCapabilityId?: (operationId: string) => string
  calculateHash?: typeof calculateUniversalContentHash
}>

export type Tm1RegtestSigningAuthorizationCompositionConfig = Readonly<{
  decisionProvider: Tm1RegtestAuthorizationDecisionProvider
  ttlMs: number
  requester: Tm1RegtestAuthorizationRequester
}>

export type Tm1RegtestBroadcastAuthorizationCompositionConfig = Readonly<{
  decisionProvider: Tm1RegtestBroadcastAuthorizationDecisionProvider
  ttlMs: number
  requester: Tm1RegtestBroadcastAuthorizationRequester
}>

export type Tm1RegtestDualAuthorizationCompositionDependencies = Readonly<{
  /**
   * The lock must be dedicated to this composition/orchestrator. The ledger
   * may be longer-lived or shared, but must reject every previously consumed
   * capabilityId globally across operations, profiles, and publication cycles.
   */
  core: Tm1RegtestDualAuthorizationCoreDependencies
  now: () => number
  createOperationIdSuffix: () => string
  signing: Tm1RegtestSigningAuthorizationCompositionConfig
  broadcast: Tm1RegtestBroadcastAuthorizationCompositionConfig
}>

export type Tm1RegtestDualAuthorizationPorts = Readonly<{
  signingAuthorization: Tm1SigningAuthorizationPort
  broadcastAuthorization: Tm1BroadcastAuthorizationPort
}>

export type Tm1RegtestDualAuthorizationCompositionErrorCode =
  | 'INVALID_COMPOSITION_CONFIGURATION'
  | 'DECISION_PROVIDERS_MUST_BE_DISTINCT'
  | 'DUPLICATE_OPERATION_ID'
  | 'DUPLICATE_CAPABILITY_ID'

export class Tm1RegtestDualAuthorizationCompositionError extends Error {
  readonly code: Tm1RegtestDualAuthorizationCompositionErrorCode

  constructor(code: Tm1RegtestDualAuthorizationCompositionErrorCode) {
    super(code)
    this.name = 'Tm1RegtestDualAuthorizationCompositionError'
    this.code = code
  }
}

export function createTm1RegtestDualAuthorizationPorts(
  dependencies: Tm1RegtestDualAuthorizationCompositionDependencies
): Tm1RegtestDualAuthorizationPorts {
  const now = dependencies.now
  const createOperationIdSuffix = dependencies.createOperationIdSuffix
  const signing = dependencies.signing
  const broadcast = dependencies.broadcast
  const coreDependencies = dependencies.core

  if (
    typeof now !== 'function' ||
    typeof createOperationIdSuffix !== 'function' ||
    !coreDependencies ||
    !signing ||
    !broadcast
  ) {
    throw new Tm1RegtestDualAuthorizationCompositionError(
      'INVALID_COMPOSITION_CONFIGURATION'
    )
  }
  if (
    signing.decisionProvider as object ===
    broadcast.decisionProvider as object
  ) {
    throw new Tm1RegtestDualAuthorizationCompositionError(
      'DECISION_PROVIDERS_MUST_BE_DISTINCT'
    )
  }

  const issuedOperationIds = new Set<string>()
  const createScopedOperationId = (prefix: string): string => {
    const suffix = createOperationIdSuffix()
    if (typeof suffix !== 'string') {
      throw new Tm1RegtestDualAuthorizationCompositionError(
        'INVALID_COMPOSITION_CONFIGURATION'
      )
    }
    const operationId = `${prefix}${suffix}`
    if (issuedOperationIds.has(operationId)) {
      throw new Tm1RegtestDualAuthorizationCompositionError('DUPLICATE_OPERATION_ID')
    }
    issuedOperationIds.add(operationId)
    return operationId
  }

  const createCapabilityId = coreDependencies.createCapabilityId === undefined
    ? undefined
    : guardCapabilityIdFactory(coreDependencies.createCapabilityId)

  const authorizationCore = new UniversalAuthorizationCore({
    enabled: coreDependencies.enabled,
    lock: coreDependencies.lock,
    approvalLedger: coreDependencies.approvalLedger,
    now,
    ...(createCapabilityId === undefined ? {} : { createCapabilityId }),
    ...(coreDependencies.calculateHash === undefined
      ? {}
      : { calculateHash: coreDependencies.calculateHash })
  })

  const signingAuthorization: Tm1SigningAuthorizationPort =
    new Tm1RegtestAuthorizationAdapter({
      core: authorizationCore,
      decisionProvider: signing.decisionProvider,
      now,
      ttlMs: signing.ttlMs,
      createOperationId: () => createScopedOperationId(
        TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX
      ),
      requester: signing.requester
    })

  const broadcastAuthorization: Tm1BroadcastAuthorizationPort =
    new Tm1RegtestBroadcastAuthorizationAdapter({
      core: authorizationCore,
      decisionProvider: broadcast.decisionProvider,
      now,
      ttlMs: broadcast.ttlMs,
      createOperationId: () => createScopedOperationId(
        TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX
      ),
      requester: broadcast.requester
    })

  return Object.freeze({
    signingAuthorization,
    broadcastAuthorization
  })
}

function guardCapabilityIdFactory(
  createCapabilityId: (operationId: string) => string
): (operationId: string) => string {
  const issuedCapabilityIds = new Set<string>()

  return operationId => {
    const capabilityId = createCapabilityId(operationId)
    if (issuedCapabilityIds.has(capabilityId)) {
      throw new Tm1RegtestDualAuthorizationCompositionError('DUPLICATE_CAPABILITY_ID')
    }
    issuedCapabilityIds.add(capabilityId)
    return capabilityId
  }
}
