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

  test('export surface has no ledger factory', () => {
    expect(Object.keys(aliasAuth).sort()).toEqual([
      'TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL',
      'TM1_ALIAS_PUBLICATION_AUTHORIZATION_PROTOCOL_VERSION',
      'Tm1AliasPublicationAuthorizationError',
      'Tm1AliasPublicationAuthorizer',
      'createTm1AliasPublicationAuthorizer',
      'parseTm1AliasPublicationAuthorization'
    ])
    expect(runtime).not.toMatch(/export function createTm1InMemoryAliasPublicationAuthorizationLedger/)
    expect(aliasAuth).not.toHaveProperty('createTm1InMemoryAliasPublicationAuthorizationLedger')
  })

  test('running consumedProofs.clear() after issue does not re-issue the same proof', () => {
    const issuer = createTm1AliasPublicationAuthorizer()
    const request = issueRequest('archclr')
    issuer.issue(request)

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

    for (const key of Reflect.ownKeys(issuer)) {
      const value = Reflect.get(issuer as object, key)
      if (value instanceof Set || value instanceof Map) value.clear()
    }

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
    expect(() => new Stolen(Object.create(issuer))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )
    expect(() => new Stolen(new Proxy(issuer, {}))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ALIAS_AUTHORIZATION_INPUT' })
    )

    expect(() => createTm1AliasPublicationAuthorizer().issue(request)).toThrowError(
      expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
    )
  })

  test('P1-A: patched WeakMap/Set/Map prototypes cannot re-issue after clear', () => {
    const request = issueRequest('archp1a')
    const issuer = createTm1AliasPublicationAuthorizer()
    issuer.issue(request)
    const originals = {
      weakMapGet: WeakMap.prototype.get,
      weakMapHas: WeakMap.prototype.has,
      weakMapSet: WeakMap.prototype.set,
      setHas: Set.prototype.has,
      setAdd: Set.prototype.add,
      mapGet: Map.prototype.get,
      mapSet: Map.prototype.set
    }
    const receivers: object[] = []
    try {
      WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
        receivers.push(this)
        const value = originals.weakMapGet.call(this, key)
        if (typeof value === 'object' && value !== null) receivers.push(value)
        return value
      } as typeof WeakMap.prototype.get
      WeakMap.prototype.has = function (this: WeakMap<object, unknown>, key: object) {
        receivers.push(this)
        return originals.weakMapHas.call(this, key)
      } as typeof WeakMap.prototype.has
      WeakMap.prototype.set = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
        receivers.push(this)
        if (typeof value === 'object' && value !== null) receivers.push(value)
        return originals.weakMapSet.call(this, key, value)
      } as typeof WeakMap.prototype.set
      Set.prototype.has = function (this: Set<unknown>, value: unknown) {
        receivers.push(this)
        return originals.setHas.call(this, value)
      } as typeof Set.prototype.has
      Set.prototype.add = function (this: Set<unknown>, value: unknown) {
        receivers.push(this)
        return originals.setAdd.call(this, value)
      } as typeof Set.prototype.add
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        receivers.push(this)
        return originals.mapGet.call(this, key)
      } as typeof Map.prototype.get
      Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        receivers.push(this)
        return originals.mapSet.call(this, key, value)
      } as typeof Map.prototype.set

      try {
        issuer.issue(request)
      } catch {
        /* records receivers if prototype-dispatched */
      }
      for (const receiver of receivers) {
        if (receiver instanceof Set || receiver instanceof Map) receiver.clear()
        else if (typeof receiver === 'object' && receiver !== null) {
          const state = receiver as {
            consumedProofs?: Set<unknown>
            latestBlockHeightByAlias?: Map<unknown, unknown>
          }
          state.consumedProofs?.clear()
          state.latestBlockHeightByAlias?.clear()
        }
      }
      expect(() => issuer.issue(request)).toThrowError(
        expect.objectContaining({ code: 'ALIAS_PROOF_REPLAYED' })
      )
    } finally {
      WeakMap.prototype.get = originals.weakMapGet
      WeakMap.prototype.has = originals.weakMapHas
      WeakMap.prototype.set = originals.weakMapSet
      Set.prototype.has = originals.setHas
      Set.prototype.add = originals.setAdd
      Map.prototype.get = originals.mapGet
      Map.prototype.set = originals.mapSet
    }
  })
})
