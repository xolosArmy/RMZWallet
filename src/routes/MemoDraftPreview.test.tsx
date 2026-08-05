/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import MemoDraftPreview from './MemoDraftPreview'
import type { Tm1Draft02ReviewSnapshot } from '../integrations/tonalliMemo/prepareTm1Draft02Review'

const { prepareReviewMock } = vi.hoisted(() => ({
  prepareReviewMock: vi.fn()
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))
vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    initialized: true,
    address: 'ecash:qptestaddress'
  })
}))
vi.mock('../integrations/tonalliMemo/prepareTm1Draft02Review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/tonalliMemo/prepareTm1Draft02Review')>()
  return {
    ...actual,
    prepareTm1Draft02Review: prepareReviewMock
  }
})

const snapshot = (message: string): Tm1Draft02ReviewSnapshot => ({
  protocol: 'TM1',
  draft: '0.2',
  address: 'ecash:qptestaddress',
  authorPublicKeyHashHex: '11'.repeat(20),
  authorInputIndex: 0,
  message,
  messageByteLength: new TextEncoder().encode(message).length,
  selectedInputs: [
    {
      index: 0,
      role: 'author',
      txid: 'a'.repeat(64),
      outIdx: 0,
      sats: 3_000n
    }
  ],
  estimatedFeeSats: 244n,
  estimatedFeeXec: '2.44',
  estimatedChangeSats: 2_756n,
  estimatedSizeBytes: 203,
  feeRateSatsPerByte: 1.2,
  signedInputSizeAssumptionBytes: 149,
  opReturnScriptHex: '6a04544d4d000401010078'
})

function renderPreview() {
  return render(
    <MemoryRouter>
      <MemoDraftPreview />
    </MemoryRouter>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  prepareReviewMock.mockReset()
})

describe('TM1 Draft 0.2 wallet-backed review UI', () => {
  it('fixes ordinary-post authorship at input zero and exposes no authorization action', () => {
    renderPreview()

    expect(screen.getByText('Política de Tonalli Wallet para publicaciones ordinarias autofinanciadas.')).toBeTruthy()
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect((screen.getByRole('button', { name: 'Calcular plan estimado' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /autorizar|firmar|publicar|transmitir/i })).toBeNull()
  })

  it('shows a wallet-backed snapshot with explicitly estimated fee and change', async () => {
    prepareReviewMock.mockResolvedValue(snapshot('  Tonalli\n'))
    renderPreview()

    const textarea = screen.getByRole('textbox', { name: 'Mensaje exacto' })
    fireEvent.change(textarea, { target: { value: '  Tonalli\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Calcular plan estimado' }))

    await waitFor(() => expect(prepareReviewMock).toHaveBeenCalledWith({ eventData: '  Tonalli\n' }))
    expect(await screen.findByText('Snapshot estimado de fondeo')).toBeTruthy()
    expect(screen.getByText('244 sats (2.44 XEC)')).toBeTruthy()
    expect(screen.getByText('2756 sats')).toBeTruthy()
    expect(screen.getByText('203 bytes')).toBeTruthy()
    expect(screen.getByText('149 bytes P2PKH')).toBeTruthy()
    expect(screen.getByText('Autor · ' + 'a'.repeat(64) + ':0 · 3000 sats')).toBeTruthy()
  })

  it('discards a stale snapshot when the message changes during lookup', async () => {
    const pending = deferred<Tm1Draft02ReviewSnapshot>()
    prepareReviewMock.mockReturnValue(pending.promise)
    renderPreview()

    const textarea = screen.getByRole('textbox', { name: 'Mensaje exacto' })
    fireEvent.change(textarea, { target: { value: 'Mensaje A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Calcular plan estimado' }))
    await waitFor(() => expect(prepareReviewMock).toHaveBeenCalledTimes(1))

    fireEvent.change(textarea, { target: { value: 'Mensaje B' } })
    pending.resolve(snapshot('Mensaje A'))
    await Promise.resolve()

    expect(screen.queryByText('Snapshot estimado de fondeo')).toBeNull()
    expect((screen.getByRole('button', { name: 'Calcular plan estimado' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
