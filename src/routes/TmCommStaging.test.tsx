/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import {
  TM_COMM_STAGING_ENABLED,
  isTmCommStagingEnabled
} from '../config/tmCommStaging'
import More from './More'
import TmCommStaging from './TmCommStaging'
import {
  createTmCommAuthChallengeView
} from '../features/privateMessaging/authChallenge'

const mockSignMessage = vi.fn()
const mockGetPublicKeyHex = vi.fn(() => '02' + '11'.repeat(32))

vi.mock('../services/XolosWalletService', () => ({
  xolosWalletService: {
    getPublicKeyHex: () => mockGetPublicKeyHex(),
    signMessage: (msg: string) => mockSignMessage(msg)
  }
}))

const mockTmCommRequest = vi.fn()

vi.mock('./tmCommStagingClient', () => ({
  tmCommRequest: (...args: unknown[]) => mockTmCommRequest(...args)
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: 'ecash:qptest',
    balance: null,
    initialized: true,
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn(),
    loading: false,
    error: null
  })
}))

const stagingSource = readFileSync(
  resolve(process.cwd(), 'src/routes/TmCommStaging.tsx'),
  'utf8'
)
const clientSource = readFileSync(
  resolve(process.cwd(), 'src/routes/tmCommStagingClient.ts'),
  'utf8'
)

describe('TM-COMM staging route containment', () => {
  test('route is absent when staging is disabled', () => {
    expect(isTmCommStagingEnabled(undefined)).toBe(false)
    expect(isTmCommStagingEnabled('false')).toBe(false)
    expect(TM_COMM_STAGING_ENABLED).toBe(false)

    const more = renderToStaticMarkup(
      <MemoryRouter><More /></MemoryRouter>
    )
    const route = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/tm-comm-staging']}><App /></MemoryRouter>
    )
    expect(more).not.toContain('/tm-comm-staging')
    expect(route).not.toContain('Staging de mensajería privada')
  })

  test('staging surfaces do not treat localStorage as canonical storage', () => {
    expect(stagingSource).not.toMatch(/localStorage/)
    expect(clientSource).not.toMatch(/localStorage/)
    expect(clientSource).toContain("credentials: 'include'")
  })
})

describe('P2-1: Local challenge validation before signing in staging UI', () => {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1:5174'

  const makeValidChallenge = () =>
    createTmCommAuthChallengeView({
      challengeId: 'chlg_valid_123',
      nonce: 'nonce_secret_abc',
      expiresAt: Date.now() + 600_000,
      audience: origin,
      origin: origin,
      sessionContext: 'tm-comm-a0-staging:v1'
    })

  beforeEach(() => {
    vi.clearAllMocks()
    mockSignMessage.mockResolvedValue('signature_bytes_hex')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('legitimate challenge is validated locally and signed', async () => {
    const validChallenge = makeValidChallenge()
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: validChallenge })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 201, data: {} })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    const signButton = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(signButton)

    await waitFor(() => {
      expect(mockSignMessage).toHaveBeenCalledTimes(1)
      expect(mockSignMessage).toHaveBeenCalledWith(validChallenge.canonicalMessage)
    })
  })

  test.each([
    ['altered protocol', () => ({ ...makeValidChallenge(), protocol: 'TM-COMM-AUTH-V2' })],
    ['altered purpose', () => ({ ...makeValidChallenge(), purpose: 'other-purpose' })],
    ['altered audience', () => ({ ...makeValidChallenge(), audience: 'http://evil.com' })],
    ['altered origin', () => ({ ...makeValidChallenge(), origin: 'http://evil.com' })],
    ['altered nonce', () => ({ ...makeValidChallenge(), nonce: 'bad nonce with spaces' })],
    ['expired timestamp', () => ({ ...makeValidChallenge(), expiresAt: Date.now() - 1000 })],
    ['manipulated canonicalMessage', () => ({ ...makeValidChallenge(), canonicalMessage: 'tampered text' })]
  ])('rejects %s without invoking signMessage', async (_description, createBadChallenge) => {
    const badChallenge = createBadChallenge()
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: badChallenge })
      }
      return Promise.resolve({ ok: true, status: 200, data: { conversations: [] } })
    })

    render(<TmCommStaging />)

    const signButton = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(signButton)

    await waitFor(() => {
      expect(screen.getByText(/Challenge inválido o manipulado/i)).toBeDefined()
    })

    expect(mockSignMessage).not.toHaveBeenCalled()
  })
})

describe('P2-4: Restore conversation and durable history on reload / mount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  test('mount with active session restores conversation and durable history without enrollment token', async () => {
    const mockConversations = [
      { id: 'conv-test-1', reservationId: 'res-alpha-001', createdAt: 5000 }
    ]
    const mockMessages = [
      {
        id: 'msg-durable-1',
        clientMessageId: 'cli-001',
        body: 'Durable message restored after reload',
        senderKind: 'customer',
        serverCreatedAt: 5010,
        status: 'delivered',
        replyToId: null
      }
    ]

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: mockConversations } })
      }
      if (path === '/v1/tm-comm/conversations/conv-test-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: mockMessages } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-test-1 · Reserva: res-alpha-001/i)).toBeDefined()
      expect(screen.getByText(/Durable message restored after reload/i)).toBeDefined()
      expect(screen.getByText(/Historial recargado desde el servidor: 1 mensaje\(s\)/i)).toBeDefined()
    })
  })

  test('mount with multiple conversations renders selector and supports explicit switching', async () => {
    const mockConversations = [
      { id: 'conv-older', reservationId: 'res-001', createdAt: 1000 },
      { id: 'conv-newer', reservationId: 'res-002', createdAt: 2000 }
    ]
    const messagesNewer = [
      {
        id: 'msg-newer-1',
        clientMessageId: 'cli-newer',
        body: 'Messages for newer conversation',
        senderKind: 'customer',
        serverCreatedAt: 2010,
        status: 'accepted',
        replyToId: null
      }
    ]
    const messagesOlder = [
      {
        id: 'msg-older-1',
        clientMessageId: 'cli-older',
        body: 'Messages for older conversation',
        senderKind: 'customer',
        serverCreatedAt: 1010,
        status: 'delivered',
        replyToId: null
      }
    ]

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: mockConversations } })
      }
      if (path === '/v1/tm-comm/conversations/conv-newer/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: messagesNewer } })
      }
      if (path === '/v1/tm-comm/conversations/conv-older/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: messagesOlder } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-newer · Reserva: res-002/i)).toBeDefined()
      expect(screen.getByText(/Messages for newer conversation/i)).toBeDefined()
    })

    const select = screen.getByRole('combobox', { name: /Seleccionar conversación/i })
    expect(select).toBeDefined()

    fireEvent.change(select, { target: { value: 'conv-older' } })

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-older · Reserva: res-001/i)).toBeDefined()
      expect(screen.getByText(/Messages for older conversation/i)).toBeDefined()
    })
  })

  test('mount without session (401) does not reveal data and leaves state clean', async () => {
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: false, status: 401, data: null })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
      expect(screen.queryByRole('listitem')).toBeNull()
    })
  })
})
