import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import App from '../App'
import {
  TM_COMM_STAGING_ENABLED,
  isTmCommStagingEnabled
} from '../config/tmCommStaging'
import More from './More'

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
  fileURLToPath(new URL('./TmCommStaging.tsx', import.meta.url)),
  'utf8'
)
const clientSource = readFileSync(
  fileURLToPath(new URL('./tmCommStagingClient.ts', import.meta.url)),
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
