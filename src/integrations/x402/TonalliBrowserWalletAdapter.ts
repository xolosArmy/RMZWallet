import type { Invoice } from '@x402-xec/core'
import type {
  BrowserWalletAdapter,
  PaymentPlan,
  WalletActiveAccountResponse,
  WalletApprovalRequest,
  WalletApprovalResponse,
  WalletSigningRequest,
  WalletSigningResponse,
  WalletTransactionSigningRequest,
  WalletTransactionSigningResponse
} from '@x402-xec/payments'

const DISABLED_REASON = 'X402 integration is disabled'
const APPROVAL_REQUIRED_REASON = 'X402 authorization requires explicit approval'
const WALLET_UNAVAILABLE_REASON = 'X402 wallet account is unavailable'
const SIGNING_FAILED_REASON = 'X402 authorization signing failed'
const TRANSACTION_SIGNING_UNSUPPORTED_REASON = 'X402 transaction signing is unsupported'

export interface TonalliX402Wallet {
  getX402ActiveAccount(): {
    address: string
    publicKey: string
  } | null
  signX402AuthorizationMessage(message: string): Promise<{
    signature: string
    publicKey: string
  }>
}

export type TonalliX402ApprovalHandler = (
  request: Readonly<WalletApprovalRequest>
) => WalletApprovalResponse | Promise<WalletApprovalResponse>

export interface TonalliBrowserWalletAdapterOptions {
  walletService: TonalliX402Wallet
  approvalHandler?: TonalliX402ApprovalHandler
}

export interface CreateTonalliBrowserWalletAdapterOptions {
  enabled?: boolean
  walletService?: TonalliX402Wallet
  approvalHandler?: TonalliX402ApprovalHandler
}

type SafeInvoice = {
  readonly x402Version: Invoice['x402Version']
  readonly scheme: Invoice['scheme']
  readonly network: Invoice['network']
  readonly resourceHash: string
  readonly amountSats: string
  readonly payTo: string
  readonly nonce: string
  readonly issuedAt: number
  readonly expiresAt: number
}

const copyInvoice = (invoice: Invoice): SafeInvoice => ({
  x402Version: invoice.x402Version,
  scheme: invoice.scheme,
  network: invoice.network,
  resourceHash: invoice.resourceHash,
  amountSats: invoice.amountSats,
  payTo: invoice.payTo,
  nonce: invoice.nonce,
  issuedAt: invoice.issuedAt,
  expiresAt: invoice.expiresAt
})

const copyPaymentPlan = (plan: PaymentPlan): PaymentPlan => ({
  network: plan.network,
  scheme: plan.scheme,
  amountSats: plan.amountSats,
  payTo: plan.payTo,
  expiresAt: plan.expiresAt,
  requiresManualApproval: plan.requiresManualApproval,
  ...(plan.feeSats === undefined ? {} : { feeSats: plan.feeSats }),
  ...(plan.transactionTxid === undefined ? {} : { transactionTxid: plan.transactionTxid }),
  ...(plan.finality === undefined ? {} : { finality: plan.finality })
})

const isCompressedPublicKey = (publicKey: string) =>
  /^(02|03)[0-9a-fA-F]{64}$/.test(publicKey)

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Invalid canonical value')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`
  }
  throw new TypeError('Invalid canonical value')
}

const canonicalAuthorizationMessage = (request: WalletSigningRequest) =>
  canonicalize({
    x402Version: request.authorization.x402Version,
    scheme: request.authorization.scheme,
    network: request.authorization.network,
    invoiceHash: request.authorization.invoiceHash,
    resourceHash: request.authorization.resourceHash,
    amountSats: request.authorization.amountSats,
    payTo: request.authorization.payTo,
    nonce: request.authorization.nonce,
    payer: request.authorization.payer,
    transaction: {
      txid: request.authorization.transaction.txid,
      vout: request.authorization.transaction.vout
    }
  })

const authorizationMatchesInvoice = (
  request: WalletSigningRequest,
  invoice: SafeInvoice
) => {
  const authorization = request.authorization
  return authorization.x402Version === invoice.x402Version
    && authorization.scheme === invoice.scheme
    && authorization.network === invoice.network
    && authorization.resourceHash === invoice.resourceHash
    && authorization.amountSats === invoice.amountSats
    && authorization.payTo === invoice.payTo
    && authorization.nonce === invoice.nonce
}

export class TonalliBrowserWalletAdapter implements BrowserWalletAdapter {
  private approvedInvoice: SafeInvoice | null = null
  private readonly walletService: TonalliX402Wallet
  private readonly approvalHandler?: TonalliX402ApprovalHandler

  constructor(options: TonalliBrowserWalletAdapterOptions) {
    this.walletService = options.walletService
    this.approvalHandler = options.approvalHandler
  }

  getActiveAccount(): WalletActiveAccountResponse {
    const account = this.walletService.getX402ActiveAccount()
    if (!account || !account.address || !isCompressedPublicKey(account.publicKey)) {
      return { status: 'unavailable', reason: WALLET_UNAVAILABLE_REASON }
    }

    return {
      status: 'available',
      account: {
        address: account.address,
        publicKey: account.publicKey
      }
    }
  }

  async requestApproval(request: WalletApprovalRequest): Promise<WalletApprovalResponse> {
    this.approvedInvoice = null
    if (!this.approvalHandler) {
      return { status: 'rejected', reason: APPROVAL_REQUIRED_REASON }
    }

    const invoice = copyInvoice(request.invoice)
    if (invoice.expiresAt <= Math.floor(Date.now() / 1000)) {
      return { status: 'rejected', reason: APPROVAL_REQUIRED_REASON }
    }
    const safeRequest: WalletApprovalRequest = {
      invoice,
      paymentPlan: copyPaymentPlan(request.paymentPlan)
    }

    try {
      const response = await this.approvalHandler(safeRequest)
      if (
        response.status === 'approved'
        && invoice.expiresAt > Math.floor(Date.now() / 1000)
      ) {
        this.approvedInvoice = invoice
        return { status: 'approved' }
      }
      if (response.status === 'cancelled') {
        return { status: 'cancelled' }
      }
      return { status: 'rejected' }
    } catch {
      return { status: 'rejected', reason: APPROVAL_REQUIRED_REASON }
    }
  }

  async signAuthorization(request: WalletSigningRequest): Promise<WalletSigningResponse> {
    const approvedInvoice = this.approvedInvoice
    this.approvedInvoice = null
    if (
      !approvedInvoice
      || approvedInvoice.expiresAt <= Math.floor(Date.now() / 1000)
      || !authorizationMatchesInvoice(request, approvedInvoice)
      || request.message !== canonicalAuthorizationMessage(request)
    ) {
      return { status: 'rejected', reason: APPROVAL_REQUIRED_REASON }
    }

    const activeAccount = this.getActiveAccount()
    if (
      activeAccount.status !== 'available'
      || request.authorization.payer !== activeAccount.account.address
    ) {
      return { status: 'rejected', reason: WALLET_UNAVAILABLE_REASON }
    }

    try {
      const signed = await this.walletService.signX402AuthorizationMessage(request.message)
      if (
        !signed.signature
        || signed.publicKey !== activeAccount.account.publicKey
        || !isCompressedPublicKey(signed.publicKey)
      ) {
        return { status: 'rejected', reason: SIGNING_FAILED_REASON }
      }
      return {
        status: 'approved',
        signature: signed.signature,
        publicKey: signed.publicKey
      }
    } catch {
      return { status: 'rejected', reason: SIGNING_FAILED_REASON }
    }
  }

  signPreparedTransaction(request: WalletTransactionSigningRequest): WalletTransactionSigningResponse {
    void request
    return { status: 'rejected', reason: TRANSACTION_SIGNING_UNSUPPORTED_REASON }
  }
}

class DisabledTonalliBrowserWalletAdapter implements BrowserWalletAdapter {
  getActiveAccount(): WalletActiveAccountResponse {
    return { status: 'unavailable', reason: DISABLED_REASON }
  }

  requestApproval(request: WalletApprovalRequest): WalletApprovalResponse {
    void request
    return { status: 'rejected', reason: DISABLED_REASON }
  }

  signAuthorization(request: WalletSigningRequest): WalletSigningResponse {
    void request
    return { status: 'rejected', reason: DISABLED_REASON }
  }

  signPreparedTransaction(request: WalletTransactionSigningRequest): WalletTransactionSigningResponse {
    void request
    return { status: 'rejected', reason: TRANSACTION_SIGNING_UNSUPPORTED_REASON }
  }
}

export const createTonalliBrowserWalletAdapter = (
  options: CreateTonalliBrowserWalletAdapterOptions = {}
): BrowserWalletAdapter => {
  if (!options.enabled || !options.walletService || !options.approvalHandler) {
    return new DisabledTonalliBrowserWalletAdapter()
  }

  return new TonalliBrowserWalletAdapter({
    walletService: options.walletService,
    approvalHandler: options.approvalHandler
  })
}

export const tonalliBrowserWalletAdapter = createTonalliBrowserWalletAdapter()

export default tonalliBrowserWalletAdapter
