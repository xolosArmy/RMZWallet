import { execFileSync } from 'node:child_process'
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

describe('P1 isolate-string-prototype-decoder', () => {
  const OTHER_ADDR = 'ecash:qrrd3y2cmg6m2vxlng9h3djh889pmwffhqv9yym2p4'

  test('parseCashAddr throws TypeError on non-string input', () => {
    expect(() => (parseCashAddr as unknown as (x: unknown) => void)(123)).toThrow(TypeError)
    expect(() => (parseCashAddr as unknown as (x: unknown) => void)({})).toThrow(TypeError)
    expect(() => (parseCashAddr as unknown as (x: unknown) => void)(null)).toThrow(TypeError)
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to monkeypatched String.prototype.split', () => {
    const originalSplit = String.prototype.split
    const stringProto = String.prototype as unknown as Record<string, unknown>
    try {
      stringProto['split'] = function (this: unknown, separator?: unknown, limit?: number): string[] {
        const self = String(this)
        if (self.includes('ecash:')) {
          // Attacker attempts to forge the payload to VALID_ADDR
          return ['ecash', VALID_ADDR.slice(6)]
        }
        return Reflect.apply(originalSplit, this, [separator, limit]) as string[]
      }

      // Outside isolated parse, split is indeed forged
      expect('ecash:dummy'.split(':')[1]).toBe(VALID_ADDR.slice(6))

      // Inside parseCashAddr and canonicalizeEcashAddress, authentic OTHER_ADDR is decoded
      const parsed = parseCashAddr(OTHER_ADDR)
      expect(parsed.cash().toString()).toBe(OTHER_ADDR)
      expect(canonicalizeEcashAddress(OTHER_ADDR)).toBe(OTHER_ADDR)
    } finally {
      stringProto['split'] = originalSplit
    }
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to monkeypatched String.prototype.toLowerCase', () => {
    const originalLower = String.prototype.toLowerCase
    try {
      String.prototype.toLowerCase = function (): string {
        if (typeof this === 'string' && this.includes('ecash:')) {
          return VALID_ADDR
        }
        return originalLower.call(this)
      }

      // Outside isolated parse, toLowerCase is forged
      expect('ecash:dummy'.toLowerCase()).toBe(VALID_ADDR)

      // Inside parseCashAddr and canonicalizeEcashAddress, authentic OTHER_ADDR is decoded
      const parsed = parseCashAddr(OTHER_ADDR)
      expect(parsed.cash().toString()).toBe(OTHER_ADDR)
      expect(canonicalizeEcashAddress(OTHER_ADDR)).toBe(OTHER_ADDR)
    } finally {
      String.prototype.toLowerCase = originalLower
    }
  })

  test('alias helpers are immune to monkeypatched String.prototype.toLowerCase and trim', () => {
    const originalLower = String.prototype.toLowerCase
    const originalTrim = String.prototype.trim
    try {
      String.prototype.toLowerCase = () => 'tampered'
      String.prototype.trim = () => 'tampered'

      expect(normalizeAliasInput('  Alice  ')).toBe('alice')
      expect(isValidAliasName('alice')).toBe(true)
      expect(isLikelyAlias('alice.xec')).toBe(true)
      expect(toXecAlias('alice')).toBe('alice.xec')
      expect(isValidEcashAddress(VALID_ADDR)).toBe(true)
    } finally {
      String.prototype.toLowerCase = originalLower
      String.prototype.trim = originalTrim
    }
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to monkeypatched Uint8Array.prototype.subarray (shadowing)', () => {
    const validHash = Address.parse(VALID_ADDR).hash
    const u8Proto = Uint8Array.prototype as unknown as Record<string, unknown>
    const origSubarray = Uint8Array.prototype.subarray

    try {
      // Attacker shadows subarray on Uint8Array.prototype to substitute validHash bytes
      u8Proto['subarray'] = function (this: Uint8Array, begin?: number, end?: number): Uint8Array {
        if (begin === 1 && end === undefined && this.length === 21) {
          const forgedBytes = new Uint8Array(
            (validHash.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16))
          )
          return forgedBytes
        }
        return Reflect.apply(origSubarray, this, [begin, end]) as Uint8Array
      }

      // Outside isolated decoder, the attack succeeds on an unprotected raw buffer
      const probe = new Uint8Array(21)
      expect((probe as unknown as { subarray: (b?: number) => Uint8Array }).subarray(1).length).toBe(20)

      // Inside parseCashAddr and canonicalizeEcashAddress, authentic OTHER_ADDR is decoded
      const parsed = parseCashAddr(OTHER_ADDR)
      expect(parsed.cash().toString()).toBe(OTHER_ADDR)
      expect(canonicalizeEcashAddress(OTHER_ADDR)).toBe(OTHER_ADDR)
    } finally {
      delete u8Proto['subarray']
    }
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to monkeypatched TypedArray.prototype.subarray (inherited)', () => {
    const validHash = Address.parse(VALID_ADDR).hash
    const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as Record<string, unknown>
    const origSubarray = typedArrayProto['subarray'] as (this: Uint8Array, begin?: number, end?: number) => Uint8Array

    try {
      // Attacker mutates inherited TypedArray.prototype.subarray
      typedArrayProto['subarray'] = function (this: Uint8Array, begin?: number, end?: number): Uint8Array {
        if (begin === 1 && end === undefined && this.length === 21) {
          const forgedBytes = new Uint8Array(
            (validHash.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16))
          )
          return forgedBytes
        }
        return Reflect.apply(origSubarray, this, [begin, end]) as Uint8Array
      }

      // Inside parseCashAddr and canonicalizeEcashAddress, authentic OTHER_ADDR is decoded
      const parsed = parseCashAddr(OTHER_ADDR)
      expect(parsed.cash().toString()).toBe(OTHER_ADDR)
      expect(canonicalizeEcashAddress(OTHER_ADDR)).toBe(OTHER_ADDR)
    } finally {
      typedArrayProto['subarray'] = origSubarray
    }
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to monkeypatched Uint8Array.prototype.set and slice', () => {
    const u8Proto = Uint8Array.prototype as unknown as Record<string, unknown>
    try {
      u8Proto['set'] = () => {
        throw new Error('tampered set')
      }
      u8Proto['slice'] = () => {
        throw new Error('tampered slice')
      }

      const parsed = parseCashAddr(OTHER_ADDR)
      expect(parsed.cash().toString()).toBe(OTHER_ADDR)
      expect(canonicalizeEcashAddress(OTHER_ADDR)).toBe(OTHER_ADDR)
    } finally {
      delete u8Proto['set']
      delete u8Proto['slice']
    }
  })

  test('fail-closed: runWithIsolatedDecoder throws immediately and aborts action if prototype property is non-configurable', () => {
    const script = `
      import { runWithIsolatedDecoder, parseCashAddr, canonicalizeEcashAddress } from './src/utils/alias.ts'
      Object.defineProperty(String.prototype, 'split', {
        value: () => ['ecash', 'fake'],
        configurable: false,
        writable: false
      })

      let executed = false
      let threw = false
      try {
        runWithIsolatedDecoder(() => {
          executed = true
        })
      } catch (err) {
        threw = true
      }
      if (executed) throw new Error('Action must not execute when prototype is non-configurable')
      if (!threw) throw new Error('runWithIsolatedDecoder must throw on non-configurable property')

      let parseThrew = false
      try {
        parseCashAddr('ecash:dummy')
      } catch {
        parseThrew = true
      }
      if (!parseThrew) throw new Error('parseCashAddr must throw on non-configurable prototype')

      const canon = canonicalizeEcashAddress('ecash:dummy')
      if (canon !== null) throw new Error('canonicalizeEcashAddress must return null on non-configurable prototype')
      process.stdout.write('OK')
    `
    const result = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH }
      }
    )
    expect(result.trim()).toBe('OK')
  })

  test('fail-closed: runWithIsolatedDecoder throws immediately and aborts action if Uint8Array shadowing is non-configurable', () => {
    const script = `
      import { runWithIsolatedDecoder, parseCashAddr, canonicalizeEcashAddress } from './src/utils/alias.ts'
      Object.defineProperty(Uint8Array.prototype, 'subarray', {
        value: function () { return new Uint8Array([99]) },
        configurable: false,
        writable: false
      })

      let executed = false
      let threw = false
      try {
        runWithIsolatedDecoder(() => {
          executed = true
        })
      } catch (err) {
        threw = true
      }
      if (executed) throw new Error('Action must not execute when Uint8Array shadowing is non-configurable')
      if (!threw) throw new Error('runWithIsolatedDecoder must throw on non-configurable Uint8Array shadowing')

      let parseThrew = false
      try {
        parseCashAddr('ecash:dummy')
      } catch {
        parseThrew = true
      }
      if (!parseThrew) throw new Error('parseCashAddr must throw on non-configurable Uint8Array shadowing')

      const canon = canonicalizeEcashAddress('ecash:dummy')
      if (canon !== null) throw new Error('canonicalizeEcashAddress must return null on non-configurable Uint8Array shadowing')
      process.stdout.write('OK')
    `
    const result = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH }
      }
    )
    expect(result.trim()).toBe('OK')
  })

  test('fail-closed: runWithIsolatedDecoder throws if finally cleanup fails to restore previous descriptor', () => {
    const script = `
      import { runWithIsolatedDecoder } from './src/utils/alias.ts'

      const orig = String.prototype.split
      String.prototype.split = () => ['tampered']

      let executed = false
      let threw = false
      try {
        runWithIsolatedDecoder(() => {
          executed = true
          // Inside action, freeze/lock split so restoring it in finally fails
          Object.defineProperty(String.prototype, 'split', {
            value: orig,
            configurable: false,
            writable: false
          })
          return 'done'
        })
      } catch (err) {
        threw = true
      }

      if (!executed) throw new Error('Action was expected to run before cleanup')
      if (!threw) throw new Error('runWithIsolatedDecoder must throw when finally cleanup fails')
      process.stdout.write('OK')
    `
    const result = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH }
      }
    )
    expect(result.trim()).toBe('OK')
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to monkeypatched globalThis.parseInt', () => {
    const origParseInt = globalThis.parseInt
    try {
      globalThis.parseInt = () => 0
      const parsed = parseCashAddr(VALID_ADDR)
      expect(parsed.cash().toString()).toBe(VALID_ADDR)
      expect(parsed.toString()).toBe(VALID_ADDR)
      expect(canonicalizeEcashAddress(VALID_ADDR)).toBe(VALID_ADDR)
      // Verify monkeypatch is restored outside
      expect(globalThis.parseInt('42', 10)).toBe(0)
    } finally {
      globalThis.parseInt = origParseInt
    }
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to altered Uint8Array.prototype prototype chain', () => {
    const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype)
    const fakeProto = Object.create(typedArrayProto)
    fakeProto.subarray = function () {
      return new Uint8Array([77, 88])
    }
    try {
      Object.setPrototypeOf(Uint8Array.prototype, fakeProto)
      const parsed = parseCashAddr(VALID_ADDR)
      expect(parsed.cash().toString()).toBe(VALID_ADDR)
      expect(canonicalizeEcashAddress(VALID_ADDR)).toBe(VALID_ADDR)
      // Verify tampered prototype chain was restored outside
      expect(Object.getPrototypeOf(Uint8Array.prototype)).toBe(fakeProto)
    } finally {
      Object.setPrototypeOf(Uint8Array.prototype, typedArrayProto)
    }
  })

  test('parseCashAddr and canonicalizeEcashAddress immune to altered String.prototype prototype chain', () => {
    const origStringProto = Object.getPrototypeOf(String.prototype)
    const fakeProto = Object.create(origStringProto)
    try {
      Object.setPrototypeOf(String.prototype, fakeProto)
      const parsed = parseCashAddr(VALID_ADDR)
      expect(parsed.cash().toString()).toBe(VALID_ADDR)
      expect(canonicalizeEcashAddress(VALID_ADDR)).toBe(VALID_ADDR)
      expect(Object.getPrototypeOf(String.prototype)).toBe(fakeProto)
    } finally {
      Object.setPrototypeOf(String.prototype, origStringProto)
    }
  })

  test('fail-closed: runWithIsolatedDecoder throws immediately and aborts action if globalThis.parseInt is non-configurable', () => {
    const script = `
      import { runWithIsolatedDecoder, parseCashAddr, canonicalizeEcashAddress } from './src/utils/alias.ts'

      Object.defineProperty(globalThis, 'parseInt', {
        value: () => 0,
        configurable: false,
        writable: false
      })

      let executed = false
      let threw = false
      try {
        runWithIsolatedDecoder(() => {
          executed = true
        })
      } catch {
        threw = true
      }
      if (executed) throw new Error('Action must not execute when parseInt is non-configurable')
      if (!threw) throw new Error('runWithIsolatedDecoder must throw on non-configurable parseInt')

      let parseThrew = false
      try {
        parseCashAddr('ecash:dummy')
      } catch {
        parseThrew = true
      }
      if (!parseThrew) throw new Error('parseCashAddr must throw on non-configurable parseInt')

      const canon = canonicalizeEcashAddress('ecash:dummy')
      if (canon !== null) throw new Error('canonicalizeEcashAddress must return null on non-configurable parseInt')
      process.stdout.write('OK')
    `
    const result = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH }
      }
    )
    expect(result.trim()).toBe('OK')
  })

  test('fail-closed: runWithIsolatedDecoder throws immediately if prototype chain tampering is non-extensible', () => {
    const script = `
      import { runWithIsolatedDecoder, parseCashAddr, canonicalizeEcashAddress } from './src/utils/alias.ts'

      const origProto = Object.getPrototypeOf(Uint8Array.prototype)
      const fakeProto = Object.create(origProto)
      Object.setPrototypeOf(Uint8Array.prototype, fakeProto)
      Object.preventExtensions(Uint8Array.prototype)

      let executed = false
      let threw = false
      try {
        runWithIsolatedDecoder(() => {
          executed = true
        })
      } catch {
        threw = true
      }
      if (executed) throw new Error('Action must not execute when prototype is non-extensible')
      if (!threw) throw new Error('runWithIsolatedDecoder must throw on non-extensible prototype chain')

      let parseThrew = false
      try {
        parseCashAddr('ecash:dummy')
      } catch {
        parseThrew = true
      }
      if (!parseThrew) throw new Error('parseCashAddr must throw on non-extensible prototype chain')

      const canon = canonicalizeEcashAddress('ecash:dummy')
      if (canon !== null) throw new Error('canonicalizeEcashAddress must return null on non-extensible prototype chain')
      process.stdout.write('OK')
    `
    const result = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH }
      }
    )
    expect(result.trim()).toBe('OK')
  })
})
