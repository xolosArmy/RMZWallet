import { describe, expect, test } from 'vitest'
import { isWelcomeQuickStartCompatible, type WelcomeFaucetConfig } from './welcomeFaucet'

const base: WelcomeFaucetConfig = {
  ok: true,
  enabled: true,
  oneTimePerAddress: true,
  dryRun: true,
  starterPack: { xecSats: '100000', xec: '1000' }
}

describe('Welcome Quick Start Turnstile contract', () => {
  test('offers Welcome XEC only when the backend is Quick Start compatible', () => {
    expect(isWelcomeQuickStartCompatible(base)).toBe(true)
    expect(isWelcomeQuickStartCompatible({ ...base, turnstileRequired: false, quickStartCompatible: true })).toBe(true)
    expect(isWelcomeQuickStartCompatible({ ...base, turnstileRequired: true })).toBe(false)
    expect(isWelcomeQuickStartCompatible({ ...base, quickStartCompatible: false })).toBe(false)
    expect(isWelcomeQuickStartCompatible({ ...base, enabled: false })).toBe(false)
  })
})
