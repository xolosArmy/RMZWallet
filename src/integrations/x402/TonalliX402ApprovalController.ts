import type {
  WalletApprovalRequest,
  WalletApprovalResponse
} from '@x402-xec/payments'

const INVALID_REQUEST_REASON = 'Invalid x402 approval metadata'
const PENDING_REQUEST_REASON = 'Another x402 approval request is already pending'

export type TonalliX402ApprovalDisplay = {
  readonly amountSats: string
  readonly amountXec: string
  readonly payTo: string
  readonly network: string
  readonly resource: string
  readonly expiresAt: number
  readonly requiresManualApproval: boolean
  readonly feeSats?: string
  readonly feeXec?: string
}

export type TonalliX402ApprovalState = {
  readonly pending: TonalliX402ApprovalDisplay | null
}

type PendingApproval = {
  readonly display: TonalliX402ApprovalDisplay
  readonly resolve: (response: WalletApprovalResponse) => void
  expiryTimer: ReturnType<typeof setTimeout>
}

export type TonalliX402ApprovalControllerOptions = {
  readonly now?: () => number
}

const isSats = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)

const satsToXec = (sats: string) => {
  const value = BigInt(sats)
  const whole = value / 100n
  const fraction = (value % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const createDisplayRequest = (
  request: WalletApprovalRequest,
  now: number
): TonalliX402ApprovalDisplay | null => {
  const { invoice, paymentPlan } = request
  const feeIsValid = paymentPlan.feeSats === undefined || isSats(paymentPlan.feeSats)
  const expiresAtIsValid = Number.isSafeInteger(invoice.expiresAt)
    && invoice.expiresAt > now
    && paymentPlan.expiresAt === invoice.expiresAt
  const metadataMatches = paymentPlan.amountSats === invoice.amountSats
    && paymentPlan.payTo === invoice.payTo
    && paymentPlan.network === invoice.network
    && paymentPlan.scheme === invoice.scheme

  if (
    !isSats(invoice.amountSats)
    || invoice.amountSats === '0'
    || !isNonEmptyString(invoice.payTo)
    || !isNonEmptyString(invoice.network)
    || !isNonEmptyString(invoice.resourceHash)
    || typeof paymentPlan.requiresManualApproval !== 'boolean'
    || !feeIsValid
    || !expiresAtIsValid
    || !metadataMatches
  ) {
    return null
  }

  return {
    amountSats: invoice.amountSats,
    amountXec: satsToXec(invoice.amountSats),
    payTo: invoice.payTo,
    network: invoice.network,
    resource: invoice.resourceHash,
    expiresAt: invoice.expiresAt,
    requiresManualApproval: paymentPlan.requiresManualApproval,
    ...(paymentPlan.feeSats === undefined
      ? {}
      : {
          feeSats: paymentPlan.feeSats,
          feeXec: satsToXec(paymentPlan.feeSats)
        })
  }
}

export class TonalliX402ApprovalController {
  private pendingApproval: PendingApproval | null = null
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private state: TonalliX402ApprovalState = { pending: null }

  constructor(options: TonalliX402ApprovalControllerOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  getState = (): TonalliX402ApprovalState => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  requestApproval = (
    request: Readonly<WalletApprovalRequest>
  ): Promise<WalletApprovalResponse> => {
    if (this.pendingApproval) {
      return Promise.resolve({ status: 'rejected', reason: PENDING_REQUEST_REASON })
    }

    let display: TonalliX402ApprovalDisplay | null
    try {
      display = createDisplayRequest(request, this.now())
    } catch {
      display = null
    }
    if (!display) {
      return Promise.resolve({ status: 'rejected', reason: INVALID_REQUEST_REASON })
    }

    return new Promise((resolve) => {
      const delay = Math.max(0, (display.expiresAt - this.now()) * 1000)
      const expiryTimer = setTimeout(() => {
        this.finish('cancelled')
      }, delay)
      this.pendingApproval = { display, resolve, expiryTimer }
      this.state = { pending: display }
      this.emit()
    })
  }

  approve = () => {
    if (!this.pendingApproval) return
    if (this.pendingApproval.display.expiresAt <= this.now()) {
      this.finish('cancelled')
      return
    }
    this.finish('approved')
  }

  reject = () => {
    this.finish('rejected')
  }

  cancel = () => {
    this.finish('cancelled')
  }

  dispose = () => {
    this.finish('cancelled')
    this.listeners.clear()
  }

  private finish(status: 'approved' | 'rejected' | 'cancelled') {
    const pending = this.pendingApproval
    if (!pending) return

    this.state = { pending: null }
    this.pendingApproval = null
    clearTimeout(pending.expiryTimer)
    pending.resolve({ status })
    this.emit()
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}
