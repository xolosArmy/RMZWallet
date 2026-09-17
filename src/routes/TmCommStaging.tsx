import { useState } from 'react'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { xolosWalletService } from '../services/XolosWalletService'
import { tmCommRequest } from './tmCommStagingClient'

type ChallengeResponse = {
  challengeId: string
  canonicalMessage: string
  nonce: string
  expiresAt: number
  audience: string
  origin: string
}

type Conversation = {
  id: string
  reservationId: string
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
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const append = (line: string) => {
    setLog((current) => [...current, line])
  }

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
      const challenge = await tmCommRequest<ChallengeResponse>('/v1/tm-comm/challenges', {
        method: 'POST'
      })
      if (!challenge.ok) {
        append(`Challenge rechazado (${challenge.status}).`)
        return
      }
      const signature = await xolosWalletService.signMessage(challenge.data.canonicalMessage)
      const session = await tmCommRequest('/v1/tm-comm/sessions', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: challenge.data.challengeId,
          address,
          publicKeyHex,
          signature
        })
      })
      append(session.ok
        ? 'Sesión TM-COMM creada. La clave privada no salió de Tonalli.'
        : `Sesión rechazada (${session.status}).`)
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
      setConversation(result.data.conversation)
      append(`Reserva ficticia vinculada: ${result.data.conversation.reservationId}`)
    } finally {
      setBusy(false)
    }
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
