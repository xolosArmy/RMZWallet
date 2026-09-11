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

  it('encodes a full 212-byte protocol payload and rejects 213 bytes', () => {
    const exact212 = 'x'.repeat(212)
    const { rerender } = render(<CanonicalPayloadPreview message={exact212} />)

    expect(screen.getByTestId('preview-active-content')).toBeTruthy()
    expect(screen.getByTestId('preview-active-content').textContent).toContain('Payload: 212B')
    expect(screen.queryByTestId('preview-error-state')).toBeNull()

    rerender(<CanonicalPayloadPreview message={'x'.repeat(213)} />)

    const errorBox = screen.getByTestId('preview-error-state')
    expect(errorBox).toBeTruthy()
    expect(errorBox.textContent).toContain('Error de codificación canónica')
    expect(errorBox.textContent).toContain('213 bytes UTF-8')
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
