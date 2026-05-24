import { useEffect, useMemo, useRef, useState } from 'react'

type SensitiveSeedPhraseProps = {
  mnemonic: string
  blurPx?: number
  autoHideMs?: number
  className?: string
}

export default function SensitiveSeedPhrase({
  mnemonic,
  blurPx = 6,
  autoHideMs = 10_000,
  className
}: SensitiveSeedPhraseProps) {
  const deadlineRef = useRef<number | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (deadlineRef.current !== null) {
        setClock(Date.now())
      }
    }, 250)

    return () => window.clearInterval(interval)
  }, [])

  const remainingMs = deadline === null ? 0 : Math.max(0, deadline - clock)
  const revealed = remainingMs > 0
  const remainingSeconds = Math.ceil(remainingMs / 1000)

  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic])

  const handleReveal = () => {
    const nextDeadline = Date.now() + autoHideMs
    deadlineRef.current = nextDeadline
    setDeadline(nextDeadline)
    setClock(Date.now())
  }

  const handleHide = () => {
    deadlineRef.current = null
    setDeadline(null)
    setClock(Date.now())
  }

  return (
    <div className={className} style={{ display: 'grid', gap: 12 }}>
      <div
        className="seed-box"
        aria-live="polite"
        style={{
          filter: revealed ? 'none' : `blur(${blurPx}px)`,
          transition: 'filter 120ms ease',
          userSelect: revealed ? 'text' : 'none'
        }}
      >
        {words.map((word, index) => `${index + 1}. ${word}`).join('   ')}
      </div>
      <div className="actions" style={{ alignItems: 'center' }}>
        <button className="cta outline" type="button" onClick={revealed ? handleHide : handleReveal}>
          {revealed ? 'Ocultar ahora' : 'Mostrar 10 segundos'}
        </button>
        <span className="muted">{revealed ? `Se oculta en ${remainingSeconds}s.` : 'Frase protegida por desenfoque.'}</span>
      </div>
    </div>
  )
}
