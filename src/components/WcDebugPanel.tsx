import { useEffect, useMemo, useState } from 'react'
import { wcWallet } from '../lib/walletconnect/WcWallet'
import { useWcDebug } from '../lib/walletconnect/wcDebug'

export default function WcDebugPanel() {
  const [wcState, setWcState] = useState(() => wcWallet.getState())
  const debug = useWcDebug()

  useEffect(() => wcWallet.subscribe(setWcState), [])

  const topics = useMemo(() => wcState.sessions.map((session) => session.topic), [wcState.sessions])

  const lastOffer = debug.lastOfferPayload
  const lastOfferPreview = lastOffer ? JSON.stringify(lastOffer).slice(0, 180) : null
  const lastBroadcast = debug.lastSignAndBroadcast
  const lastRefresh = debug.lastRefreshAt

  return (
    <div className="fixed bottom-4 left-4 z-50 w-[320px] space-y-2 rounded-2xl border border-white/10 bg-black/85 p-3 text-[11px] text-white/80 shadow-lg">
      <div className="flex items-center justify-between text-xs text-white/60">
        <span>WC Debug</span>
        <span>{topics.length} sessions</span>
      </div>
      <div className="space-y-1">
        <div className="text-white/50">Topics</div>
        <div className="max-h-[90px] overflow-auto break-all text-white/80">
          {topics.length ? topics.join('\n') : '—'}
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-white/50">Last offer payload</div>
        <div className="break-all text-white/80">{lastOfferPreview ?? '—'}</div>
      </div>
      <div className="space-y-1">
        <div className="text-white/50">Last signAndBroadcast</div>
        <div className="break-all text-white/80">
          {lastBroadcast
            ? lastBroadcast.txid
              ? `txid=${lastBroadcast.txid}`
              : lastBroadcast.error
                ? `error=${lastBroadcast.error}`
                : '—'
            : '—'}
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-white/50">Last refresh</div>
        <div className="text-white/80">
          {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : '—'}
        </div>
      </div>
    </div>
  )
}
