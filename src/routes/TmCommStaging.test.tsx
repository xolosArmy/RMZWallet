/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

type MockWalletState = {
  address: string | null
  initialized: boolean
  balance: null
  loading: boolean
  error: null
}

const mockWalletState: MockWalletState = {
  address: 'ecash:qptest',
  initialized: true,
  balance: null,
  loading: false,
  error: null
}

const walletListeners = new Set<() => void>()

function setMockWallet(update: Partial<MockWalletState>) {
  act(() => {
    Object.assign(mockWalletState, update)
    walletListeners.forEach((listener) => listener())
  })
}

vi.mock('./tmCommStagingClient', () => ({
  tmCommRequest: async (...args: unknown[]) => {
    const res = await mockTmCommRequest(...args)
    if (args[0] === '/v1/tm-comm/me' && res && res.ok && res.data && Object.keys(res.data).length === 0) {
      return {
        ...res,
        data: {
          principal: {
            id: 'prn-mock',
            kind: 'customer',
            walletAddress: mockWalletState.address ?? 'ecash:qptest'
          }
        }
      }
    }
    return res
  }
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => {
    const [, setTick] = useState(0)
    useEffect(() => {
      const listener = () => setTick((t) => t + 1)
      walletListeners.add(listener)
      return () => {
        walletListeners.delete(listener)
      }
    }, [])
    return {
      ...mockWalletState,
      refreshBalances: vi.fn(),
      rescanWallet: vi.fn()
    }
  }
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
    ['manipulated canonicalMessage', () => ({ ...makeValidChallenge(), canonicalMessage: 'tampered text' })],
    ['different valid sessionContext', () => ({ ...makeValidChallenge(), sessionContext: 'tm-comm-production:v1' })],
    ['same prefix with different version', () => ({ ...makeValidChallenge(), sessionContext: 'tm-comm-a0-staging:v2' })],
    ['empty sessionContext', () => ({ ...makeValidChallenge(), sessionContext: '' })],
    ['omitted sessionContext', () => {
      const copy = { ...makeValidChallenge() } as Record<string, unknown>
      delete copy.sessionContext
      return copy
    }],
    ['whitespace added to sessionContext', () => ({ ...makeValidChallenge(), sessionContext: ' tm-comm-a0-staging:v1' })],
    ['canonicalMessage consistent with wrong context', () => createTmCommAuthChallengeView({ ...makeValidChallenge(), sessionContext: 'tm-comm-a0-staging:v2' })]
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

describe('P2-10: Session-generation-safe hydration and state containment', () => {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1:5174'

  const makeValidChallenge = (id = 'chlg_valid_123') =>
    createTmCommAuthChallengeView({
      challengeId: id,
      nonce: 'nonce_secret_abc',
      expiresAt: Date.now() + 600_000,
      audience: origin,
      origin: origin,
      sessionContext: 'tm-comm-a0-staging:v1'
    })

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

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

  test('delayed messages from previous session are discarded after authenticating new session', async () => {
    const deferredMessagesA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    const convA = { id: 'conv-session-A', reservationId: 'rsv-A', createdAt: 1000 }
    const convB = { id: 'conv-session-B', reservationId: 'rsv-B', createdAt: 2000 }
    const msgB = {
      id: 'msg-B-1',
      clientMessageId: 'cli-B-1',
      body: 'Visible session B message',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'accepted',
      replyToId: null
    }
    const msgA = {
      id: 'msg-A-1',
      clientMessageId: 'cli-A-1',
      body: 'STALE SENSITIVE CONTENT SESSION A',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-session-A/messages') {
        return deferredMessagesA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // Wait until conv-session-A is active (messages pending)
    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-session-A · Reserva: rsv-A/i)).toBeDefined()
    })

    // Now configure mocks for authenticating session B
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 201, data: {} })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-session-B/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-session-A/messages') {
        return deferredMessagesA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    // User authenticates session B
    const signBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(signBtn)

    // UI transitions and displays session B
    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-session-B · Reserva: rsv-B/i)).toBeDefined()
      expect(screen.getByText(/Visible session B message/i)).toBeDefined()
    })

    // Now delayed messages for session A finally resolve
    deferredMessagesA.resolve({ ok: true, status: 200, data: { messages: [msgA] } })

    // Give microtasks time to execute
    await new Promise((resolve) => setTimeout(resolve, 50))

    // UI MUST show ONLY session B
    expect(screen.getByText(/Conversación: conv-session-B · Reserva: rsv-B/i)).toBeDefined()
    expect(screen.getByText(/Visible session B message/i)).toBeDefined()

    // Session A sensitive message must NEVER appear in the DOM
    expect(screen.queryByText(/STALE SENSITIVE CONTENT SESSION A/i)).toBeNull()
    expect(screen.queryByText(/Conversación: conv-session-A/i)).toBeNull()

    // Log must not contain stale messages content for session A after session switch
    const logText = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logText).not.toContain('STALE SENSITIVE CONTENT SESSION A')
    const logLines = logText.split('\n')
    const bIndex = logLines.findIndex((line) => line.includes('conv-session-B'))
    const linesAfterB = logLines.slice(bIndex)
    expect(linesAfterB.some((line) => line.includes('conv-session-A'))).toBe(false)
    expect(linesAfterB.filter((line) => line.includes('Historial recargado')).length).toBe(1)
  })

  test('conversations pending for session A are discarded when session B is authenticated', async () => {
    const deferredConversationsA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    const convA = { id: 'conv-late-A', reservationId: 'rsv-late-A', createdAt: 1000 }
    const convB = { id: 'conv-active-B', reservationId: 'rsv-active-B', createdAt: 2000 }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return deferredConversationsA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // While conversations A is pending, authenticate session B
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B2') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 201, data: {} })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-active-B/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    const signBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(signBtn)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-active-B · Reserva: rsv-active-B/i)).toBeDefined()
    })

    // Now resolve late conversations for session A
    deferredConversationsA.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // UI remains on session B
    expect(screen.getByText(/Conversación: conv-active-B · Reserva: rsv-active-B/i)).toBeDefined()
    expect(screen.queryByText(/conv-late-A/i)).toBeNull()
  })

  test('rapid authentication clicks (A -> B -> C) preserve only latest generation', async () => {
    let callIndex = 0
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        callIndex++
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge(`chlg_rapid_${callIndex}`) })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 201, data: {} })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            conversations: [{ id: `conv-gen-${callIndex}`, reservationId: `rsv-gen-${callIndex}`, createdAt: callIndex * 1000 }]
          }
        })
      }
      if (path.includes('/messages')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            messages: [
              {
                id: `msg-gen-${callIndex}`,
                clientMessageId: `cli-${callIndex}`,
                body: `Body from gen ${callIndex}`,
                senderKind: 'customer',
                serverCreatedAt: callIndex * 1000 + 10,
                status: 'accepted',
                replyToId: null
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    const signBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(signBtn)
    fireEvent.click(signBtn)
    fireEvent.click(signBtn)

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Body from gen ${callIndex}`, 'i'))).toBeDefined()
    })

    // Intermediate generations are not displayed
    for (let i = 1; i < callIndex; i++) {
      expect(screen.queryByText(new RegExp(`Body from gen ${i}`, 'i'))).toBeNull()
    }
  })

  test('switching conversation while previous conversation history is pending discards stale history', async () => {
    const deferredMsg1 = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    const conv1 = { id: 'conv-switch-1', reservationId: 'rsv-1', createdAt: 1000 }
    const conv2 = { id: 'conv-switch-2', reservationId: 'rsv-2', createdAt: 2000 }
    const msg2 = {
      id: 'msg-conv2-1',
      clientMessageId: 'cli-2-1',
      body: 'Content for conversation 2',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'accepted',
      replyToId: null
    }
    const msg1 = {
      id: 'msg-conv1-1',
      clientMessageId: 'cli-1-1',
      body: 'Stale content for conversation 1',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'accepted',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        // Return both conversations, conv2 is newer
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [conv1, conv2] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-switch-2/messages') {
        return deferredMsg1.promise
      }
      if (path === '/v1/tm-comm/conversations/conv-switch-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msg2] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // Mount selects newer conversation conv-switch-2, its messages are pending (deferredMsg1)
    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-switch-2 · Reserva: rsv-2/i)).toBeDefined()
    })

    // User switches to conv-switch-1
    const select = screen.getByRole('combobox', { name: /Seleccionar conversación/i })
    fireEvent.change(select, { target: { value: 'conv-switch-1' } })

    // conv-switch-1 resolves immediately
    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-switch-1 · Reserva: rsv-1/i)).toBeDefined()
      expect(screen.getByText(/Content for conversation 2/i)).toBeDefined()
    })

    // Now delayed message for conv-switch-2 resolves
    deferredMsg1.resolve({ ok: true, status: 200, data: { messages: [msg1] } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // UI continues showing conv-switch-1 and never shows stale content
    expect(screen.getByText(/Conversación: conv-switch-1 · Reserva: rsv-1/i)).toBeDefined()
    expect(screen.getByText(/Content for conversation 2/i)).toBeDefined()
    expect(screen.queryByText(/Stale content for conversation 1/i)).toBeNull()
  })

  test('stale 401 from earlier session does not clear valid state of current session', async () => {
    const deferredConvA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    const convB = { id: 'conv-session-B-valid', reservationId: 'rsv-B-valid', createdAt: 2000 }
    const msgB = {
      id: 'msg-B-valid',
      clientMessageId: 'cli-B-v',
      body: 'Valid session B data',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'accepted',
      replyToId: null
    }

    // Mount starts session A hydration (deferred)
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return deferredConvA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // User authenticates session B
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B_401') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 201, data: {} })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-session-B-valid/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    const signBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(signBtn)

    // Session B hydrates valid data
    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-session-B-valid · Reserva: rsv-B-valid/i)).toBeDefined()
      expect(screen.getByText(/Valid session B data/i)).toBeDefined()
    })

    // Now session A resolves with 401 Unauthorized
    deferredConvA.resolve({ ok: false, status: 401, data: null })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Valid state of session B is NOT cleared!
    expect(screen.getByText(/Conversación: conv-session-B-valid · Reserva: rsv-B-valid/i)).toBeDefined()
    expect(screen.getByText(/Valid session B data/i)).toBeDefined()
  })

  test('unmount while hydration in-flight cancels cleanly without errors', async () => {
    const deferred = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/conversations') {
        return deferred.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    const { unmount } = render(<TmCommStaging />)
    unmount()

    // Resolving after unmount must not throw or cause state update on unmounted component
    deferred.resolve({
      ok: true,
      status: 200,
      data: { conversations: [{ id: 'conv-unmounted', reservationId: 'rsv-unmounted' }] }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  describe('P2-11: Clear stale messages when switching conversations', () => {
    test('A tiene mensajes visibles -> seleccionar B -> los mensajes de A desaparecen inmediatamente, antes de resolver el fetch de B', async () => {
      const convA = { id: 'conv-A', reservationId: 'rsv-A', createdAt: 2000 }
      const convB = { id: 'conv-B', reservationId: 'rsv-B', createdAt: 1000 }
      const msgA = {
        id: 'msg-A-1',
        clientMessageId: 'cli-A-1',
        body: 'Message A visible content',
        senderKind: 'customer',
        serverCreatedAt: 2010,
        status: 'delivered',
        replyToId: null
      }
      const msgB = {
        id: 'msg-B-1',
        clientMessageId: 'cli-B-1',
        body: 'Message B newly loaded',
        senderKind: 'customer',
        serverCreatedAt: 2020,
        status: 'delivered',
        replyToId: null
      }

      const deferredB = createDeferred<{ ok: boolean; status: number; data: unknown }>()

      mockTmCommRequest.mockImplementation((path: string) => {
        if (path === '/v1/tm-comm/conversations') {
          return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA, convB] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-A/messages') {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-B/messages') {
          return deferredB.promise
        }
        return Promise.resolve({ ok: true, status: 200, data: {} })
      })

      render(<TmCommStaging />)

      // Wait until conv-A is active and msgA is visible
      await waitFor(() => {
        expect(screen.getByText(/Conversación: conv-A · Reserva: rsv-A/i)).toBeDefined()
        expect(screen.getByText(/Message A visible content/i)).toBeDefined()
      })

      // Now select conv-B
      const select = screen.getByLabelText(/Seleccionar conversación/i)
      fireEvent.change(select, { target: { value: 'conv-B' } })

      // Immediately and synchronously before deferredB resolves:
      // Conversation heading switches to conv-B
      expect(screen.getByText(/Conversación: conv-B · Reserva: rsv-B/i)).toBeDefined()
      // Message A disappeared immediately!
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()
      // No messages rendered for B yet
      expect(screen.queryByText(/Message B newly loaded/i)).toBeNull()

      // Now resolve fetch for B
      deferredB.resolve({ ok: true, status: 200, data: { messages: [msgB] } })

      await waitFor(() => {
        expect(screen.getByText(/Message B newly loaded/i)).toBeDefined()
      })

      // A remains gone
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()
    })

    test('fetch de B falla -> A nunca reaparece', async () => {
      const convA = { id: 'conv-A', reservationId: 'rsv-A', createdAt: 2000 }
      const convB = { id: 'conv-B', reservationId: 'rsv-B', createdAt: 1000 }
      const msgA = {
        id: 'msg-A-1',
        clientMessageId: 'cli-A-1',
        body: 'Message A visible content',
        senderKind: 'customer',
        serverCreatedAt: 2010,
        status: 'delivered',
        replyToId: null
      }

      mockTmCommRequest.mockImplementation((path: string) => {
        if (path === '/v1/tm-comm/conversations') {
          return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA, convB] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-A/messages') {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-B/messages') {
          return Promise.resolve({ ok: false, status: 500, data: null })
        }
        return Promise.resolve({ ok: true, status: 200, data: {} })
      })

      render(<TmCommStaging />)

      await waitFor(() => {
        expect(screen.getByText(/Conversación: conv-A · Reserva: rsv-A/i)).toBeDefined()
        expect(screen.getByText(/Message A visible content/i)).toBeDefined()
      })

      const select = screen.getByLabelText(/Seleccionar conversación/i)
      fireEvent.change(select, { target: { value: 'conv-B' } })

      // Messages of A disappear immediately
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()

      // Wait for the failure to be logged
      await waitFor(() => {
        expect(screen.getByText(/No se pudieron leer mensajes \(500\)/i)).toBeDefined()
      })

      // A never reappears, UI remains empty
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()
      expect(screen.getByText(/Conversación: conv-B · Reserva: rsv-B/i)).toBeDefined()
    })

    test('fetch de B queda pendiente -> UI de B permanece sin mensajes', async () => {
      const convA = { id: 'conv-A', reservationId: 'rsv-A', createdAt: 2000 }
      const convB = { id: 'conv-B', reservationId: 'rsv-B', createdAt: 1000 }
      const msgA = {
        id: 'msg-A-1',
        clientMessageId: 'cli-A-1',
        body: 'Message A visible content',
        senderKind: 'customer',
        serverCreatedAt: 2010,
        status: 'delivered',
        replyToId: null
      }

      const pendingPromise = new Promise<{ ok: boolean; status: number; data: unknown }>(() => {})

      mockTmCommRequest.mockImplementation((path: string) => {
        if (path === '/v1/tm-comm/conversations') {
          return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA, convB] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-A/messages') {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-B/messages') {
          return pendingPromise
        }
        return Promise.resolve({ ok: true, status: 200, data: {} })
      })

      render(<TmCommStaging />)

      await waitFor(() => {
        expect(screen.getByText(/Message A visible content/i)).toBeDefined()
      })

      const select = screen.getByLabelText(/Seleccionar conversación/i)
      fireEvent.change(select, { target: { value: 'conv-B' } })

      // Message A is gone immediately
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()

      // Wait a brief delay to ensure no asynchronous effect populates stale messages
      await new Promise((resolve) => setTimeout(resolve, 50))

      // UI of B remains without messages
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()
      expect(screen.getByText(/Conversación: conv-B · Reserva: rsv-B/i)).toBeDefined()
    })

    test('cambios rápidos A -> B -> C -> solo C puede poblar estado', async () => {
      const convA = { id: 'conv-A', reservationId: 'rsv-A', createdAt: 3000 }
      const convB = { id: 'conv-B', reservationId: 'rsv-B', createdAt: 2000 }
      const convC = { id: 'conv-C', reservationId: 'rsv-C', createdAt: 1000 }

      const msgA = {
        id: 'msg-A-1',
        clientMessageId: 'cli-A-1',
        body: 'Message A visible content',
        senderKind: 'customer',
        serverCreatedAt: 3010,
        status: 'delivered',
        replyToId: null
      }
      const msgB = {
        id: 'msg-B-1',
        clientMessageId: 'cli-B-1',
        body: 'Stale message B content',
        senderKind: 'customer',
        serverCreatedAt: 2010,
        status: 'delivered',
        replyToId: null
      }
      const msgC = {
        id: 'msg-C-1',
        clientMessageId: 'cli-C-1',
        body: 'Active message C content',
        senderKind: 'customer',
        serverCreatedAt: 1010,
        status: 'delivered',
        replyToId: null
      }

      const deferredB = createDeferred<{ ok: boolean; status: number; data: unknown }>()
      const deferredC = createDeferred<{ ok: boolean; status: number; data: unknown }>()

      mockTmCommRequest.mockImplementation((path: string) => {
        if (path === '/v1/tm-comm/conversations') {
          return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA, convB, convC] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-A/messages') {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        if (path === '/v1/tm-comm/conversations/conv-B/messages') {
          return deferredB.promise
        }
        if (path === '/v1/tm-comm/conversations/conv-C/messages') {
          return deferredC.promise
        }
        return Promise.resolve({ ok: true, status: 200, data: {} })
      })

      render(<TmCommStaging />)

      await waitFor(() => {
        expect(screen.getByText(/Message A visible content/i)).toBeDefined()
      })

      const select = screen.getByLabelText(/Seleccionar conversación/i)

      // Rapidly switch A -> B -> C
      fireEvent.change(select, { target: { value: 'conv-B' } })
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()

      fireEvent.change(select, { target: { value: 'conv-C' } })
      expect(screen.getByText(/Conversación: conv-C · Reserva: rsv-C/i)).toBeDefined()

      // B resolves late
      deferredB.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      await new Promise((resolve) => setTimeout(resolve, 50))

      // B must NOT populate state
      expect(screen.queryByText(/Stale message B content/i)).toBeNull()
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()

      // C resolves
      deferredC.resolve({ ok: true, status: 200, data: { messages: [msgC] } })

      await waitFor(() => {
        expect(screen.getByText(/Active message C content/i)).toBeDefined()
      })

      // Confirm only C populated state
      expect(screen.getByText(/Conversación: conv-C · Reserva: rsv-C/i)).toBeDefined()
      expect(screen.getByText(/Active message C content/i)).toBeDefined()
      expect(screen.queryByText(/Stale message B content/i)).toBeNull()
      expect(screen.queryByText(/Message A visible content/i)).toBeNull()
    })
  })
})

describe('P2-13: Wallet-session coherence and state containment', () => {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1:5174'

  const makeValidChallenge = (id = 'chlg_valid_123') =>
    createTmCommAuthChallengeView({
      challengeId: id,
      nonce: 'nonce_secret_abc',
      expiresAt: Date.now() + 600_000,
      audience: origin,
      origin: origin,
      sessionContext: 'tm-comm-a0-staging:v1'
    })

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setMockWallet({
      address: 'ecash:qptest',
      initialized: true,
      balance: null,
      loading: false,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('mount with cookie/session A + active wallet B fails closed and A never appears', async () => {
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-1',
      clientMessageId: 'cli-A-1',
      body: 'Secret A messages should not leak',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })

    // Wallet A's conversation and messages must never appear
    expect(screen.queryByText(/Secret A messages should not leak/i)).toBeNull()
    expect(screen.queryByText(/conv-A-1/i)).toBeNull()

    // Authenticated operations must be disabled
    expect((screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('reload with cookie/session A + active wallet A restores previous valid session', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-1',
      clientMessageId: 'cli-A-1',
      body: 'Reloaded message for wallet A',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-A-1 · Reserva: rsv-A-1/i)).toBeDefined()
      expect(screen.getByText(/Reloaded message for wallet A/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    expect((screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('authenticated wallet A -> switch wallet to B -> state A immediately disappears', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-1',
      clientMessageId: 'cli-A-1',
      body: 'Wallet A confidential chat',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        // Return wallet A's principal (as if cookie is still for wallet A)
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Wallet A confidential chat/i)).toBeDefined()
    })

    // User switches to wallet B
    setMockWallet({ address: 'ecash:walletB' })

    // Wallet A's state must disappear synchronously
    expect(screen.queryByText(/Wallet A confidential chat/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()

    // Authenticated operations must now be disabled for wallet B
    expect((screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('pending requests from wallet A -> switch to wallet B -> responses from A are never applied', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-1',
      clientMessageId: 'cli-A-1',
      body: 'Slow in-flight message for A',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    const deferredMsgA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-1/messages') {
        return deferredMsgA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-A-1 · Reserva: rsv-A-1/i)).toBeDefined()
    })

    // Switch to wallet B while message request for A is still pending
    setMockWallet({ address: 'ecash:walletB' })

    // Now resolve message A
    deferredMsgA.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Message A must never appear
    expect(screen.queryByText(/Slow in-flight message for A/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
  })

  test('after wallet switch, bind and send cannot execute until reauth for wallet B', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-A-1 · Reserva: rsv-A-1/i)).toBeDefined()
    })

    // Switch to wallet B
    setMockWallet({ address: 'ecash:walletB' })

    const bindButton = screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement
    const sendButton = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement

    expect(bindButton.disabled).toBe(true)
    expect(sendButton.disabled).toBe(true)

    // Clear calls to track any unauthorized mutation
    mockTmCommRequest.mockClear()

    // Attempting to invoke bind or send directly fails without sending requests
    fireEvent.click(bindButton)
    fireEvent.click(sendButton)

    expect(mockTmCommRequest).not.toHaveBeenCalledWith(
      '/v1/tm-comm/bindings',
      expect.anything()
    )
    expect(mockTmCommRequest).not.toHaveBeenCalledWith(
      expect.stringContaining('/messages'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('wallet switch A -> B -> reauth B -> only B can hydrate and display', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    const convB = { id: 'conv-B-1', reservationId: 'rsv-B-1', createdAt: 2000 }
    const msgB = {
      id: 'msg-B-1',
      clientMessageId: 'cli-B-1',
      body: 'Verified chat for wallet B',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-A-1 · Reserva: rsv-A-1/i)).toBeDefined()
    })

    // Switch to wallet B
    setMockWallet({ address: 'ecash:walletB' })

    // Setup mock for B's authentication and data
    mockSignMessage.mockResolvedValue('signature_wallet_B')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({
          ok: true,
          status: 201,
          data: {
            principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' },
            expiresAt: Date.now() + 600_000
          }
        })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-B-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    // Click authenticate for wallet B
    const authButton = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(authButton)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-B-1 · Reserva: rsv-B-1/i)).toBeDefined()
      expect(screen.getByText(/Verified chat for wallet B/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
    })

    // Wallet A's conversation must NOT be in the document
    expect(screen.queryByText(/Conversación: conv-A-1/i)).toBeNull()
  })

  test('wallet locked/uninitialized -> private state purged immediately', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-1', reservationId: 'rsv-A-1', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-1',
      clientMessageId: 'cli-A-1',
      body: 'Visible secret before lock',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Visible secret before lock/i)).toBeDefined()
    })

    // Wallet locks / uninitializes
    setMockWallet({ initialized: false, address: null })

    expect(screen.queryByText(/Visible secret before lock/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    expect(screen.getByText(/Wallet: no desbloqueada/i)).toBeDefined()
  })

  test('stale 401 or response from earlier session A cannot mutate state of wallet B', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convB = { id: 'conv-B-1', reservationId: 'rsv-B-1', createdAt: 2000 }
    const msgB = {
      id: 'msg-B-1',
      clientMessageId: 'cli-B-1',
      body: 'Protected wallet B content',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'delivered',
      replyToId: null
    }

    const deferredConvA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return deferredConvA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // Switch to wallet B and authenticate
    setMockWallet({ address: 'ecash:walletB' })

    mockSignMessage.mockResolvedValue('signature_wallet_B')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B_stale') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({
          ok: true,
          status: 201,
          data: {
            principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' },
            expiresAt: Date.now() + 600_000
          }
        })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-B-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/Protected wallet B content/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-B-1/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
    })

    // Now earlier request from session A resolves with 401 Unauthorized
    deferredConvA.resolve({ ok: false, status: 401, data: null })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // State of wallet B must NOT be wiped by stale 401
    expect(screen.getByText(/Protected wallet B content/i)).toBeDefined()
    expect(screen.getByText(/Conversación: conv-B-1/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
  })
})

describe('P2-17 & P2-18: Pre-commit privacy gate and busy state invalidation', () => {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1:5174'

  const makeValidChallenge = (id = 'chlg_valid_123') =>
    createTmCommAuthChallengeView({
      challengeId: id,
      nonce: 'nonce_secret_abc',
      expiresAt: Date.now() + 600_000,
      audience: origin,
      origin: origin,
      sessionContext: 'tm-comm-a0-staging:v1'
    })

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    walletListeners.clear()
    setMockWallet({
      address: 'ecash:qptest',
      initialized: true,
      balance: null,
      loading: false,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('immediate render gate: switching wallet A -> B hides private state immediately before effects', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA1 = { id: 'conv-A-primary', reservationId: 'rsv-A-primary', createdAt: 1000 }
    const convA2 = { id: 'conv-A-secondary', reservationId: 'rsv-A-secondary', createdAt: 1001 }
    const msgA = {
      id: 'msg-A-secret-1',
      clientMessageId: 'cli-A-1',
      body: 'CONFIDENTIAL_A_BODY_TEXT',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA1, convA2] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-secondary/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // Wait until A is fully visible
    await waitFor(() => {
      expect(screen.getByText(/CONFIDENTIAL_A_BODY_TEXT/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-A-secondary/i)).toBeDefined()
      expect(screen.getByText(/Reserva: rsv-A-secondary/i)).toBeDefined()
      expect(screen.getByRole('combobox', { name: /Seleccionar conversación/i })).toBeDefined()
    })

    const logBefore = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logBefore).toContain('conv-A-secondary')

    // Synchronously switch wallet from A to B
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    // In the immediate resulting render:
    // 1. Text of message A is absent
    expect(screen.queryByText(/CONFIDENTIAL_A_BODY_TEXT/i)).toBeNull()
    // 2. Conversation ID A is absent
    expect(screen.queryByText(/conv-A-primary/i)).toBeNull()
    expect(screen.queryByText(/conv-A-secondary/i)).toBeNull()
    // 3. Reservation ID A is absent
    expect(screen.queryByText(/rsv-A-primary/i)).toBeNull()
    expect(screen.queryByText(/rsv-A-secondary/i)).toBeNull()
    // 4. Selector / options A are absent
    expect(screen.queryByRole('combobox', { name: /Seleccionar conversación/i })).toBeNull()
    // 5. Metadata of log A is absent
    const logAfter = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logAfter).not.toContain('conv-A-primary')
    expect(logAfter).not.toContain('conv-A-secondary')
    expect(logAfter).not.toContain('rsv-A-primary')
    expect(logAfter).not.toContain('rsv-A-secondary')
    expect(logAfter).not.toContain('CONFIDENTIAL_A_BODY_TEXT')
    // 6. Sensitive input fields are blank in render
    expect((screen.getByLabelText('Token de enrolamiento') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Cuerpo del mensaje') as HTMLTextAreaElement).value).toBe('')
    // 7. Conversación summary is reset
    expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
  })

  test('auth A pending + switch B -> auth button on B is enabled (busy=false)', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const deferredChallengeA = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({ ok: false, status: 401, data: null })
      }
      if (path === '/v1/tm-comm/challenges') {
        return deferredChallengeA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    const signButtonA = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    expect(signButtonA.hasAttribute('disabled')).toBe(false)

    fireEvent.click(signButtonA)

    // While challenge request for A is pending, button is disabled
    expect(signButtonA.hasAttribute('disabled')).toBe(true)

    // Switch wallet to B
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    // Immediately on render of wallet B, auth button for B is enabled (busy=false)
    const signButtonB = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    expect(signButtonB.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(/Wallet: ecash:walletB/i)).toBeDefined()

    // Resolve deferred challenge for A
    deferredChallengeA.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg-stale-A') })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Button B remains enabled and unaffected
    expect(signButtonB.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
  })

  test('bind pending on A + switch B -> UI is not blocked, busy=false', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const deferredBindA = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [] } })
      }
      if (path === '/v1/tm-comm/bindings') {
        return deferredBindA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    const bindButton = screen.getByRole('button', { name: /Consumir invitación/i })
    expect(bindButton.hasAttribute('disabled')).toBe(false)

    fireEvent.click(bindButton)

    // In-flight binding on A makes UI busy
    expect(bindButton.hasAttribute('disabled')).toBe(true)

    // Switch wallet to B
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    // Immediately on render of wallet B: auth button is enabled, UI is not locked
    const signButtonB = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    expect(signButtonB.hasAttribute('disabled')).toBe(false)

    // Resolve deferred bind for A
    const staleConv = { id: 'conv-stale-A', reservationId: 'rsv-stale-A', createdAt: 9999 }
    deferredBindA.resolve({ ok: true, status: 201, data: { conversation: staleConv } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // B remains clean and not blocked
    expect(screen.queryByText(/conv-stale-A/i)).toBeNull()
    expect(screen.queryByText(/rsv-stale-A/i)).toBeNull()
    expect(signButtonB.hasAttribute('disabled')).toBe(false)
  })

  test('send pending on A + switch B -> UI is not blocked, busy=false', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-send', reservationId: 'rsv-A-send', createdAt: 1000 }
    const deferredSendA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-send/messages') {
        return deferredSendA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Conversación: conv-A-send/i)).toBeDefined()
    })

    const sendButton = screen.getByRole('button', { name: /Enviar al servidor/i })
    fireEvent.click(sendButton)

    // Send is in-flight on A
    expect(sendButton.hasAttribute('disabled')).toBe(true)

    // Switch wallet to B
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    // Immediately on render of B: auth button is enabled, UI not blocked
    const signButtonB = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    expect(signButtonB.hasAttribute('disabled')).toBe(false)

    // Resolve deferred send for A
    deferredSendA.resolve({
      ok: true,
      status: 201,
      data: {
        id: 'msg-stale-A',
        clientMessageId: 'cli-stale',
        body: 'Late message from A',
        senderKind: 'customer',
        serverCreatedAt: 9999,
        status: 'delivered',
        replyToId: null
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // B remains clean and not blocked
    expect(screen.queryByText(/msg-stale-A/i)).toBeNull()
    expect(screen.queryByText(/Late message from A/i)).toBeNull()
    expect(signButtonB.hasAttribute('disabled')).toBe(false)
  })

  test('late completion of A cannot alter busy nor repopulate content', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const deferredAuthA = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    const deferredListA = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({ ok: false, status: 401, data: null })
      }
      if (path === '/v1/tm-comm/challenges') {
        return deferredAuthA.promise
      }
      if (path === '/v1/tm-comm/conversations') {
        return deferredListA.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    // Switch to wallet B
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    // Authenticate B cleanly
    const convB = { id: 'conv-B-valid', reservationId: 'rsv-B-valid', createdAt: 2000 }
    const msgB = {
      id: 'msg-B-valid',
      clientMessageId: 'cli-B-valid',
      body: 'Clean wallet B message',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'delivered',
      replyToId: null
    }

    mockSignMessage.mockResolvedValue('signature_B')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B_valid') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({
          ok: true,
          status: 201,
          data: {
            principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' },
            expiresAt: Date.now() + 600_000
          }
        })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-B-valid/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/Clean wallet B message/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-B-valid/i)).toBeDefined()
    })

    // Now resolve late responses from A
    deferredAuthA.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_stale_A') })
    deferredListA.resolve({
      ok: true,
      status: 200,
      data: {
        conversations: [{ id: 'conv-A-stale', reservationId: 'rsv-A-stale', createdAt: 999 }]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Only B's state remains visible, busy remains false
    expect(screen.getByText(/Clean wallet B message/i)).toBeDefined()
    expect(screen.queryByText(/conv-A-stale/i)).toBeNull()
    expect(screen.queryByText(/rsv-A-stale/i)).toBeNull()
    const signButton = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    expect(signButton.hasAttribute('disabled')).toBe(false)
  })

  test('rapid A -> B -> C switch retains only visible state compatible with C', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            conversations: [{ id: 'conv-A-rapid', reservationId: 'rsv-A-rapid', createdAt: 1000 }]
          }
        })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-rapid/messages') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            messages: [
              {
                id: 'msg-A-rapid',
                clientMessageId: 'cli-A-rapid',
                body: 'Rapid A message',
                senderKind: 'customer',
                serverCreatedAt: 1010,
                status: 'delivered',
                replyToId: null
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Rapid A message/i)).toBeDefined()
    })

    // Rapid switch: A -> B -> C
    setMockWallet({ address: 'ecash:walletB', initialized: true })
    setMockWallet({ address: 'ecash:walletC', initialized: true })

    // Immediately on render of C: neither A nor B data is visible
    expect(screen.queryByText(/Rapid A message/i)).toBeNull()
    expect(screen.queryByText(/conv-A-rapid/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
    expect(screen.getByText(/Wallet: ecash:walletC/i)).toBeDefined()

    // Authenticate C
    const convC = { id: 'conv-C-rapid', reservationId: 'rsv-C-rapid', createdAt: 3000 }
    const msgC = {
      id: 'msg-C-rapid',
      clientMessageId: 'cli-C-rapid',
      body: 'Legitimate C content',
      senderKind: 'customer',
      serverCreatedAt: 3010,
      status: 'delivered',
      replyToId: null
    }

    mockSignMessage.mockResolvedValue('signature_C')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_C_rapid') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({
          ok: true,
          status: 201,
          data: {
            principal: { id: 'prn-C', kind: 'customer', walletAddress: 'ecash:walletC' },
            expiresAt: Date.now() + 600_000
          }
        })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-C', kind: 'customer', walletAddress: 'ecash:walletC' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convC] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-C-rapid/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgC] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/Legitimate C content/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-C-rapid/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletC\)/i)).toBeDefined()
    })

    expect(screen.queryByText(/Rapid A message/i)).toBeNull()
    expect(screen.queryByText(/conv-A-rapid/i)).toBeNull()
  })

  test('initial mount with cookie A + wallet B fails closed and displays no private data', async () => {
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        // Server cookie belongs to wallet A, but active client wallet is B
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM no coincide con la wallet activa/i)).toBeDefined()
    })

    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    expect(screen.getByText(/Conversación: ninguna · Reserva: —/i)).toBeDefined()
    expect(screen.queryByText(/conv-A/i)).toBeNull()
  })

  test('reload A + wallet A restores previous valid session correctly', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    const convA = { id: 'conv-A-reload', reservationId: 'rsv-A-reload', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-reload',
      clientMessageId: 'cli-A-reload',
      body: 'Restored message on reload',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-reload/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Restored message on reload/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-A-reload/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })
  })

  test('inputs enrollmentToken and messageBody typed under wallet A are purged upon switch to B', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    // User types confidential token and draft under wallet A
    const tokenInput = screen.getByLabelText('Token de enrolamiento') as HTMLInputElement
    const messageInput = screen.getByLabelText('Cuerpo del mensaje') as HTMLTextAreaElement

    fireEvent.change(tokenInput, { target: { value: 'secret-enrollment-token-A' } })
    fireEvent.change(messageInput, { target: { value: 'secret-draft-body-A' } })

    expect(tokenInput.value).toBe('secret-enrollment-token-A')
    expect(messageInput.value).toBe('secret-draft-body-A')

    // Switch wallet to B
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    // Immediately on render of B: inputs are blank
    expect((screen.getByLabelText('Token de enrolamiento') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Cuerpo del mensaje') as HTMLTextAreaElement).value).toBe('')

    // After effects settle, verify underlying state was wiped and does not carry over
    await waitFor(() => {
      expect((screen.getByLabelText('Token de enrolamiento') as HTMLInputElement).value).toBe('')
    })
    expect((screen.getByLabelText('Token de enrolamiento') as HTMLInputElement).value).toBe('')
  })
})

describe('P2-19: Session-expiry invalidation on 401 in refreshMessages', () => {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1:5174'

  const makeValidChallenge = (id = 'chlg_valid_123') =>
    createTmCommAuthChallengeView({
      challengeId: id,
      nonce: 'nonce_secret_abc',
      expiresAt: Date.now() + 600_000,
      audience: origin,
      origin: origin,
      sessionContext: 'tm-comm-a0-staging:v1'
    })

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    walletListeners.clear()
    mockSignMessage.mockResolvedValue('signature_test_sig')
    mockGetPublicKeyHex.mockReturnValue('02' + '11'.repeat(32))
    setMockWallet({
      address: 'ecash:walletA',
      initialized: true,
      balance: null,
      loading: false,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('sesión válida con mensajes visibles -> refreshMessages recibe 401 -> invalida sesión y oculta contenido de inmediato', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })
    const convA = { id: 'conv-A-401', reservationId: 'rsv-A-401', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-secret',
      clientMessageId: 'cli-A-1',
      body: 'CONFIDENTIAL_MSG_BODY_TO_HIDE',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    let refreshCallCount = 0
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-401/messages') {
        refreshCallCount++
        if (refreshCallCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        // Second call (refresh history) returns 401 session expired
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    // Wait until authenticated session and messages are fully visible
    await waitFor(() => {
      expect(screen.getByText(/CONFIDENTIAL_MSG_BODY_TO_HIDE/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-A-401/i)).toBeDefined()
      expect(screen.getByText(/Reserva: rsv-A-401/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    // Controls are currently enabled
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement
    const tokenInput = screen.getByLabelText(/Token de enrolamiento/i) as HTMLInputElement
    const msgInput = screen.getByLabelText(/Cuerpo del mensaje/i) as HTMLTextAreaElement
    expect(refreshBtn.disabled).toBe(false)
    expect(sendBtn.disabled).toBe(false)
    expect(tokenInput.disabled).toBe(false)
    expect(msgInput.disabled).toBe(false)

    // Click "Recargar historial" to trigger refreshMessages which returns 401
    fireEvent.click(refreshBtn)

    // Immediately after 401:
    await waitFor(() => {
      // 1. Session shows "no autenticada"
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })

    // 2. Messages disappear
    expect(screen.queryByText(/CONFIDENTIAL_MSG_BODY_TO_HIDE/i)).toBeNull()

    // 3. Conversation disappears (shows "ninguna")
    expect(screen.getByText(/Conversación: ninguna/i)).toBeDefined()

    // 4. Reservation disappears (shows "—")
    expect(screen.getByText(/Reserva: —/i)).toBeDefined()

    // 5. Authenticated controls are disabled
    expect(refreshBtn.disabled).toBe(true)
    expect(sendBtn.disabled).toBe(true)
    expect(tokenInput.disabled).toBe(true)
    expect(msgInput.disabled).toBe(true)

    // 6. Authentication button remains enabled (busy released)
    const authBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }) as HTMLButtonElement
    expect(authBtn.disabled).toBe(false)

    // 7. Generic message is NOT logged as sole behavior, specific expiration logged
    const logText = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logText).not.toContain('No se pudieron leer mensajes (401)')
    expect(logText).toContain('Sesión TM-COMM expirada o no autorizada (401)')
  })

  test('401 vigente incrementa generación y respuestas antiguas posteriores no repueblan estado', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })
    const convA = { id: 'conv-A-old', reservationId: 'rsv-A-old', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-old',
      clientMessageId: 'cli-A-old',
      body: 'OLD_MESSAGES_DATA',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    const deferredOldFetch = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    let callCount = 0

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-old/messages') {
        callCount++
        if (callCount === 1) {
          // First load succeeds
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        if (callCount === 2) {
          // Second load is held pending (old fetch)
          return deferredOldFetch.promise
        }
        // Third call immediately returns 401
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/OLD_MESSAGES_DATA/i)).toBeDefined()
    })

    // Start a message refresh that stays pending (callCount = 2)
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i })
    fireEvent.click(refreshBtn)

    // Now trigger another refresh that returns 401 (callCount = 3)
    fireEvent.click(refreshBtn)

    // Verify session is invalidated by 401
    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })
    expect(screen.queryByText(/OLD_MESSAGES_DATA/i)).toBeNull()

    // Now resolve the old deferred fetch with data
    deferredOldFetch.resolve({
      ok: true,
      status: 200,
      data: {
        messages: [
          {
            id: 'msg-A-reappear-attempt',
            clientMessageId: 'cli-late',
            body: 'LATE_POLLUTING_DATA',
            senderKind: 'customer',
            serverCreatedAt: 2000,
            status: 'delivered',
            replyToId: null
          }
        ]
      }
    })

    // Wait microtasks
    await new Promise((r) => setTimeout(r, 50))

    // Late response cannot repopulate messages or conversation
    expect(screen.queryByText(/LATE_POLLUTING_DATA/i)).toBeNull()
    expect(screen.queryByText(/OLD_MESSAGES_DATA/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
  })

  test('stale 401 de una generación anterior se ignora y no destruye una sesión nueva válida', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })
    const convA = { id: 'conv-A-stale', reservationId: 'rsv-A-stale', createdAt: 1000 }
    const msgA1 = {
      id: 'msg-A-initial',
      clientMessageId: 'cli-A-1',
      body: 'INITIAL_SESSION_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }
    const msgA2 = {
      id: 'msg-A-new',
      clientMessageId: 'cli-A-2',
      body: 'VALID_NEW_SESSION_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1020,
      status: 'delivered',
      replyToId: null
    }

    const deferredStale401 = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    let callCount = 0

    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-stale/messages') {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA1] } })
        }
        if (callCount === 2) {
          // This call is held pending and will later return 401
          return deferredStale401.promise
        }
        // Newer calls in generation 2 return fresh messages
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA2] } })
      }
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 200, data: makeValidChallenge('chlg_stale_1') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 200, data: { session: { id: 'sess-new' } } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/INITIAL_SESSION_MSG/i)).toBeDefined()
    })

    // Trigger refreshMessages that will be held pending (callCount = 2)
    fireEvent.click(screen.getByRole('button', { name: /Recargar historial/i }))

    // Now re-authenticate (which starts a new session generation)
    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/VALID_NEW_SESSION_MSG/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    // Now resolve the old pending request from generation 1 with 401
    deferredStale401.resolve({ ok: false, status: 401, data: { error: 'EXPIRED' } })

    // Wait microtasks
    await new Promise((r) => setTimeout(r, 50))

    // The stale 401 from generation 1 MUST be ignored:
    // Session 2 must remain valid and authenticated, and messages must stay intact!
    expect(screen.getByText(/VALID_NEW_SESSION_MSG/i)).toBeDefined()
    expect(screen.getByText(/Conversación: conv-A-stale/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
  })

  test('un 500 no debe cerrar la sesión: conserva la semántica actual y deja controles activos', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })
    const convA = { id: 'conv-A-500', reservationId: 'rsv-A-500', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-safe',
      clientMessageId: 'cli-A-500',
      body: 'STILL_VISIBLE_AFTER_500',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    let refreshCount = 0
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-500/messages') {
        refreshCount++
        if (refreshCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        // Server failure (500)
        return Promise.resolve({ ok: false, status: 500, data: { error: 'INTERNAL_SERVER_ERROR' } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/STILL_VISIBLE_AFTER_500/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    fireEvent.click(refreshBtn)

    // Wait for the failure log
    await waitFor(() => {
      expect(screen.getByText(/No se pudieron leer mensajes \(500\)/i)).toBeDefined()
    })

    // Session remains authenticated!
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    // Messages remain visible
    expect(screen.getByText(/STILL_VISIBLE_AFTER_500/i)).toBeDefined()
    // Conversation remains visible
    expect(screen.getByText(/Conversación: conv-A-500/i)).toBeDefined()
    // Controls remain enabled
    expect(refreshBtn.disabled).toBe(false)
  })

  test('reautenticación posterior a 401 permite restaurar estado normalmente', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })
    const convA = { id: 'conv-A-restore', reservationId: 'rsv-A-restore', createdAt: 1000 }
    const msgA = {
      id: 'msg-A-restored',
      clientMessageId: 'cli-A-restored',
      body: 'RESTORED_AFTER_REAUTH_BODY',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    let refreshCount = 0
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-restore/messages') {
        refreshCount++
        if (refreshCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        if (refreshCount === 2) {
          // Session expires
          return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
        }
        // After reauthentication, refresh succeeds
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 200, data: makeValidChallenge('chlg_reauth') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({ ok: true, status: 200, data: { session: { id: 'sess-reauth' } } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/RESTORED_AFTER_REAUTH_BODY/i)).toBeDefined()
    })

    // Trigger 401
    fireEvent.click(screen.getByRole('button', { name: /Recargar historial/i }))

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })
    expect(screen.queryByText(/RESTORED_AFTER_REAUTH_BODY/i)).toBeNull()

    // Re-authenticate
    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
      expect(screen.getByText(/RESTORED_AFTER_REAUTH_BODY/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-A-restore/i)).toBeDefined()
    })
  })

  test('401 durante refreshMessages en send() libera busy state correctamente', async () => {
    setMockWallet({ address: 'ecash:walletA', initialized: true })
    const convA = { id: 'conv-A-busy', reservationId: 'rsv-A-busy', createdAt: 1000 }
    let msgCallCount = 0

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path.includes('/messages')) {
        return Promise.resolve({ ok: true, status: 200, data: { id: 'srv-msg-1' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-A-busy/messages') {
        msgCallCount++
        if (msgCallCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [] } })
        }
        // When send() triggers refreshMessages, it returns 401
        return Promise.resolve({ ok: false, status: 401, data: { error: 'EXPIRED' } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    // Click "Enviar al servidor"
    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i })
    fireEvent.click(sendBtn)

    // Wait for session invalidation
    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })

    // The authenticate button must not be stuck busy
    const authBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }) as HTMLButtonElement
    expect(authBtn.disabled).toBe(false)
  })
})

describe('P2-20: Centralized 401 session invalidation across refresh, bind, and send mutations', () => {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://127.0.0.1:5174'

  const makeValidChallenge = (id = 'chlg_p2_20') =>
    createTmCommAuthChallengeView({
      challengeId: id,
      nonce: 'nonce_secret_p2_20',
      expiresAt: Date.now() + 600_000,
      audience: origin,
      origin: origin,
      sessionContext: 'tm-comm-a0-staging:v1'
    })

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    walletListeners.clear()
    mockSignMessage.mockResolvedValue('signature_p2_20_sig')
    mockGetPublicKeyHex.mockReturnValue('02' + '11'.repeat(32))
    setMockWallet({
      address: 'ecash:walletA',
      initialized: true,
      balance: null,
      loading: false,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('bind() devuelve 401 -> sesión no autenticada, conversación/mensajes purgados, controles protegidos deshabilitados', async () => {
    const convA = { id: 'conv-bind-401', reservationId: 'rsv-bind-401', createdAt: 1000 }
    const msgA = {
      id: 'msg-bind-401-1',
      clientMessageId: 'cli-b401-1',
      body: 'BIND_401_SECRET_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/bindings') {
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-bind-401/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-bind-401/i)).toBeDefined()
      expect(screen.getByText(/Reserva: rsv-bind-401/i)).toBeDefined()
      expect(screen.getByText(/BIND_401_SECRET_MSG/i)).toBeDefined()
    })

    const bindBtn = screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement
    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    const tokenInput = screen.getByLabelText(/Token de enrolamiento/i) as HTMLInputElement
    const msgInput = screen.getByLabelText(/Cuerpo del mensaje/i) as HTMLTextAreaElement
    const authBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }) as HTMLButtonElement

    expect(bindBtn.disabled).toBe(false)
    expect(sendBtn.disabled).toBe(false)
    expect(refreshBtn.disabled).toBe(false)
    expect(tokenInput.disabled).toBe(false)
    expect(msgInput.disabled).toBe(false)

    fireEvent.click(bindBtn)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })

    expect(screen.queryByText(/BIND_401_SECRET_MSG/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna/i)).toBeDefined()
    expect(screen.getByText(/Reserva: —/i)).toBeDefined()

    expect(bindBtn.disabled).toBe(true)
    expect(sendBtn.disabled).toBe(true)
    expect(refreshBtn.disabled).toBe(true)
    expect(tokenInput.disabled).toBe(true)
    expect(msgInput.disabled).toBe(true)

    expect(authBtn.disabled).toBe(false)

    const logText = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logText).toContain('Sesión TM-COMM expirada o no autorizada (401). Se requiere reautenticación.')
    expect(logText).not.toContain('Binding rechazado (401)')
  })

  test('send() devuelve 401 -> misma invalidación completa', async () => {
    const convA = { id: 'conv-send-401', reservationId: 'rsv-send-401', createdAt: 1000 }
    const msgA = {
      id: 'msg-send-401-1',
      clientMessageId: 'cli-s401-1',
      body: 'SEND_401_SECRET_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/conversations/conv-send-401/messages') {
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-send-401/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-send-401/i)).toBeDefined()
      expect(screen.getByText(/Reserva: rsv-send-401/i)).toBeDefined()
      expect(screen.getByText(/SEND_401_SECRET_MSG/i)).toBeDefined()
    })

    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement
    const bindBtn = screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    const tokenInput = screen.getByLabelText(/Token de enrolamiento/i) as HTMLInputElement
    const msgInput = screen.getByLabelText(/Cuerpo del mensaje/i) as HTMLTextAreaElement
    const authBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }) as HTMLButtonElement

    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })

    expect(screen.queryByText(/SEND_401_SECRET_MSG/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna/i)).toBeDefined()
    expect(screen.getByText(/Reserva: —/i)).toBeDefined()

    expect(sendBtn.disabled).toBe(true)
    expect(bindBtn.disabled).toBe(true)
    expect(refreshBtn.disabled).toBe(true)
    expect(tokenInput.disabled).toBe(true)
    expect(msgInput.disabled).toBe(true)

    expect(authBtn.disabled).toBe(false)

    const logText = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logText).toContain('Sesión TM-COMM expirada o no autorizada (401). Se requiere reautenticación.')
    expect(logText).not.toContain('Envío rechazado (401)')
  })

  test('refreshMessages() 401 continúa usando el helper centralizado', async () => {
    const convA = { id: 'conv-ref-401', reservationId: 'rsv-ref-401', createdAt: 1000 }
    const msgA = {
      id: 'msg-ref-401-1',
      clientMessageId: 'cli-r401-1',
      body: 'REFRESH_401_SECRET_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    let refreshCallCount = 0
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-ref-401/messages') {
        refreshCallCount++
        if (refreshCallCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/REFRESH_401_SECRET_MSG/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    fireEvent.click(refreshBtn)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })

    expect(screen.queryByText(/REFRESH_401_SECRET_MSG/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna/i)).toBeDefined()
    expect(screen.getByText(/Reserva: —/i)).toBeDefined()
    expect(refreshBtn.disabled).toBe(true)

    const logText = screen.getByText(/Registro local de evidencia/i).parentElement?.textContent ?? ''
    expect(logText).toContain('Sesión TM-COMM expirada o no autorizada (401). Se requiere reautenticación.')
    expect(logText).not.toContain('No se pudieron leer mensajes (401)')
  })

  test('stale 401 de bind() de generación anterior no destruye una sesión nueva', async () => {
    const convA = { id: 'conv-b-stale-1', reservationId: 'rsv-b-stale-1', createdAt: 1000 }
    const convB = { id: 'conv-b-stale-2', reservationId: 'rsv-b-stale-2', createdAt: 2000 }
    const msgA = {
      id: 'msg-b-stale-1',
      clientMessageId: 'cli-bs1',
      body: 'GEN1_BIND_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }
    const msgB = {
      id: 'msg-b-stale-2',
      clientMessageId: 'cli-bs2',
      body: 'GEN2_AUTHENTICATED_BIND_MSG',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'delivered',
      replyToId: null
    }

    const deferredBind401 = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/bindings') {
        return deferredBind401.promise
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-b-stale-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/GEN1_BIND_MSG/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-b-stale-1/i)).toBeDefined()
    })

    // Click bind() which stays pending
    const bindBtn = screen.getByRole('button', { name: /Consumir invitación/i })
    fireEvent.click(bindBtn)

    // Switch wallet to B to advance session generation and clear busy state
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    mockSignMessage.mockResolvedValue('signature_wallet_B')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B_bind_stale') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({
          ok: true,
          status: 201,
          data: {
            principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' }
          }
        })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-b-stale-2/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/GEN2_AUTHENTICATED_BIND_MSG/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-b-stale-2/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
    })

    // Now resolve the stale bind() request from generation 1 with 401
    deferredBind401.resolve({ ok: false, status: 401, data: { error: 'STALE_SESSION_EXPIRED' } })

    // Wait microtasks
    await new Promise((resolve) => setTimeout(resolve, 50))

    // The stale 401 from generation 1 MUST be ignored; session B stays intact
    expect(screen.getByText(/GEN2_AUTHENTICATED_BIND_MSG/i)).toBeDefined()
    expect(screen.getByText(/Conversación: conv-b-stale-2/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
  })

  test('stale 401 de send() de generación anterior no destruye una sesión nueva', async () => {
    const convA = { id: 'conv-s-stale-1', reservationId: 'rsv-s-stale-1', createdAt: 1000 }
    const convB = { id: 'conv-s-stale-2', reservationId: 'rsv-s-stale-2', createdAt: 2000 }
    const msgA = {
      id: 'msg-s-stale-1',
      clientMessageId: 'cli-ss1',
      body: 'GEN1_SEND_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }
    const msgB = {
      id: 'msg-s-stale-2',
      clientMessageId: 'cli-ss2',
      body: 'GEN2_AUTHENTICATED_SEND_MSG',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'delivered',
      replyToId: null
    }

    const deferredSend401 = createDeferred<{ ok: boolean; status: number; data: unknown }>()

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/conversations/conv-s-stale-1/messages') {
        return deferredSend401.promise
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-s-stale-1/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/GEN1_SEND_MSG/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-s-stale-1/i)).toBeDefined()
    })

    // Click send() which stays pending
    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i })
    fireEvent.click(sendBtn)

    // Switch wallet to B to advance session generation and clear busy state
    setMockWallet({ address: 'ecash:walletB', initialized: true })

    mockSignMessage.mockResolvedValue('signature_wallet_B')
    mockTmCommRequest.mockImplementation((path: string) => {
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 201, data: makeValidChallenge('chlg_B_send_stale') })
      }
      if (path === '/v1/tm-comm/sessions') {
        return Promise.resolve({
          ok: true,
          status: 201,
          data: {
            principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' }
          }
        })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-B', kind: 'customer', walletAddress: 'ecash:walletB' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convB] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-s-stale-2/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgB] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    fireEvent.click(screen.getByRole('button', { name: /Firmar challenge TM-COMM/i }))

    await waitFor(() => {
      expect(screen.getByText(/GEN2_AUTHENTICATED_SEND_MSG/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-s-stale-2/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
    })

    // Now resolve the stale send() request from generation 1 with 401
    deferredSend401.resolve({ ok: false, status: 401, data: { error: 'STALE_SESSION_EXPIRED' } })

    // Wait microtasks
    await new Promise((resolve) => setTimeout(resolve, 50))

    // The stale 401 from generation 1 MUST be ignored; session B stays intact
    expect(screen.getByText(/GEN2_AUTHENTICATED_SEND_MSG/i)).toBeDefined()
    expect(screen.getByText(/Conversación: conv-s-stale-2/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletB\)/i)).toBeDefined()
  })

  test('bind() 500 no invalida sesión', async () => {
    const convA = { id: 'conv-b-500', reservationId: 'rsv-b-500', createdAt: 1000 }
    const msgA = {
      id: 'msg-b-500-1',
      clientMessageId: 'cli-b500-1',
      body: 'STILL_VISIBLE_AFTER_BIND_500',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/bindings') {
        return Promise.resolve({ ok: false, status: 500, data: { error: 'SERVER_ERROR' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-b-500/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/STILL_VISIBLE_AFTER_BIND_500/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    const bindBtn = screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement
    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    fireEvent.click(bindBtn)

    await waitFor(() => {
      expect(screen.getByText(/Binding rechazado \(500\)\. Una dirección conocida no basta\./i)).toBeDefined()
    })

    // Session remains authenticated
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    expect(screen.getByText(/Conversación: conv-b-500/i)).toBeDefined()
    expect(screen.getByText(/STILL_VISIBLE_AFTER_BIND_500/i)).toBeDefined()

    // Controls remain enabled
    expect(bindBtn.disabled).toBe(false)
    expect(sendBtn.disabled).toBe(false)
    expect(refreshBtn.disabled).toBe(false)
  })

  test('send() 500 no invalida sesión', async () => {
    const convA = { id: 'conv-s-500', reservationId: 'rsv-s-500', createdAt: 1000 }
    const msgA = {
      id: 'msg-s-500-1',
      clientMessageId: 'cli-s500-1',
      body: 'STILL_VISIBLE_AFTER_SEND_500',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/conversations/conv-s-500/messages') {
        return Promise.resolve({ ok: false, status: 500, data: { error: 'SERVER_ERROR' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-s-500/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/STILL_VISIBLE_AFTER_SEND_500/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement
    const bindBtn = screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(screen.getByText(/Envío rechazado \(500\)\./i)).toBeDefined()
    })

    // Session remains authenticated
    expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    expect(screen.getByText(/Conversación: conv-s-500/i)).toBeDefined()
    expect(screen.getByText(/STILL_VISIBLE_AFTER_SEND_500/i)).toBeDefined()

    // Controls remain enabled
    expect(sendBtn.disabled).toBe(false)
    expect(bindBtn.disabled).toBe(false)
    expect(refreshBtn.disabled).toBe(false)
  })

  test('reautenticación después de un mutation-401 funciona normalmente', async () => {
    const convA = { id: 'conv-mut-401', reservationId: 'rsv-mut-401', createdAt: 1000 }
    const convRestored = { id: 'conv-mut-restored', reservationId: 'rsv-mut-restored', createdAt: 2000 }
    const msgA = {
      id: 'msg-mut-1',
      clientMessageId: 'cli-m-1',
      body: 'BEFORE_MUT_401_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }
    const msgRestored = {
      id: 'msg-mut-2',
      clientMessageId: 'cli-m-2',
      body: 'RESTORED_AFTER_MUT_401_MSG',
      senderKind: 'customer',
      serverCreatedAt: 2010,
      status: 'delivered',
      replyToId: null
    }

    let isReauthenticated = false

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/conversations/conv-mut-401/messages') {
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { conversations: isReauthenticated ? [convRestored] : [convA] }
        })
      }
      if (path === '/v1/tm-comm/conversations/conv-mut-401/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-mut-restored/messages') {
        return Promise.resolve({ ok: true, status: 200, data: { messages: [msgRestored] } })
      }
      if (path === '/v1/tm-comm/challenges') {
        return Promise.resolve({ ok: true, status: 200, data: makeValidChallenge('chlg_reauth_mut') })
      }
      if (path === '/v1/tm-comm/sessions') {
        isReauthenticated = true
        return Promise.resolve({ ok: true, status: 200, data: { session: { id: 'sess-restored' } } })
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/BEFORE_MUT_401_MSG/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    // Trigger mutation 401 via send()
    const sendBtn = screen.getByRole('button', { name: /Enviar al servidor/i })
    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })
    expect(screen.queryByText(/BEFORE_MUT_401_MSG/i)).toBeNull()

    // Re-authenticate
    const authBtn = screen.getByRole('button', { name: /Firmar challenge TM-COMM/i })
    fireEvent.click(authBtn)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
      expect(screen.getByText(/Conversación: conv-mut-restored/i)).toBeDefined()
      expect(screen.getByText(/RESTORED_AFTER_MUT_401_MSG/i)).toBeDefined()
    })

    // Controls re-enabled
    const newSendBtn = screen.getByRole('button', { name: /Enviar al servidor/i }) as HTMLButtonElement
    const newBindBtn = screen.getByRole('button', { name: /Consumir invitación/i }) as HTMLButtonElement
    const newRefreshBtn = screen.getByRole('button', { name: /Recargar historial/i }) as HTMLButtonElement
    expect(newSendBtn.disabled).toBe(false)
    expect(newBindBtn.disabled).toBe(false)
    expect(newRefreshBtn.disabled).toBe(false)
  })

  test('late completion de requests de la sesión invalidada no repuebla estado', async () => {
    const convA = { id: 'conv-late-comp', reservationId: 'rsv-late-comp', createdAt: 1000 }
    const msgA = {
      id: 'msg-late-1',
      clientMessageId: 'cli-lc-1',
      body: 'EARLY_INITIAL_MSG',
      senderKind: 'customer',
      serverCreatedAt: 1010,
      status: 'delivered',
      replyToId: null
    }

    const deferredLateFetch = createDeferred<{ ok: boolean; status: number; data: unknown }>()
    let msgCallCount = 0

    mockTmCommRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path === '/v1/tm-comm/bindings') {
        // Mutation returns 401
        return Promise.resolve({ ok: false, status: 401, data: { error: 'SESSION_EXPIRED' } })
      }
      if (path === '/v1/tm-comm/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { principal: { id: 'prn-A', kind: 'customer', walletAddress: 'ecash:walletA' } }
        })
      }
      if (path === '/v1/tm-comm/conversations') {
        return Promise.resolve({ ok: true, status: 200, data: { conversations: [convA] } })
      }
      if (path === '/v1/tm-comm/conversations/conv-late-comp/messages') {
        msgCallCount++
        if (msgCallCount === 1) {
          return Promise.resolve({ ok: true, status: 200, data: { messages: [msgA] } })
        }
        // Second fetch is held pending
        return deferredLateFetch.promise
      }
      return Promise.resolve({ ok: true, status: 200, data: {} })
    })

    render(<TmCommStaging />)

    await waitFor(() => {
      expect(screen.getByText(/EARLY_INITIAL_MSG/i)).toBeDefined()
      expect(screen.getByText(/Sesión TM-COMM: autenticada \(ecash:walletA\)/i)).toBeDefined()
    })

    // Start a message refresh that stays pending
    const refreshBtn = screen.getByRole('button', { name: /Recargar historial/i })
    fireEvent.click(refreshBtn)

    // Now trigger bind() which returns 401 and invalidates session
    const bindBtn = screen.getByRole('button', { name: /Consumir invitación/i })
    fireEvent.click(bindBtn)

    await waitFor(() => {
      expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
    })
    expect(screen.queryByText(/EARLY_INITIAL_MSG/i)).toBeNull()

    // Now resolve the old pending fetch with data
    deferredLateFetch.resolve({
      ok: true,
      status: 200,
      data: {
        messages: [
          {
            id: 'msg-polluting-late',
            clientMessageId: 'cli-late-pollute',
            body: 'POLLUTING_LATE_MSG_DATA',
            senderKind: 'customer',
            serverCreatedAt: 3000,
            status: 'delivered',
            replyToId: null
          }
        ]
      }
    })

    // Wait microtasks
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Late completion cannot repopulate state
    expect(screen.queryByText(/POLLUTING_LATE_MSG_DATA/i)).toBeNull()
    expect(screen.queryByText(/EARLY_INITIAL_MSG/i)).toBeNull()
    expect(screen.getByText(/Conversación: ninguna/i)).toBeDefined()
    expect(screen.getByText(/Sesión TM-COMM: no autenticada/i)).toBeDefined()
  })
})


