import {
  H3WC_CHAIN,
  H3WC_EVENTS,
  H3WC_GRANT_VERSION,
  H3WC_METHODS,
  H3WC_PROFILE,
  type H3wcNamespace,
  type H3wcPeer,
  type H3wcProposal,
  type H3wcQualificationContext,
  type H3wcQualificationFailure,
  type H3wcQualificationResult,
  type H3wcSessionCandidate
} from './contracts'
import { identityToH3wcAccount, validateH3wcIdentity } from './identity'
import { H3wcPeerError, qualifyH3wcPeer } from './peer'

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const failure = (
  code: H3wcQualificationFailure['code'],
  detail: string
): H3wcQualificationFailure => Object.freeze({ status: 'REJECTED', code, detail })

const isFailure = (value: unknown): value is H3wcQualificationFailure => (
  isRecord(value) && value.status === 'REJECTED'
)

const equalStrings = (left: readonly string[], right: readonly string[]) => (
  left.length === right.length && left.every((value, index) => value === right[index])
)

/**
 * Exact set comparison is order independent but duplicate sensitive.  A
 * duplicate is never silently collapsed because doing so would hide malformed
 * authority data from the reviewer.
 */
function compareExactSet(
  value: unknown,
  expected: readonly string[],
  label: string
): H3wcQualificationFailure | readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    return failure('NAMESPACE_INVALID', `${label} must be an array of strings`)
  }
  const actual = [...value]
  if (new Set(actual).size !== actual.length) {
    return failure('DUPLICATE_VALUE', `${label} contains a duplicate value`)
  }
  const orderedActual = [...actual].sort()
  const orderedExpected = [...expected].sort()
  if (!equalStrings(orderedActual, orderedExpected)) {
    const code = label === 'chains'
      ? 'CHAIN_SET_MISMATCH'
      : label === 'methods' ? 'METHOD_SET_MISMATCH'
        : label === 'events' ? 'EVENT_SET_MISMATCH' : 'ACCOUNT_SET_MISMATCH'
    return failure(code, `${label} is not the exact H3WC grant`)
  }
  return Object.freeze(actual)
}

function readNamespace(value: unknown, allowMissingAccounts: boolean): H3wcNamespace | H3wcQualificationFailure {
  if (!isRecord(value)) return failure('NAMESPACE_INVALID', 'ecash namespace is not an object')
  const allowedKeys = allowMissingAccounts
    ? ['accounts', 'chains', 'events', 'methods']
    : ['accounts', 'chains', 'events', 'methods']
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    return failure('NAMESPACE_INVALID', 'ecash namespace contains unknown authority fields')
  }
  const chains = compareExactSet(value.chains, [H3WC_CHAIN], 'chains')
  if (isFailure(chains)) return chains
  const methods = compareExactSet(value.methods, H3WC_METHODS, 'methods')
  if (isFailure(methods)) return methods
  const events = compareExactSet(value.events, H3WC_EVENTS, 'events')
  if (isFailure(events)) return events

  const accountsValue = value.accounts
  if (accountsValue === undefined && allowMissingAccounts) {
    return Object.freeze({ chains, methods, events, accounts: [] })
  }
  if (!Array.isArray(accountsValue) || !accountsValue.every((item): item is string => typeof item === 'string')) {
    return failure('NAMESPACE_INVALID', 'accounts must be an array of strings')
  }
  const accounts = [...accountsValue]
  if (new Set(accounts).size !== accounts.length) {
    return failure('DUPLICATE_VALUE', 'accounts contains a duplicate value')
  }
  if (accounts.some(account => !/^ecash:1:[qp][a-z0-9]+$/u.test(account))) {
    return failure('ACCOUNT_SET_MISMATCH', 'accounts contain a non-canonical ecash CAIP-10 account')
  }
  return Object.freeze({ chains, methods, events, accounts })
}

type NamespaceMapResult = H3wcQualificationFailure | { namespace: H3wcNamespace }

function readNamespaceMap(value: unknown, allowMissingAccounts: boolean): NamespaceMapResult {
  if (!isRecord(value)) return failure('NAMESPACE_INVALID', 'namespace map is not an object')
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'ecash') {
    return failure('NAMESPACE_SET_MISMATCH', 'only the ecash namespace is permitted')
  }
  const namespace = readNamespace(value.ecash, allowMissingAccounts)
  if (isFailure(namespace)) return namespace
  return { namespace }
}

function readProposalNamespaceMap(value: unknown): NamespaceMapResult | null {
  if (isRecord(value) && Object.keys(value).length === 0) return null
  return readNamespaceMap(value, true)
}

function proposalNamespace(proposal: H3wcProposal): H3wcNamespace | H3wcQualificationFailure {
  const required = proposal.requiredNamespaces === undefined
    ? null
    : readProposalNamespaceMap(proposal.requiredNamespaces)
  const optional = proposal.optionalNamespaces === undefined
    ? null
    : readProposalNamespaceMap(proposal.optionalNamespaces)

  if (!required && !optional) return failure('NAMESPACE_INVALID', 'proposal has no namespace grant')
  if (required && 'status' in required) return required
  if (optional && 'status' in optional) return optional
  const requiredNamespace = required && 'namespace' in required ? required.namespace : null
  const optionalNamespace = optional && 'namespace' in optional ? optional.namespace : null
  if (requiredNamespace && optionalNamespace) {
    const same = (
      equalStrings([...requiredNamespace.chains].sort(), [...optionalNamespace.chains].sort())
      && equalStrings([...requiredNamespace.methods].sort(), [...optionalNamespace.methods].sort())
      && equalStrings([...requiredNamespace.events].sort(), [...optionalNamespace.events].sort())
    )
    if (!same) return failure('NAMESPACE_SET_MISMATCH', 'required and optional grants conflict')
  }
  return requiredNamespace ?? optionalNamespace ?? failure('NAMESPACE_INVALID', 'proposal grant is empty')
}

function proposalPeer(proposal: H3wcProposal): H3wcPeer | undefined {
  if (!proposal.proposer) return undefined
  return Object.freeze({
    publicKey: proposal.proposer.publicKey,
    metadata: proposal.proposer.metadata
  })
}

/**
 * Proposal validation tolerates the known SignClient normalization from a
 * required namespace into an optional namespace.  It never uses that shape as
 * authority: the final approved session is always qualified separately.
 */
export function qualifyH3wcProposal(
  proposal: H3wcProposal,
  expectedPeer: H3wcQualificationContext['peer']
): H3wcQualificationResult {
  const namespace = proposalNamespace(proposal)
  if ('status' in namespace) return namespace
  try {
    const peerOrigin = qualifyH3wcPeer(proposalPeer(proposal), expectedPeer)
    return Object.freeze({
      status: 'QUALIFIED',
      topic: `proposal:${proposal.id}`,
      account: namespace.accounts[0] ?? '',
      peerOrigin,
      expiresAt: Number.POSITIVE_INFINITY,
      qualificationEpoch: 0
    })
  } catch (error) {
    if (error instanceof H3wcPeerError) return failure(error.code, error.message)
    return failure('PEER_ORIGIN_INVALID', 'proposal peer could not be qualified')
  }
}

/**
 * Qualify only the effective approved/restored session.  No proposal field is
 * consulted here, and no malformed session is repaired or narrowed.
 */
export function qualifyExactH3wcSession(
  candidate: H3wcSessionCandidate,
  context: H3wcQualificationContext
): H3wcQualificationResult {
  if (!candidate || !isRecord(candidate) || !isRecord(candidate.session)) {
    return failure('INVALID_SESSION', 'H3WC session candidate is not an object')
  }
  const session = candidate.session
  if (typeof session.topic !== 'string' || session.topic.length === 0) {
    return failure('INVALID_TOPIC', 'H3WC session topic is missing')
  }
  if (session.topic !== context.expectedTopic) {
    return failure('INVALID_TOPIC', 'H3WC session topic does not match the request')
  }
  if (!Number.isSafeInteger(session.expiry)) return failure('INVALID_EXPIRY', 'H3WC session expiry is invalid')
  if (session.expiry <= context.nowSeconds) return failure('SESSION_EXPIRED', 'H3WC session has expired')
  if (candidate.revoked) return failure('SESSION_REVOKED', 'H3WC session is revoked')
  if (!candidate.live || session.acknowledged !== true) {
    return failure('SESSION_NOT_LIVE', 'H3WC session is not live and acknowledged')
  }
  if (candidate.qualificationEpoch !== context.qualificationEpoch) {
    return failure('QUALIFICATION_EPOCH_MISMATCH', 'H3WC qualification epoch is stale')
  }
  if (candidate.grantVersion !== (context.expectedGrantVersion ?? H3WC_GRANT_VERSION)) {
    return failure('GRANT_VERSION_MISMATCH', 'H3WC grant version is not exact')
  }
  if (candidate.profile !== (context.expectedProfile ?? H3WC_PROFILE)) {
    return failure('PROFILE_MISMATCH', 'H3WC profile is not exact')
  }
  if (!/^ecash:1:[qp][a-z0-9]+$/u.test(context.expectedAccount)) {
    return failure('ACCOUNT_SET_MISMATCH', 'expected account is not canonical ecash CAIP-10')
  }

  const namespaces = readNamespaceMap(session.namespaces, false)
  if (!('namespace' in namespaces)) return namespaces
  const accountResult = compareExactSet(
    namespaces.namespace.accounts,
    [context.expectedAccount],
    'accounts'
  )
  if (isFailure(accountResult)) return accountResult

  if (context.expectedIdentity) {
    try {
      const identity = validateH3wcIdentity(context.expectedIdentity)
      if (identityToH3wcAccount(identity) !== context.expectedAccount) {
        return failure('IDENTITY_INVALID', 'active identity does not bind to the session account')
      }
    } catch (error) {
      return failure('IDENTITY_INVALID', error instanceof Error ? error.message : 'identity is invalid')
    }
  }

  try {
    const peerOrigin = qualifyH3wcPeer(session.peer, context.peer)
    return Object.freeze({
      status: 'QUALIFIED',
      topic: session.topic,
      account: context.expectedAccount,
      peerOrigin,
      expiresAt: session.expiry,
      qualificationEpoch: context.qualificationEpoch
    })
  } catch (error) {
    if (error instanceof H3wcPeerError) return failure(error.code, error.message)
    return failure('PEER_ORIGIN_INVALID', 'session peer could not be qualified')
  }
}
