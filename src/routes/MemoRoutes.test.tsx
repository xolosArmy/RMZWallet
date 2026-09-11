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
    alias: 'satoshixec.xec',
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

  test('feed renders displayPayload and NFT attachment card when attachment is present', async () => {
    const attachedTokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const itemWithNft = {
      ...item,
      payload: `@nft1:${attachedTokenId}\nTexto limpio de prueba`,
      displayPayload: 'Texto limpio de prueba',
      attachment: {
        type: 'NFT',
        tokenId: attachedTokenId,
        ownership: 'VERIFIED_AT_INDEXING'
      }
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ transaction: itemWithNft, verification: itemWithNft }] })
    )

    renderAt('/memo', <MemoFeed />)

    expect(await screen.findByText('Texto limpio de prueba')).toBeTruthy()
    // Should display verified NFT attachment card
    expect(screen.getByTestId('memo-nft-verified')).toBeTruthy()
  })

  test('detail route renders displayPayload and unverified NFT attachment warning', async () => {
    const attachedTokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const itemWithUnverifiedNft = {
      ...item,
      payload: `@nft1:${attachedTokenId}\nTexto en detalle`,
      displayPayload: 'Texto en detalle',
      attachment: {
        type: 'NFT',
        tokenId: attachedTokenId,
        ownership: 'UNVERIFIED'
      }
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ transaction: itemWithUnverifiedNft, verification: itemWithUnverifiedNft })
    )

    renderAt(`/memo/tx/${TXID}`, (
      <Routes>
        <Route path="/memo/tx/:txid" element={<MemoTx />} />
      </Routes>
    ))

    expect(await screen.findAllByText('Texto en detalle')).toBeTruthy()
    expect(screen.getAllByTestId('memo-nft-unverified').length).toBeGreaterThan(0)
  })

  test('feed NFT-only does not contain "@nft1:" and card remains visible', async () => {
    const attachedTokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const nftOnlyItem = {
      ...item,
      payload: `@nft1:${attachedTokenId}\n`,
      displayPayload: '',
      attachment: {
        type: 'NFT',
        tokenId: attachedTokenId,
        ownership: 'VERIFIED_AT_INDEXING'
      }
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ transaction: nftOnlyItem, verification: nftOnlyItem }] })
    )

    renderAt('/memo', <MemoFeed />)

    expect(await screen.findByTestId('memo-nft-verified')).toBeTruthy()
    expect(document.body.textContent).not.toContain('@nft1:')
  })

  test('tx detail NFT-only does not contain "@nft1:" and card remains visible', async () => {
    const attachedTokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const nftOnlyItem = {
      ...item,
      payload: `@nft1:${attachedTokenId}\n`,
      displayPayload: '',
      attachment: {
        type: 'NFT',
        tokenId: attachedTokenId,
        ownership: 'VERIFIED_AT_INDEXING'
      }
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ transaction: nftOnlyItem, verification: nftOnlyItem })
    )

    renderAt(`/memo/tx/${TXID}`, (
      <Routes>
        <Route path="/memo/tx/:txid" element={<MemoTx />} />
      </Routes>
    ))

    expect((await screen.findAllByTestId('memo-nft-verified')).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('@nft1:')
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

  test('route navigation mounts MemoCompose through App', async () => {
    renderAt('/memo/compose', (
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    ) as ReactNode)

    expect(await screen.findByText('Componer y Publicar Memo TM1')).toBeTruthy()
    expect(screen.getByTestId('memo-composer')).toBeTruthy()
  })

  test('feed has link to compose memo', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

    renderAt('/memo', (
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    ) as ReactNode)

    const composeLink = await screen.findByRole('link', { name: 'Publicar memo' })
    expect(composeLink.getAttribute('href')).toBe('/memo/compose')
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

  test('feed renders clickable safe hyperlinks for URLs in displayPayload', async () => {
    const itemWithUrl = {
      ...item,
      payload: 'Visita https://xolosarmy.xyz para ver el protocolo.',
      displayPayload: 'Visita https://xolosarmy.xyz para ver el protocolo.'
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ transaction: itemWithUrl, verification: itemWithUrl }] })
    )

    renderAt('/memo', <MemoFeed />)

    const link = await screen.findByRole('link', { name: 'https://xolosarmy.xyz' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://xolosarmy.xyz/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
    expect(screen.getByText(/Visita/)).toBeTruthy()
    expect(screen.getByText(/para ver el protocolo\./)).toBeTruthy()
  })

  test('detail route renders clickable safe hyperlinks in transaction and verification displayPayload', async () => {
    const itemWithUrl = {
      ...item,
      payload: 'Ver docs en https://e.cash/build ahora!',
      displayPayload: 'Ver docs en https://e.cash/build ahora!'
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ transaction: itemWithUrl, verification: itemWithUrl })
    )

    renderAt(`/memo/tx/${TXID}`, (
      <Routes>
        <Route path="/memo/tx/:txid" element={<MemoTx />} />
      </Routes>
    ))

    const links = await screen.findAllByRole('link', { name: 'https://e.cash/build' })
    expect(links.length).toBeGreaterThanOrEqual(2) // Once in transaction, once in verification
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('https://e.cash/build')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
    }
  })

  test('feed handles coexistence of clickable URL and verified NFT attachment', async () => {
    const attachedTokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const itemWithUrlAndNft = {
      ...item,
      payload: `@nft1:${attachedTokenId}\nExplora https://xolosarmy.xyz con tu NFT`,
      displayPayload: 'Explora https://xolosarmy.xyz con tu NFT',
      attachment: {
        type: 'NFT',
        tokenId: attachedTokenId,
        ownership: 'VERIFIED_AT_INDEXING'
      }
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ transaction: itemWithUrlAndNft, verification: itemWithUrlAndNft }] })
    )

    renderAt('/memo', <MemoFeed />)

    const link = await screen.findByRole('link', { name: 'https://xolosarmy.xyz' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://xolosarmy.xyz/')
    expect(screen.getByTestId('memo-nft-verified')).toBeTruthy()
  })
})
