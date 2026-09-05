import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

const runtime = source('./tm1AliasPublicationAuthorization.ts')

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
})
