export const isX402H3BEnabled = (
  value: unknown = import.meta.env.VITE_X402_H3B_ENABLED
) => String(value).trim().toLowerCase() === 'true'

export const X402_H3B_ENABLED = isX402H3BEnabled()
