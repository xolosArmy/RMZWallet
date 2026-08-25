import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const gateSource = readFileSync(new URL(
  './tm1RollbackWitnessAuthorityGate.ts',
  import.meta.url
), 'utf8')

describe('TM1 rollback witness Gate A authority isolation', () => {
  test('keeps signing, transport, Chronik, React and runtime composition unreachable', () => {
    expect(gateSource).not.toMatch(/RegtestP2pkhSigner/)
    expect(gateSource).not.toMatch(/DeliveryTransport/)
    expect(gateSource).not.toMatch(/Chronik/)
    expect(gateSource).not.toMatch(/createTm1RegtestRuntime/)
    expect(gateSource).not.toMatch(/from ['"]react/)
    expect(gateSource).not.toMatch(/\.broadcast\s*\(/)
    expect(gateSource).not.toMatch(/\.sign\s*\(/)
  })

  test('exports freshness evidence without an executable authority method', async () => {
    const module = await import('./tm1RollbackWitnessAuthorityGate')
    expect(Object.keys(module).sort()).toEqual([
      'Tm1RollbackWitnessAuthorityGateError',
      'establishTm1RollbackWitnessFreshness',
      'provisionTm1RollbackWitness'
    ])
  })
})
