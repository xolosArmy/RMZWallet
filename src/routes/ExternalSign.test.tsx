import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import ExternalSignDisabled from './ExternalSign'

vi.mock('../components/TopBar', () => ({
  default: () => <div>TopBar fixture</div>
}))

describe('/external-sign production containment', () => {
  test('renders only the disabled capability surface', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ExternalSignDisabled />
      </MemoryRouter>
    )
    expect(markup).toContain('EXTERNAL_SIGN_DISABLED')
    expect(markup).toContain('No hay perfiles productivos registrados')
    expect(markup).not.toContain('<button')
  })
})
