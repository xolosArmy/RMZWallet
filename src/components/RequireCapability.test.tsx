// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { WalletContext } from '../context/walletContext'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { walletContextFixture } from '../test/walletContextFixture'
import { RequireCapability } from './RequireCapability'

afterEach(() => {
  cleanup()
})

describe('RequireCapability route fail-closed', () => {
  test('direct privileged route is blocked for QUICK_START_UNBACKED', () => {
    render(
      <MemoryRouter>
        <WalletContext.Provider
          value={walletContextFixture({
            initialized: true,
            backupVerified: false,
            lifecycle: WALLET_LIFECYCLE.QUICK_START_UNBACKED
          })}
        >
          <RequireCapability capability={WALLET_CAPABILITY.WALLETCONNECT}>
            <div data-testid="privileged">walletconnect live</div>
          </RequireCapability>
        </WalletContext.Provider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('capability-blocked')).toBeTruthy()
    expect(screen.queryByTestId('privileged')).toBeNull()
  })

  test('BACKUP_VERIFIED restores the privileged route', () => {
    render(
      <MemoryRouter>
        <WalletContext.Provider
          value={walletContextFixture({
            initialized: true,
            backupVerified: true,
            lifecycle: WALLET_LIFECYCLE.BACKUP_VERIFIED
          })}
        >
          <RequireCapability capability={WALLET_CAPABILITY.WALLETCONNECT}>
            <div data-testid="privileged">walletconnect live</div>
          </RequireCapability>
        </WalletContext.Provider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('privileged').textContent).toBe('walletconnect live')
  })
})
