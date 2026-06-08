import { useEffect, useMemo, useState } from 'react'
import { isLikelyAlias, isValidEcashAddress, normalizeAliasInput, toXecAlias } from '../utils/alias'

const ALIAS_API_BASE = 'https://alias.ecash.mx/alias'
const ALIAS_DEBOUNCE_MS = 500

export type AliasInputType = 'empty' | 'ecash-address' | 'alias' | 'invalid'
export type AliasResolutionStatus = 'idle' | 'loading' | 'confirmed' | 'error'

export type AliasRecord = {
  alias: string
  address: string
  txid: string
  blockheight?: number
  status: string
  source?: string
}

export type AliasResolution = {
  inputType: AliasInputType
  status: AliasResolutionStatus
  alias: string | null
  resolvedAddress: string | null
  errorMessage: string | null
  aliasRecord: AliasRecord | null
}

const idleResolution: AliasResolution = {
  inputType: 'empty',
  status: 'idle',
  alias: null,
  resolvedAddress: null,
  errorMessage: null,
  aliasRecord: null
}

const isAliasRecord = (value: unknown): value is AliasRecord => {
  if (!value || typeof value !== 'object') return false
  const record = value as AliasRecord
  return (
    typeof record.alias === 'string' &&
    typeof record.address === 'string' &&
    typeof record.txid === 'string' &&
    typeof record.status === 'string'
  )
}

export function useAliasResolution(rawRecipientInput: string): AliasResolution {
  const parsedInput = useMemo(() => {
    const trimmed = rawRecipientInput.trim()
    if (!trimmed) return { kind: 'empty' as const, alias: null, address: null }
    if (isValidEcashAddress(trimmed)) return { kind: 'ecash-address' as const, alias: null, address: trimmed }
    if (isLikelyAlias(trimmed)) return { kind: 'alias' as const, alias: toXecAlias(trimmed), address: null }
    return { kind: 'invalid' as const, alias: null, address: null }
  }, [rawRecipientInput])

  const [resolution, setResolution] = useState<AliasResolution>(idleResolution)

  useEffect(() => {
    if (parsedInput.kind === 'empty') {
      setResolution(idleResolution)
      return
    }

    if (parsedInput.kind === 'ecash-address') {
      setResolution({
        inputType: 'ecash-address',
        status: 'confirmed',
        alias: null,
        resolvedAddress: parsedInput.address,
        errorMessage: null,
        aliasRecord: null
      })
      return
    }

    if (parsedInput.kind === 'invalid' || !parsedInput.alias) {
      setResolution({
        inputType: 'invalid',
        status: 'error',
        alias: null,
        resolvedAddress: null,
        errorMessage: 'Ingresa una dirección eCash válida o un alias .xec válido.',
        aliasRecord: null
      })
      return
    }

    const alias = normalizeAliasInput(parsedInput.alias)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      setResolution({
        inputType: 'alias',
        status: 'loading',
        alias,
        resolvedAddress: null,
        errorMessage: null,
        aliasRecord: null
      })

      void (async () => {
        try {
          const response = await fetch(`${ALIAS_API_BASE}/${encodeURIComponent(alias)}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
          })

          if (response.status === 404) {
            setResolution({
              inputType: 'alias',
              status: 'error',
              alias,
              resolvedAddress: null,
              errorMessage: 'Alias .xec no encontrado.',
              aliasRecord: null
            })
            return
          }

          if (!response.ok) {
            throw new Error(`Alias API error: ${response.status}`)
          }

          const record = (await response.json()) as unknown
          if (!isAliasRecord(record) || !isValidEcashAddress(record.address)) {
            throw new Error('Invalid alias response')
          }

          if (record.status !== 'confirmed') {
            setResolution({
              inputType: 'alias',
              status: 'error',
              alias,
              resolvedAddress: null,
              errorMessage: 'Alias pendiente de confirmación. No es seguro para pagos.',
              aliasRecord: record
            })
            return
          }

          setResolution({
            inputType: 'alias',
            status: 'confirmed',
            alias: record.alias,
            resolvedAddress: record.address,
            errorMessage: null,
            aliasRecord: record
          })
        } catch {
          if (controller.signal.aborted) return
          setResolution({
            inputType: 'alias',
            status: 'error',
            alias,
            resolvedAddress: null,
            errorMessage: 'No se pudo consultar alias.ecash.mx.',
            aliasRecord: null
          })
        }
      })()
    }, ALIAS_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [parsedInput])

  return resolution
}
