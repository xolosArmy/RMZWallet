import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import * as portApi from './tm1AliasOwnershipVerificationPort'
import * as aliasAuth from './tm1AliasPublicationAuthorization'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = (relativePath: string): string => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8'
)

const portRuntime = source('./tm1AliasOwnershipVerificationPort.ts')
const app = source('../../App.tsx')
const registerAlias = source('../../routes/RegisterAlias.tsx')
const orchestrator = source('./tm1RegtestPublicationOrchestrator.ts')

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkTs(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('TM1 alias ownership verification port isolation', () => {
  test('H: App, RegisterAlias, and orchestrator do not import the port or mint', () => {
    expect(app).not.toContain('tm1AliasOwnershipVerificationPort')
    expect(app).not.toContain('tm1AliasOwnershipVerificationPort.testFetch')
    expect(app).not.toContain('tm1AliasVerifiedOwnershipMint')
    expect(app).not.toContain('tm1AliasPublicationAuthorization')
    expect(registerAlias).not.toContain('tm1AliasOwnershipVerificationPort')
    expect(registerAlias).not.toContain('tm1AliasOwnershipVerificationPort.testFetch')
    expect(registerAlias).not.toContain('tm1AliasVerifiedOwnershipMint')
    expect(orchestrator).not.toContain('tm1AliasOwnershipVerificationPort')
    expect(orchestrator).not.toContain('tm1AliasOwnershipVerificationPort.testFetch')
    expect(orchestrator).not.toContain('tm1AliasVerifiedOwnershipMint')
  })

  test('does not export mint or a public success path for caller JSON', () => {
    expect(Object.keys(portApi).sort()).toEqual([
      'Tm1AliasOwnershipVerificationError',
      'Tm1AliasOwnershipVerificationPort',
      'createTm1AliasOwnershipVerificationPort',
      'lookupTm1VerifiedAliasOwnershipToken'
    ])
    expect(portApi).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
    expect(portApi).not.toHaveProperty('mintVerifiedAliasOwnershipEvidence')
    expect(portApi).not.toHaveProperty('mintVerifiedAliasOwnershipToken')
    expect(portApi).not.toHaveProperty('mintTm1VerifiedAliasOwnershipToken')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasOwnershipEvidence')
    expect(aliasAuth).not.toHaveProperty('mintTm1VerifiedAliasOwnershipToken')
    expect(aliasAuth).not.toHaveProperty('createTm1InMemoryAliasPublicationAuthorizationLedger')
    expect(portRuntime).not.toMatch(/export\s+(async\s+)?function\s+mint/)
    expect(portRuntime).not.toMatch(/export\s+\{[^}]*\bmint\w*/)
  })

  test('no mint* export exists under src/integrations/tonalliMemo', () => {
    const files = walkTs(here)
    expect(files.some(path => path.endsWith('tm1AliasVerifiedOwnershipMint.ts'))).toBe(false)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/export\s+(async\s+)?function\s+mint/)
      expect(text, file).not.toMatch(/export\s+(const|let|var)\s+mint/)
      expect(text, file).not.toMatch(/export\s+\{[^}]*\bmint\w*/)
    }
  })

  test('does not sign, broadcast, auto-wire UI, or default to a network observer', () => {
    expect(portRuntime).not.toMatch(/broadcastTx|\.broadcast\s*\(|\.sign\s*\(/)
    expect(portRuntime).not.toMatch(/TxBuilder|fromWIF|seedPhrase|mnemonic/)
    expect(portRuntime).not.toMatch(/ChronikClient|chronik-client/)
    expect(portRuntime).not.toMatch(/from ['"]react|WalletContext|localStorage/)
    expect(portRuntime).not.toMatch(/RegisterAlias|MemoDraft|approveAndBroadcast/)
    expect(portRuntime).toContain('https://alias.ecash.mx/alias')
    expect(portRuntime).toContain('NOT SUFFICIENT TO ENABLE PUBLICATION')
  })

  test('public factory binds trusted transport and rejects fetch/endpointUrl', () => {
    const parsePublic = portRuntime.slice(
      portRuntime.indexOf('function parsePublicCreate('),
      portRuntime.indexOf('function readTrustedNow(')
    )
    expect(parsePublic).toContain('allowedRecord(value, [])')
    expect(parsePublic).not.toContain("'fetch'")
    expect(parsePublic).not.toContain("'endpointUrl'")
    expect(parsePublic).not.toContain("'observe'")
    expect(portRuntime).toContain("TRUSTED_ALIAS_ENDPOINT = 'https://alias.ecash.mx/alias'")
    expect(portRuntime).toContain('const fetchImpl = globalThis.fetch')
    expect(portRuntime).not.toContain('trustedFetch')
    expect(portApi).not.toHaveProperty('createTm1AliasOwnershipVerificationPortForTests')
    expect(portRuntime).toContain('observeAliasOwnership')
    expect(portRuntime).not.toContain('createTm1InMemory')
    expect(portRuntime).not.toMatch(/Date\.now\s*\(/)
    expect(portRuntime).not.toMatch(/request\.now/)
  })

  test('production class and factory ownKeys do not yield a test constructor', () => {
    const standard = new Set<PropertyKey>(['length', 'name', 'prototype'])
    const classKeys = Reflect.ownKeys(portApi.Tm1AliasOwnershipVerificationPort)
      .filter(key => !standard.has(key))
    expect(classKeys).toEqual(['create'])
    const factoryKeys = Reflect.ownKeys(portApi.createTm1AliasOwnershipVerificationPort)
      .filter(key => !standard.has(key))
    expect(factoryKeys).toEqual([])
    expect(portRuntime).not.toContain('TEST_SEAM')
    expect(portRuntime).not.toContain('createForTests')
    expect(portRuntime).not.toContain('parseTestDeps')
    expect(portRuntime).not.toContain('ForTests')
  })
})
