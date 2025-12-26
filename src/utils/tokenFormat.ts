const pow10 = (decimals: number): bigint => 10n ** BigInt(decimals)

export function formatTokenAmount(atoms: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Los decimales del token son inválidos.')
  }
  const negative = atoms < 0n
  const absAtoms = negative ? -atoms : atoms
  const base = pow10(decimals)
  const whole = absAtoms / base
  const fraction = absAtoms % base

  if (decimals === 0) {
    return `${negative ? '-' : ''}${whole.toString()}`
  }

  const fractionStr = fraction.toString().padStart(decimals, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${fractionStr}`
}

export function parseTokenAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Los decimales del token son inválidos.')
  }

  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Ingresa un monto válido.')
  }
  if (trimmed.startsWith('-')) {
    throw new Error('El monto no puede ser negativo.')
  }

  const normalized = trimmed.startsWith('.') ? `0${trimmed}` : trimmed
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('Ingresa un monto válido.')
  }

  const [wholeStr, fractionStr = ''] = normalized.split('.')
  if (decimals === 0 && fractionStr.length > 0) {
    throw new Error('El token no admite decimales.')
  }
  if (fractionStr.length > decimals) {
    throw new Error(`Máximo ${decimals} decimales permitidos.`)
  }

  const paddedFraction = fractionStr.padEnd(decimals, '0')
  const atoms = BigInt(wholeStr || '0') * pow10(decimals) + BigInt(paddedFraction || '0')
  return atoms
}
