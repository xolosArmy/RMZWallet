import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Html5Qrcode } from 'html5-qrcode'
import TopBar from '../components/TopBar'

export function ScanQR() {
  const [scannedAddress, setScannedAddress] = useState<string>('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isScanning, setIsScanning] = useState<boolean>(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  const shareSupported = useMemo(() => typeof navigator !== 'undefined' && !!navigator.share, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const qr = new Html5Qrcode('qr-reader')
    scannerRef.current = qr
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCameraError(null)
    setIsScanning(true)
    setStatusMessage('Activando cámara... apunta al código de guardianía.')

    qr
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
          setIsScanning(false)
          try {
            await qr.stop()
          } catch {
            // ignorar errores de stop, incluido "Cannot stop, scanner is not running or paused"
          }
          const text = decodedText.trim()

          const [mainPart] = text.split('?')

          let withoutPrefix = mainPart
          while (withoutPrefix.toLowerCase().startsWith('ecash:')) {
            withoutPrefix = withoutPrefix.slice('ecash:'.length)
          }

          if (!withoutPrefix) {
            setCameraError('No se pudo leer una dirección eCash válida.')
            setStatusMessage('No se reconoció una dirección eCash. Intenta de nuevo.')
            return
          }

          const normalized = `ecash:${withoutPrefix}`

          setScannedAddress(normalized)
          setCameraError(null)
          setStatusMessage('Código capturado. Dirección lista para usar.')
        },
        () => {
          // Silenciar errores intermitentes mientras el usuario enfoca el QR.
        }
      )
      .catch((err) => {
        const message = (err as Error).message || 'No se pudo iniciar la cámara para el escaneo.'
        setStatusMessage(message)
        setCameraError('No se pudo acceder a la cámara. Revisa permisos del navegador.')
        setIsScanning(false)
      })

    return () => {
      const scanner = scannerRef.current
      if (!scanner) return

      ;(async () => {
        try {
          await scanner.stop()
          try {
            await scanner.clear()
          } catch {
            // ignorar errores de clear
          }
        } catch {
          // ignorar "Cannot stop, scanner is not running or paused" y cualquier otro error
        }
      })()
    }
  }, [])

  const handleCopy = async () => {
    if (!scannedAddress) return
    try {
      await navigator.clipboard.writeText(scannedAddress)
      setStatusMessage('Dirección copiada al portapapeles.')
    } catch {
      setStatusMessage('No pudimos copiar la dirección. Intenta manualmente.')
    }
  }

  const handleShare = async () => {
    if (!scannedAddress || !navigator.share) return
    try {
      await navigator.share({
        title: 'Dirección RMZWallet',
        text: `Recibe RMZ/XEC en: ${scannedAddress}`
      })
      setStatusMessage('Dirección compartida.')
    } catch {
      setStatusMessage('El compartir fue cancelado o no se pudo completar.')
    }
  }

  return (
    <div className="page">
      <TopBar />

      <header className="section-header">
        <div>
          <p className="eyebrow">Escáner QR</p>
          <h1 className="section-title">Escanear código QR</h1>
          <p className="muted">
            Apunta tu cámara al código QR que contiene una dirección eCash. Guardianía digital dentro de tu templo
            seguro.
          </p>
        </div>
        <div className="actions">
          <Link className="cta ghost" to="/">
            Cancelar
          </Link>
        </div>
      </header>

      <div className="card">
        <p className="muted">
          Usa la cámara trasera para mayor nitidez. Mantén el recuadro centrado mientras la app descifra la dirección.
        </p>
        <div
          style={{
            marginTop: 12,
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
            padding: 12,
            background: 'rgba(15,23,42,0.6)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)'
          }}
        >
          <div
            id="qr-reader"
            style={{ width: '100%', maxWidth: 400, height: 300, margin: '0 auto' }}
          />
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <span className="pill">{isScanning ? 'Escaneando...' : 'Cámara lista'}</span>
        </div>
      </div>

      {scannedAddress && (
        <div className="card">
          <p className="muted">Dirección escaneada:</p>
          <div className="address-box">{scannedAddress}</div>
          <div className="actions">
            <button className="cta primary" type="button" onClick={handleCopy}>
              Copiar dirección
            </button>
            <button className="cta outline" type="button" onClick={handleShare} disabled={!shareSupported}>
              {shareSupported ? 'Compartir' : 'Compartir no disponible'}
            </button>
            <Link className="cta ghost" to="/receive">
              Ver en Recibir
            </Link>
          </div>
        </div>
      )}

      {cameraError && <div className="error">{cameraError}</div>}
      {statusMessage && <div className="muted">{statusMessage}</div>}
    </div>
  )
}

export default ScanQR
