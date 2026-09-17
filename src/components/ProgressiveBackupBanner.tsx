import { Link } from 'react-router-dom'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { useWallet } from '../context/useWallet'

export default function ProgressiveBackupBanner() {
  const { lifecycle, hasCapability } = useWallet()
  if (lifecycle !== WALLET_LIFECYCLE.QUICK_START_UNBACKED) return null
  if (!hasCapability?.(WALLET_CAPABILITY.BACKUP_WALLET)) return null

  return (
    <section className="card backup-progress-banner" aria-labelledby="backup-progress-title">
      <p className="eyebrow">Protege tu Tonalli</p>
      <h2 id="backup-progress-title" className="section-title">Guarda tu frase de recuperación</h2>
      <p className="muted">
        Ya puedes explorar y recibir. Cuando quieras, protege tu wallet para desbloquear el resto de funciones.
      </p>
      <div className="actions">
        <Link className="cta outline" to="/backup">
          Proteger ahora
        </Link>
      </div>
    </section>
  )
}
