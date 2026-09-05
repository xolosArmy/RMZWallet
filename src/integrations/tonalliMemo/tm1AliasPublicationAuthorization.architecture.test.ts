import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  Tm1AliasPublicationAuthorizer,
  createTm1AliasPublicationAuthorizer,
  createTm1InMemoryAliasPublicationAuthorizationLedger
} from './tm1AliasPublicationAuthorization'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

const runtime = source('./tm1AliasPublicationAuthorization.ts')

const ALIAS = 'xolosarmy.xec'
const OWNER = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'
const TXID = 'ab'.repeat(32)

function issueRequest() {
  return {
    alias: ALIAS,
    ownerAddress: OWNER,
    evidence: {
      alias: ALIAS,
      address: OWNER,
      txid: TXID,
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
    expect(runtime).not.toMatch(/verificationPort|VerificationPort|verifyOnChain/)
  })

  test('hides replay collections behind a module-private WeakMap and internal mutators', () => {
    expect(runtime).toContain('new WeakMap<object,')
    expect(runtime).toContain('function hasProof(')
    expect(runtime).toContain('function recordProof(')
    expect(runtime).toContain('function lastHeight(')
    expect(runtime).toContain('function recordHeight(')
    expect(runtime).not.toMatch(/function\s+(reset|clear)/)
    expect(runtime).not.toMatch(/\.clear\s*\(/)
    expect(runtime).not.toMatch(/this\.ledger\.consumedProofs/)
    expect(runtime).not.toMatch(/this\.ledger\.latestBlockHeightByAlias/)
  })

  test('create() and factory parse the opaque ledger', () => {
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
  })

  test('running consumedProofs.clear() after issue does not re-issue the same proof', () => {
    const ledger = createTm1InMemoryAliasPublicationAuthorizationLedger()
    const issuer = createTm1AliasPublicationAuthorizer(ledger)
    issuer.issue(issueRequest())

    const leaked = ledger as {
      consumedProofs?: Set<string>
      latestBlockHeightByAlias?: Map<string, number>
      clear?: () => void
      reset?: () => void
    }
    leaked.consumedProofs?.clear()
    leaked.latestBlockHeightByAlias?.clear()
    leaked.clear?.()
    leaked.reset?.()

    for (const key of Reflect.ownKeys(ledger)) {
      const value = Reflect.get(ledger as object, key)
      if (value instanceof Set || value instanceof Map) value.clear()
    }

    const bag = {
      consumedProofs: new Set<string>(),
      latestBlockHeightByAlias: new Map<string, number>()
    }
    expect(() => createTm1AliasPublicationAuthorizer(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    const Stolen = Tm1AliasPublicationAuthorizer as unknown as {
      new (ledger: unknown): unknown
    }
    expect(() => new Stolen(bag)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => createTm1AliasPublicationAuthorizer(Object.create(ledger))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => createTm1AliasPublicationAuthorizer(new Proxy(ledger, {}))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )

    expect(() => createTm1AliasPublicationAuthorizer(ledger).issue(issueRequest())).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })
})
