import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import * as portApi from './tm1AliasOwnershipVerificationPort'
import * as aliasAuth from './tm1AliasPublicationAuthorization'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

const portRuntime = source('./tm1AliasOwnershipVerificationPort.ts')
const mintRuntime = source('./tm1AliasVerifiedOwnershipMint.ts')
const app = source('../../App.tsx')
const registerAlias = source('../../routes/RegisterAlias.tsx')
const orchestrator = source('./tm1RegtestPublicationOrchestrator.ts')

describe('TM1 alias ownership verification port isolation', () => {
  test('H: App, RegisterAlias, and orchestrator do not import the port or mint', () => {
    expect(app).not.toContain('tm1AliasOwnershipVerificationPort')
    expect(app).not.toContain('tm1AliasVerifiedOwnershipMint')
    expect(app).not.toContain('tm1AliasPublicationAuthorization')
    expect(registerAlias).not.toContain('tm1AliasOwnershipVerificationPort')
    expect(registerAlias).not.toContain('tm1AliasVerifiedOwnershipMint')
    expect(orchestrator).not.toContain('tm1AliasOwnershipVerificationPort')
    expect(orchestrator).not.toContain('tm1AliasVerifiedOwnershipMint')
  })

  test('does not export mint or a public success path for caller JSON', () => {
    expect(Object.keys(portApi).sort()).toEqual([
      'Tm1AliasOwnershipVerificationError',
      'Tm1AliasOwnershipVerificationPort',
      'createTm1AliasOwnershipVerificationPort'
    ])
    expect(portRuntime).not.toMatch(/export function mintVerified/)
    expect(mintRuntime).not.toMatch(/export function mintVerifiedAliasOwnershipEvidence/)
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasPublicationEvidence')
    expect(aliasAuth).not.toHaveProperty('mintVerifiedAliasOwnershipEvidence')
    expect(aliasAuth).not.toHaveProperty('createTm1InMemoryAliasPublicationAuthorizationLedger')
  })

  test('does not sign, broadcast, auto-wire UI, or default to a network observer', () => {
    expect(portRuntime).not.toMatch(/broadcastTx|\.broadcast\s*\(|\.sign\s*\(/)
    expect(portRuntime).not.toMatch(/TxBuilder|fromWIF|seedPhrase|mnemonic/)
    expect(portRuntime).not.toMatch(/ChronikClient|chronik-client/)
    expect(portRuntime).not.toMatch(/from ['"]react|WalletContext|localStorage/)
    expect(portRuntime).not.toMatch(/RegisterAlias|MemoDraft|approveAndBroadcast/)
    expect(portRuntime).not.toContain('https://alias.ecash.mx')
    expect(portRuntime).not.toMatch(/fetch\s*\(/)
    expect(portRuntime).toContain('NOT SUFFICIENT TO ENABLE PUBLICATION')
    expect(mintRuntime).not.toMatch(/from ['"]react/)
    expect(mintRuntime).not.toMatch(/ChronikClient/)
    expect(mintRuntime).not.toMatch(/from ['"].*RegisterAlias/)
  })

  test('observe and clock are required injected deps with no in-memory production fallback', () => {
    expect(portRuntime).toContain('observe')
    expect(portRuntime).toContain('clock')
    expect(portRuntime).not.toContain('createTm1InMemory')
    expect(portRuntime).not.toMatch(/Date\.now\s*\(/)
    expect(portRuntime).not.toMatch(/request\.now/)
  })
})
