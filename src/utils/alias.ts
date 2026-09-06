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

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object)
const objectDefineProperty = Object.defineProperty.bind(Object)
const stringTrim = Function.prototype.call.bind(String.prototype.trim) as (target: string) => string
const stringToLowerCase = Function.prototype.call.bind(
  String.prototype.toLowerCase
) as (target: string) => string
const stringStartsWith = Function.prototype.call.bind(
  String.prototype.startsWith
) as (target: string, search: string, position?: number) => boolean

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
    ? Object.getPrototypeOf(Uint8Array.prototype)
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

export function runWithIsolatedDecoder<T>(action: () => T): T {
  const previousDescriptors: Array<PropertyDescriptor | undefined> = []
  const tamperedIndices: number[] = []

  for (let i = 0; i < authenticSnapshots.length; i++) {
    const { target, name, authenticDesc } = authenticSnapshots[i]
    const currentDesc = objectGetOwnPropertyDescriptor(target, name)

    if (authenticDesc) {
      if (
        currentDesc?.value !== authenticDesc.value ||
        currentDesc?.get !== authenticDesc.get ||
        currentDesc?.set !== authenticDesc.set
      ) {
        previousDescriptors[i] = currentDesc
        tamperedIndices[tamperedIndices.length] = i
        try {
          objectDefineProperty(target, name, authenticDesc)
        } catch {
          /* ignore if non-configurable */
        }
      }
    } else {
      // Authentic state had no own property on target (e.g. shadowing on Uint8Array.prototype)
      if (currentDesc !== undefined) {
        previousDescriptors[i] = currentDesc
        tamperedIndices[tamperedIndices.length] = i
        try {
          delete (target as unknown as Record<string, unknown>)[name]
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    return action()
  } finally {
    for (let j = 0; j < tamperedIndices.length; j++) {
      const idx = tamperedIndices[j]
      const { target, name } = authenticSnapshots[idx]
      const previousDesc = previousDescriptors[idx]
      try {
        if (previousDesc) {
          objectDefineProperty(target, name, previousDesc)
        } else {
          delete (target as unknown as Record<string, unknown>)[name]
        }
      } catch {
        /* ignore */
      }
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
