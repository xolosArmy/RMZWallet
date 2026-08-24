// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useNftVerification } from '../../hooks/useNftVerification'
import type {
  NftCollectionVerifier,
  NftVerificationOutcome
} from './nftVerification'
import { NftVerificationBadge } from './NftVerificationBadge'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function VerificationHarness({
  childTokenId,
  verifier
}: {
  childTokenId: string | null
  verifier: NftCollectionVerifier
}) {
  const state = useNftVerification(childTokenId, verifier)
  return <NftVerificationBadge state={state} />
}

afterEach(() => {
  cleanup()
})

describe('NftVerificationBadge', () => {
  test('renders no verification claim while idle', () => {
    const { container } = render(<NftVerificationBadge state={{ status: 'idle' }} />)

    expect(container.textContent).toBe('')
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test.each([
    ['official', 'VERIFIED LINEAGE', 'official'],
    ['unknown', 'UNVERIFIED', 'unknown'],
    ['community', 'COMMUNITY COLLECTION', 'community']
  ] as const)('renders the resolved %s presentation', (tier, label, status) => {
    render(<NftVerificationBadge state={{ status: 'resolved', tier }} />)

    expect(screen.getByText(label).getAttribute('data-verification-status')).toBe(status)
  })

  test('keeps loading neutral and never renders the official label', () => {
    render(<NftVerificationBadge state={{ status: 'loading' }} />)

    expect(screen.getByText('Verifying on-chain…')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test('keeps errors distinct and never renders the official label', () => {
    render(<NftVerificationBadge state={{ status: 'error' }} />)

    expect(screen.getByText('Verification unavailable')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test('ignores fraudulent metadata when the canonical classification is unknown', () => {
    const hostileMetadata = {
      name: 'Official Xolos Ramírez',
      collection: 'Official',
      verification: 'VERIFIED',
      description: 'Verified Lineage'
    }
    expect(hostileMetadata.verification).toBe('VERIFIED')

    render(<NftVerificationBadge state={{ status: 'resolved', tier: 'unknown' }} />)

    expect(screen.getByText('UNVERIFIED')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test('does not allow fraudulent metadata to turn a request error into official', () => {
    const hostileMetadata = {
      name: 'Official Xolos Ramírez',
      verification: 'VERIFIED'
    }
    expect(hostileMetadata.name).toContain('Official')

    render(<NftVerificationBadge state={{ status: 'error' }} />)

    expect(screen.getByText('Verification unavailable')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })
})

describe('useNftVerification', () => {
  test('shows official only after the complete asynchronous verifier resolves', async () => {
    const result = deferred<NftVerificationOutcome>()
    const verifier = vi.fn(() => result.promise)

    render(<VerificationHarness childTokenId={'a'.repeat(64)} verifier={verifier} />)

    expect(screen.getByText('Verifying on-chain…')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()

    await act(async () => {
      result.resolve({ status: 'resolved', tier: 'official' })
      await result.promise
    })

    expect(screen.getByText('VERIFIED LINEAGE')).toBeTruthy()
  })

  test('maps a rejected verification request to error without showing official', async () => {
    const verifier = vi.fn(async () => {
      throw new Error('Chronik unavailable')
    })

    render(<VerificationHarness childTokenId={'b'.repeat(64)} verifier={verifier} />)

    await waitFor(() => expect(screen.getByText('Verification unavailable')).toBeTruthy())
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test('clears a previous official result immediately when the token changes', async () => {
    const tokenA = 'a'.repeat(64)
    const tokenB = 'b'.repeat(64)
    const pendingB = deferred<NftVerificationOutcome>()
    const verifier = vi.fn((tokenId: string) =>
      tokenId === tokenA
        ? Promise.resolve<NftVerificationOutcome>({ status: 'resolved', tier: 'official' })
        : pendingB.promise
    )
    const view = render(<VerificationHarness childTokenId={tokenA} verifier={verifier} />)

    await waitFor(() => expect(screen.getByText('VERIFIED LINEAGE')).toBeTruthy())
    view.rerender(<VerificationHarness childTokenId={tokenB} verifier={verifier} />)

    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
    expect(screen.getByText('Verifying on-chain…')).toBeTruthy()
  })

  test('ignores a stale official response from the previously selected token', async () => {
    const tokenA = 'a'.repeat(64)
    const tokenB = 'b'.repeat(64)
    const resultA = deferred<NftVerificationOutcome>()
    const resultB = deferred<NftVerificationOutcome>()
    const verifier = vi.fn((tokenId: string) =>
      tokenId === tokenA ? resultA.promise : resultB.promise
    )
    const view = render(<VerificationHarness childTokenId={tokenA} verifier={verifier} />)

    view.rerender(<VerificationHarness childTokenId={tokenB} verifier={verifier} />)
    await act(async () => {
      resultB.resolve({ status: 'resolved', tier: 'unknown' })
      await resultB.promise
    })
    expect(screen.getByText('UNVERIFIED')).toBeTruthy()

    await act(async () => {
      resultA.resolve({ status: 'resolved', tier: 'official' })
      await resultA.promise
    })

    expect(screen.getByText('UNVERIFIED')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test('does not update state after the consumer unmounts', async () => {
    const result = deferred<NftVerificationOutcome>()
    const verifier = vi.fn(() => result.promise)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(
      <VerificationHarness childTokenId={'c'.repeat(64)} verifier={verifier} />
    )

    view.unmount()
    await act(async () => {
      result.resolve({ status: 'resolved', tier: 'official' })
      await result.promise
    })

    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
