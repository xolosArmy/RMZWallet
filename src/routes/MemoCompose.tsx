import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import TonalliMemoComposer from '../components/tonalliMemo/TonalliMemoComposer'
import {
  ChronikNetworkTransport,
  WalletSigner,
  createWalletPublisherExecutor,
  Tm1ProductionRecoveryStore
} from '../components/tonalliMemo/walletPublisherExecutor'
import type { Tm1PublisherExecutor } from '../components/tonalliMemo/types'
import type { Tm1PublicationRecoveryStore } from '../integrations/tonalliMemo/recovery/tm1PublicationRecoveryStore'
import { getChronik } from '../services/ChronikClient'

export interface MemoComposeProps {
  executor?: Tm1PublisherExecutor
  recoveryStore?: Tm1PublicationRecoveryStore
}

export function MemoCompose({
  executor: customExecutor,
  recoveryStore: customRecoveryStore
}: MemoComposeProps = {}) {
  const { address, alias } = useWallet()

  const productionRecoveryStore = useMemo(() => {
    return customRecoveryStore ?? new Tm1ProductionRecoveryStore({ address })
  }, [address, customRecoveryStore])

  const productionExecutor = useMemo(() => {
    const chronik = getChronik()
    const transport = new ChronikNetworkTransport({ chronik })
    const signer = new WalletSigner({ address, chronik })
    return createWalletPublisherExecutor({
      transport,
      signer,
      recoveryStore: productionRecoveryStore
    })
  }, [address, productionRecoveryStore])

  const executor = customExecutor ?? productionExecutor
  const effectiveRecoveryStore =
    customRecoveryStore ??
    (customExecutor as any)?.recoveryStore ??
    productionRecoveryStore

  return (
    <div className="page memo-compose-page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Memo</p>
          <h1 className="section-title">Componer y Publicar Memo TM1</h1>
          <p className="muted">
            Creación oficial y publicación en cadena de Tonalli Memos verificados mediante consenso de titularidad.
          </p>
        </div>
        <div className="quick-actions" aria-label="Acciones de composición de Memo">
          <Link className="cta outline" to="/memo">
            Volver al feed
          </Link>
          <Link className="cta outline" to="/memo/draft/tm1">
            Vista previa borrador
          </Link>
        </div>
      </header>

      {!alias ? (
        <div className="card memo-no-alias-state" data-testid="memo-no-alias-state">
          <div className="state-badge warning">Sin Alias Configurado</div>
          <h2 className="card-title">Se requiere un alias .xec activo</h2>
          <p className="muted">
            Para componer y publicar Tonalli Memos en la red eCash, tu billetera debe tener un alias .xec registrado y verificado.
          </p>
          <div className="action-buttons" style={{ marginTop: '1.5rem' }}>
            <Link to="/register-alias" className="cta primary" data-testid="register-alias-cta">
              Registrar o vincular alias .xec
            </Link>
          </div>
        </div>
      ) : (
        <TonalliMemoComposer
          key={`${address || 'no-address'}-${alias}`}
          initialOwnerAddress={address || undefined}
          initialAlias={alias}
          executor={executor}
          recoveryStore={effectiveRecoveryStore}
        />
      )}
    </div>
  )
}

export default MemoCompose
