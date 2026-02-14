import assert from 'node:assert/strict'
import test from 'node:test'
import { getChronik } from '../../services/ChronikClient.ts'
import { xolosWalletService } from '../../services/XolosWalletService.ts'
import { WcWallet } from './WcWallet.ts'

type SessionRequestHandler = (event: unknown) => Promise<void>

function buildWalletHarness() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const responses: Array<{ topic: string; response: { id: number; error?: { code: number; message: string }; result?: unknown } }> = []

  const mockWeb3wallet = {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb)
    },
    async respondSessionRequest(payload: {
      topic: string
      response: { id: number; error?: { code: number; message: string }; result?: unknown }
    }) {
      responses.push(payload)
    },
    async rejectSession() {
      // noop
    },
    async emitSessionEvent() {
      // noop
    },
    getActiveSessions() {
      return {
        t1: {
          topic: 't1',
          namespaces: {
            ecash: {
              methods: ['ecash_signAndBroadcastTransaction'],
              chains: ['ecash:1'],
              events: ['accountsChanged'],
              accounts: ['ecash:1:qqtest']
            }
          },
          peer: {
            metadata: {
              name: 'Teyolia',
              url: 'https://teyolia.app',
              icons: []
            }
          }
        }
      }
    }
  }

  const wallet = new WcWallet()
  ;(wallet as unknown as { web3wallet: unknown }).web3wallet = mockWeb3wallet
  ;(wallet as unknown as { registerHandlers: () => void }).registerHandlers()

  const sessionRequest = handlers.get('session_request') as SessionRequestHandler
  assert.ok(sessionRequest, 'session_request handler should be registered')

  return { wallet, responses, sessionRequest }
}

test('session_request con offerId faltante responde -32602', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { responses, sessionRequest } = buildWalletHarness()

  await sessionRequest({
    topic: 't1',
    id: 101,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: {}
      }
    }
  })

  assert.equal(responses.length, 1)
  assert.equal(responses[0].response.error?.code, -32602)

  xolosWalletService.getAddress = originalGetAddress
})

test('método desconocido responde -32601', async () => {
  const { responses, sessionRequest } = buildWalletHarness()

  await sessionRequest({
    topic: 't1',
    id: 102,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_unknownMethod',
        params: {}
      }
    }
  })

  assert.equal(responses.length, 1)
  assert.equal(responses[0].response.error?.code, -32601)
})

test('rechazo usuario responde 4001', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { wallet, responses, sessionRequest } = buildWalletHarness()

  await sessionRequest({
    topic: 't1',
    id: 103,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: { offerId: 'offer-1' }
      }
    }
  })

  await wallet.rejectPendingRequest()

  assert.equal(responses.length, 1)
  assert.equal(responses[0].response.error?.code, 4001)

  xolosWalletService.getAddress = originalGetAddress
})

test('request válido responde { txid }', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const chronik = getChronik() as unknown as {
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
    validateRawTx: (rawTx: string) => Promise<{
      size: number
      inputs: Array<{ sats: bigint }>
      outputs: Array<{ sats: bigint; outputScript: string }>
    }>
  }

  const originalBroadcastTx = chronik.broadcastTx
  const originalValidateRawTx = chronik.validateRawTx

  chronik.broadcastTx = async () => ({
    txid: 'a'.repeat(64)
  })
  chronik.validateRawTx = async () => ({
    size: 100,
    inputs: [{ sats: 1000n }],
    outputs: [{ sats: 900n, outputScript: '76a91400112233445566778899aabbccddeeff0011223388ac' }]
  })

  const { wallet, responses, sessionRequest } = buildWalletHarness()

  await sessionRequest({
    topic: 't1',
    id: 104,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: {
          offerId: 'offer-2',
          rawHex: '00'
        }
      }
    }
  })

  await wallet.approvePendingRequest()

  assert.equal(responses.length, 1)
  assert.equal((responses[0].response.result as { txid: string }).txid, 'a'.repeat(64))

  chronik.broadcastTx = originalBroadcastTx
  chronik.validateRawTx = originalValidateRawTx
  xolosWalletService.getAddress = originalGetAddress
})
