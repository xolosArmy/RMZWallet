import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { QRCodeCanvas } from 'qrcode.react'
import { useWallet } from '../context/useWallet'
import TopBar from '../components/TopBar'

function Receive() {
  const { address, initialized } = useWallet()
  const [amount, setAmount] = useState<string>('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const qrValue = useMemo(() => {
    if (!address) return ''
    const normalizedAddress = address.startsWith('ecash:') ? address.slice('ecash:'.length) : address
    const base = `ecash:${normalizedAddress}`
    return amount && amount.trim() !== '' ? `${base}?amount=${amount.trim()}` : base
  }, [address, amount])

  const copyAddress = async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setStatusMessage('Dirección copiada.')
    } catch {
      setStatusMessage('No pudimos copiar la dirección en este dispositivo.')
    }
  }

  const downloadQR = () => {
    const canvas = document.getElementById('address-qr') as HTMLCanvasElement | null
    if (!canvas) {
      setStatusMessage('No encontramos el QR para descargar.')
      return
    }
    const imageData = canvas.toDataURL('image/png')
    const link = document.createElement('a')
    link.href = imageData
    link.download = 'RMZWallet_QR.png'
    link.click()
    setStatusMessage('QR descargado en tu dispositivo.')
  }

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">Configura tu billetera</h1>
        <p className="muted">Ve al onboarding para generar o desbloquear tu seed.</p>
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
          <p className="eyebrow">Recibir</p>
          <h1 className="section-title">Comparte tu dirección eCash</h1>
          <p className="muted">Recibe RMZ y XEC en la misma dirección cifrada en tu dispositivo.</p>
        </div>
        <div className="actions">
          <Link className="cta outline" to="/scan">
            Escanear QR
          </Link>
        </div>
      </header>

      <div className="card">
        <p className="muted">Puedes recibir RMZ y XEC en la misma dirección.</p>
        <label htmlFor="amount">Monto opcional a solicitar (RMZ):</label>
        <input
          id="amount"
          type="number"
          step="0.000001"
          placeholder="Ingresa cantidad (opcional)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div style={{ textAlign: 'center', margin: '16px 0' }}>
          {address ? (
            <QRCodeCanvas
              id="address-qr"
              value={qrValue}
              size={180}
              bgColor="#0f172a"
              fgColor="#f97316"
              level="H"
            />
          ) : (
            'Generando QR...'
          )}
        </div>
        <div className="address-box">{address}</div>
        <div className="actions">
          <button className="cta primary" type="button" onClick={copyAddress} disabled={!address}>
            Copiar dirección
          </button>
          <button className="cta outline" type="button" onClick={downloadQR} disabled={!address}>
            Descargar QR
          </button>
        </div>
      </div>

      {statusMessage && <div className="muted">{statusMessage}</div>}
    </div>
  )
}

export default Receive
