/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanonicalPayloadPreview } from './CanonicalPayloadPreview'

afterEach(() => {
  cleanup()
})

describe('CanonicalPayloadPreview Component', () => {
  it('renders placeholder when message is empty', () => {
    render(<CanonicalPayloadPreview message="" />)

    expect(screen.getByTestId('preview-empty-state')).toBeTruthy()
    expect(screen.queryByTestId('preview-active-content')).toBeNull()
  })

  it('computes and renders canonical TM1 payload for valid message', () => {
    const message = 'Tonalli Memo Test'
    render(<CanonicalPayloadPreview message={message} authorInputIndex={0} />)

    expect(screen.queryByTestId('preview-empty-state')).toBeNull()
    const content = screen.getByTestId('preview-active-content')
    expect(content).toBeTruthy()

    // LOKAD ID
    expect(content.textContent).toContain('0x544d4d00')
    // Version 1
    expect(content.textContent).toContain('0x01')
    // Event POST
    expect(content.textContent).toContain('POST')
    // Author input
    expect(content.textContent).toContain('input[0]')

    // Envelope and Script hex blocks
    const envelopeHex = screen.getByTestId('envelope-hex').textContent
    const scriptHex = screen.getByTestId('script-hex').textContent

    expect(envelopeHex).toBeTruthy()
    expect(scriptHex).toBeTruthy()
    // Script must start with OP_RETURN (0x6a) and LOKAD push (04 54 4d 4d 00)
    expect(scriptHex?.startsWith('6a04544d4d00')).toBe(true)
  })

  it('displays error state when message is too long', () => {
    const tooLong = 'x'.repeat(81) // exceeds wallet max of 80 bytes
    render(<CanonicalPayloadPreview message={tooLong} />)

    const errorBox = screen.getByTestId('preview-error-state')
    expect(errorBox).toBeTruthy()
    expect(errorBox.textContent).toContain('Error de codificación canónica')
    expect(screen.queryByTestId('preview-active-content')).toBeNull()
  })

  it('supports clipboard copying of envelope and script hex', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock
      }
    })

    render(<CanonicalPayloadPreview message="Copy test" />)

    const copyEnvelopeBtn = screen.getByTestId('copy-envelope-hex-button')
    fireEvent.click(copyEnvelopeBtn)

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1)
      expect(copyEnvelopeBtn.textContent).toBe('¡Copiado!')
    })
  })
})
