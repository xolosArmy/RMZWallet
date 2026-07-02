import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import TonalliPaymentApprovalModal from '../components/x402/TonalliPaymentApprovalModal'
import { TonalliX402ApprovalController } from '../integrations/x402/TonalliX402ApprovalController'
import { TonalliX402ApprovalContext } from './useTonalliX402ApprovalHandler'


export function TonalliX402ApprovalProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new TonalliX402ApprovalController())
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => () => controller.dispose(), [controller])

  return (
    <TonalliX402ApprovalContext.Provider value={{ requestApproval: controller.requestApproval }}>
      {children}
      {state.pending && (
        <TonalliPaymentApprovalModal
          request={state.pending}
          onApprove={controller.approve}
          onReject={controller.reject}
          onCancel={controller.cancel}
        />
      )}
    </TonalliX402ApprovalContext.Provider>
  )
}
