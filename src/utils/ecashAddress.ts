import { Address } from 'ecash-lib'
import type { TxInput } from 'chronik-client'

export type SenderType = 'p2pkh' | 'p2sh'

export type SenderDetails = {
  address: string
  type: SenderType
}

const normalizeEcashAddress = (value: string): SenderDetails | null => {
  try {
    const parsed = Address.parse(value.trim())
    const cash = parsed.cash()
    return { address: cash.toString(), type: cash.type }
  } catch {
    return null
  }
}

const addressFromOutputScript = (outputScript: string): SenderDetails | null => {
  try {
    const parsed = Address.fromScriptHex(outputScript)
    return { address: parsed.toString(), type: parsed.type }
  } catch {
    return null
  }
}

const resolveInputSender = (input: TxInput): SenderDetails | null => {
  const addressField = (input as { address?: string }).address
  if (typeof addressField === 'string' && addressField.trim()) {
    const normalized = normalizeEcashAddress(addressField)
    if (normalized) return normalized
  }

  if (!input.outputScript) return null
  return addressFromOutputScript(input.outputScript)
}

export const selectSenderFromInputs = (inputs: TxInput[]): SenderDetails | null => {
  if (!inputs.length) return null
  const hasValues = inputs.some((input) => typeof input.sats === 'bigint' && input.sats > 0n)
  const ordered = hasValues
    ? [...inputs].sort((a, b) => {
        const aSats = typeof a.sats === 'bigint' ? a.sats : 0n
        const bSats = typeof b.sats === 'bigint' ? b.sats : 0n
        if (aSats === bSats) return 0
        return aSats > bSats ? -1 : 1
      })
    : inputs

  for (const input of ordered) {
    const sender = resolveInputSender(input)
    if (sender) return sender
  }

  return null
}
