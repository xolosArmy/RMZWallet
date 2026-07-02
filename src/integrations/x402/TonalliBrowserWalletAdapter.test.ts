import { describe, expect, test, vi } from 'vitest'
import type {
  WalletApprovalRequest,
  WalletSigningRequest,
  WalletTransactionSigningRequest
} from '@x402-xec/payments'
import {
  TonalliBrowserWalletAdapter,
  createTonalliBrowserWalletAdapter,
  type TonalliX402Wallet
} from './TonalliBrowserWalletAdapter'

const address = 'ecash:qptestaddress'
const publicKey = `02${'11'.repeat(32)}`
const sensitiveValues = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  privateKey: '22'.repeat(32),
  WIF: 'L1secretWif',
  signatory: 'secret-signatory'
}

const approvalRequest: WalletApprovalRequest = {
  invoice: {
    x402Version: 1,
    scheme: 'exact',
    network: 'xec:mainnet',
    resourceHash: 'resource-hash',
    amountSats: '550',
    payTo: 'ecash:qpreceiver',
    nonce: 'nonce-1',
    issuedAt: 3_999_999_700,
    expiresAt: 4_000_000_000
  },
  paymentPlan: {
    network: 'xec:mainnet',
    scheme: 'exact',
    amountSats: '550',
    payTo: 'ecash:qpreceiver',
    expiresAt: 4_000_000_000,
    requiresManualApproval: true
  }
}

const authorization = {
  x402Version: 1 as const,
  scheme: 'exact' as const,
  network: 'xec:mainnet' as const,
  invoiceHash: 'invoice-hash',
  resourceHash: approvalRequest.invoice.resourceHash,
  amountSats: approvalRequest.invoice.amountSats,
  payTo: approvalRequest.invoice.payTo,
  nonce: approvalRequest.invoice.nonce,
  payer: address,
  transaction: {
    txid: 'aa'.repeat(32),
    vout: 0
  }
}

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`
  }
  throw new TypeError('Unsupported test value')
}

const signingRequest: WalletSigningRequest = {
  authorization,
  message: canonicalize(authorization)
}

const preparedTransactionRequest: WalletTransactionSigningRequest = {
  invoiceHash: authorization.invoiceHash,
  paymentPlan: approvalRequest.paymentPlan,
  transaction: {
    transactionHex: '00'
  }
}

const createWallet = (available = true) => {
  const sendXEC = vi.fn()
  const broadcastTx = vi.fn()
  const signX402AuthorizationMessage = vi.fn(async () => ({
    signature: 'safe-signature',
    publicKey
  }))
  const wallet: TonalliX402Wallet & { sendXEC: typeof sendXEC; broadcastTx: typeof broadcastTx } = {
    getX402ActiveAccount: vi.fn(() => available ? { address, publicKey } : null),
    signX402AuthorizationMessage,
    sendXEC,
    broadcastTx
  }
  return { wallet, signX402AuthorizationMessage, sendXEC, broadcastTx }
}

const expectNoSensitiveData = (value: unknown) => {
  const serialized = JSON.stringify(value)
  for (const [name, secret] of Object.entries(sensitiveValues)) {
    expect(serialized).not.toContain(name)
    expect(serialized).not.toContain(secret)
  }
}

describe('TonalliBrowserWalletAdapter', () => {
  test('locked or uninitialized wallet returns unavailable', () => {
    const { wallet } = createWallet(false)
    const adapter = new TonalliBrowserWalletAdapter({ walletService: wallet })

    const result = adapter.getActiveAccount()

    expect(result.status).toBe('unavailable')
    expectNoSensitiveData(result)
  })

  test('disabled factory and missing approval handler fail closed', async () => {
    const { wallet } = createWallet()
    const disabled = createTonalliBrowserWalletAdapter()
    const missingHandler = new TonalliBrowserWalletAdapter({ walletService: wallet })

    expect(await disabled.requestApproval(approvalRequest)).toMatchObject({
      status: 'rejected'
    })
    expect(await missingHandler.requestApproval(approvalRequest)).toMatchObject({
      status: 'rejected'
    })
  })

  test.each(['rejected', 'cancelled'] as const)(
    '%s approval prevents authorization signing',
    async (status) => {
      const { wallet, signX402AuthorizationMessage } = createWallet()
      const adapter = new TonalliBrowserWalletAdapter({
        walletService: wallet,
        approvalHandler: async () => ({ status })
      })

      await adapter.requestApproval(approvalRequest)
      const result = await adapter.signAuthorization(signingRequest)

      expect(result.status).toBe('rejected')
      expect(signX402AuthorizationMessage).not.toHaveBeenCalled()
      expectNoSensitiveData(result)
    }
  )

  test('approved authorization signs the exact canonical message and returns only public output', async () => {
    const { wallet, signX402AuthorizationMessage, sendXEC, broadcastTx } = createWallet()
    const approvalHandler = vi.fn(async (request: WalletApprovalRequest) => {
      void request
      return {
        status: 'approved' as const,
        ...sensitiveValues
      }
    })
    const adapter = new TonalliBrowserWalletAdapter({
      walletService: wallet,
      approvalHandler
    })

    await adapter.requestApproval({
      ...approvalRequest,
      mnemonic: sensitiveValues.mnemonic,
      privateKey: sensitiveValues.privateKey
    } as WalletApprovalRequest)
    const result = await adapter.signAuthorization(signingRequest)
    const shownRequest = approvalHandler.mock.calls[0]?.[0]

    expect(signX402AuthorizationMessage).toHaveBeenCalledOnce()
    expect(signX402AuthorizationMessage).toHaveBeenCalledWith(signingRequest.message)
    expect(result).toEqual({
      status: 'approved',
      signature: 'safe-signature',
      publicKey
    })
    expect(shownRequest).toBeDefined()
    expect(Object.keys(shownRequest ?? {})).toEqual(['invoice', 'paymentPlan'])
    expectNoSensitiveData(shownRequest)
    expectNoSensitiveData(result)
    expect(sendXEC).not.toHaveBeenCalled()
    expect(broadcastTx).not.toHaveBeenCalled()
  })

  test('non-canonical message is rejected without signing', async () => {
    const { wallet, signX402AuthorizationMessage } = createWallet()
    const adapter = new TonalliBrowserWalletAdapter({
      walletService: wallet,
      approvalHandler: async () => ({ status: 'approved' })
    })

    await adapter.requestApproval(approvalRequest)
    const result = await adapter.signAuthorization({
      ...signingRequest,
      message: `${signingRequest.message} `
    })

    expect(result.status).toBe('rejected')
    expect(signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('prepared transaction signing remains rejected without sends or broadcasts', () => {
    const { wallet, sendXEC, broadcastTx } = createWallet()
    const adapter = new TonalliBrowserWalletAdapter({
      walletService: wallet,
      approvalHandler: async () => ({ status: 'approved' })
    })

    const result = adapter.signPreparedTransaction(preparedTransactionRequest)

    expect(result).toMatchObject({ status: 'rejected' })
    expectNoSensitiveData(result)
    expect(sendXEC).not.toHaveBeenCalled()
    expect(broadcastTx).not.toHaveBeenCalled()
  })

  test('signing failures expose no secrets in results, errors, or logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const wallet: TonalliX402Wallet = {
      getX402ActiveAccount: () => ({ address, publicKey }),
      signX402AuthorizationMessage: vi.fn(async () => {
        throw new Error(Object.values(sensitiveValues).join(' '))
      })
    }
    const adapter = new TonalliBrowserWalletAdapter({
      walletService: wallet,
      approvalHandler: async () => ({ status: 'approved' })
    })

    await adapter.requestApproval(approvalRequest)
    const result = await adapter.signAuthorization(signingRequest)

    expect(result.status).toBe('rejected')
    expectNoSensitiveData(result)
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
