import { useEffect, useState } from 'react'
import type { OfferPublishedPayload } from './WcWallet'

type SignAndBroadcastDebug = {
  at: number
  txid?: string
  error?: string
  paramsSummary?: unknown
}

type WcDebugState = {
  lastOfferPayload?: OfferPublishedPayload
  lastSignAndBroadcast?: SignAndBroadcastDebug
  lastRefreshAt?: number
}

type Listener = () => void

let state: WcDebugState = {}
const listeners = new Set<Listener>()

export function getWcDebugState() {
  return state
}

export function updateWcDebugState(partial: Partial<WcDebugState>) {
  state = { ...state, ...partial }
  listeners.forEach((listener) => listener())
}

export function subscribeWcDebug(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWcDebug() {
  const [current, setCurrent] = useState<WcDebugState>(() => getWcDebugState())

  useEffect(() => {
    return subscribeWcDebug(() => {
      setCurrent(getWcDebugState())
    })
  }, [])

  return current
}
