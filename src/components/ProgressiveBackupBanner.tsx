import { Link } from 'react-router-dom'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import { WALLET_LIFECYCLE } from '../domain/walletLifecycle'
import { useWallet } from '../context/useWallet'

export default function ProgressiveBackupBanner() {
  const { lifecycle, quickStartRecoveryState, hasCapability } = useWallet()
  if (lifecycle !== WALLET_LIFECYCLE.QUICK_START_UNBACKED) return null
  if (!hasCapability?.(WALLET_CAPABILITY.BACKUP_WALLET)) return null

  return (
    <section className="card backup-progress-banner" aria-labelledby="backup-progress-title">
      <p className="eyebrow">Protege tu Tonalli</p>
      <h2 id="backup-progress-title" className="section-title">
        {quickStartRecoveryState === 'INTERRUPTED_BACKUP'
          ? 'Continúa tu respaldo interrumpido'
          : 'Guarda tu frase de recuperación'}
      </h2>
      <p className="muted">
        {quickStartRecoveryState === 'INTERRUPTED_BACKUP'
          ? 'Tu Tonalli temporal sigue intacta. Usa el PIN del respaldo anterior para terminar la verificación.'
          : 'Ya puedes explorar y recibir. Cuando quieras, protege tu wallet para desbloquear el resto de funciones.'}
      </p>
      <div className="actions">
        <Link className="cta outline" to="/backup">
          {quickStartRecoveryState === 'INTERRUPTED_BACKUP'
            ? 'Continuar respaldo interrumpido'
            : 'Proteger ahora'}
        </Link>
      </div>
    </section>
  )
}
