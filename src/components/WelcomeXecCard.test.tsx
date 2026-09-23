// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WelcomeXecCard, {
  WELCOME_RECONCILE_INTERVAL_MS,
  WELCOME_RECONCILE_MAX_ATTEMPTS
} from './WelcomeXecCard'

const ADDRESS_A = 'ecash:qwelcomea'
const ADDRESS_B = 'ecash:qwelcomeb'
const available = (address: string) => ({ ok: true, status: 'available' as const, address })
const pending = (address: string) => ({ ok: false, status: 'pending_review' as const, address })
const completed = (address: string) => ({ ok: true, status: 'completed' as const, address })

const mocks = vi.hoisted(() => ({
  useWallet: vi.fn(),
  claimWelcomeXec: vi.fn(),
  getWelcomeClaimStatus: vi.fn(),
  getWelcomeFaucetConfig: vi.fn(),
  refreshBalances: vi.fn(),
  isWelcomeQuickStartCompatible: vi.fn(() => true)
}))

vi.mock('../context/useWallet', () => ({ useWallet: mocks.useWallet }))
vi.mock('../services/welcomeFaucet', () => ({
  claimWelcomeXec: mocks.claimWelcomeXec,
  getWelcomeClaimStatus: mocks.getWelcomeClaimStatus,
  getWelcomeFaucetConfig: mocks.getWelcomeFaucetConfig,
  isWelcomeFaucetConfigured: () => true,
  isWelcomeQuickStartCompatible: mocks.isWelcomeQuickStartCompatible
}))

function setWalletAddress(address: string) {
  mocks.useWallet.mockReturnValue({
    address,
    hasCapability: () => true,
    refreshBalances: mocks.refreshBalances
  })
}

async function mountAvailable() {
  mocks.getWelcomeClaimStatus.mockResolvedValueOnce(available(ADDRESS_A))
  const view = render(<WelcomeXecCard />)
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Recibir XEC' }).disabled).toBe(false))
  mocks.getWelcomeClaimStatus.mockReset()
  return view
}

async function startPendingClaim() {
  vi.useFakeTimers()
  mocks.claimWelcomeXec.mockResolvedValueOnce(pending(ADDRESS_A))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Recibir XEC' })) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'En revisión' }).disabled).toBe(true)
  expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
}

async function advancePolls(count: number) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(WELCOME_RECONCILE_INTERVAL_MS) })
  }
}

describe('WelcomeXecCard pending reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWelcomeQuickStartCompatible.mockReturnValue(true)
    setWalletAddress(ADDRESS_A)
    mocks.getWelcomeFaucetConfig.mockResolvedValue({
      ok: true,
      enabled: true,
      oneTimePerAddress: true,
      dryRun: false,
      quickStartCompatible: true,
      starterPack: { xecSats: '100', xec: '1' }
    })
    mocks.refreshBalances.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('POSTs once, reconciles pending through GETs, and refreshes once on completion', async () => {
    await mountAvailable()
    mocks.getWelcomeClaimStatus
      .mockResolvedValueOnce(pending(ADDRESS_A))
      .mockResolvedValueOnce(completed(ADDRESS_A))
    await startPendingClaim()

    await advancePolls(2)
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Ya recibiste tus primeros XEC')).toBeTruthy()
    expect(mocks.refreshBalances).toHaveBeenCalledTimes(1)
  })

  it('stops after its retry budget, preserves pending, and exposes GET-only manual refresh', async () => {
    await mountAvailable()
    mocks.getWelcomeClaimStatus.mockResolvedValue(pending(ADDRESS_A))
    await startPendingClaim()

    await advancePolls(WELCOME_RECONCILE_MAX_ATTEMPTS)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(WELCOME_RECONCILE_MAX_ATTEMPTS)
    expect(screen.getByRole('button', { name: 'Actualizar estado' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'En revisión' }).disabled).toBe(true)
    await advancePolls(2)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(WELCOME_RECONCILE_MAX_ATTEMPTS)
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
  })

  it('keeps pending and disables the POST after a status GET network failure', async () => {
    await mountAvailable()
    mocks.getWelcomeClaimStatus
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(pending(ADDRESS_A))
    await startPendingClaim()

    await advancePolls(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'En revisión' }).disabled).toBe(true)
    expect(screen.getByText('No pudimos actualizar el estado todavía.')).toBeTruthy()
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
    expect(mocks.refreshBalances).not.toHaveBeenCalled()
    await advancePolls(1)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'En revisión' }).disabled).toBe(true)
  })

  it('does not turn an unexpected available status GET into another POST', async () => {
    await mountAvailable()
    mocks.getWelcomeClaimStatus.mockResolvedValueOnce(available(ADDRESS_A))
    await startPendingClaim()

    await advancePolls(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'En revisión' }).disabled).toBe(true)
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
    expect(mocks.refreshBalances).not.toHaveBeenCalled()
  })

  it('manual refresh after budget exhaustion is GET-only and completes once', async () => {
    await mountAvailable()
    mocks.getWelcomeClaimStatus.mockResolvedValue(pending(ADDRESS_A))
    await startPendingClaim()
    await advancePolls(WELCOME_RECONCILE_MAX_ATTEMPTS)

    mocks.getWelcomeClaimStatus.mockResolvedValueOnce(completed(ADDRESS_A))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' })) })
    expect(screen.getByText('Ya recibiste tus primeros XEC')).toBeTruthy()
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
    expect(mocks.refreshBalances).toHaveBeenCalledTimes(1)
  })

  it('aborts A on address switch and ignores an unabortable late A response', async () => {
    const view = await mountAvailable()
    let finishA!: (value: ReturnType<typeof completed>) => void
    let signalA: AbortSignal | undefined
    mocks.getWelcomeClaimStatus.mockImplementationOnce((_address: string, signal: AbortSignal) => {
      signalA = signal
      return new Promise(resolve => { finishA = resolve })
    })
    await startPendingClaim()
    await advancePolls(1)
    expect(signalA?.aborted).toBe(false)

    mocks.getWelcomeClaimStatus.mockResolvedValueOnce(available(ADDRESS_B))
    setWalletAddress(ADDRESS_B)
    await act(async () => { view.rerender(<WelcomeXecCard />) })
    expect(signalA?.aborted).toBe(true)
    await act(async () => { finishA(completed(ADDRESS_A)) })

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Recibir XEC' }).disabled).toBe(false)
    expect(screen.queryByText('Ya recibiste tus primeros XEC')).toBeNull()
    expect(mocks.refreshBalances).not.toHaveBeenCalled()
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
  })

  it('clears the pending A timer when switching address before the first poll', async () => {
    const view = await mountAvailable()
    await startPendingClaim()
    mocks.getWelcomeClaimStatus.mockResolvedValueOnce(available(ADDRESS_B))

    setWalletAddress(ADDRESS_B)
    await act(async () => { view.rerender(<WelcomeXecCard />) })
    await advancePolls(1)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(1)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledWith(ADDRESS_B, expect.any(AbortSignal))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Recibir XEC' }).disabled).toBe(false)
    expect(mocks.refreshBalances).not.toHaveBeenCalled()
  })

  it('aborts polling on unmount and does not refresh from a late response', async () => {
    const view = await mountAvailable()
    let finishA!: (value: ReturnType<typeof completed>) => void
    let signalA: AbortSignal | undefined
    mocks.getWelcomeClaimStatus.mockImplementationOnce((_address: string, signal: AbortSignal) => {
      signalA = signal
      return new Promise(resolve => { finishA = resolve })
    })
    await startPendingClaim()
    await advancePolls(1)

    view.unmount()
    expect(signalA?.aborted).toBe(true)
    await act(async () => { finishA(completed(ADDRESS_A)) })
    expect(mocks.refreshBalances).not.toHaveBeenCalled()
  })

  it.each(['capability revoked', 'config incompatible'] as const)('cancels pending polling when %s', async (reason) => {
    const view = await mountAvailable()
    let finishA!: (value: ReturnType<typeof completed>) => void
    let signalA: AbortSignal | undefined
    mocks.getWelcomeClaimStatus.mockImplementationOnce((_address: string, signal: AbortSignal) => {
      signalA = signal
      return new Promise(resolve => { finishA = resolve })
    })
    await startPendingClaim()
    await advancePolls(1)

    if (reason === 'capability revoked') {
      mocks.useWallet.mockReturnValue({
        address: ADDRESS_A,
        hasCapability: () => false,
        refreshBalances: mocks.refreshBalances
      })
    } else {
      mocks.isWelcomeQuickStartCompatible.mockReturnValue(false)
    }
    await act(async () => { view.rerender(<WelcomeXecCard />) })
    expect(signalA?.aborted).toBe(true)
    await act(async () => { finishA(completed(ADDRESS_A)) })
    await advancePolls(2)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(1)
    expect(mocks.refreshBalances).not.toHaveBeenCalled()
    expect(view.container.firstChild).toBeNull()
  })

  it('does not refresh twice after terminal response and effect re-render', async () => {
    const view = await mountAvailable()
    mocks.getWelcomeClaimStatus.mockResolvedValueOnce(completed(ADDRESS_A))
    await startPendingClaim()
    await advancePolls(1)

    await act(async () => { view.rerender(<WelcomeXecCard />) })
    await advancePolls(2)
    expect(mocks.getWelcomeClaimStatus).toHaveBeenCalledTimes(1)
    expect(mocks.refreshBalances).toHaveBeenCalledTimes(1)
    expect(mocks.claimWelcomeXec).toHaveBeenCalledTimes(1)
  })
})
