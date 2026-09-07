/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoEditor } from './MemoEditor'
import {
  MAX_TM1_SCRIPT_BYTES,
  TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES,
  TM1_PROTOCOL_MAX_EVENT_DATA_BYTES,
  TM1_PROTOCOL_OVERHEAD_BYTES
} from './types'

afterEach(() => {
  cleanup()
})

describe('MemoEditor Component', () => {
  it('renders textarea with proper accessibility attributes and placeholder', () => {
    const handleChange = vi.fn()
    render(
      <MemoEditor
        value=""
        onChange={handleChange}
        placeholder="Escribe tu memo aquí..."
      />
    )

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    expect(textarea).toBeTruthy()
    expect(textarea.getAttribute('placeholder')).toBe('Escribe tu memo aquí...')
    expect(textarea.getAttribute('aria-invalid')).toBe('false')

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain(`0/${TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES} bytes UTF-8`)
    expect(counter.textContent).toContain(`${TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES} B restantes`)
  })

  it('updates real-time byte count accurately for ASCII text', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="Hello eCash" onChange={handleChange} />)

    const counter = screen.getByTestId('memo-byte-counter')
    // "Hello eCash" has 11 ASCII characters = 11 UTF-8 bytes
    expect(counter.textContent).toContain('11')
    expect(counter.textContent).toContain('69 B restantes')
  })

  it('counts multi-byte UTF-8 characters and emojis correctly', () => {
    const handleChange = vi.fn()
    // "Tonalli México 🌮"
    // "Tonalli M" = 9 bytes
    // "é" = 2 bytes
    // "xico " = 5 bytes
    // "🌮" = 4 bytes (F0 9F 8C AE)
    // Total = 9 + 2 + 5 + 4 = 20 bytes (even though length string is 18)
    const text = 'Tonalli México 🌮'
    const expectedBytes = new TextEncoder().encode(text).length
    expect(expectedBytes).toBe(20)

    render(<MemoEditor value={text} onChange={handleChange} />)

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain('20')
    expect(counter.textContent).toContain(`${80 - 20} B restantes`)
  })

  it('triggers onChange callback when typing in textarea', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="" onChange={handleChange} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    fireEvent.change(textarea, { target: { value: 'Nuevo memo' } })

    expect(handleChange).toHaveBeenCalledWith('Nuevo memo')
  })

  it('displays warning style when approaching the byte limit', () => {
    const handleChange = vi.fn()
    // 70 bytes out of 80 (87.5% >= 85%)
    const nearLimitText = 'a'.repeat(70)
    render(<MemoEditor value={nearLimitText} onChange={handleChange} />)

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.className).toContain('byte-counter--warning')
    expect(counter.textContent).toContain('70')
    expect(counter.textContent).toContain('10 B restantes')
  })

  it('displays error alert and invalid state when exceeding byte limit', () => {
    const handleChange = vi.fn()
    // 85 bytes (> 80 limit)
    const overLimitText = 'x'.repeat(85)
    render(<MemoEditor value={overLimitText} onChange={handleChange} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    expect(textarea.getAttribute('aria-invalid')).toBe('true')
    expect(textarea.className).toContain('input--error')

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.className).toContain('byte-counter--error')
    expect(counter.textContent).toContain('Excedido por 5 B')

    const errorAlert = screen.getByRole('alert')
    expect(errorAlert.textContent).toContain('El mensaje excede el límite del borrador (85/80 bytes)')
  })

  it('renders OP_RETURN overhead breakdown details', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="Test" onChange={handleChange} showOverheadDetails={true} />)

    const breakdown = screen.getByTestId('memo-overhead-breakdown')
    expect(breakdown.textContent).toContain(`${MAX_TM1_SCRIPT_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`-${TM1_PROTOCOL_OVERHEAD_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`${TM1_PROTOCOL_MAX_EVENT_DATA_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`${TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES} bytes`)
  })

  it('disables textarea when disabled prop is true', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="Frozen" onChange={handleChange} disabled={true} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })
})
