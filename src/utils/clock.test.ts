import { describe, expect, test } from 'vitest'
import { dateNow, nowMs } from './clock'

describe('shared captured clock', () => {
  test('exports finite positive timestamp', () => {
    const value = nowMs()
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThan(0)
  })

  test('nowMs and dateNow reference the exact same captured function', () => {
    expect(nowMs).toBe(dateNow)
  })

  test('post-import monkeypatching of Date.now does not affect captured clock', () => {
    const originalNow = Date.now
    try {
      Date.now = () => -999_999
      const captured = nowMs()
      expect(captured).toBeGreaterThan(0)
      expect(dateNow()).toBeGreaterThanOrEqual(captured)
      expect(Date.now()).toBe(-999_999)
    } finally {
      Date.now = originalNow
    }
  })
})
