import { Address } from 'ecash-lib'

const BARE_ALIAS_RE = /^[a-z0-9]{1,21}$/
const FULL_ALIAS_RE = /^([a-z0-9]{1,21})\.xec$/

export const normalizeAliasInput = (input: string): string => input.trim().toLowerCase()

export const isValidAliasName = (input: string): boolean => BARE_ALIAS_RE.test(normalizeAliasInput(input))

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
  const trimmed = input.trim()
  if (!trimmed.toLowerCase().startsWith('ecash:')) return false

  try {
    Address.parse(trimmed)
    return true
  } catch {
    return false
  }
}
