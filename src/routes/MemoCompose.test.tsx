/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { MemoCompose } from './MemoCompose'
import type { Tm1PublisherExecutor } from '../components/tonalliMemo/types'

// Mock TopBar to keep unit tests focused on MemoCompose
vi.mock('../components/TopBar', () => ({
  default: () => <div data-testid="top-bar">TopBar</div>
}))

const mockWallet = {
  address: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
  alias: 'satoshixolos.xec' as string | null,
  balance: null,
  loading: false,
  error: null,
  initialized: true,
  backupVerified: true
}

vi.mock('../context/useWallet', () => ({
  useWallet: () => mockWallet
}))

function createMockExecutor(): Tm1PublisherExecutor {
  return {
    verifyOwnership: vi.fn().mockResolvedValue({ evidenceToken: 'mock-token' }),
    requestAuthorization: vi.fn().mockResolvedValue({ authToken: 'mock-auth' }),
    prepareAndSign: vi.fn().mockResolvedValue({
      preparedReview: { preparedId: 'prep-1' },
      signedReview: { preparedId: 'prep-1', signature: 'sig-1' }
    }),
    broadcastAndFinalize: vi.fn().mockResolvedValue({
      txid: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      submissionId: 'sub-1'
    })
  }
}

afterEach(() => {
  cleanup()
  mockWallet.alias = 'satoshixolos.xec'
  mockWallet.address = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
})

describe('MemoCompose Route', () => {
  describe('Finding 2: Dynamic alias resolution from wallet context', () => {
    it('extracts active alias dynamically from wallet context and passes to composer', () => {
      mockWallet.alias = 'satoshixolos.xec'
      const mockExecutor = createMockExecutor()

      render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose executor={mockExecutor} />}
            />
          </Routes>
        </MemoryRouter>
      )

      // Verifies dynamic alias from wallet is rendered, NOT hardcoded satoshi.xec
      const aliasElement = screen.getByTestId('identity-alias')
      expect(aliasElement.textContent).toBe('satoshixolos.xec')
      expect(screen.queryByTestId('memo-no-alias-state')).toBeNull()
    })

    it('renders empty state card with CTA to /register-alias when wallet has no alias', () => {
      mockWallet.alias = null

      render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route path="/memo/compose" element={<MemoCompose />} />
          </Routes>
        </MemoryRouter>
      )

      // Composer should NOT be rendered
      expect(screen.queryByTestId('memo-composer')).toBeNull()

      // Empty state card must be rendered
      const emptyState = screen.getByTestId('memo-no-alias-state')
      expect(emptyState).toBeTruthy()
      expect(screen.getByText(/Se requiere un alias \.xec activo/i)).toBeTruthy()

      // CTA must link to /register-alias
      const ctaLink = screen.getByTestId('register-alias-cta')
      expect(ctaLink.getAttribute('href')).toBe('/register-alias')
    })

    it('transitions out of no-alias-state when registered alias is persisted into wallet context', () => {
      // Step 1: Wallet starts without alias
      mockWallet.alias = null

      const { rerender } = render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route path="/memo/compose" element={<MemoCompose />} />
          </Routes>
        </MemoryRouter>
      )

      expect(screen.getByTestId('memo-no-alias-state')).toBeTruthy()
      expect(screen.queryByTestId('memo-composer')).toBeNull()

      // Step 2: Alias registration persists new alias in wallet context
      mockWallet.alias = 'satoshinew.xec'

      rerender(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route path="/memo/compose" element={<MemoCompose />} />
          </Routes>
        </MemoryRouter>
      )

      // Step 3: no-alias-state is dismissed, and composer is active
      expect(screen.queryByTestId('memo-no-alias-state')).toBeNull()
      const composer = screen.getByTestId('memo-composer')
      expect(composer).toBeTruthy()
      expect(screen.getByTestId('identity-alias').textContent).toBe('satoshinew.xec')
    })
  })

  describe('Finding 1: Injects WalletPublisherExecutor with real dependencies', () => {
    it('instantiates and provides WalletPublisherExecutor by default when no executor is passed', () => {
      mockWallet.alias = 'myalias.xec'

      render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route path="/memo/compose" element={<MemoCompose />} />
          </Routes>
        </MemoryRouter>
      )

      // The composer is rendered without throwing EXECUTOR_REQUIRED
      expect(screen.getByTestId('memo-composer')).toBeTruthy()
      expect(screen.getByTestId('identity-alias').textContent).toBe('myalias.xec')
    })
  })

  describe('Finding 3: Canonical preview error keeps publish button disabled', () => {
    it('disables the publish button when canonical encoding throws an error (>80 bytes)', () => {
      mockWallet.alias = 'satoshixolos.xec'
      const mockExecutor = createMockExecutor()

      render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose executor={mockExecutor} />}
            />
          </Routes>
        </MemoryRouter>
      )

      const textarea = screen.getByRole('textbox', {
        name: /mensaje de tonalli memo/i
      })
      const publishBtn = screen.getByTestId('publish-button-idle') as HTMLButtonElement

      // Initially empty -> disabled
      expect(publishBtn.disabled).toBe(true)

      // Enter valid message -> enabled
      fireEvent.change(textarea, { target: { value: 'Mensaje canónico válido' } })
      expect(publishBtn.disabled).toBe(false)
      expect(screen.getByTestId('preview-active-content')).toBeTruthy()

      // Exceed canonical 80 bytes (e.g. 85 bytes) -> preview error and disabled
      const tooLongMessage = 'X'.repeat(85)
      fireEvent.change(textarea, { target: { value: tooLongMessage } })

      expect(publishBtn.disabled).toBe(true)
      expect(screen.getByTestId('preview-error-state')).toBeTruthy()
      expect(screen.getByTestId('preview-error-state').textContent).toContain('85 bytes UTF-8')
    })
  })

  describe('P1 Finding: Refresh composer identity after wallet switch', () => {
    it('remounts composer with fresh state and updated identity when wallet switches account and alias', () => {
      mockWallet.address = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      mockWallet.alias = 'alice.xec'
      const mockExecutor = createMockExecutor()

      const { rerender } = render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose executor={mockExecutor} />}
            />
          </Routes>
        </MemoryRouter>
      )

      expect(screen.getByTestId('identity-alias').textContent).toBe('alice.xec')
      expect(screen.getByTestId('identity-address').textContent).toBe(
        'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      )

      const textarea = screen.getByRole('textbox', {
        name: /mensaje de tonalli memo/i
      }) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Borrador confidencial de Alice' } })
      expect(textarea.value).toBe('Borrador confidencial de Alice')

      const publishBtn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
      expect(publishBtn.disabled).toBe(false)

      // Switch wallet context to Bob
      mockWallet.address = 'ecash:qqe9guxz2kswm8vdhe7s3768m64k6s679sf6l3q55r'
      mockWallet.alias = 'bob.xec'

      rerender(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose executor={mockExecutor} />}
            />
          </Routes>
        </MemoryRouter>
      )

      // Identity reflects Bob's alias and address
      expect(screen.getByTestId('identity-alias').textContent).toBe('bob.xec')
      expect(screen.getByTestId('identity-address').textContent).toBe(
        'ecash:qqe9guxz2kswm8vdhe7s3768m64k6s679sf6l3q55r'
      )

      // State is completely reset (unmounted and fresh mount)
      const freshTextarea = screen.getByRole('textbox', {
        name: /mensaje de tonalli memo/i
      }) as HTMLTextAreaElement
      expect(freshTextarea.value).toBe('')

      const freshPublishBtn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
      expect(freshPublishBtn.disabled).toBe(true)
    })

    it('resets composer when active address changes even if alias remains unchanged', () => {
      mockWallet.address = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      mockWallet.alias = 'sharedalias.xec'
      const mockExecutor = createMockExecutor()

      const { rerender } = render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose executor={mockExecutor} />}
            />
          </Routes>
        </MemoryRouter>
      )

      expect(screen.getByTestId('identity-address').textContent).toBe(
        'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      )

      const textarea = screen.getByRole('textbox', {
        name: /mensaje de tonalli memo/i
      }) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Texto preliminar' } })
      expect(textarea.value).toBe('Texto preliminar')

      // Switch active address (e.g. secondary HD account)
      mockWallet.address = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'

      rerender(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose executor={mockExecutor} />}
            />
          </Routes>
        </MemoryRouter>
      )

      expect(screen.getByTestId('identity-address').textContent).toBe(
        'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
      )
      const freshTextarea = screen.getByRole('textbox', {
        name: /mensaje de tonalli memo/i
      }) as HTMLTextAreaElement
      expect(freshTextarea.value).toBe('')
    })
  })

  describe('Production executor construction and durable recoveryStore integration', () => {
    it('constructs WalletPublisherExecutor with a valid non-null recoveryStore and active Chronik client', async () => {
      const walletPublisherModule = await import('../components/tonalliMemo/walletPublisherExecutor')
      const createExecutorSpy = vi.spyOn(walletPublisherModule, 'createWalletPublisherExecutor')

      mockWallet.address = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      mockWallet.alias = 'satoshixolos.xec'

      render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route path="/memo/compose" element={<MemoCompose />} />
          </Routes>
        </MemoryRouter>
      )

      expect(createExecutorSpy).toHaveBeenCalled()
      const callOptions = createExecutorSpy.mock.calls[createExecutorSpy.mock.calls.length - 1][0]
      expect(callOptions).toBeDefined()

      // Assert that recoveryStore is valid and non-null
      expect(callOptions?.recoveryStore).toBeDefined()
      expect(callOptions?.recoveryStore).not.toBeNull()
      expect(typeof callOptions?.recoveryStore?.create).toBe('function')
      expect(typeof callOptions?.recoveryStore?.load).toBe('function')
      expect(typeof callOptions?.recoveryStore?.commitDispatchIntent).toBe('function')
      expect(typeof callOptions?.recoveryStore?.commitTransportAcknowledgement).toBe('function')
      expect(typeof callOptions?.recoveryStore?.claimOwnership).toBe('function')

      // Assert the constructed executor has the non-null recoveryStore instance
      const executorInstance =
        createExecutorSpy.mock.results[createExecutorSpy.mock.results.length - 1].value
      expect(executorInstance).toBeInstanceOf(walletPublisherModule.WalletPublisherExecutor)
      expect(executorInstance.recoveryStore).toBeDefined()
      expect(executorInstance.recoveryStore).not.toBeNull()
      expect(executorInstance.recoveryStore).toBe(callOptions?.recoveryStore)

      // Assert active Chronik transport and signer are wired
      expect(callOptions?.transport).toBeDefined()
      expect(callOptions?.transport?.chronik).toBeDefined()
      expect(callOptions?.signer).toBeDefined()

      createExecutorSpy.mockRestore()
    })

    it('injects custom recoveryStore into production executor when passed via props', async () => {
      const walletPublisherModule = await import('../components/tonalliMemo/walletPublisherExecutor')
      const createExecutorSpy = vi.spyOn(walletPublisherModule, 'createWalletPublisherExecutor')
      const customStore = new walletPublisherModule.Tm1ProductionRecoveryStore()

      mockWallet.address = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      mockWallet.alias = 'satoshixolos.xec'

      render(
        <MemoryRouter initialEntries={['/memo/compose']}>
          <Routes>
            <Route
              path="/memo/compose"
              element={<MemoCompose recoveryStore={customStore} />}
            />
          </Routes>
        </MemoryRouter>
      )

      expect(createExecutorSpy).toHaveBeenCalled()
      const callOptions = createExecutorSpy.mock.calls[createExecutorSpy.mock.calls.length - 1][0]
      expect(callOptions?.recoveryStore).toBe(customStore)

      const executorInstance =
        createExecutorSpy.mock.results[createExecutorSpy.mock.results.length - 1].value
      expect(executorInstance.recoveryStore).toBe(customStore)

      createExecutorSpy.mockRestore()
    })
  })
})

