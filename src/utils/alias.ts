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

type StringMethodName = (typeof CAPTURED_STRING_METHODS)[number]

interface MethodSnapshot {
  readonly name: StringMethodName
  readonly desc: PropertyDescriptor
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

const authenticSnapshots: MethodSnapshot[] = []
for (let i = 0; i < CAPTURED_STRING_METHODS.length; i++) {
  const name = CAPTURED_STRING_METHODS[i]
  const desc = objectGetOwnPropertyDescriptor(String.prototype, name)
  if (desc) {
    authenticSnapshots[authenticSnapshots.length] = { name, desc }
  }
}

export function runWithIsolatedStringDecoder<T>(action: () => T): T {
  const previousDescriptors: Array<PropertyDescriptor | undefined> = []
  const tamperedIndices: number[] = []

  for (let i = 0; i < authenticSnapshots.length; i++) {
    const { name, desc: authenticDesc } = authenticSnapshots[i]
    const currentDesc = objectGetOwnPropertyDescriptor(String.prototype, name)
    if (currentDesc?.value !== authenticDesc.value) {
      previousDescriptors[i] = currentDesc
      tamperedIndices[tamperedIndices.length] = i
      try {
        objectDefineProperty(String.prototype, name, authenticDesc)
      } catch {
        /* ignore if non-configurable */
      }
    }
  }

  try {
    return action()
  } finally {
    for (let j = 0; j < tamperedIndices.length; j++) {
      const idx = tamperedIndices[j]
      const name = authenticSnapshots[idx].name
      const previousDesc = previousDescriptors[idx]
      try {
        if (previousDesc) {
          objectDefineProperty(String.prototype, name, previousDesc)
        } else {
          delete (String.prototype as unknown as Record<string, unknown>)[name]
        }
      } catch {
        /* ignore */
      }
    }
  }
}

const rawParseCashAddr = Address.parse.bind(Address)

export const parseCashAddr = (address: string): ReturnType<typeof rawParseCashAddr> => {
  if (typeof address !== 'string') {
    throw new TypeError('Address must be a string')
  }
  return runWithIsolatedStringDecoder(() => rawParseCashAddr(address))
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
    return runWithIsolatedStringDecoder(() => {
      return rawParseCashAddr(input).cash().toString()
    })
  } catch {
    return null
  }
}
