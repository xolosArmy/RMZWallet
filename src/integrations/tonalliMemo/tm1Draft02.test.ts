import { describe, expect, it } from 'vitest'
import {
  TM1_DRAFT_02_LOKAD_ID_HEX,
  TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES,
  Tm1Draft02EncodingError,
  encodeTm1Draft02Post
} from './tm1Draft02'

describe('TM1 Draft 0.2 preview encoder', () => {
  it('preserves exact UTF-8 bytes including surrounding whitespace', () => {
    const preview = encodeTm1Draft02Post({ eventData: '  hola\n' })

    expect(preview.eventData).toBe('  hola\n')
    expect(preview.eventDataByteLength).toBe(new TextEncoder().encode('  hola\n').length)
    expect(preview.scriptHex.startsWith(`6a04${TM1_DRAFT_02_LOKAD_ID_HEX}`)).toBe(true)
    expect(preview.envelopeHex.startsWith('010100')).toBe(true)
  })

  it('encodes Unicode by UTF-8 byte length without normalization', () => {
    const composed = encodeTm1Draft02Post({ eventData: 'é' })
    const decomposed = encodeTm1Draft02Post({ eventData: 'e\u0301' })

    expect(composed.eventDataByteLength).toBe(2)
    expect(decomposed.eventDataByteLength).toBe(3)
    expect(composed.envelopeHex).not.toBe(decomposed.envelopeHex)
  })

  it('encodes the selected author input index', () => {
    const preview = encodeTm1Draft02Post({ eventData: 'mensaje', authorInputIndex: 7 })

    expect(preview.authorInputIndex).toBe(7)
    expect(preview.envelopeHex.startsWith('010107')).toBe(true)
  })

  it('uses OP_PUSHDATA1 at the product limit and stays below the protocol script limit', () => {
    const preview = encodeTm1Draft02Post({ eventData: 'a'.repeat(TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES) })

    expect(preview.eventDataByteLength).toBe(80)
    expect(preview.envelopeByteLength).toBe(83)
    expect(preview.scriptHex.startsWith(`6a04${TM1_DRAFT_02_LOKAD_ID_HEX}4c53`)).toBe(true)
    expect(preview.scriptByteLength).toBe(91)
  })

  it('rejects empty data, oversized data, and invalid input indexes with stable codes', () => {
    const cases = [
      { run: () => encodeTm1Draft02Post({ eventData: '' }), code: 'EMPTY_EVENT_DATA' },
      {
        run: () => encodeTm1Draft02Post({ eventData: 'a'.repeat(TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES + 1) }),
        code: 'EVENT_DATA_TOO_LARGE'
      },
      { run: () => encodeTm1Draft02Post({ eventData: 'a', authorInputIndex: -1 }), code: 'INVALID_AUTHOR_INPUT_INDEX' },
      { run: () => encodeTm1Draft02Post({ eventData: 'a', authorInputIndex: 256 }), code: 'INVALID_AUTHOR_INPUT_INDEX' }
    ] as const

    for (const testCase of cases) {
      expect(testCase.run).toThrowError(Tm1Draft02EncodingError)
      try {
        testCase.run()
      } catch (error) {
        expect(error).toBeInstanceOf(Tm1Draft02EncodingError)
        expect((error as Tm1Draft02EncodingError).code).toBe(testCase.code)
      }
    }
  })

  it('rejects unpaired surrogates as INVALID_UTF8 and never reports SCRIPT_TOO_LARGE falsely', () => {
    const surrogateCases = [
      '\uD800',
      '\uDFFF',
      'leading \uD800 trailing',
      '\uDC00\uD800'
    ]

    for (const badString of surrogateCases) {
      expect(() => encodeTm1Draft02Post({ eventData: badString })).toThrowError(Tm1Draft02EncodingError)
      try {
        encodeTm1Draft02Post({ eventData: badString })
      } catch (error) {
        expect(error).toBeInstanceOf(Tm1Draft02EncodingError)
        const encodingError = error as Tm1Draft02EncodingError
        expect(encodingError.code).toBe('INVALID_UTF8')
        expect(encodingError.code).not.toBe('SCRIPT_TOO_LARGE')
        expect(encodingError.message).toMatch(/surrogate|UTF-8/i)
      }
    }
  })

  it('rejects invalid format without raw canonical errors escaping or misreporting SCRIPT_TOO_LARGE', () => {
    expect(() => encodeTm1Draft02Post({ eventData: 123 as unknown as string })).toThrowError(Tm1Draft02EncodingError)
    try {
      encodeTm1Draft02Post({ eventData: 123 as unknown as string })
    } catch (error) {
      expect(error).toBeInstanceOf(Tm1Draft02EncodingError)
      const encodingError = error as Tm1Draft02EncodingError
      expect(encodingError.code).toBe('INVALID_FORMAT')
      expect(encodingError.code).not.toBe('SCRIPT_TOO_LARGE')
    }
  })
})
