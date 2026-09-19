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
