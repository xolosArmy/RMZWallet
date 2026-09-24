// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { WalletContext } from '../context/walletContext'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { walletContextFixture } from '../test/walletContextFixture'
import ProgressiveBackupBanner from './ProgressiveBackupBanner'

describe('ProgressiveBackupBanner', () => {
  afterEach(cleanup)

  it('offers the existing backup route for an interrupted Quick Start backup', () => {
    const wallet = walletContextFixture({
      initialized: true,
      backupVerified: false,
      lifecycle: WALLET_LIFECYCLE.QUICK_START_UNBACKED,
      quickStartRecoveryState: 'INTERRUPTED_BACKUP'
    })
    render(
      <WalletContext.Provider value={wallet}>
        <MemoryRouter><ProgressiveBackupBanner /></MemoryRouter>
      </WalletContext.Provider>
    )

    expect(screen.getByText('Continúa tu respaldo interrumpido')).toBeTruthy()
    expect(screen.getByText(/PIN del respaldo anterior/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continuar respaldo interrumpido' }).getAttribute('href')).toBe('/backup')
  })

  it('does not request backup again after verified commit', () => {
    const wallet = walletContextFixture({
      initialized: true,
      backupVerified: true,
      lifecycle: WALLET_LIFECYCLE.BACKUP_VERIFIED,
      quickStartRecoveryState: 'BACKUP_VERIFIED'
    })
    const { container } = render(
      <WalletContext.Provider value={wallet}>
        <MemoryRouter><ProgressiveBackupBanner /></MemoryRouter>
      </WalletContext.Provider>
    )
    expect(container.firstChild).toBeNull()
  })
})
