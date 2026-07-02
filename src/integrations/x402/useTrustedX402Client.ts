import { useMemo } from 'react'
import { useTonalliX402ApprovalHandler } from '../../context/useTonalliX402ApprovalHandler'
import { xolosWalletService } from '../../services/XolosWalletService'
import {
  TonalliBrowserWalletAdapter,
  type TonalliX402Wallet
} from './TonalliBrowserWalletAdapter'
import {
  createTrustedX402Client,
  type CreateTrustedX402ClientOptions
} from './createTrustedX402Client'

export type UseTrustedX402ClientOptions = Omit<
  CreateTrustedX402ClientOptions,
  'walletAdapter'
>

export function useTrustedX402Client(options: UseTrustedX402ClientOptions) {
  const requestApproval = useTonalliX402ApprovalHandler()

  return useMemo(() => {
    const walletAdapter = new TonalliBrowserWalletAdapter({
      walletService: xolosWalletService as TonalliX402Wallet,
      approvalHandler: requestApproval
    })
    return createTrustedX402Client({ ...options, walletAdapter })
  }, [options, requestApproval])
}

