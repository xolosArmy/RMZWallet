import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 Phase 6-G regtest E2E CLI authority boundaries', () => {
  const entrypoint = source('../../../scripts/run-tm1-regtest-e2e.ts')
  const helper = source('../../../scripts/tm1-regtest-e2e-cli.ts')
  const production = `${entrypoint}\n${helper}`

  test('uses only the public 6-F factory for the publication lifecycle', () => {
    expect(helper).toContain('createTm1RegtestRuntime({')
    expect(helper).toContain('runtime.prepare({')
    expect(helper).toContain('runtime.authorizeAndSign(')
    expect(helper).toContain('runtime.approveAndBroadcast(')
    expect(helper).toContain('runtime.confirm(')
    expect(helper).toContain('runtime.reconcile(')
  })

  test('has no direct signer, transport, Chronik, UTXO, candidate, or audit authority', () => {
    expect(production).not.toMatch(
      /signTm1Draft02RegtestCandidate|Tm1ChronikRegtestDeliveryTransport|Tm1InMemoryDeliveryTransport|ChronikClient|readFixtureUtxos|createTm1Draft02Candidate|prepareTm1Draft02Review|revalidateTm1Draft02Candidate/
    )
    expect(production).not.toMatch(/\bWIF\b|privateKey|secretKey/)
    expect(production).not.toMatch(/\.submit\s*\(|\.broadcast\s*\(/)
  })

  test('imports no 6-F private implementation helper', () => {
    const imports = Array.from(
      helper.matchAll(/from\s+['"]([^'"]+)['"]/g),
      match => match[1]
    )

    expect(imports).toEqual([
      'node:readline',
      'node:stream',
      '../src/integrations/tonalliMemo/tm1RegtestRuntimeComposition'
    ])
  })

  test('constructs distinct named SIGN and BROADCAST providers', () => {
    expect(helper).toContain(
      'const signingDecisionProvider = createInteractiveSigningDecisionProvider(options.io)'
    )
    expect(helper).toContain(
      'const broadcastDecisionProvider = createInteractiveBroadcastDecisionProvider(options.io)'
    )
    expect(helper).toContain('decisionProvider: signingDecisionProvider')
    expect(helper).toContain('decisionProvider: broadcastDecisionProvider')
  })

  test('has no silent approval flag, approval environment variable, or mainnet path', () => {
    expect(production).not.toMatch(/--yes|--force|--approve-all|TM1_APPROVE|AUTO.?APPROV/i)
    expect(production).not.toMatch(/mainnet/i)
  })

  test('fails closed on non-TTY before constructing the runtime', () => {
    const ttyGuard = helper.indexOf('if (!options.isTty)')
    const construction = helper.indexOf('createTm1RegtestRuntime({')

    expect(ttyGuard).toBeGreaterThan(-1)
    expect(construction).toBeGreaterThan(ttyGuard)
    expect(entrypoint).toContain('isTty: process.stdin.isTTY === true')
  })

  test('uses the fixed public fixture request and bounded observation constants', () => {
    expect(helper).toContain("'76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'")
    expect(helper).toContain('const MAX_FEE_SATS = 10_000n')
    expect(helper).toContain('TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS = 300_000')
    expect(helper).toContain('TM1_REGTEST_E2E_CONFIRMATION_POLL_MS = 1_000')
    expect(helper).toContain('TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS = 120_000')
  })

  test('does not expose authority-bearing dependency injection in the production runner', () => {
    const options = helper.slice(
      helper.indexOf('export type Tm1RegtestE2eRunOptions'),
      helper.indexOf('export type Tm1RegtestE2eRunResult')
    )

    expect(options).not.toMatch(/runtimeFactory|signer|transport|chronik|client|core|ledger|lock/i)
  })
})
