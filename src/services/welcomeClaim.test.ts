import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  claimWelcomeXec: vi.fn(),
  getWelcomeClaimStatus: vi.fn(),
  getWelcomeFaucetConfig: vi.fn(),
  isWelcomeFaucetConfigured: vi.fn(() => true)
}))

vi.mock('./welcomeFaucet', () => mocks)

import {
  nextWelcomeClaimAction,
  requestWelcomeClaim,
  shouldAttemptWelcomeClaim
} from './welcomeClaim'

describe('Welcome XEC claim policy', () => {
  test('only available and retryable statuses may broadcast', () => {
    expect(shouldAttemptWelcomeClaim('available')).toBe(true)
    expect(shouldAttemptWelcomeClaim('retryable')).toBe(true)
    expect(shouldAttemptWelcomeClaim('pending_review')).toBe(false)
    expect(shouldAttemptWelcomeClaim('already_claimed')).toBe(false)
    expect(shouldAttemptWelcomeClaim('completed')).toBe(false)
    expect(nextWelcomeClaimAction('pending_review')).toBe('reconcile')
  })

  test('pending_review never fires another transfer', async () => {
    mocks.getWelcomeClaimStatus.mockResolvedValue({
      ok: false,
      status: 'pending_review',
      address: 'ecash:qtest'
    })
    const result = await requestWelcomeClaim('ecash:qtest', 'pending_review')
    expect(result.status).toBe('pending_review')
    expect(mocks.claimWelcomeXec).not.toHaveBeenCalled()
  })
})
