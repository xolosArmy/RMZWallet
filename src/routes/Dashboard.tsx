import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WsMsgClient } from 'chronik-client'
import { useWallet } from '../context/useWallet'
import TopBar from '../components/TopBar'
import { getChronik } from '../services/ChronikClient'
import { mapChronikTxToRecord } from '../utils/txHistory'
import type { TxRecord } from '../types/tx'

const HISTORY_PAGE_SIZE = 25
const POLL_FAST_MS = 5000
const POLL_MEDIUM_MS = 15000
const POLL_SLOW_MS = 60000
const IDLE_TO_MEDIUM = 6
const IDLE_TO_SLOW = 14
const TONALLI_WINDOW_MS = 24 * 60 * 60 * 1000
const WS_DEBOUNCE_MS = 400
const ENABLE_CHRONIK_WS = (() => {
  const raw = import.meta.env.VITE_ENABLE_CHRONIK_WS
  if (raw === undefined || raw === null || raw === '') return true
  const normalized = String(raw).toLowerCase().trim()
  return normalized !== 'false' && normalized !== '0' && normalized !== 'off'
})()

function Dashboard() {
  const { address, balance, initialized, refreshBalances, rescanWallet, loading, error } = useWallet()
  const [txHistory, setTxHistory] = useState<TxRecord[]>([])
  const [txHistoryLoading, setTxHistoryLoading] = useState(false)
  const [txHistoryError, setTxHistoryError] = useState<string | null>(null)
  const [isRescanning, setIsRescanning] = useState(false)
  const isFetchingRef = useRef(false)
  const mountedRef = useRef(false)
  const txHistoryRef = useRef<TxRecord[]>([])
  const lastSeenHeadRef = useRef<{ txid?: string; length: number; timestampMs: number } | null>(null)
  const idlePollCountRef = useRef(0)
  const currentIntervalRef = useRef(POLL_FAST_MS)
  const pollTimerRef = useRef<number | null>(null)
  const loadHistoryRef = useRef<(() => void) | null>(null)
  const debounceTimerRef = useRef<number | null>(null)
  const wsHealthyRef = useRef(false)

  useEffect(() => {
    if (initialized) {
      refreshBalances()
    }
  }, [initialized, refreshBalances])

  useEffect(() => {
    txHistoryRef.current = txHistory
  }, [txHistory])

  const isVisibleAndOnline = useCallback(() => {
    const isVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
    const isOnline = typeof navigator === 'undefined' || navigator.onLine !== false
    return isVisible && isOnline
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const scheduleNextPoll = useCallback(
    (delayMs?: number) => {
      stopPolling()
      if (!mountedRef.current || !isVisibleAndOnline()) return
      const nextDelay = delayMs ?? currentIntervalRef.current
      pollTimerRef.current = window.setTimeout(() => {
        loadHistoryRef.current?.()
      }, nextDelay)
    },
    [isVisibleAndOnline, stopPolling]
  )

  const setPollingInterval = useCallback(
    (nextInterval: number) => {
      if (currentIntervalRef.current !== nextInterval) {
        currentIntervalRef.current = nextInterval
        scheduleNextPoll(nextInterval)
      }
    },
    [scheduleNextPoll]
  )

  const loadHistory = useCallback(async () => {
    if (!initialized || !address) return
    if (!isVisibleAndOnline()) {
      stopPolling()
      return
    }
    if (isFetchingRef.current) return
    isFetchingRef.current = true
    setTxHistoryLoading(true)
    setTxHistoryError(null)
    try {
      const history = await getChronik().address(address).history(0, HISTORY_PAGE_SIZE)
      const records = history.txs.map(mapChronikTxToRecord)
      const cutoffMs = Date.now() - TONALLI_WINDOW_MS
      const filtered = records.filter((record) => {
        if (record.opReturnApp !== 'tonalli' || !record.opReturnMessage) return false
        if (!record.timestamp) return false
        return record.timestamp * 1000 >= cutoffMs
      })

      if (!mountedRef.current) return

      const latest = filtered[0]
      const latestTimestampMs = latest?.timestamp ? latest.timestamp * 1000 : 0
      const previousHead = lastSeenHeadRef.current
      const hasNewer =
        !!latest &&
        (!previousHead ||
          latest.txid !== previousHead.txid ||
          filtered.length > previousHead.length ||
          latestTimestampMs > previousHead.timestampMs)

      lastSeenHeadRef.current = {
        txid: latest?.txid,
        length: filtered.length,
        timestampMs: latestTimestampMs
      }

      const previous = txHistoryRef.current
      const isSameLength = previous.length === filtered.length
      const sameHead = previous[0]?.txid === latest?.txid
      if (!isSameLength || !sameHead) {
        setTxHistory(filtered)
      }

      if (hasNewer) {
        idlePollCountRef.current = 0
        setPollingInterval(POLL_FAST_MS)
      } else if (!wsHealthyRef.current) {
        idlePollCountRef.current += 1
        if (idlePollCountRef.current >= IDLE_TO_SLOW) {
          setPollingInterval(POLL_SLOW_MS)
        } else if (idlePollCountRef.current >= IDLE_TO_MEDIUM) {
          setPollingInterval(POLL_MEDIUM_MS)
        }
      } else {
        setPollingInterval(POLL_SLOW_MS)
      }
    } catch (err) {
      if (mountedRef.current) {
        const message = (err as Error).message || 'No se pudo cargar el historial.'
        setTxHistoryError(message)
      }
    } finally {
      if (mountedRef.current) {
        setTxHistoryLoading(false)
        scheduleNextPoll()
      }
      isFetchingRef.current = false
    }
  }, [address, initialized, isVisibleAndOnline, scheduleNextPoll, setPollingInterval, stopPolling])

  const handleRescan = useCallback(async () => {
    if (!initialized) return
    setIsRescanning(true)
    try {
      await rescanWallet()
      await loadHistory()
    } catch {
      // errors are surfaced through the wallet alert UI
    } finally {
      setIsRescanning(false)
    }
  }, [initialized, loadHistory, rescanWallet])

  useEffect(() => {
    loadHistoryRef.current = loadHistory
  }, [loadHistory])

  useEffect(() => {
    if (!initialized || !address) return
    mountedRef.current = true
    idlePollCountRef.current = 0
    currentIntervalRef.current = POLL_FAST_MS
    lastSeenHeadRef.current = null
    loadHistory()
    scheduleNextPoll(POLL_FAST_MS)
    return () => {
      mountedRef.current = false
      stopPolling()
    }
  }, [address, initialized, loadHistory, scheduleNextPoll, stopPolling])

  useEffect(() => {
    const handleVisibility = () => {
      if (!mountedRef.current) return
      if (isVisibleAndOnline()) {
        loadHistory()
        scheduleNextPoll(POLL_FAST_MS)
      } else {
        stopPolling()
      }
    }
    window.addEventListener('online', handleVisibility)
    window.addEventListener('offline', handleVisibility)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('online', handleVisibility)
      window.removeEventListener('offline', handleVisibility)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [isVisibleAndOnline, loadHistory, scheduleNextPoll, stopPolling])

  useEffect(() => {
    if (!initialized || !address || !ENABLE_CHRONIK_WS) return
    const chronik = getChronik()
    const ws = chronik.ws({
      onMessage: (msg: WsMsgClient) => {
        if (msg.type !== 'Tx') return
        const isRelevant =
          msg.msgType === 'TX_ADDED_TO_MEMPOOL' ||
          msg.msgType === 'TX_CONFIRMED' ||
          msg.msgType === 'TX_FINALIZED'
        if (!isRelevant) return
        if (debounceTimerRef.current) {
          window.clearTimeout(debounceTimerRef.current)
        }
        debounceTimerRef.current = window.setTimeout(() => {
          debounceTimerRef.current = null
          loadHistoryRef.current?.()
        }, WS_DEBOUNCE_MS)
      },
      onConnect: () => {
        wsHealthyRef.current = true
        idlePollCountRef.current = 0
        setPollingInterval(POLL_SLOW_MS)
      },
      onReconnect: () => {
        wsHealthyRef.current = true
        setPollingInterval(POLL_SLOW_MS)
      },
      onError: () => {
        wsHealthyRef.current = false
        setPollingInterval(POLL_FAST_MS)
      },
      onEnd: () => {
        wsHealthyRef.current = false
        setPollingInterval(POLL_FAST_MS)
      }
    })

    let active = true
    const connect = async () => {
      try {
        await ws.waitForOpen()
        if (!active) return
        ws.subscribeToAddress(address)
      } catch {
        wsHealthyRef.current = false
        setPollingInterval(POLL_FAST_MS)
      }
    }

    connect()

    return () => {
      active = false
      wsHealthyRef.current = false
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      try {
        ws.unsubscribeFromAddress(address)
      } catch {
        // ignore missing subscription during teardown
      }
      ws.close()
    }
  }, [address, initialized, setPollingInterval])

  const formatTxTime = (timestamp: number | null) => {
    if (!timestamp) return 'Fecha no disponible'
    return new Date(timestamp * 1000).toLocaleString()
  }

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">Bienvenido</h1>
        <p className="muted">Configura tu billetera para ver tus saldos.</p>
        <div className="actions">
          <Link className="cta primary" to="/onboarding">
            Ir a onboarding
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Panel principal</p>
          <h1 className="section-title">Guardianía RMZ sobre eCash</h1>
          <p className="muted">
            Saldos, gas y tu dirección protegida en una sola vista. La seed nunca sale de tu dispositivo.
          </p>
        </div>
        <div className="actions">
          <Link className="cta primary" to="/send">
            Enviar RMZ
          </Link>
          <Link className="cta outline" to="/send-xec">
            Enviar XEC
          </Link>
          <Link className="cta outline" to="/dex">
            DEX (Phase 1)
          </Link>
          <Link className="cta outline" to="/receive">
            Recibir
          </Link>
          <Link className="cta outline" to="/scan">
            Escanear QR para recibir RMZ
          </Link>
          <Link className="cta outline" to="/reveal-seed">
            Ver frase seed
          </Link>
        </div>
      </header>

      <div className="grid">
        <div className="card">
          <p className="muted">Balance RMZ</p>
          <h2 style={{ marginTop: 4, fontSize: 32 }}>
            {balance ? `${balance.rmzFormatted} RMZ` : 'Cargando...'}
          </h2>
          <div className="actions">
            <button
              className="cta outline"
              type="button"
              onClick={handleRescan}
              disabled={!initialized || loading || isRescanning}
            >
              {isRescanning ? 'Escaneando...' : 'Escanear'}
            </button>
          </div>
        </div>
        <div className="card">
          <p className="muted">Gas de red (XEC)</p>
          <h3 style={{ marginTop: 4 }}>{balance ? `${balance.xecFormatted} XEC` : 'Cargando...'}</h3>
          <p className="muted">({balance ? `${balance.xec.toString()} sats` : 'sats...'})</p>
        </div>
      </div>

      <div className="card">
        <p className="muted">Dirección eCash</p>
        <div className="address-box">{address}</div>
      </div>

      <div className="card">
        <p className="muted">Historial reciente</p>
        {txHistoryLoading && (
          <p className="muted">{txHistory.length ? 'Actualizando...' : 'Cargando transacciones...'}</p>
        )}
        {txHistoryError && <div className="error">{txHistoryError}</div>}
        {!txHistoryLoading && !txHistoryError && txHistory.length === 0 && (
          <p className="muted">Aún no hay transacciones registradas.</p>
        )}
        <div className="tx-list">
          {txHistory.map((tx) => (
            <div key={tx.txid} className="tx-item">
              <div className="address-box">{tx.txid}</div>
              <p className="muted tx-meta">{formatTxTime(tx.timestamp)}</p>
              {tx.opReturnMessage && (
                <div className="tx-opreturn">
                  <span className="pill pill-ghost">
                    {tx.opReturnApp === 'tonalli' ? 'Mensaje Tonalli' : 'OP_RETURN'}
                  </span>
                  <p className="tx-message">{tx.opReturnMessage}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {loading && <div className="muted">Actualizando saldos...</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

export default Dashboard
