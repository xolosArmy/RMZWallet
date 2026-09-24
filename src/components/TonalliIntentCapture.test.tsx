// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from 'vitest'
import TonalliIntentCapture from './TonalliIntentCapture'

afterEach(cleanup)

test('global intent capture cannot stop the app rendering when sessionStorage access is denied', () => {
  const previous = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get: () => { throw new DOMException('Denied', 'SecurityError') }
  })
  try {
    render(
      <MemoryRouter initialEntries={['/?intent=conversation&peer=teyolia&source=xolosramirez']}>
        <TonalliIntentCapture />
        <main>Wallet rendered</main>
      </MemoryRouter>
    )
    expect(screen.getByText('Wallet rendered')).toBeTruthy()
  } finally {
    if (previous) Object.defineProperty(window, 'sessionStorage', previous)
    else Reflect.deleteProperty(window, 'sessionStorage')
  }
})
