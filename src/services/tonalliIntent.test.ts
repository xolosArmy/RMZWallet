import { describe, expect, test } from 'vitest'
import {
  TONALLI_INTENT_STORAGE_KEY,
  captureTonalliIntentFromLocation,
  consumeTonalliIntent,
  parseTonalliIntent,
  persistTonalliIntent,
  readTonalliIntent
} from './tonalliIntent'

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    removeItem: (key: string) => {
      delete data[key]
    },
    snapshot: () => data
  }
}

describe('Tonalli safe intent adapter', () => {
  test('accepts a conversation intent and rejects protocol-looking payloads', () => {
    expect(parseTonalliIntent({
      kind: 'conversation',
      peer: 'xolos.ramirez',
      source: 'xolosramirez'
    })).toEqual({
      kind: 'conversation',
      peer: 'xolos.ramirez',
      source: 'xolosramirez'
    })
    expect(parseTonalliIntent({ kind: 'private-message', peer: 'xolos' })).toBeNull()
    expect(parseTonalliIntent({ kind: 'conversation', peer: '<script>' })).toBeNull()
  })

  test('persists and resumes without coupling to TM-COMM modules', () => {
    const store = memoryStore()
    persistTonalliIntent({ kind: 'conversation', peer: 'teyolia', source: 'xolosramirez' }, store)
    expect(readTonalliIntent(store)?.peer).toBe('teyolia')
    expect(consumeTonalliIntent(store)?.kind).toBe('conversation')
    expect(store.getItem(TONALLI_INTENT_STORAGE_KEY)).toBeNull()
  })

  test('captures a deep-link from xolosramirez.com query params', () => {
    const store = memoryStore()
    const intent = captureTonalliIntentFromLocation(
      '?intent=conversation&peer=xolos.ramirez&source=xolosramirez',
      store
    )
    expect(intent).toEqual({
      kind: 'conversation',
      peer: 'xolos.ramirez',
      source: 'xolosramirez'
    })
  })

  test('Quick Start / dashboard navigation does not consume a pending conversation intent', () => {
    const store = memoryStore()
    captureTonalliIntentFromLocation(
      '?intent=conversation&peer=xolos.ramirez&source=xolosramirez',
      store
    )
    expect(readTonalliIntent(store)?.peer).toBe('xolos.ramirez')
    expect(readTonalliIntent(store)?.peer).toBe('xolos.ramirez')
    expect(store.getItem(TONALLI_INTENT_STORAGE_KEY)).toContain('xolos.ramirez')
  })

  test('reload before TM-COMM keeps the pending intent', () => {
    const store = memoryStore()
    persistTonalliIntent({ kind: 'conversation', peer: 'xolos.ramirez', source: 'xolosramirez' }, store)
    const afterReload = memoryStore({
      [TONALLI_INTENT_STORAGE_KEY]: store.getItem(TONALLI_INTENT_STORAGE_KEY) ?? ''
    })
    expect(readTonalliIntent(afterReload)).toEqual({
      kind: 'conversation',
      peer: 'xolos.ramirez',
      source: 'xolosramirez'
    })
  })

  test('explicit consume by a future consumer removes the intent exactly once', () => {
    const store = memoryStore()
    persistTonalliIntent({ kind: 'conversation', peer: 'xolos.ramirez' }, store)
    expect(consumeTonalliIntent(store)?.peer).toBe('xolos.ramirez')
    expect(consumeTonalliIntent(store)).toBeNull()
    expect(store.getItem(TONALLI_INTENT_STORAGE_KEY)).toBeNull()
  })

  test('setItem denial drops the optional intent without throwing', () => {
    const store = {
      getItem: () => null,
      setItem: () => { throw new DOMException('Denied', 'SecurityError') },
      removeItem: () => {}
    }
    expect(() => persistTonalliIntent({ kind: 'conversation', peer: 'teyolia' }, store)).not.toThrow()
    expect(readTonalliIntent(store)).toBeNull()
  })

  test('getItem denial returns null without throwing', () => {
    const store = {
      getItem: () => { throw new DOMException('Denied', 'SecurityError') },
      setItem: () => {},
      removeItem: () => {}
    }
    expect(readTonalliIntent(store)).toBeNull()
  })

  test('malformed stored intent remains harmless when cleanup removeItem throws', () => {
    const store = {
      getItem: () => '{"kind":"conversation",',
      setItem: () => {},
      removeItem: () => { throw new DOMException('Denied', 'SecurityError') }
    }
    expect(readTonalliIntent(store)).toBeNull()
  })

  test('consume returns a valid intent when removeItem throws', () => {
    const store = {
      getItem: () => '{"kind":"conversation","peer":"teyolia"}',
      setItem: () => {},
      removeItem: () => { throw new DOMException('Denied', 'SecurityError') }
    }
    expect(consumeTonalliIntent(store)).toEqual({ kind: 'conversation', peer: 'teyolia' })
  })

  test('capture parses a valid URL even when acquiring sessionStorage throws', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => { throw new DOMException('Denied', 'SecurityError') }
    })
    try {
      expect(captureTonalliIntentFromLocation(
        '?intent=conversation&peer=teyolia&source=xolosramirez'
      )).toEqual({ kind: 'conversation', peer: 'teyolia', source: 'xolosramirez' })
    } finally {
      if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous)
      else Reflect.deleteProperty(globalThis, 'sessionStorage')
    }
  })
})
