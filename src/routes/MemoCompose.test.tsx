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
})
