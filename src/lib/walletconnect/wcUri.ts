import { parseUri } from '@walletconnect/utils'

export const INVALID_WC_URI_ERROR = 'URI inválido. Revisa que no tenga espacios/saltos de línea.'

export const sanitizeWcUri = (raw: string) => raw.trim().replace(/\s+/g, '')

export const hasWhitespace = (value: string) => /\s/.test(value)

export const isChronikWsError = (value: string) => /chronik/i.test(value) && /(wss?:\/\/|websocket|ws)/i.test(value)

export const canPairWalletConnectUri = (value: string) => {
  if (!value.toLowerCase().startsWith('wc:')) return false
  try {
    parseUri(value)
    return true
  } catch {
    return false
  }
}
