import { useEffect, useState } from 'react'

interface SensitiveSeedPhraseProps {
  mnemonic: string
  className?: string
  revealDurationMs?: number
}

function SensitiveSeedPhrase({
  mnemonic,
  className = 'seed-box',
  revealDurationMs = 10_000,
}: SensitiveSeedPhraseProps) {
  const [revealSession, setRevealSession] = useState<{
    mnemonic: string
    revealDurationMs: number
    deadline: number | null
  }>({
    mnemonic: '',
    revealDurationMs,
    deadline: null,
  })
  const [now, setNow] = useState(() => Date.now())

  const revealDeadline = revealSession.deadline
  const isCurrentRevealSession =
    revealDeadline !== null &&
    revealSession.mnemonic === mnemonic &&
    revealSession.revealDurationMs === revealDurationMs
  const remainingMs = isCurrentRevealSession ? Math.max(0, revealDeadline - now) : revealDurationMs
  const isRevealed = isCurrentRevealSession && remainingMs > 0
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000))

  useEffect(() => {
    if (!isCurrentRevealSession) {
      return
    }

    const hideTimer = window.setTimeout(() => {
      setNow(Date.now())
    }, Math.max(0, revealDeadline - Date.now()))

    const countdownTimer = window.setInterval(() => {
      setNow(Date.now())
    }, 250)

    return () => {
      window.clearTimeout(hideTimer)
      window.clearInterval(countdownTimer)
    }
  }, [isCurrentRevealSession, revealDeadline])

  const handleReveal = () => {
    const startedAt = Date.now()
    setNow(startedAt)
    setRevealSession({
      mnemonic,
      revealDurationMs,
      deadline: startedAt + revealDurationMs,
    })
  }

  return (
    <div className={`sensitive-seed ${isRevealed ? 'is-revealed' : 'is-hidden'}`}>
      <div className={`${className} sensitive-seed__content`}>{mnemonic}</div>
      {!isRevealed ? (
        <button className="cta sensitive-seed__overlay" type="button" onClick={handleReveal}>
          Haz clic para revelar la frase
        </button>
      ) : (
        <button
          className="cta outline sensitive-seed__hide"
          type="button"
          onClick={() =>
            setRevealSession((currentSession) => ({
              ...currentSession,
              deadline: null,
            }))
          }
        >
          Ocultar ahora ({remainingSeconds}s)
        </button>
      )}
    </div>
  )
}

export default SensitiveSeedPhrase
