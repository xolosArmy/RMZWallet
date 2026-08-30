import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const gateSource = readFileSync(new URL(
  './tm1RollbackWitnessAuthorityGate.ts',
  import.meta.url
), 'utf8')
const grantSource = readFileSync(new URL(
  './tm1RollbackWitnessReservationGrant.ts',
  import.meta.url
), 'utf8')
const storeSource = readFileSync(new URL(
  './tm1SqlitePublicationRecoveryStore.ts',
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

  test('keeps grant provenance private and rejects public structural branding', () => {
    expect(grantSource).toContain('new WeakMap<object,')
    expect(grantSource).toContain('new WeakSet<object>()')
    expect(grantSource).not.toContain('Symbol.for(')
    expect(grantSource).not.toMatch(/export const .*brand/i)
    expect(grantSource).not.toMatch(/public.*token/i)
  })

  test('checks runtime grant provenance before opening the reserved SQLite write', () => {
    const method = storeSource.slice(
      storeSource.indexOf('commitReservedWitnessBinding('),
      storeSource.indexOf('\n  close(): void')
    )
    expect(method.indexOf('withTm1RollbackWitnessReservationGrant(')).toBeGreaterThan(-1)
    expect(method.indexOf('assertReservationFence(')).toBeGreaterThan(-1)
    expect(method.indexOf("this.database.exec('BEGIN IMMEDIATE')"))
      .toBeGreaterThan(method.indexOf('withTm1RollbackWitnessReservationGrant('))
    expect(method.indexOf("this.database.exec('BEGIN IMMEDIATE')"))
      .toBeGreaterThan(method.indexOf('assertReservationFence('))
  })

  test('consumes the reservation grant before the authority-bearing operate callback', () => {
    const fn = grantSource.slice(
      grantSource.indexOf('export function withTm1RollbackWitnessReservationGrant'),
      grantSource.indexOf('\nfunction snapshotWitness(')
    )
    const inFlightCheckIndex = fn.indexOf('inFlightGrants.has(grantValue)')
    const inFlightMarkIndex = fn.indexOf('inFlightGrants.add(grantValue)')
    const prepareIndex = fn.indexOf('prepare(evidence)')
    const consumeIndex = fn.lastIndexOf('consumedGrants.add(grantValue)')
    const operateIndex = fn.indexOf('return operate(evidence)')
    expect(inFlightCheckIndex).toBeGreaterThan(-1)
    expect(inFlightMarkIndex).toBeGreaterThan(inFlightCheckIndex)
    expect(prepareIndex).toBeGreaterThan(inFlightMarkIndex)
    expect(consumeIndex).toBeGreaterThan(prepareIndex)
    expect(operateIndex).toBeGreaterThan(consumeIndex)
    expect(grantSource).toContain('new WeakSet<object>()')
    expect(grantSource).not.toContain('consumedGrants.delete')
    expect(fn).not.toMatch(/const result = (operate|operation)\(/)
  })

  test('keeps signing, transport and browser composition out of the grant module', () => {
    expect(grantSource).not.toMatch(/RegtestP2pkhSigner/)
    expect(grantSource).not.toMatch(/DeliveryTransport/)
    expect(grantSource).not.toMatch(/Chronik/)
    expect(grantSource).not.toMatch(/createTm1RegtestRuntime/)
    expect(grantSource).not.toMatch(/from ['"]react/)
    expect(grantSource).not.toMatch(/\.broadcast\s*\(/)
    expect(grantSource).not.toMatch(/\.sign\s*\(/)
  })
})
