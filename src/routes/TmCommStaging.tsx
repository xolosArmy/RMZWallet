import { useEffect, useState } from 'react'
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

  const append = (line: string) => {
    setLog((current) => [...current, line])
  }

  const refreshMessages = async (conversationId = conversation?.id) => {
    if (!conversationId) {
      append('No hay conversación autorizada.')
      return
    }
    const listed = await tmCommRequest<{ messages: Message[] }>(
      `/v1/tm-comm/conversations/${conversationId}/messages`
    )
    if (!listed.ok) {
      append(`No se pudieron leer mensajes (${listed.status}).`)
      return
    }
    setMessages(listed.data.messages)
    append(`Historial recargado desde el servidor: ${listed.data.messages.length} mensaje(s).`)
  }

  const restoreAuthorizedConversations = async (preferredConversationId?: string) => {
    const listed = await tmCommRequest<{ conversations: Conversation[] }>('/v1/tm-comm/conversations')
    if (!listed.ok) {
      if (listed.status === 401) {
        setConversations([])
        setConversation(null)
        setMessages([])
      }
      return
    }
    const list = listed.data.conversations ?? []
    setConversations(list)
    if (list.length === 0) {
      setConversation(null)
      setMessages([])
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

    setConversation(target)
    append(`Conversación activa: ${target.id} (${target.reservationId}).`)
    await refreshMessages(target.id)
  }

  useEffect(() => {
    let active = true
    async function hydrateConversationsOnMount() {
      const listed = await tmCommRequest<{ conversations: Conversation[] }>('/v1/tm-comm/conversations')
      if (!active) return
      if (!listed.ok) {
        if (listed.status === 401) {
          setConversations([])
          setConversation(null)
          setMessages([])
        }
        return
      }
      const list = listed.data.conversations ?? []
      setConversations(list)
      if (list.length === 0) {
        setConversation(null)
        setMessages([])
        return
      }
      const sorted = [...list].sort((a, b) => {
        const timeA = a.createdAt ?? 0
        const timeB = b.createdAt ?? 0
        if (timeB !== timeA) return timeB - timeA
        return b.id.localeCompare(a.id)
      })
      const target = sorted[0]
      setConversation(target)
      setLog((current) => [...current, `Conversación activa: ${target.id} (${target.reservationId}).`])
      const msgRes = await tmCommRequest<{ messages: Message[] }>(
        `/v1/tm-comm/conversations/${target.id}/messages`
      )
      if (!active) return
      if (msgRes.ok) {
        setMessages(msgRes.data.messages)
        setLog((current) => [
          ...current,
          `Historial recargado desde el servidor: ${msgRes.data.messages.length} mensaje(s).`
        ])
      }
    }
    void hydrateConversationsOnMount()
    return () => {
      active = false
    }
  }, [])

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
    setBusy(true)
    try {
      const challenge = await tmCommRequest<TmCommAuthChallengePayload>('/v1/tm-comm/challenges', {
        method: 'POST'
      })
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
        append(
          `Challenge inválido o manipulado: ${
            validationError instanceof Error ? validationError.message : 'FAIL_CLOSED'
          }`
        )
        return
      }

      const signature = await xolosWalletService.signMessage(verified.canonicalMessage)
      const session = await tmCommRequest('/v1/tm-comm/sessions', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: verified.challengeId,
          address,
          publicKeyHex,
          signature
        })
      })
      if (session.ok) {
        append('Sesión TM-COMM creada. La clave privada no salió de Tonalli.')
        await restoreAuthorizedConversations()
      } else {
        append(`Sesión rechazada (${session.status}).`)
      }
    } finally {
      setBusy(false)
    }
  }

  const bind = async () => {
    setBusy(true)
    try {
      const result = await tmCommRequest<{ conversation: Conversation }>('/v1/tm-comm/bindings', {
        method: 'POST',
        body: JSON.stringify({ enrollmentToken })
      })
      if (!result.ok) {
        append(`Binding rechazado (${result.status}). Una dirección conocida no basta.`)
        return
      }
      append(`Reserva ficticia vinculada: ${result.data.conversation.reservationId}`)
      await restoreAuthorizedConversations(result.data.conversation.id)
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!conversation) {
      append('Enlaza una reserva antes de enviar.')
      return
    }
    setBusy(true)
    try {
      const sent = await tmCommRequest<Message>(
        `/v1/tm-comm/conversations/${conversation.id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            clientMessageId: `ui-${crypto.randomUUID()}`,
            body: messageBody
          })
        }
      )
      if (!sent.ok) {
        append(`Envío rechazado (${sent.status}).`)
        return
      }
      append(`Mensaje aceptado con id de servidor ${sent.data.id}.`)
      await refreshMessages(conversation.id)
    } finally {
      setBusy(false)
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
        <button className="cta" type="button" onClick={() => void authenticate()} disabled={busy}>
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
        />
        <button className="cta outline" type="button" onClick={() => void bind()} disabled={busy}>
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
                const selected = conversations.find((c) => c.id === e.target.value) ?? null
                setConversation(selected)
                if (selected) {
                  void refreshMessages(selected.id)
                }
              }}
              disabled={busy}
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
        />
        <div className="actions">
          <button className="cta" type="button" onClick={() => void send()} disabled={busy}>
            Enviar al servidor
          </button>
          <button className="cta ghost" type="button" onClick={() => void refreshMessages()} disabled={busy}>
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
