export const XEC_SATS_PER_XEC = 100

export const FEE_RATE_SATS_PER_BYTE = 1
export const MIN_NETWORK_FEE_SATS = 700

export const TONALLI_SERVICE_FEE_XEC = 55
export const TONALLI_SERVICE_FEE_SATS = Math.round(TONALLI_SERVICE_FEE_XEC * XEC_SATS_PER_XEC)

export const XEC_TONALLI_TREASURY_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
export const XEC_DUST_SATS = 546

export const satsToXec = (sats: number) => sats / XEC_SATS_PER_XEC
export const xecToSats = (xec: number) => Math.round(xec * XEC_SATS_PER_XEC)

export const computeNetworkFeeSats = (txBytes: number) =>
  Math.max(MIN_NETWORK_FEE_SATS, Math.ceil(txBytes * FEE_RATE_SATS_PER_BYTE))
