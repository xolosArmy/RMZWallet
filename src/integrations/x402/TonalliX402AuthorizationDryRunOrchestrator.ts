import {
  authorizationSchema,
  authorizationSigningMessage,
  computeInvoiceHash,
  unsignedAuthorizationSchema,
  type UnsignedAuthorization
} from '@x402-xec/core'
import type {
  PaymentOrchestrator,
  PaymentOrchestratorResult,
  PaymentPreparationRequest
} from '@x402-xec/axios'
import {
  BrowserWalletApprovalSigningBoundary,
  type BrowserWalletAdapter,
  type WalletApprovalResponse
} from '@x402-xec/payments'

const DEMO_TRANSACTION_PLACEHOLDER = Object.freeze({
  txid: '0'.repeat(64),
  vout: 0
})
const AUTHORIZATION_FAILED = 'X402 authorization dry run failed'

export type TonalliX402AuthorizationDryRunStatus =
  | 'approval-requested'
  | 'approval-accepted'
  | 'approval-rejected'
  | 'approval-cancelled'
  | 'authorization-signature-returned'

export interface TonalliX402AuthorizationDryRunOrchestratorOptions {
  readonly walletAdapter: BrowserWalletAdapter
  readonly now?: () => number
  readonly onStatus?: (status: TonalliX402AuthorizationDryRunStatus) => void
}

const encodeBase64UrlJson = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

const toBase64Url = (signature: string) =>
  signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')

const reportApproval = (
  response: WalletApprovalResponse,
  onStatus?: (status: TonalliX402AuthorizationDryRunStatus) => void
) => {
  if (response.status === 'approved') onStatus?.('approval-accepted')
  if (response.status === 'rejected') onStatus?.('approval-rejected')
  if (response.status === 'cancelled') onStatus?.('approval-cancelled')
}

/**
 * Authorization-only x402 demo boundary.
 *
 * The all-zero outpoint is deterministic protocol-shaped metadata for this
 * local demo. It is never a funding transaction and must never be broadcast.
 */
export class TonalliX402AuthorizationDryRunOrchestrator implements PaymentOrchestrator {
  private readonly boundary: BrowserWalletApprovalSigningBoundary
  private readonly walletAdapter: BrowserWalletAdapter
  private readonly now: () => number
  private readonly onStatus?: (status: TonalliX402AuthorizationDryRunStatus) => void

  constructor(options: TonalliX402AuthorizationDryRunOrchestratorOptions) {
    this.walletAdapter = options.walletAdapter
    this.boundary = new BrowserWalletApprovalSigningBoundary(options.walletAdapter)
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.onStatus = options.onStatus
  }

  async execute(request: PaymentPreparationRequest): Promise<PaymentOrchestratorResult> {
    const { invoice } = request
    if (invoice.expiresAt <= this.now()) throw new Error(AUTHORIZATION_FAILED)

    let activeAccount
    try {
      activeAccount = await this.walletAdapter.getActiveAccount()
    } catch {
      throw new Error(AUTHORIZATION_FAILED)
    }
    if (activeAccount.status !== 'available') throw new Error(AUTHORIZATION_FAILED)

    const unsignedAuthorization: UnsignedAuthorization = unsignedAuthorizationSchema.parse({
      x402Version: invoice.x402Version,
      scheme: invoice.scheme,
      network: invoice.network,
      invoiceHash: computeInvoiceHash(invoice),
      resourceHash: invoice.resourceHash,
      amountSats: invoice.amountSats,
      payTo: invoice.payTo,
      nonce: invoice.nonce,
      payer: activeAccount.account.address,
      transaction: DEMO_TRANSACTION_PLACEHOLDER
    })
    const message = authorizationSigningMessage({
      ...unsignedAuthorization,
      signature: 'placeholder'
    })

    this.onStatus?.('approval-requested')
    let result
    try {
      result = await this.boundary.authorize({
        approval: {
          invoice,
          paymentPlan: {
            network: invoice.network,
            scheme: invoice.scheme,
            amountSats: invoice.amountSats,
            payTo: invoice.payTo,
            expiresAt: invoice.expiresAt,
            requiresManualApproval: true
          }
        },
        signing: { authorization: unsignedAuthorization, message }
      })
    } catch {
      throw new Error(AUTHORIZATION_FAILED)
    }
    reportApproval(result.approval, this.onStatus)

    if (
      result.approval.status !== 'approved'
      || result.signing?.status !== 'approved'
      || invoice.expiresAt <= this.now()
    ) {
      throw new Error(AUTHORIZATION_FAILED)
    }

    const parsedAuthorization = authorizationSchema.safeParse({
      ...unsignedAuthorization,
      signature: toBase64Url(result.signing.signature)
    })
    if (!parsedAuthorization.success) throw new Error(AUTHORIZATION_FAILED)
    const authorization = parsedAuthorization.data
    this.onStatus?.('authorization-signature-returned')

    return {
      paymentSignature: encodeBase64UrlJson({ invoice, authorization }),
      broadcasted: false,
      mode: 'authorization-dry-run'
    }
  }
}

export default TonalliX402AuthorizationDryRunOrchestrator
