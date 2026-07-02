export const isX402DryRunEnabled = (
  value: unknown = import.meta.env.VITE_X402_DRY_RUN
) => String(value).trim().toLowerCase() === 'true'

export const X402_DRY_RUN_ENABLED = isX402DryRunEnabled()
