import { describe, expect, test } from 'vitest'
import { Address } from 'ecash-lib'
import {
  canonicalizeEcashAddress,
  isLikelyAlias,
  isValidAliasName,
  isValidEcashAddress,
  normalizeAliasInput,
  parseCashAddr,
  toXecAlias
} from './alias'

const VALID_ADDR = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg'

describe('alias utility functions', () => {
  test('normalizeAliasInput trims and lowercases', () => {
    expect(normalizeAliasInput('  Alice  ')).toBe('alice')
  })

  test('isValidAliasName validates bare alias names', () => {
    expect(isValidAliasName('alice')).toBe(true)
    expect(isValidAliasName('alice123')).toBe(true)
    expect(isValidAliasName('alice.xec')).toBe(false)
    expect(isValidAliasName('')).toBe(false)
    expect(isValidAliasName('a'.repeat(22))).toBe(false)
  })

  test('isLikelyAlias recognizes bare and .xec aliases', () => {
    expect(isLikelyAlias('alice')).toBe(true)
    expect(isLikelyAlias('alice.xec')).toBe(true)
    expect(isLikelyAlias('not an alias!')).toBe(false)
  })

  test('toXecAlias converts bare alias to .xec and preserves .xec', () => {
    expect(toXecAlias('alice')).toBe('alice.xec')
    expect(toXecAlias('alice.xec')).toBe('alice.xec')
    expect(toXecAlias('invalid alias!')).toBeNull()
  })

  test('isValidEcashAddress validates ecash addresses', () => {
    expect(isValidEcashAddress(VALID_ADDR)).toBe(true)
    expect(isValidEcashAddress('not:an:address')).toBe(false)
    expect(isValidEcashAddress('')).toBe(false)
  })

  test('canonicalizeEcashAddress canonicalizes address', () => {
    expect(canonicalizeEcashAddress(VALID_ADDR)).toBe(VALID_ADDR)
    expect(canonicalizeEcashAddress(VALID_ADDR.toUpperCase())).toBe(VALID_ADDR)
    expect(canonicalizeEcashAddress('invalid')).toBeNull()
    expect(canonicalizeEcashAddress('  ' + VALID_ADDR)).toBeNull()
  })
})

describe('P1 prevent-address-prototype-interception', () => {
  test('Address.prototype is frozen and has null prototype', () => {
    expect(Object.isFrozen(Address.prototype)).toBe(true)
    expect(Object.getPrototypeOf(Address.prototype)).toBeNull()
  })

  test('post-import setter injection on Address.prototype throws and is rejected', () => {
    expect(() => {
      Object.defineProperty(Address.prototype, 'address', {
        get() {
          return 'ecash:qzmalicious00000000000000000000000000000000'
        },
        set() {},
        configurable: true
      })
    }).toThrow()

    expect(() => {
      Object.defineProperty(Address.prototype, 'hash', {
        get() {
          return '00'.repeat(20)
        },
        set() {},
        configurable: true
      })
    }).toThrow()
  })

  test('parseCashAddr(owner).cash().toString() is immune to Object.prototype pollution', () => {
    const originalDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'address')
    try {
      Object.defineProperty(Object.prototype, 'address', {
        get() {
          return 'ecash:qzpolluted00000000000000000000000000000000'
        },
        set() {},
        configurable: true
      })

      const parsed = parseCashAddr(VALID_ADDR)
      const canonical = parsed.cash().toString()
      expect(canonical).toBe(VALID_ADDR)

      const canonicalFromHelper = canonicalizeEcashAddress(VALID_ADDR)
      expect(canonicalFromHelper).toBe(VALID_ADDR)
    } finally {
      if (originalDesc === undefined) {
        Reflect.deleteProperty(Object.prototype, 'address')
      } else {
        Object.defineProperty(Object.prototype, 'address', originalDesc)
      }
    }
  })
})
