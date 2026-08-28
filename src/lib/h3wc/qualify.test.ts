import { describe, expect, test } from 'vitest'
import {
  H3WC_CHAIN,
  H3WC_EVENTS,
  H3WC_GRANT_VERSION,
  H3WC_METHODS,
  H3WC_PROFILE,
  type H3wcIdentity,
  type H3wcPeerExpectation,
  type H3wcProposal,
  type H3wcSession,
  type H3wcSessionCandidate
} from './contracts'
import { identityToH3wcAccount } from './identity'
import { qualifyExactH3wcSession, qualifyH3wcProposal } from './qualify'

const identity: H3wcIdentity = {
  address: 'ecash:qptestaddress',
  publicKey: `02${'11'.repeat(32)}`
}
const account = identityToH3wcAccount(identity)
const peer: H3wcPeerExpectation = { origin: 'https://x402.ecash.mx' }
const topic = 'a'.repeat(64)
const context = {
  nowSeconds: 1_800_000_000,
  expectedTopic: topic,
  peer,
  expectedAccount: account,
  expectedIdentity: identity,
  qualificationEpoch: 7
}

const namespace = (overrides: Record<string, unknown> = {}) => ({
  chains: [H3WC_CHAIN],
  methods: [...H3WC_METHODS],
  events: [...H3WC_EVENTS],
  accounts: [account],
  ...overrides
})

const session = (overrides: Partial<H3wcSession> = {}): H3wcSession => ({
  topic,
  expiry: context.nowSeconds + 240,
  namespaces: { ecash: namespace() },
  peer: { publicKey: 'peer-key', metadata: { url: peer.origin } },
  acknowledged: true,
  ...overrides
})

const candidate = (overrides: Partial<H3wcSessionCandidate> = {}): H3wcSessionCandidate => ({
  session: session(),
  grantVersion: H3WC_GRANT_VERSION,
  profile: H3WC_PROFILE,
  live: true,
  revoked: false,
  qualificationEpoch: context.qualificationEpoch,
  ...overrides
})

const proposal = (overrides: Partial<H3wcProposal> = {}): H3wcProposal => ({
  id: 11,
  requiredNamespaces: { ecash: namespace({ accounts: [] }) },
  proposer: { publicKey: 'peer-key', metadata: { url: peer.origin } },
  ...overrides
})

const rejectCode = (value: ReturnType<typeof qualifyExactH3wcSession>) => {
  expect(value.status).toBe('REJECTED')
  return value.status === 'REJECTED' ? value.code : ''
}

describe('H3WC exact effective grant qualification', () => {
  test('accepts the exact approved session and equivalent array ordering', () => {
    expect(qualifyExactH3wcSession(candidate(), context).status).toBe('QUALIFIED')
    expect(qualifyExactH3wcSession(candidate({
      session: session({
        namespaces: {
          ecash: namespace({ methods: [...H3WC_METHODS].reverse(), chains: [H3WC_CHAIN] })
        }
      })
    }), context).status).toBe('QUALIFIED')
  })

  test.each([
    ['transaction method', { methods: [...H3WC_METHODS, 'ecash_signAndBroadcastTransaction'] }, 'METHOD_SET_MISMATCH'],
    ['arbitrary method', { methods: [...H3WC_METHODS, 'ecash_arbitrary'] }, 'METHOD_SET_MISMATCH'],
    ['removed method', { methods: ['ecash_getAccountIdentity'] }, 'METHOD_SET_MISMATCH'],
    ['extra event', { events: ['accountsChanged'] }, 'EVENT_SET_MISMATCH'],
    ['changed chain', { chains: ['ecash:2'] }, 'CHAIN_SET_MISMATCH'],
    ['added account', { accounts: [account, `${account}x`] }, 'ACCOUNT_SET_MISMATCH'],
    ['duplicate method', { methods: [H3WC_METHODS[0], H3WC_METHODS[0]] }, 'DUPLICATE_VALUE']
  ])('rejects %s without narrowing it', (_label, override, expected) => {
    const result = qualifyExactH3wcSession(candidate({
      session: session({ namespaces: { ecash: namespace(override) } })
    }), context)
    expect(rejectCode(result)).toBe(expected)
  })

  test('rejects topic, peer, expiry, liveness, epoch, profile and identity drift', () => {
    expect(rejectCode(qualifyExactH3wcSession(candidate({ session: session({ topic: 'other' }) }), context))).toBe('INVALID_TOPIC')
    expect(rejectCode(qualifyExactH3wcSession(candidate({ session: session({ peer: { metadata: { url: 'https://evil.example' } } }) }), context))).toBe('PEER_ORIGIN_MISMATCH')
    expect(rejectCode(qualifyExactH3wcSession(candidate({ session: session({ expiry: context.nowSeconds }) }), context))).toBe('SESSION_EXPIRED')
    expect(rejectCode(qualifyExactH3wcSession(candidate({ live: false }), context))).toBe('SESSION_NOT_LIVE')
    expect(rejectCode(qualifyExactH3wcSession(candidate({ qualificationEpoch: 8 }), context))).toBe('QUALIFICATION_EPOCH_MISMATCH')
    expect(rejectCode(qualifyExactH3wcSession(candidate({ profile: 'legacy' }), context))).toBe('PROFILE_MISMATCH')
    expect(rejectCode(qualifyExactH3wcSession(candidate({
      session: session({ namespaces: { ecash: namespace({ accounts: [`${account}x`] }) } })
    }), context))).toBe('ACCOUNT_SET_MISMATCH')
  })

  test('rejects a legacy broad session and never trusts proposal origin', () => {
    const legacy = candidate({
      session: session({
        namespaces: {
          ecash: namespace({ methods: [...H3WC_METHODS, 'ecash_signAndBroadcast'] })
        }
      })
    })
    expect(rejectCode(qualifyExactH3wcSession(legacy, context))).toBe('METHOD_SET_MISMATCH')
    expect(qualifyExactH3wcSession(candidate(), {
      ...context,
      expectedTopic: `${topic}other`
    }).status).toBe('REJECTED')
  })
})

describe('H3WC proposal normalization boundary', () => {
  test('accepts exact required and the known empty-required/optional-normalized shape', () => {
    expect(qualifyH3wcProposal(proposal(), peer).status).toBe('QUALIFIED')
    expect(qualifyH3wcProposal(proposal({
      requiredNamespaces: {},
      optionalNamespaces: { ecash: namespace({ accounts: [] }) }
    }), peer).status).toBe('QUALIFIED')
  })

  test('rejects extra optional authority and conflicting required/optional grants', () => {
    expect(qualifyH3wcProposal(proposal({
      requiredNamespaces: {},
      optionalNamespaces: { ecash: namespace({ methods: [...H3WC_METHODS, 'ecash_signAndBroadcast'] }) }
    }), peer)).toMatchObject({ status: 'REJECTED', code: 'METHOD_SET_MISMATCH' })
    expect(qualifyH3wcProposal(proposal({
      requiredNamespaces: { ecash: namespace({ accounts: [] }) },
      optionalNamespaces: { ecash: namespace({ events: ['accountsChanged'], accounts: [] }) }
    }), peer)).toMatchObject({ status: 'REJECTED', code: 'EVENT_SET_MISMATCH' })
  })
})
