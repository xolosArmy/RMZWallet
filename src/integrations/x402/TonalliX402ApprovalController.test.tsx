import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WalletApprovalRequest } from '@x402-xec/payments'
import TonalliPaymentApprovalModal from '../../components/x402/TonalliPaymentApprovalModal'
import { TonalliX402ApprovalController } from './TonalliX402ApprovalController'

const secrets = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  privateKey: '22'.repeat(32),
  WIF: 'L1secretWif',
  signatory: 'secret-signatory',
  transactionHex: 'deadbeef'
}

const createRequest = (expiresAt = 2_000): WalletApprovalRequest => ({
  invoice: {
    x402Version: 1,
    scheme: 'exact',
    network: 'xec:mainnet',
    resourceHash: 'safe-resource-hash',
    amountSats: '550',
    payTo: 'ecash:qpreceiver',
    nonce: 'safe-nonce',
    issuedAt: 1_000,
    expiresAt
  },
  paymentPlan: {
    network: 'xec:mainnet',
    scheme: 'exact',
    amountSats: '550',
    payTo: 'ecash:qpreceiver',
    expiresAt,
    requiresManualApproval: true,
    feeSats: '12'
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TonalliX402ApprovalController', () => {
  test('modal renders only display-safe payment metadata', () => {
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    void controller.requestApproval({ ...createRequest(), ...secrets } as WalletApprovalRequest)
    const display = controller.getState().pending
    expect(display).not.toBeNull()

    const output = renderToStaticMarkup(
      <TonalliPaymentApprovalModal
        request={display!}
        onApprove={() => undefined}
        onReject={() => undefined}
        onCancel={() => undefined}
      />
    )

    expect(output).toContain('5.50 XEC (550 sats)')
    expect(output).toContain('ecash:qpreceiver')
    expect(output).toContain('xec:mainnet')
    expect(output).toContain('safe-resource-hash')
    expect(output).toContain('1970-01-01T00:33:20.000Z')
    expect(output).toContain('0.12 XEC (12 sats)')
    for (const [name, value] of Object.entries(secrets)) {
      expect(output).not.toContain(name)
      expect(output).not.toContain(value)
    }
    controller.dispose()
  })

  test('approval resolves only after the explicit approve action', async () => {
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    const decision = controller.requestApproval(createRequest())
    let settled = false
    void decision.then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    controller.approve()

    await expect(decision).resolves.toEqual({ status: 'approved' })
  })

  test('reject and close return their respective fail-closed statuses', async () => {
    const rejectController = new TonalliX402ApprovalController({ now: () => 1_000 })
    const rejected = rejectController.requestApproval(createRequest())
    rejectController.reject()
    await expect(rejected).resolves.toEqual({ status: 'rejected' })

    const closeController = new TonalliX402ApprovalController({ now: () => 1_000 })
    const cancelled = closeController.requestApproval(createRequest())
    closeController.cancel()
    await expect(cancelled).resolves.toEqual({ status: 'cancelled' })
  })

  test('expired metadata is rejected and a pending invoice cannot be approved after expiry', async () => {
    let now = 1_000
    const controller = new TonalliX402ApprovalController({ now: () => now })
    await expect(controller.requestApproval(createRequest(1_000))).resolves.toMatchObject({
      status: 'rejected'
    })

    const decision = controller.requestApproval(createRequest(1_001))
    now = 1_001
    controller.approve()
    await expect(decision).resolves.toEqual({ status: 'cancelled' })
  })

  test('invoice expiry automatically cancels the pending request', async () => {
    vi.useFakeTimers()
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    const decision = controller.requestApproval(createRequest(1_001))

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(decision).resolves.toEqual({ status: 'cancelled' })
  })

  test('a concurrent request fails closed without replacing the pending request', async () => {
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    const first = controller.requestApproval(createRequest())

    await expect(controller.requestApproval(createRequest())).resolves.toMatchObject({
      status: 'rejected'
    })
    expect(controller.getState().pending?.resource).toBe('safe-resource-hash')
    controller.cancel()
    await expect(first).resolves.toEqual({ status: 'cancelled' })
  })

  test('provider unmount disposal cancels a pending request', async () => {
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    const decision = controller.requestApproval(createRequest())

    controller.dispose()

    await expect(decision).resolves.toEqual({ status: 'cancelled' })
    expect(controller.getState().pending).toBeNull()
  })

  test('approval output contains no secrets and invokes no signing, sending, or broadcast boundary', async () => {
    const signAuthorization = vi.fn()
    const sendXEC = vi.fn()
    const sendRMZ = vi.fn()
    const chronikBroadcast = vi.fn()
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    const decision = controller.requestApproval({ ...createRequest(), ...secrets } as WalletApprovalRequest)

    controller.approve()
    const result = await decision
    const serialized = JSON.stringify({ state: controller.getState(), result })

    for (const [name, value] of Object.entries(secrets)) {
      expect(serialized).not.toContain(name)
      expect(serialized).not.toContain(value)
    }
    expect(signAuthorization).not.toHaveBeenCalled()
    expect(sendXEC).not.toHaveBeenCalled()
    expect(sendRMZ).not.toHaveBeenCalled()
    expect(chronikBroadcast).not.toHaveBeenCalled()
  })

  test('invalid required metadata is rejected without opening the modal', async () => {
    const controller = new TonalliX402ApprovalController({ now: () => 1_000 })
    const validRequest = createRequest()
    const request: WalletApprovalRequest = {
      ...validRequest,
      paymentPlan: { ...validRequest.paymentPlan, payTo: 'ecash:qdifferent' }
    }

    await expect(controller.requestApproval(request)).resolves.toMatchObject({ status: 'rejected' })
    expect(controller.getState().pending).toBeNull()
  })
})
