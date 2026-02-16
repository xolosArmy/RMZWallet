import assert from 'node:assert/strict'
import test from 'node:test'
import { getChronik } from '../../services/ChronikClient.ts'
import { xolosWalletService } from '../../services/XolosWalletService.ts'
import { WcWallet } from './WcWallet.ts'

type SessionRequestHandler = (event: unknown) => Promise<void>

function buildWalletHarness(sessionChainId = 'ecash:1') {
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
              chains: [sessionChainId],
              events: ['accountsChanged'],
              accounts: [`${sessionChainId}:qqtest`]
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

  const wallet = new (WcWallet as unknown as { new (): WcWallet })()
  ;(wallet as unknown as { web3wallet: unknown }).web3wallet = mockWeb3wallet
  ;(wallet as unknown as { setupEventListeners: () => void }).setupEventListeners()

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

test('session_request legacy ecash:mainnet se acepta si la sesión usa legacy chain', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { wallet, responses, sessionRequest } = buildWalletHarness('ecash:mainnet')

  await sessionRequest({
    topic: 't1',
    id: 105,
    params: {
      chainId: 'ecash:mainnet',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: { offerId: 'offer-legacy' }
      }
    }
  })

  await wallet.rejectPendingRequest()

  assert.equal(responses.length, 1)
  assert.equal(responses[0].response.error?.code, 4001)

  xolosWalletService.getAddress = originalGetAddress
})

test('session_request con chain no soportada responde Unsupported chain', async () => {
  const { responses, sessionRequest } = buildWalletHarness()

  await sessionRequest({
    topic: 't1',
    id: 106,
    params: {
      chainId: 'ecash:999',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: { offerId: 'offer-unsupported' }
      }
    }
  })

  assert.equal(responses.length, 1)
  assert.equal(responses[0].response.error?.code, -32000)
  assert.equal(responses[0].response.error?.message, 'Unsupported chain')
})

test('request con outputs usa ruta build+sign+broadcast desde outputs', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { wallet, responses, sessionRequest } = buildWalletHarness()
  ;(wallet as unknown as {
    buildSignBroadcastFromOutputs: (outputs: Array<{ address: string; valueSats: number }>) => Promise<{ txid: string }>
  }).buildSignBroadcastFromOutputs = async (outputs) => {
    assert.equal(outputs.length, 1)
    assert.equal(outputs[0].address, 'ecash:qrecipient')
    assert.equal(outputs[0].valueSats, 1200)
    return { txid: 'b'.repeat(64) }
  }

  await sessionRequest({
    topic: 't1',
    id: 107,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: {
          offerId: 'offer-outputs',
          outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }]
        }
      }
    }
  })

  await wallet.approvePendingRequest()

  assert.equal(responses.length, 1)
  assert.equal((responses[0].response.result as { txid: string }).txid, 'b'.repeat(64))
  xolosWalletService.getAddress = originalGetAddress
})

test('si vienen rawHex unsigned y outputs, se reconstruye desde outputs', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { wallet, responses, sessionRequest } = buildWalletHarness()
  const unsignedRawHex =
    '0100000001' +
    `${'00'.repeat(32)}` +
    '00000000' +
    '00' +
    'ffffffff' +
    '01' +
    'e803000000000000' +
    '19' +
    '76a91400112233445566778899aabbccddeeff0011223388ac' +
    '00000000'
  let outputsRouteCalled = false
  let rawHexRouteCalled = false

  ;(wallet as unknown as { signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }> }).signAndBroadcastRawHex =
    async () => {
      rawHexRouteCalled = true
      return { txid: 'c'.repeat(64) }
    }
  ;(wallet as unknown as {
    buildSignBroadcastFromOutputs: (outputs: Array<{ address: string; valueSats: number }>) => Promise<{ txid: string }>
  }).buildSignBroadcastFromOutputs = async (outputs) => {
    outputsRouteCalled = true
    assert.equal(outputs.length, 1)
    assert.equal(outputs[0].address, 'ecash:qrecipient')
    assert.equal(outputs[0].valueSats, 1200)
    return { txid: 'd'.repeat(64) }
  }

  await sessionRequest({
    topic: 't1',
    id: 108,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: {
          offerId: 'offer-priority',
          rawHex: unsignedRawHex,
          outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }]
        }
      }
    }
  })

  await wallet.approvePendingRequest()

  assert.equal(rawHexRouteCalled, false)
  assert.equal(outputsRouteCalled, true)
  assert.equal(responses.length, 1)
  assert.equal((responses[0].response.result as { txid: string }).txid, 'd'.repeat(64))
  xolosWalletService.getAddress = originalGetAddress
})

test('si vienen rawHex firmado y outputs, rawHex mantiene prioridad', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { wallet, responses, sessionRequest } = buildWalletHarness()
  const signedLikeRawHex =
    '0100000001' +
    `${'00'.repeat(32)}` +
    '00000000' +
    '01' +
    '00' +
    'ffffffff' +
    '01' +
    'e803000000000000' +
    '19' +
    '76a91400112233445566778899aabbccddeeff0011223388ac' +
    '00000000'
  let outputsRouteCalled = false

  ;(wallet as unknown as { signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }> }).signAndBroadcastRawHex =
    async (rawHex) => {
      assert.equal(rawHex, signedLikeRawHex)
      return { txid: 'c'.repeat(64) }
    }
  ;(wallet as unknown as {
    buildSignBroadcastFromOutputs: (outputs: Array<{ address: string; valueSats: number }>) => Promise<{ txid: string }>
  }).buildSignBroadcastFromOutputs = async () => {
    outputsRouteCalled = true
    return { txid: 'd'.repeat(64) }
  }

  await sessionRequest({
    topic: 't1',
    id: 109,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: {
          offerId: 'offer-signed-priority',
          rawHex: signedLikeRawHex,
          outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }]
        }
      }
    }
  })

  await wallet.approvePendingRequest()

  assert.equal(outputsRouteCalled, false)
  assert.equal(responses.length, 1)
  assert.equal((responses[0].response.result as { txid: string }).txid, 'c'.repeat(64))
  xolosWalletService.getAddress = originalGetAddress
})

test('parser: intent-only (sin inputs) => mode intent', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    parseSignAndBroadcastParams: (input: unknown) => { params: { requestMode?: string } | null; error: { code: number } | null }
  }
  const parsed = wallet.parseSignAndBroadcastParams({
    outputs: [{ address: 'ecash:qrecipient', valueSats: 1500 }]
  })
  assert.equal(parsed.error, null)
  assert.equal(parsed.params?.requestMode, 'intent')
})

test('parser: legacy inputsUsed => mode legacy', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    parseSignAndBroadcastParams: (input: unknown) => { params: { requestMode?: string } | null; error: { code: number } | null }
  }
  const parsed = wallet.parseSignAndBroadcastParams({
    inputsUsed: [`${'a'.repeat(64)}:0`],
    outputs: [{ address: 'ecash:qrecipient', valueSats: 900 }]
  })
  assert.equal(parsed.error, null)
  assert.equal(parsed.params?.requestMode, 'legacy')
})

test('parser: error por formato inválido en inputsUsed', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    parseSignAndBroadcastParams: (input: unknown) => { params: unknown; error: { code: number; message: string } | null }
  }
  const parsed = wallet.parseSignAndBroadcastParams({
    inputsUsed: ['no-es-outpoint'],
    outputs: [{ address: 'ecash:qrecipient', valueSats: 900 }]
  })
  assert.equal(parsed.params, null)
  assert.equal(parsed.error?.code, -32602)
  assert.match(parsed.error?.message ?? '', /txid:vout/)
})
