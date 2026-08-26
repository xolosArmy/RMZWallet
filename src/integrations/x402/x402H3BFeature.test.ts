import { describe, expect, test } from 'vitest'
import { isX402H3BEnabled, X402_H3B_ENABLED } from './x402H3BFeature'

describe('H3B feature flag', () => {
  test('is disabled unless explicitly set to true', () => {
    expect(X402_H3B_ENABLED).toBe(false)
    expect(isX402H3BEnabled(undefined)).toBe(false)
    expect(isX402H3BEnabled(false)).toBe(false)
    expect(isX402H3BEnabled('1')).toBe(false)
    expect(isX402H3BEnabled('true')).toBe(true)
    expect(isX402H3BEnabled(' TRUE ')).toBe(true)
  })
})
