/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoEditor } from './MemoEditor'
import {
  MAX_TM1_SCRIPT_BYTES,
  TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES,
  TM1_NFT_DIRECTIVE_BYTES,
  TM1_PROTOCOL_MAX_EVENT_DATA_BYTES,
  TM1_PROTOCOL_OVERHEAD_BYTES,
  tm1EffectiveUserMessageMaxBytes
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
    expect(counter.textContent).toContain(`0/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`)
    expect(counter.textContent).toContain(`${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} B restantes`)
    expect(TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES).toBe(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES)
  })

  it('updates real-time byte count accurately for ASCII text', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="Hello eCash" onChange={handleChange} />)

    const counter = screen.getByTestId('memo-byte-counter')
    // "Hello eCash" has 11 ASCII characters = 11 UTF-8 bytes
    expect(counter.textContent).toContain('11')
    expect(counter.textContent).toContain(
      `${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES - 11} B restantes`
    )
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
    expect(counter.textContent).toContain(`${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES - 20} B restantes`)
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
    // 181 / 212 ≈ 85.4% >= 85%
    const nearLimitBytes = Math.ceil(TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES * 0.85)
    const nearLimitText = 'a'.repeat(nearLimitBytes)
    render(<MemoEditor value={nearLimitText} onChange={handleChange} />)

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.className).toContain('byte-counter--warning')
    expect(counter.textContent).toContain(String(nearLimitBytes))
    expect(counter.textContent).toContain(
      `${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES - nearLimitBytes} B restantes`
    )
  })

  it('displays error alert and invalid state when exceeding byte limit', () => {
    const handleChange = vi.fn()
    const overLimitBytes = TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES + 1
    const overLimitText = 'x'.repeat(overLimitBytes)
    render(<MemoEditor value={overLimitText} onChange={handleChange} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    expect(textarea.getAttribute('aria-invalid')).toBe('true')
    expect(textarea.className).toContain('input--error')

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.className).toContain('byte-counter--error')
    expect(counter.textContent).toContain('Excedido por 1 B')

    const errorAlert = screen.getByRole('alert')
    expect(errorAlert.textContent).toContain(
      `El mensaje excede el límite del borrador (${overLimitBytes}/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes)`
    )
  })

  it('renders OP_RETURN overhead breakdown details', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="Test" onChange={handleChange} showOverheadDetails={true} />)

    const breakdown = screen.getByTestId('memo-overhead-breakdown')
    expect(breakdown.textContent).toContain(`${MAX_TM1_SCRIPT_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`-${TM1_PROTOCOL_OVERHEAD_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`${TM1_PROTOCOL_MAX_EVENT_DATA_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`4/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes`)
  })

  it('disables textarea when disabled prop is true', () => {
    const handleChange = vi.fn()
    render(<MemoEditor value="Frozen" onChange={handleChange} disabled={true} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })

  it('renders NFT attachment overhead badge and wire calculation when attachedNftTokenId is provided', () => {
    const handleChange = vi.fn()
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    render(
      <MemoEditor
        value="Hola mundo"
        onChange={handleChange}
        attachedNftTokenId={tokenId}
        showOverheadDetails={true}
      />
    )

    // "Hola mundo" = 10 bytes, +71 B = 81 B wire
    const badge = screen.getByTestId('memo-attachment-overhead')
    expect(badge.textContent).toContain('+71 B NFT (81/212 B wire)')

    const breakdown = screen.getByTestId('memo-overhead-breakdown')
    expect(breakdown.textContent).toContain('+71 bytes')
    expect(breakdown.textContent).toContain('81/212 bytes')
  })

  it('alerts when total wire payload exceeds protocol limit', () => {
    const handleChange = vi.fn()
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    // User message 150 bytes, maxBytes 160 (under user maxBytes), but 150 + 71 = 221 > 212 protocolMaxBytes
    render(
      <MemoEditor
        value={'a'.repeat(150)}
        onChange={handleChange}
        maxBytes={160}
        attachedNftTokenId={tokenId}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('La carga wire total con el NFT adjunto excede el límite del protocolo (221/212 bytes)')
  })

  it('keeps textarea plain text and counts exact UTF-8 bytes for URLs without injecting HTML or markdown', () => {
    const handleChange = vi.fn()
    const urlText = 'Visita https://xolosarmy.xyz para ver el protocolo'
    const expectedBytes = new TextEncoder().encode(urlText).length

    render(<MemoEditor value={urlText} onChange={handleChange} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe(urlText)
    expect(textarea.value).not.toContain('<a')
    expect(textarea.value).not.toContain('href=')
    expect(textarea.value).not.toContain('[')

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain(`${expectedBytes}/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`)

    const detectedLinks = screen.getByTestId('memo-detected-links')
    expect(detectedLinks.textContent).toContain('https://xolosarmy.xyz')
  })

  it('consumes the machine effective user-text budget (141 B) when an NFT is attached', () => {
    const handleChange = vi.fn()
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const effective = tm1EffectiveUserMessageMaxBytes(TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES, true)
    expect(effective).toBe(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES - TM1_NFT_DIRECTIVE_BYTES)

    render(
      <MemoEditor
        value={'a'.repeat(140)}
        onChange={handleChange}
        maxBytes={effective}
        attachedNftTokenId={tokenId}
        wirePayloadBytes={140 + TM1_NFT_DIRECTIVE_BYTES}
      />
    )

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain(`140/${effective} bytes UTF-8`)
    expect(counter.className).not.toContain('byte-counter--error')

    const breakdown = screen.getByTestId('memo-overhead-breakdown')
    expect(breakdown.textContent).toContain(`140/${effective} bytes`)
    expect(breakdown.textContent).toContain(`+${TM1_NFT_DIRECTIVE_BYTES} bytes`)
    expect(breakdown.textContent).toContain(`${140 + TM1_NFT_DIRECTIVE_BYTES}/${TM1_PROTOCOL_MAX_EVENT_DATA_BYTES} bytes`)
  })

  it('does not truncate text when the effective budget shrinks below the current byte length', () => {
    const handleChange = vi.fn()
    const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'
    const text = 'a'.repeat(180)
    const effective = tm1EffectiveUserMessageMaxBytes(TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES, true)

    render(
      <MemoEditor
        value={text}
        onChange={handleChange}
        maxBytes={effective}
        attachedNftTokenId={tokenId}
        wirePayloadBytes={180 + TM1_NFT_DIRECTIVE_BYTES}
      />
    )

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe(text)
    expect(textarea.value.length).toBe(180)
    expect(handleChange).not.toHaveBeenCalled()

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain(`180/${effective} bytes UTF-8`)
    expect(counter.className).toContain('byte-counter--error')
  })

  it('counts exact UTF-8 bytes for Spanish, accented characters, and emoji at the 212 B boundary', () => {
    const handleChange = vi.fn()
    // 208 ASCII + "é" (2 B) + "🌮" (4 B) would overflow; 206 ASCII + "é" + "🌮" = 212
    const exact212 = `${'n'.repeat(206)}é🌮`
    expect(new TextEncoder().encode(exact212).length).toBe(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES)

    const { rerender } = render(<MemoEditor value={exact212} onChange={handleChange} />)
    expect(screen.getByTestId('memo-byte-counter').textContent).toContain(
      `${TM1_PROTOCOL_MAX_EVENT_DATA_BYTES}/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`
    )
    expect(screen.getByTestId('memo-byte-counter').className).not.toContain('byte-counter--error')

    const over213 = `${exact212}!`
    expect(new TextEncoder().encode(over213).length).toBe(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES + 1)
    rerender(<MemoEditor value={over213} onChange={handleChange} />)
    expect(screen.getByTestId('memo-byte-counter').className).toContain('byte-counter--error')
    expect(screen.getByRole('alert').textContent).toContain(
      `(${TM1_PROTOCOL_MAX_EVENT_DATA_BYTES + 1}/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes)`
    )
  })

  it('counts a long URL (>80 B, <=212 B) as exact UTF-8 bytes without injecting markup into the textarea', () => {
    const handleChange = vi.fn()
    const longUrl =
      'https://xolosarmy.xyz/tonalli-memo/protocol/tm1-draft-02/event-data/full-capacity?ref=composer-byte-limit'
    const expectedBytes = new TextEncoder().encode(longUrl).length
    expect(expectedBytes).toBeGreaterThan(80)
    expect(expectedBytes).toBeLessThanOrEqual(TM1_PROTOCOL_MAX_EVENT_DATA_BYTES)

    render(<MemoEditor value={longUrl} onChange={handleChange} />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe(longUrl)
    expect(textarea.value).not.toContain('<a')
    expect(textarea.value).not.toContain('href=')

    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain(`${expectedBytes}/${TM1_DEFAULT_WALLET_MAX_USER_MESSAGE_BYTES} bytes UTF-8`)
    expect(counter.className).not.toContain('byte-counter--error')
    expect(screen.getByTestId('memo-detected-links').textContent).toContain(longUrl)
  })
})
