import { Address } from 'ecash-lib'

// Isolate and freeze Address.prototype to prevent prototype pollution and setter interception
const addressProto = Address.prototype as unknown as Record<string, unknown>
for (const key of Object.getOwnPropertyNames(addressProto)) {
  if (key !== 'constructor') {
    try {
      delete addressProto[key]
    } catch {
      /* ignore non-configurable */
    }
  }
}
Object.setPrototypeOf(Address.prototype, null)
Object.freeze(Address.prototype)

const CAPTURED_STRING_METHODS = [
  'split',
  'toLowerCase',
  'toUpperCase',
  'slice',
  'substring',
  'indexOf',
  'lastIndexOf',
  'includes',
  'charCodeAt',
  'toString'
] as const

const CAPTURED_TYPED_ARRAY_METHODS = [
  'subarray',
  'slice',
  'set',
  'fill',
  'copyWithin',
  'indexOf',
  'lastIndexOf',
  'includes',
  'join',
  'map',
  'forEach',
  'reduce',
  'reduceRight',
  'reverse',
  'sort',
  'every',
  'some',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'at',
  'toString',
  'toLocaleString',
  'entries',
  'keys',
  'values'
] as const

interface TargetSnapshot {
  readonly target: object
  readonly name: string
  readonly authenticDesc?: PropertyDescriptor
}

interface ProtoChainSnapshot {
  readonly target: object
  readonly authenticProto: object | null
}

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object)
const objectDefineProperty = Object.defineProperty.bind(Object)
const objectGetPrototypeOf = Object.getPrototypeOf.bind(Object)
const objectSetPrototypeOf = Object.setPrototypeOf.bind(Object)
const stringTrim = Function.prototype.call.bind(String.prototype.trim) as (target: string) => string
const stringToLowerCase = Function.prototype.call.bind(
  String.prototype.toLowerCase
) as (target: string) => string
const stringStartsWith = Function.prototype.call.bind(
  String.prototype.startsWith
) as (target: string, search: string, position?: number) => boolean

export const capturedGlobalParseInt =
  typeof globalThis !== 'undefined' ? globalThis.parseInt : undefined

const authenticSnapshots: TargetSnapshot[] = []

for (let i = 0; i < CAPTURED_STRING_METHODS.length; i++) {
  const name = CAPTURED_STRING_METHODS[i]
  const desc = objectGetOwnPropertyDescriptor(String.prototype, name)
  if (desc) {
    authenticSnapshots[authenticSnapshots.length] = {
      target: String.prototype,
      name,
      authenticDesc: desc
    }
  }
}

const typedArrayProto =
  typeof Uint8Array !== 'undefined'
    ? objectGetPrototypeOf(Uint8Array.prototype)
    : undefined

if (typedArrayProto) {
  for (let i = 0; i < CAPTURED_TYPED_ARRAY_METHODS.length; i++) {
    const name = CAPTURED_TYPED_ARRAY_METHODS[i]
    const desc = objectGetOwnPropertyDescriptor(typedArrayProto, name)
    if (desc) {
      authenticSnapshots[authenticSnapshots.length] = {
        target: typedArrayProto,
        name,
        authenticDesc: desc
      }
    }
  }
}

if (typeof Uint8Array !== 'undefined' && Uint8Array.prototype) {
  for (let i = 0; i < CAPTURED_TYPED_ARRAY_METHODS.length; i++) {
    const name = CAPTURED_TYPED_ARRAY_METHODS[i]
    const desc = objectGetOwnPropertyDescriptor(Uint8Array.prototype, name)
    authenticSnapshots[authenticSnapshots.length] = {
      target: Uint8Array.prototype,
      name,
      authenticDesc: desc
    }
  }
}

if (typeof globalThis !== 'undefined' && capturedGlobalParseInt) {
  const desc =
    objectGetOwnPropertyDescriptor(globalThis, 'parseInt') ?? {
      value: capturedGlobalParseInt,
      writable: true,
      enumerable: false,
      configurable: true
    }
  authenticSnapshots[authenticSnapshots.length] = {
    target: globalThis as unknown as object,
    name: 'parseInt',
    authenticDesc: desc
  }
}

if (typeof Number !== 'undefined' && Number.parseInt) {
  const desc =
    objectGetOwnPropertyDescriptor(Number, 'parseInt') ?? {
      value: Number.parseInt,
      writable: true,
      enumerable: false,
      configurable: true
    }
  authenticSnapshots[authenticSnapshots.length] = {
    target: Number as unknown as object,
    name: 'parseInt',
    authenticDesc: desc
  }
}

const protoChainSnapshots: ProtoChainSnapshot[] = []

if (typeof String !== 'undefined' && String.prototype) {
  protoChainSnapshots[protoChainSnapshots.length] = {
    target: String.prototype,
    authenticProto: objectGetPrototypeOf(String.prototype)
  }
}

if (typeof Uint8Array !== 'undefined' && Uint8Array.prototype) {
  protoChainSnapshots[protoChainSnapshots.length] = {
    target: Uint8Array.prototype,
    authenticProto: objectGetPrototypeOf(Uint8Array.prototype)
  }
}

if (typedArrayProto) {
  protoChainSnapshots[protoChainSnapshots.length] = {
    target: typedArrayProto,
    authenticProto: objectGetPrototypeOf(typedArrayProto)
  }
}

if (typeof Array !== 'undefined' && Array.prototype) {
  protoChainSnapshots[protoChainSnapshots.length] = {
    target: Array.prototype,
    authenticProto: objectGetPrototypeOf(Array.prototype)
  }
}

export function runWithIsolatedDecoder<T>(action: () => T): T {
  const previousDescriptors: Array<PropertyDescriptor | undefined> = []
  const tamperedIndices: number[] = []
  const previousProtos: Array<object | null | undefined> = []
  const tamperedProtoIndices: number[] = []

  try {
    for (let i = 0; i < protoChainSnapshots.length; i++) {
      const { target, authenticProto } = protoChainSnapshots[i]
      const currentProto = objectGetPrototypeOf(target)

      if (currentProto !== authenticProto) {
        objectSetPrototypeOf(target, authenticProto)
        if (objectGetPrototypeOf(target) !== authenticProto) {
          throw new TypeError('Cannot restore prototype chain')
        }
        previousProtos[i] = currentProto
        tamperedProtoIndices[tamperedProtoIndices.length] = i
      }
    }

    for (let i = 0; i < authenticSnapshots.length; i++) {
      const { target, name, authenticDesc } = authenticSnapshots[i]
      const currentDesc = objectGetOwnPropertyDescriptor(target, name)

      if (authenticDesc) {
        if (
          currentDesc?.value !== authenticDesc.value ||
          currentDesc?.get !== authenticDesc.get ||
          currentDesc?.set !== authenticDesc.set
        ) {
          objectDefineProperty(target, name, authenticDesc)
          previousDescriptors[i] = currentDesc
          tamperedIndices[tamperedIndices.length] = i
        }
      } else {
        // Authentic state had no own property on target (e.g. shadowing on Uint8Array.prototype)
        if (currentDesc !== undefined) {
          const deleted = delete (target as unknown as Record<string, unknown>)[name]
          if (!deleted || objectGetOwnPropertyDescriptor(target, name) !== undefined) {
            throw new TypeError(`Cannot delete non-configurable prototype property '${name}'`)
          }
          previousDescriptors[i] = currentDesc
          tamperedIndices[tamperedIndices.length] = i
        }
      }
    }

    return action()
  } finally {
    let restorationError: unknown = null
    for (let j = 0; j < tamperedIndices.length; j++) {
      const idx = tamperedIndices[j]
      const { target, name } = authenticSnapshots[idx]
      const previousDesc = previousDescriptors[idx]
      try {
        if (previousDesc) {
          objectDefineProperty(target, name, previousDesc)
        } else {
          const deleted = delete (target as unknown as Record<string, unknown>)[name]
          if (!deleted || objectGetOwnPropertyDescriptor(target, name) !== undefined) {
            if (!restorationError) {
              restorationError = new TypeError(`Cannot restore deleted prototype property '${name}'`)
            }
          }
        }
      } catch (err) {
        if (!restorationError) {
          restorationError = err
        }
      }
    }

    for (let p = 0; p < tamperedProtoIndices.length; p++) {
      const idx = tamperedProtoIndices[p]
      const { target } = protoChainSnapshots[idx]
      const previousProto = previousProtos[idx]
      try {
        if (previousProto !== undefined) {
          objectSetPrototypeOf(target, previousProto)
          if (objectGetPrototypeOf(target) !== previousProto) {
            if (!restorationError) {
              restorationError = new TypeError('Cannot restore tampered prototype chain')
            }
          }
        }
      } catch (err) {
        if (!restorationError) {
          restorationError = err
        }
      }
    }

    if (restorationError) {
      // eslint-disable-next-line no-unsafe-finally
      throw restorationError
    }
  }
}

export const runWithIsolatedStringDecoder = runWithIsolatedDecoder

const rawParseCashAddr = Address.parse.bind(Address)

const wrapAddressInstance = (instance: ReturnType<typeof rawParseCashAddr>): ReturnType<typeof rawParseCashAddr> => {
  if (!instance || typeof instance !== 'object') return instance
  const origCash = instance.cash
  if (typeof origCash === 'function') {
    instance.cash = () => wrapAddressInstance(runWithIsolatedDecoder(() => origCash.call(instance)))
  }
  const origLegacy = instance.legacy
  if (typeof origLegacy === 'function') {
    instance.legacy = () => wrapAddressInstance(runWithIsolatedDecoder(() => origLegacy.call(instance)))
  }
  const origToString = instance.toString
  if (typeof origToString === 'function') {
    instance.toString = () => runWithIsolatedDecoder(() => origToString.call(instance))
  }
  return instance
}

export const parseCashAddr = (address: string): ReturnType<typeof rawParseCashAddr> => {
  if (typeof address !== 'string') {
    throw new TypeError('Address must be a string')
  }
  return wrapAddressInstance(runWithIsolatedDecoder(() => rawParseCashAddr(address)))
}

const BARE_ALIAS_RE = /^[a-z0-9]{1,21}$/
const FULL_ALIAS_RE = /^([a-z0-9]{1,21})\.xec$/

export const normalizeAliasInput = (input: string): string =>
  typeof input === 'string' ? stringToLowerCase(stringTrim(input)) : ''

export const isValidAliasName = (input: string): boolean =>
  BARE_ALIAS_RE.test(normalizeAliasInput(input))

export const isLikelyAlias = (input: string): boolean => {
  const normalized = normalizeAliasInput(input)
  return BARE_ALIAS_RE.test(normalized) || FULL_ALIAS_RE.test(normalized)
}

export const toXecAlias = (input: string): string | null => {
  const normalized = normalizeAliasInput(input)
  if (BARE_ALIAS_RE.test(normalized)) return `${normalized}.xec`
  const fullMatch = normalized.match(FULL_ALIAS_RE)
  return fullMatch ? normalized : null
}

export const isValidEcashAddress = (input: string): boolean => {
  if (typeof input !== 'string') return false
  const trimmed = stringTrim(input)
  if (!stringStartsWith(stringToLowerCase(trimmed), 'ecash:')) return false

  try {
    parseCashAddr(trimmed)
    return true
  } catch {
    return false
  }
}

export const canonicalizeEcashAddress = (input: string): string | null => {
  if (typeof input !== 'string' || stringTrim(input) !== input) return null
  if (!stringStartsWith(stringToLowerCase(input), 'ecash:')) return null
  try {
    return runWithIsolatedDecoder(() => {
      return rawParseCashAddr(input).cash().toString()
    })
  } catch {
    return null
  }
}
