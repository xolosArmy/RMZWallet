import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const adapterSource = readFileSync(new URL(
  './tm1RemoteRollbackWitness.ts',
  import.meta.url
), 'utf8')
const inMemorySource = readFileSync(new URL(
  './tm1InMemoryRollbackWitness.ts',
  import.meta.url
), 'utf8')

describe('TM1 remote rollback-witness adapter isolation', () => {
  test('does not fall back to the in-memory test double', () => {
    expect(adapterSource).not.toContain('createTm1InMemoryRollbackWitness')
    expect(adapterSource).not.toContain('Tm1InMemoryRollbackWitness')
    expect(adapterSource).not.toContain('tm1InMemoryRollbackWitness')
  })

  test('keeps signing, Chronik, Memo UI and broadcast unreachable', () => {
    expect(adapterSource).not.toMatch(/RegtestP2pkhSigner/)
    expect(adapterSource).not.toMatch(/DeliveryTransport/)
    expect(adapterSource).not.toMatch(/ChronikClient/)
    expect(adapterSource).not.toMatch(/chronik-client/)
    expect(adapterSource).not.toMatch(/createTm1RegtestRuntime/)
    expect(adapterSource).not.toMatch(/from ['"]react/)
    expect(adapterSource).not.toMatch(/TxBuilder/)
    expect(adapterSource).not.toMatch(/fromWIF|seedPhrase|mnemonic/)
    expect(adapterSource).not.toMatch(/\.broadcast\s*\(/)
    expect(adapterSource).not.toMatch(/\.sign\s*\(/)
  })

  test('does not copy Reflect.get test seams into production', () => {
    expect(adapterSource).not.toContain('Reflect.get(')
  })

  test('keeps the in-memory witness marked as a test double', () => {
    expect(inMemorySource).toContain('Deterministic adversarial-test double')
    expect(inMemorySource).toContain('not suitable')
  })
})
