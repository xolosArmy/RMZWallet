/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import App from '../App'
import MobileBottomNav from '../components/MobileBottomNav'
import { isWalletNavigationActive } from '../components/walletNavigation'
import More from './More'
import MemoFeed from './MemoFeed'
import MemoTx from './MemoTx'

const TXID = 'a'.repeat(64)

const item = {
  txid: TXID,
  status: 'VERIFIED',
  profile: { alias: 'Tonalli', code: 'TONALLI' },
  eventType: 'ANNOUNCEMENT',
  payload: 'Texto <b>sin HTML</b>',
  chainStatus: 'CONFIRMED',
  blockHeight: 900001,
  timestamp: '2026-07-28T12:00:00.000Z'
}

const feedItem = {
  transaction: item,
  verification: item
}

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))
vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    initialized: true,
    address: 'ecash:qptestaddress',
    balance: { rmzFormatted: '1', xecFormatted: '2', xec: 2n },
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn(),
    loading: false,
    error: null
  })
}))

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function renderAt(path: string, element: ReactNode) {
  return render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>)
}

function deferredResponse() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Tonalli Memo routes', () => {
  test('loading and feed success UI states', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [feedItem] }))

    renderAt('/memo', <MemoFeed />)

    expect(screen.getByRole('status').textContent).toContain('Cargando Tonalli Memo')
    expect(await screen.findByText('Tonalli')).toBeTruthy()
    expect(screen.getByText('TONALLI')).toBeTruthy()
    expect(screen.getByText('ANNOUNCEMENT')).toBeTruthy()
    expect(screen.getByText('Texto <b>sin HTML</b>')).toBeTruthy()
    expect(screen.getByText('CONFIRMED')).toBeTruthy()
    expect(screen.getByText('900001')).toBeTruthy()
    expect(screen.getByRole('link', { name: /aaaaaaaaaa/ }).getAttribute('href')).toBe(`/memo/tx/${TXID}`)
  })

  test('empty feed UI state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

    renderAt('/memo', <MemoFeed />)

    expect(await screen.findByText('No hay mensajes oficiales verificados por ahora.')).toBeTruthy()
  })

  test('error and retry UI states', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse({ items: [feedItem] }))

    renderAt('/memo', <MemoFeed />)

    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar Tonalli Memo')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reintentar' })[0])
    expect(await screen.findByText('Tonalli')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('unmount cancellation aborts and ignores stale feed completion', async () => {
    const first = deferredResponse()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(first.promise)

    const view = renderAt('/memo', <MemoFeed />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal

    view.unmount()
    expect(signal.aborted).toBe(true)

    first.resolve(jsonResponse({ items: [feedItem] }))
    await Promise.resolve()
    expect(screen.queryByText('Tonalli')).toBeNull()
  })

  test('invalid detail TXID is rejected before fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))

    renderAt('/memo/tx/ABC', (
      <Routes>
        <Route path="/memo/tx/:txid" element={<MemoTx />} />
      </Routes>
    ))

    expect((await screen.findByRole('alert')).textContent).toContain('TXID invalido')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('detail route with verification', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ transaction: item, verification: item }))

    renderAt(`/memo/tx/${TXID}`, (
      <Routes>
        <Route path="/memo/tx/:txid" element={<MemoTx />} />
      </Routes>
    ))

    expect(await screen.findByText('TXID completo')).toBeTruthy()
    expect(screen.getByText(TXID)).toBeTruthy()
    expect(screen.getByText(/Tonalli Wallet displays Tonalli Memo registry-policy verification/)).toBeTruthy()
    expect(screen.getByText('Verificacion')).toBeTruthy()
    expect(screen.getAllByText('VERIFIED').length).toBeGreaterThan(1)
  })

  test('detail route with verification null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ transaction: item, verification: null }))

    renderAt(`/memo/tx/${TXID}`, (
      <Routes>
        <Route path="/memo/tx/:txid" element={<MemoTx />} />
      </Routes>
    ))

    expect(await screen.findByText('La API devolvio verification: null para esta transaccion.')).toBeTruthy()
  })

  test('route navigation mounts Memo routes through App', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

    renderAt('/memo', (
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    ))

    expect(await screen.findByText('Feed oficial verificado')).toBeTruthy()
  })

  test('Memo bottom navigation active state', () => {
    renderAt('/memo/tx/' + TXID, <MobileBottomNav />)

    expect(isWalletNavigationActive('memo', '/memo')).toBe(true)
    expect(isWalletNavigationActive('memo', `/memo/tx/${TXID}`)).toBe(true)
    expect(screen.getByRole('link', { name: 'Memo' }).getAttribute('aria-current')).toBe('page')
  })

  test('NFTs remains reachable from More', () => {
    renderAt('/more', <More />)

    expect(screen.getByRole('link', { name: /NFTs/ }).getAttribute('href')).toBe('/nfts')
  })

  test('no administrative endpoint usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

    renderAt('/memo', <MemoFeed />)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())

    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url)).join('\\n')).not.toContain('/api/v1/admin/index')
  })
})
