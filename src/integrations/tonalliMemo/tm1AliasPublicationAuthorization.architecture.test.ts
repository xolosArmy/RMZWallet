import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import * as aliasAuth from './tm1AliasPublicationAuthorization'
import {
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer
} from './tm1AliasPublicationAuthorization'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

const runtime = source('./tm1AliasPublicationAuthorization.ts')

const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const UNTRUSTED = { code: 'ALIAS_EVIDENCE_UNTRUSTED' }

function issueRequest(tag: string) {
  const alias = `${tag}.xec`
  const bytes = Array.from(tag, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  const txid = (bytes + 'ab'.repeat(32)).slice(0, 64)
  return {
    alias,
    ownerAddress: OWNER,
    evidence: {
      alias,
      address: OWNER,
      txid,
      blockHeight: 100,
      status: 'confirmed'
    }
  }
}

describe('TM1 alias publication authorization isolation', () => {
  test('does not become a signer, broadcast or Chronik client', () => {
    expect(runtime).not.toMatch(/broadcastTx|\.broadcast\s*\(|\.sign\s*\(/)
    expect(runtime).not.toMatch(/TxBuilder|fromWIF|seedPhrase|mnemonic/)
    expect(runtime).not.toMatch(/ChronikClient|chronik-client|DeliveryTransport/)
    expect(runtime).not.toMatch(/createTm1RemoteRollbackWitness|createTm1InMemoryRollbackWitness/)
    expect(runtime).not.toMatch(/alias\.ecash\.mx/)
  })

  test('does not auto-wire App, routes, or publication UI', () => {
    expect(source('../../App.tsx')).not.toContain('AliasPublication')
    expect(source('../../App.tsx')).not.toContain('tm1AliasPublicationAuthorization')
    expect(runtime).not.toMatch(/from ['"]react|WalletContext|localStorage/)
    expect(runtime).not.toMatch(/RegisterAlias|MemoDraft|approveAndBroadcast/)
  })

  test('reuses existing alias format helpers only', () => {
    const imports = Array.from(
      runtime.matchAll(/from\s+['"]([^'"]+)['"]/g),
      match => match[1]
    )
    expect(imports).toEqual(['../../utils/alias'])
  })

  test('records that caller-supplied evidence is not sufficient to enable publication', () => {
    expect(runtime).toContain('NOT SUFFICIENT TO ENABLE PUBLICATION')
    expect(runtime).toContain('ALIAS_EVIDENCE_UNTRUSTED')
    expect(runtime).not.toMatch(/verifyOnChain/)
  })

  test('hides replay collections behind a module-private WeakMap and uncurried mutators', () => {
    expect(runtime).toContain('new WeakMap<object,')
    expect(runtime).toContain('function hasProof(')
    expect(runtime).toContain('function recordProof(')
    expect(runtime).toContain('function lastHeight(')
    expect(runtime).toContain('function recordHeight(')
    expect(runtime).toContain('Function.prototype.call.bind(WeakMap.prototype.has)')
    expect(runtime).toContain('Function.prototype.call.bind(WeakMap.prototype.get)')
    expect(runtime).toContain('Function.prototype.call.bind(WeakMap.prototype.set)')
    expect(runtime).toContain('Function.prototype.call.bind(Set.prototype.has)')
    expect(runtime).toContain('Function.prototype.call.bind(Set.prototype.add)')
    expect(runtime).toContain('Function.prototype.call.bind(Map.prototype.get)')
    expect(runtime).toContain('Function.prototype.call.bind(Map.prototype.set)')
    expect(runtime).toContain('Function.prototype.call.bind(Array.prototype.join)')
    expect(runtime).toContain('Function.prototype.call.bind(String)')
    expect(runtime).not.toMatch(/function\s+(reset|clear)/)
    expect(runtime).not.toMatch(/\.clear\s*\(/)
    expect(runtime).not.toMatch(/this\.ledger\.consumedProofs/)
    expect(runtime).not.toMatch(/this\.ledger\.latestBlockHeightByAlias/)
    expect(runtime).not.toMatch(/ledgerStates\.(has|get|set)\s*\(/)
    expect(runtime).not.toMatch(/consumedProofs\.(has|add)\s*\(/)
    expect(runtime).not.toMatch(/latestBlockHeightByAlias\.(get|set)\s*\(/)
  })

  test('create() and factory parse the opaque process-local ledger', () => {
    const constructorBody = runtime.slice(
      runtime.indexOf('private constructor('),
      runtime.indexOf('static create(')
    )
    const createBody = runtime.slice(
      runtime.indexOf('static create('),
      runtime.indexOf('\n  issue(')
    )
    const factoryBody = runtime.slice(
      runtime.indexOf('export function createTm1AliasPublicationAuthorizer'),
      runtime.indexOf('export function parseTm1AliasPublicationAuthorization')
    )
    expect(constructorBody).toContain('parseLedger')
    expect(createBody).toContain('parseLedger')
    expect(factoryBody).toContain('parseLedger')
    expect(createBody).not.toMatch(/ledgerValue/)
    expect(factoryBody).not.toMatch(/ledgerValue/)
  })

  test('export surface has no ledger factory and no verified-mint', () => {
    expect(Object.keys(aliasAuth).sort()).toEqual([
      'TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL',
      'TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION',
      'Tm1AliasPublicationAuthorizationError',
      'Tm1AliasPublicationAuthorizer',
      'createTm1AliasPublicationAuthorizer',
      'parseTm1AliasPublicationAuthorization'
    ])
    expect(runtime).not.toMatch(/export function createTm1InMemoryAliasPublicationAuthorizationLedger/)
    expect(runtime).not.toMatch(/export function mintVerifiedAliasPublicationEvidence/)
    expect(aliasAuth).not.toHaveProperty('createTm1InMemoryAliasPublicationAuthorizationLedger')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
  })

  test('verified commit records proof before freeze/join/String', () => {
    const commit = runtime.slice(
      runtime.indexOf('function commitVerifiedAuthorization'),
      runtime.indexOf('export class Tm1AliasPublicationAuthorizer')
    )
    const recordProofIndex = commit.indexOf('recordProof(')
    const recordHeightIndex = commit.indexOf('recordHeight(')
    const joinIndex = commit.indexOf('arrayJoin(')
    const freezeIndex = commit.indexOf('objectFreeze(')
    expect(recordProofIndex).toBeGreaterThan(-1)
    expect(recordHeightIndex).toBeGreaterThan(recordProofIndex)
    expect(joinIndex).toBeGreaterThan(recordHeightIndex)
    expect(freezeIndex).toBeGreaterThan(joinIndex)
    expect(commit).not.toMatch(/Object\.freeze\s*\(/)
    expect(commit).not.toMatch(/\.join\s*\(/)
    expect(commit).not.toMatch(/\bString\s*\(/)
  })

  test('caller-supplied confirmed evidence is untrusted and does not issue', () => {
    const issuer = createTm1AliasPublicationAuthorizer()
    const request = issueRequest('archclr')
    expect(() => issuer.issue(request)).toThrowError(expect.objectContaining(UNTRUSTED))

    const leaked = issuer as unknown as {
      consumedProofs?: Set<string>
      latestBlockHeightByAlias?: Map<string, number>
      ledger?: {
        consumedProofs?: Set<string>
        latestBlockHeightByAlias?: Map<string, number>
      }
      clear?: () => void
      reset?: () => void
    }
    leaked.consumedProofs?.clear()
    leaked.latestBlockHeightByAlias?.clear()
    leaked.ledger?.consumedProofs?.clear()
    leaked.ledger?.latestBlockHeightByAlias?.clear()
    leaked.clear?.()
    leaked.reset?.()

    const bag = {
      consumedProofs: new Set<string>(),
      latestBlockHeightByAlias: new Map<string, number>()
    }
    const Stolen = Tm1AliasPublicationAuthorizer as unknown as {
      new (ledger: unknown): unknown
    }
    expect(() => new Stolen(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => createTm1AliasPublicationAuthorizer().issue(request)).toThrowError(
      expect.objectContaining(UNTRUSTED)
    )
  })

  test('P1-C: patched freeze/join/String reentry yields no durable auths', () => {
    const request = issueRequest('archp1c')
    const issuer = createTm1AliasPublicationAuthorizer()
    const auths: unknown[] = []
    const originalFreeze = Object.freeze
    const originalJoin = Array.prototype.join
    const OriginalString = String
    let reentering = false
    const looksLikeAuth = (value: unknown): boolean => (
      value !== null
      && typeof value === 'object'
      && 'authorizationId' in value
    )
    const reenter = () => {
      if (reentering) return
      reentering = true
      try {
        auths.push(issuer.issue(request))
      } catch {
        /* fail-closed */
      }
    }
    try {
      Object.freeze = ((value: unknown) => {
        if (looksLikeAuth(value)) reenter()
        return originalFreeze(value as object)
      }) as typeof Object.freeze
      Array.prototype.join = function (this: unknown[], separator?: string) {
        const result = originalJoin.call(this, separator)
        if (typeof result === 'string' && result.startsWith('tm1-alias-auth:v1:')) reenter()
        return result
      }
      const wrappedString = function String(value?: unknown) {
        if (new.target) return new OriginalString(value as string)
        return OriginalString(value)
      } as unknown as StringConstructor
      Object.defineProperty(wrappedString, 'prototype', { value: OriginalString.prototype })
      globalThis.String = wrappedString
      try {
        auths.push(issuer.issue(request))
      } catch {
        /* fail-closed */
      }
    } finally {
      Object.freeze = originalFreeze
      Array.prototype.join = originalJoin
      globalThis.String = OriginalString
    }
    expect(auths).toHaveLength(0)
  })
})
