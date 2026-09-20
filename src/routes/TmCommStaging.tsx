import { useEffect, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import {
  verifyAndReconstructAuthChallenge,
  TM_COMM_EXPECTED_SESSION_CONTEXT,
  type TmCommAuthChallengePayload
} from '../features/privateMessaging/authChallenge'
import { xolosWalletService } from '../services/XolosWalletService'
import { tmCommRequest } from './tmCommStagingClient'

type Conversation = {
  id: string
  reservationId: string
  createdAt?: number
}

type Message = {
  id: string
  clientMessageId: string
  body: string
  senderKind: string
  serverCreatedAt: number
  status: string
  replyToId: string | null
}

function TmCommStaging() {
  const { initialized, address } = useWallet()
  const [enrollmentToken, setEnrollmentToken] = useState('')
  const [messageBody, setMessageBody] = useState('Mensaje privado de staging A0')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [authenticatedWalletAddress, setAuthenticatedWalletAddress] = useState<string | null>(null)

  const authenticatedWalletAddressRef = useRef<string | null>(null)
  const prevAddressRef = useRef<string | null | undefined>(undefined)
  const prevInitializedRef = useRef<boolean | undefined>(undefined)

  const sessionGenerationRef = useRef<number>(0)
  const hydrationAbortRef = useRef<AbortController | null>(null)
  const messageAbortRef = useRef<AbortController | null>(null)
  const activeConversationIdRef = useRef<string | null>(null)
  const messageRequestGenRef = useRef<number>(0)

  const setAuthWallet = (addr: string | null) => {
    authenticatedWalletAddressRef.current = addr
    setAuthenticatedWalletAddress(addr)
  }

  const append = (line: string) => {
    setLog((current) => [...current, line])
  }

  const refreshMessages = async (
    conversationId = conversation?.id,
    targetSessionGen = sessionGenerationRef.current,
    signal?: AbortSignal
  ) => {
    if (!initialized || !address || authenticatedWalletAddressRef.current !== address) {
      if (targetSessionGen === sessionGenerationRef.current) {
        append('Se requiere autenticación para la wallet activa.')
      }
      return
    }

    if (!conversationId) {
      if (targetSessionGen === sessionGenerationRef.current) {
        append('No hay conversación autorizada.')
      }
      return
    }

    messageAbortRef.current?.abort()
    const msgAbort = new AbortController()
    messageAbortRef.current = msgAbort

    if (signal) {
      if (signal.aborted) {
        msgAbort.abort()
      } else {
        signal.addEventListener('abort', () => msgAbort.abort(), { once: true })
      }
    }

    const messageReqId = ++messageRequestGenRef.current
    activeConversationIdRef.current = conversationId

    const listed = await tmCommRequest<{ messages: Message[] }>(
      `/v1/tm-comm/conversations/${conversationId}/messages`,
      { signal: msgAbort.signal }
    )

    if (targetSessionGen !== sessionGenerationRef.current) return
    if (activeConversationIdRef.current !== conversationId || messageReqId !== messageRequestGenRef.current) return

    if (!listed.ok) {
      append(`No se pudieron leer mensajes (${listed.status}).`)
      return
    }

    const msgs = Array.isArray(listed.data?.messages) ? listed.data.messages : []
    setMessages(msgs)
    append(`Historial recargado desde el servidor: ${msgs.length} mensaje(s).`)
  }

  const restoreAuthorizedConversations = async (
    targetAddress: string,
    preferredConversationId?: string,
    targetSessionGen = sessionGenerationRef.current,
    signal?: AbortSignal,
    skipIdentityCheck = false
  ) => {
    if (targetSessionGen !== sessionGenerationRef.current) return

    if (!skipIdentityCheck) {
      const meRes = await tmCommRequest<{
        principal?: { id: string; kind: string; walletAddress: string }
      }>('/v1/tm-comm/me', signal ? { signal } : undefined)

      if (targetSessionGen !== sessionGenerationRef.current) return

      if (!meRes.ok) {
        if (targetSessionGen === sessionGenerationRef.current) {
          setAuthWallet(null)
          setConversations([])
          setConversation(null)
          setMessages([])
          activeConversationIdRef.current = null
        }
        return
      }

      const sessionWalletAddress = meRes.data?.principal?.walletAddress
      if (!sessionWalletAddress || sessionWalletAddress !== targetAddress) {
        if (targetSessionGen === sessionGenerationRef.current) {
          setAuthWallet(null)
          setConversations([])
          setConversation(null)
          setMessages([])
          activeConversationIdRef.current = null
          append('Sesión TM-COMM no coincide con la wallet activa. Se requiere reautenticación.')
        }
        return
      }
    }

    setAuthWallet(targetAddress)

    const listed = await tmCommRequest<{ conversations: Conversation[] }>(
      '/v1/tm-comm/conversations',
      signal ? { signal } : undefined
    )

    if (targetSessionGen !== sessionGenerationRef.current) return

    if (!listed.ok) {
      if (listed.status === 401) {
        if (targetSessionGen === sessionGenerationRef.current) {
          setAuthWallet(null)
          setConversations([])
          setConversation(null)
          setMessages([])
          activeConversationIdRef.current = null
        }
      }
      return
    }

    const list = listed.data?.conversations ?? []
    setConversations(list)

    if (list.length === 0) {
      setConversation(null)
      setMessages([])
      activeConversationIdRef.current = null
      return
    }

    const sorted = [...list].sort((a, b) => {
      const timeA = a.createdAt ?? 0
      const timeB = b.createdAt ?? 0
      if (timeB !== timeA) return timeB - timeA
      return b.id.localeCompare(a.id)
    })

    const target = (preferredConversationId ? sorted.find((c) => c.id === preferredConversationId) : undefined)
      ?? (conversation?.id ? sorted.find((c) => c.id === conversation.id) : undefined)
      ?? sorted[0]

    if (targetSessionGen !== sessionGenerationRef.current) return

    if (conversation?.id !== target.id) {
      setMessages([])
    }
    setConversation(target)
    activeConversationIdRef.current = target.id
    append(`Conversación activa: ${target.id} (${target.reservationId}).`)

    await refreshMessages(target.id, targetSessionGen, signal)
  }

  useEffect(() => {
    const prevAddr = prevAddressRef.current
    const prevInit = prevInitializedRef.current
    const addressChanged = address !== prevAddr

    prevAddressRef.current = address
    prevInitializedRef.current = initialized

    // Abort in-flight operations
    hydrationAbortRef.current?.abort()
    messageAbortRef.current?.abort()

    // Increment generations to invalidate any pending promises
    const nextGen = ++sessionGenerationRef.current
    messageRequestGenRef.current++

    // Clean state immediately
    setConversations([])
    setConversation(null)
    setMessages([])
    activeConversationIdRef.current = null
    setAuthWallet(null)

    if (!initialized || !address) {
      if (prevInit) {
        append('Wallet desinicializada o bloqueada. Estado de TM-COMM purgado.')
      }
      return
    }

    if (addressChanged && prevAddr !== undefined) {
      append(`Wallet activa cambió a ${address}. Se requiere autenticación para esta wallet.`)
    }

    const hydrationAbort = new AbortController()
    hydrationAbortRef.current = hydrationAbort

    void restoreAuthorizedConversations(address, undefined, nextGen, hydrationAbort.signal, false)

    return () => {
      hydrationAbort.abort()
      messageAbortRef.current?.abort()
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sessionGenerationRef.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, initialized])

  const authenticate = async () => {
    if (!initialized || !address) {
      append('La wallet debe estar desbloqueada en staging.')
      return
    }
    const publicKeyHex = xolosWalletService.getPublicKeyHex()
    if (!publicKeyHex) {
      append('No se pudo leer la clave pública.')
      return
    }

    hydrationAbortRef.current?.abort()
    messageAbortRef.current?.abort()
    messageRequestGenRef.current++
    const nextGen = ++sessionGenerationRef.current
    const sessionAbort = new AbortController()
    hydrationAbortRef.current = sessionAbort

    setConversation(null)
    setConversations([])
    setMessages([])
    activeConversationIdRef.current = null
    setAuthWallet(null)

    setBusy(true)
    try {
      const challenge = await tmCommRequest<TmCommAuthChallengePayload>('/v1/tm-comm/challenges', {
        method: 'POST',
        signal: sessionAbort.signal
      })

      if (nextGen !== sessionGenerationRef.current) return

      if (!challenge.ok || !challenge.data) {
        append(`Challenge rechazado (${challenge.status}).`)
        return
      }

      const clientOrigin = typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
        ? window.location.origin
        : 'http://127.0.0.1:5174'

      let verified: { canonicalMessage: string; challengeId: string }
      try {
        verified = verifyAndReconstructAuthChallenge(challenge.data, {
          expectedOrigin: clientOrigin,
          expectedSessionContext: TM_COMM_EXPECTED_SESSION_CONTEXT
        })
      } catch (validationError) {
        if (nextGen !== sessionGenerationRef.current) return
        append(
          `Challenge inválido o manipulado: ${
            validationError instanceof Error ? validationError.message : 'FAIL_CLOSED'
          }`
        )
        return
      }

      const signature = await xolosWalletService.signMessage(verified.canonicalMessage)
      if (nextGen !== sessionGenerationRef.current) return

      const session = await tmCommRequest<{
        principal?: { id: string; kind: string; walletAddress: string }
      }>('/v1/tm-comm/sessions', {
        method: 'POST',
        signal: sessionAbort.signal,
        body: JSON.stringify({
          challengeId: verified.challengeId,
          address,
          publicKeyHex,
          signature
        })
      })

      if (nextGen !== sessionGenerationRef.current) return

      if (session.ok) {
        setAuthWallet(address)
        append('Sesión TM-COMM creada. La clave privada no salió de Tonalli.')
        await restoreAuthorizedConversations(address, undefined, nextGen, sessionAbort.signal, true)
      } else {
        setAuthWallet(null)
        append(`Sesión rechazada (${session.status}).`)
      }
    } finally {
      if (nextGen === sessionGenerationRef.current) {
        setBusy(false)
      }
    }
  }

  const bind = async () => {
    if (!initialized || !address || authenticatedWalletAddressRef.current !== address) {
      append('Se requiere autenticación para la wallet activa antes de enlazar un expediente.')
      return
    }
    const currentGen = sessionGenerationRef.current
    setBusy(true)
    try {
      const result = await tmCommRequest<{ conversation: Conversation }>('/v1/tm-comm/bindings', {
        method: 'POST',
        body: JSON.stringify({ enrollmentToken })
      })
      if (currentGen !== sessionGenerationRef.current) return
      if (!result.ok) {
        append(`Binding rechazado (${result.status}). Una dirección conocida no basta.`)
        return
      }
      append(`Reserva ficticia vinculada: ${result.data.conversation.reservationId}`)
      await restoreAuthorizedConversations(address, result.data.conversation.id, currentGen, undefined, true)
    } finally {
      if (currentGen === sessionGenerationRef.current) {
        setBusy(false)
      }
    }
  }

  const send = async () => {
    if (!initialized || !address || authenticatedWalletAddressRef.current !== address) {
      append('Se requiere autenticación para la wallet activa antes de enviar.')
      return
    }
    if (!conversation) {
      append('Enlaza una reserva antes de enviar.')
      return
    }
    const currentGen = sessionGenerationRef.current
    const targetConversationId = conversation.id
    setBusy(true)
    try {
      const sent = await tmCommRequest<Message>(
        `/v1/tm-comm/conversations/${targetConversationId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            clientMessageId: `ui-${crypto.randomUUID()}`,
            body: messageBody
          })
        }
      )
      if (currentGen !== sessionGenerationRef.current) return
      if (!sent.ok) {
        append(`Envío rechazado (${sent.status}).`)
        return
      }
      append(`Mensaje aceptado con id de servidor ${sent.data.id}.`)
      await refreshMessages(targetConversationId, currentGen)
    } finally {
      if (currentGen === sessionGenerationRef.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">TM-COMM A0</p>
          <h1 className="section-title">Staging de mensajería privada</h1>
          <p className="muted">
            Harness de arquitectura. No es un chat de producción. No usa reservas, clientes ni fondos reales.
            El registro canónico vive en SQLite de staging, no en el navegador.
          </p>
        </div>
      </header>

      <div className="card">
        <h2>1. Autenticar con firma de challenge</h2>
        <p className="muted">Wallet: {address ?? 'no desbloqueada'}</p>
        <p className="muted">
          Sesión TM-COMM:{' '}
          {authenticatedWalletAddress === address && address ? `autenticada (${address})` : 'no autenticada'}
        </p>
        <button
          className="cta"
          type="button"
          onClick={() => void authenticate()}
          disabled={busy || !initialized || !address}
        >
          Firmar challenge TM-COMM
        </button>
      </div>

      <div className="card">
        <h2>2. Enlazar expediente ficticio</h2>
        <input
          value={enrollmentToken}
          onChange={(event) => setEnrollmentToken(event.target.value)}
          placeholder="Token de enrolamiento de Xolos Ramírez"
          aria-label="Token de enrolamiento"
          disabled={busy || !initialized || !address || authenticatedWalletAddress !== address}
        />
        <button
          className="cta outline"
          type="button"
          onClick={() => void bind()}
          disabled={busy || !initialized || !address || authenticatedWalletAddress !== address}
        >
          Consumir invitación
        </button>
      </div>

      <div className="card">
        <h2>3. Mensaje durable</h2>
        {conversations.length > 1 && (
          <div style={{ marginBottom: '1rem' }}>
            <label
              htmlFor="conversation-select"
              style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem' }}
            >
              Seleccionar conversación:
            </label>
            <select
              id="conversation-select"
              aria-label="Seleccionar conversación"
              value={conversation?.id ?? ''}
              onChange={(e) => {
                const targetId = e.target.value
                const selected = conversations.find((c) => c.id === targetId) ?? null

                // Invalida cualquier request de historial anterior
                messageAbortRef.current?.abort()
                messageRequestGenRef.current++

                // Ejecuta setMessages([]) sincrónicamente antes de cambiar/renderizar la nueva conversación
                setMessages([])

                // Actualiza activeConversationIdRef
                activeConversationIdRef.current = selected?.id ?? null

                // Cambiar/renderizar la nueva conversación
                setConversation(selected)

                // Inicia el fetch del nuevo historial; si el fetch falla o tarda, la UI permanece vacía
                if (selected) {
                  void refreshMessages(selected.id, sessionGenerationRef.current)
                }
              }}
              disabled={busy || !initialized || !address || authenticatedWalletAddress !== address}
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} ({c.reservationId})
                </option>
              ))}
            </select>
          </div>
        )}
        <p className="muted">
          Conversación: {conversation?.id ?? 'ninguna'} · Reserva: {conversation?.reservationId ?? '—'}
        </p>
        <textarea
          value={messageBody}
          onChange={(event) => setMessageBody(event.target.value)}
          rows={3}
          aria-label="Cuerpo del mensaje"
          disabled={busy || !initialized || !address || authenticatedWalletAddress !== address}
        />
        <div className="actions">
          <button
            className="cta"
            type="button"
            onClick={() => void send()}
            disabled={busy || !initialized || !address || authenticatedWalletAddress !== address}
          >
            Enviar al servidor
          </button>
          <button
            className="cta ghost"
            type="button"
            onClick={() => void refreshMessages(conversation?.id, sessionGenerationRef.current)}
            disabled={busy || !initialized || !address || authenticatedWalletAddress !== address}
          >
            Recargar historial
          </button>
        </div>
        <ul>
          {messages.map((message) => (
            <li key={message.id}>
              <strong>{message.id}</strong> · {message.status} · {message.body}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Registro local de evidencia</h2>
        <p className="muted">Esto no es el log canónico. Solo ayuda a demostrar el harness.</p>
        <pre>{log.join('\n') || 'Sin eventos todavía.'}</pre>
      </div>
    </div>
  )
}

export default TmCommStaging
