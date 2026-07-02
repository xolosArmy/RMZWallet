import { computeResourceHash, type Invoice, type ResourceRequest } from '@x402-xec/core'
import { fromHex, signMsg } from 'ecash-lib'
import type { BrowserWalletAdapter, WalletApprovalResponse } from '@x402-xec/payments'
import { describe, expect, test, vi } from 'vitest'
import {
  TonalliBrowserWalletAdapter,
  type TonalliX402Wallet
} from './TonalliBrowserWalletAdapter'
import {
  TonalliX402AuthorizationDryRunOrchestrator,
  type TonalliX402AuthorizationDryRunStatus
} from './TonalliX402AuthorizationDryRunOrchestrator'

const NOW = 4_000_000_000
const address = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const publicKey = `02${'11'.repeat(32)}`
const resource: ResourceRequest = {
  serverOrigin: 'https://x402-demo.local',
  method: 'GET',
  path: '/protected'
}
const invoice: Invoice = {
  x402Version: 1,
  scheme: 'exact',
  network: 'xec:mainnet',
  resourceHash: computeResourceHash(resource),
  amountSats: '100',
  payTo: address,
  nonce: 'Uk1aV2FsbGV0LXg0MDItZGVtbw',
  issuedAt: NOW,
  expiresAt: NOW + 300
}
const sensitiveValues = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  privateKey: '22'.repeat(32),
  WIF: 'L1secretWif',
  signatory: 'secret-signatory',
  transactionHex: 'deadbeef'
}

const decodePaymentSignature = (value: string) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return JSON.parse(atob(padded)) as {
    invoice: Invoice
    authorization: {
      signature: string
      transaction: { txid: string; vout: number }
    }
  }
}

const createHarness = (approval: WalletApprovalResponse = { status: 'approved' }) => {
  const order: string[] = []
  const statuses: TonalliX402AuthorizationDryRunStatus[] = []
  const signPreparedTransaction = vi.fn()
  const sendXEC = vi.fn()
  const sendRMZ = vi.fn()
  const transactionBuilder = vi.fn()
  const chronik = vi.fn()
  const signX402AuthorizationMessage = vi.fn(async (message: string) => {
    order.push('sign')
    expect(message).not.toContain('placeholder')
    return { signature: signMsg(message, fromHex('22'.repeat(32))), publicKey }
  })
  const wallet: TonalliX402Wallet = {
    getX402ActiveAccount: () => ({ address, publicKey }),
    signX402AuthorizationMessage
  }
  const adapter = new TonalliBrowserWalletAdapter({
    walletService: wallet,
    approvalHandler: async () => {
      order.push('approval')
      return approval
    }
  })
  const browserAdapter: BrowserWalletAdapter = {
    getActiveAccount: () => adapter.getActiveAccount(),
    requestApproval: (request) => adapter.requestApproval(request),
    signAuthorization: (request) => adapter.signAuthorization(request),
    signPreparedTransaction
  }
  const orchestrator = new TonalliX402AuthorizationDryRunOrchestrator({
    walletAdapter: browserAdapter,
    now: () => NOW,
    onStatus: (status) => statuses.push(status)
  })

  return {
    orchestrator,
    order,
    statuses,
    signX402AuthorizationMessage,
    signPreparedTransaction,
    sendXEC,
    sendRMZ,
    transactionBuilder,
    chronik
  }
}

describe('TonalliX402AuthorizationDryRunOrchestrator', () => {
  test('approval occurs before a wallet authorization signature and returns safe dry-run output', async () => {
    const harness = createHarness()

    const result = await harness.orchestrator.execute({ invoice, resource })
    const payload = decodePaymentSignature(result.paymentSignature)

    expect(harness.order).toEqual(['approval', 'sign'])
    expect(harness.statuses).toEqual([
      'approval-requested',
      'approval-accepted',
      'authorization-signature-returned'
    ])
    expect(harness.signX402AuthorizationMessage).toHaveBeenCalledOnce()
    expect(payload.invoice).toEqual(invoice)
    expect(payload.authorization.signature).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(payload.authorization.transaction).toEqual({
      txid: '0'.repeat(64),
      vout: 0
    })
    expect(result).toMatchObject({
      broadcasted: false,
      mode: 'authorization-dry-run'
    })
    expect(harness.signPreparedTransaction).not.toHaveBeenCalled()
    expect(harness.transactionBuilder).not.toHaveBeenCalled()
    expect(harness.sendXEC).not.toHaveBeenCalled()
    expect(harness.sendRMZ).not.toHaveBeenCalled()
    expect(harness.chronik).not.toHaveBeenCalled()
  })

  test.each(['rejected', 'cancelled'] as const)(
    '%s approval fails closed before signing',
    async (status) => {
      const harness = createHarness({ status })

      await expect(harness.orchestrator.execute({ invoice, resource }))
        .rejects.toThrow('X402 authorization dry run failed')

      expect(harness.order).toEqual(['approval'])
      expect(harness.statuses).toEqual([
        'approval-requested',
        status === 'rejected' ? 'approval-rejected' : 'approval-cancelled'
      ])
      expect(harness.signX402AuthorizationMessage).not.toHaveBeenCalled()
      expect(harness.signPreparedTransaction).not.toHaveBeenCalled()
    }
  )

  test('an expired invoice fails before approval or signing', async () => {
    const harness = createHarness()
    const expiredInvoice = { ...invoice, expiresAt: NOW }

    await expect(harness.orchestrator.execute({ invoice: expiredInvoice, resource }))
      .rejects.toThrow('X402 authorization dry run failed')

    expect(harness.order).toEqual([])
    expect(harness.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('signing failures expose no secret material', async () => {
    const adapter: BrowserWalletAdapter = {
      getActiveAccount: () => ({ status: 'available', account: { address, publicKey } }),
      requestApproval: () => ({ status: 'approved' }),
      signAuthorization: async () => {
        throw new Error(Object.values(sensitiveValues).join(' '))
      }
    }
    const orchestrator = new TonalliX402AuthorizationDryRunOrchestrator({
      walletAdapter: adapter,
      now: () => NOW
    })

    let error: unknown
    try {
      await orchestrator.execute({ invoice, resource })
    } catch (caught) {
      error = caught
    }
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error as object))

    for (const [name, value] of Object.entries(sensitiveValues)) {
      expect(serialized).not.toContain(name)
      expect(serialized).not.toContain(value)
    }
  })
})
