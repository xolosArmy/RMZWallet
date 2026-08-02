import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionTypes } from '@walletconnect/types'
import { OP_RETURN_MAX_BYTES, getStackArray } from 'ecash-lib'
import { getChronik } from '../../services/ChronikClient.ts'
import { xolosWalletService } from '../../services/XolosWalletService.ts'
import { getWcDebugState } from './wcDebug.ts'
import {
  WcWallet,
  type PendingRequest,
  type RawHexAnalysis,
  type RawTxPreview,
  type RawTxPreviewStatus
} from './WcWallet.ts'

type SessionRequestHandler = (event: unknown) => Promise<void>

const buildRawTxFixture = (inputScriptHex: string) =>
  '0100000001' +
  `${'00'.repeat(32)}` +
  '00000000' +
  (inputScriptHex.length / 2).toString(16).padStart(2, '0') +
  inputScriptHex +
  'ffffffff' +
  '01' +
  'e803000000000000' +
  '19' +
  '76a91400112233445566778899aabbccddeeff0011223388ac' +
  '00000000'

const SIGNED_RAW_HEX = buildRawTxFixture('00')
const UNSIGNED_RAW_HEX = buildRawTxFixture('')
const TONALLI_MESSAGE_PREFIX_HEX = '6d02'

type OpReturnScriptLike = {
  bytecode: Uint8Array
  toHex: () => string
}

function getOpReturnBuilder(wallet: WcWallet) {
  return (wallet as unknown as {
    buildOpReturnScript: (message: string) => OpReturnScriptLike | null
  }).buildOpReturnScript.bind(wallet)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function assertTonalliOpReturnRoundTrip(script: OpReturnScriptLike, originalMessage: string) {
  const normalizedMessage = originalMessage.trim()
  const messageBytes = new TextEncoder().encode(normalizedMessage)
  const payloadByteLength = messageBytes.length + 2
  const expectedScriptByteLength = messageBytes.length <= 73
    ? messageBytes.length + 4
    : messageBytes.length + 5
  const bytecode = script.bytecode

  assert.equal(bytecode[0], 0x6a)
  assert.equal(bytecode.length, expectedScriptByteLength)

  let payloadStart: number
  let declaredPayloadByteLength: number
  if (payloadByteLength <= 75) {
    assert.equal(bytecode[1], payloadByteLength)
    payloadStart = 2
    declaredPayloadByteLength = bytecode[1]
  } else {
    assert.equal(bytecode[1], 0x4c)
    assert.equal(bytecode[2], payloadByteLength)
    payloadStart = 3
    declaredPayloadByteLength = bytecode[2]
  }

  const payload = bytecode.slice(payloadStart)
  assert.equal(declaredPayloadByteLength, payload.length)
  assert.equal(bytesToHex(payload.slice(0, 2)), TONALLI_MESSAGE_PREFIX_HEX)
  assert.deepEqual(payload.slice(2), messageBytes)
  assert.equal(payload.length, payloadByteLength)
  assert.equal(script.toHex(), bytesToHex(bytecode))
  assert.deepEqual(getStackArray(script.toHex()), [TONALLI_MESSAGE_PREFIX_HEX + bytesToHex(messageBytes)])
}

const VALID_RAW_TX_PREVIEW: RawTxPreview = {
  bytes: 86,
  inputs: 1,
  outputs: 1,
  totalOutputSats: '1000',
  totalOutputXec: '10.00',
  feeSats: '500',
  feeXec: '5.00',
  outputSummary: [{
    sats: '1000',
    xec: '10.00',
    script: '76a91400112233445566778899aabbccdd'
  }]
}

function installReadyRawPreview(wallet: WcWallet) {
  ;(wallet as unknown as {
    buildRawTxPreview: () => Promise<RawTxPreview>
  }).buildRawTxPreview = async () => ({ ...VALID_RAW_TX_PREVIEW })
}

function buildPendingRawRequest(
  rawTxPreviewStatus: RawTxPreviewStatus,
  rawTxPreview?: RawTxPreview,
  id = 900
): PendingRequest {
  return {
    id,
    topic: 't1',
    method: 'ecash_signAndBroadcastTransaction',
    chainId: 'ecash:1',
    params: {
      offerId: `offer-${id}`,
      mode: 'tx',
      requestMode: 'tx',
      rawHex: SIGNED_RAW_HEX
    },
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    createdAt: Math.floor(Date.now() / 1000),
    rawTxPreview,
    rawTxPreviewStatus
  }
}

function setPendingRequest(wallet: WcWallet, request: PendingRequest) {
  ;(wallet as unknown as {
    setState: (next: Record<string, unknown>) => void
  }).setState({
    pendingRequest: request,
    pendingRequestError: null,
    pendingRequestBusy: false,
    pendingRequestResolved: false,
    pendingRequestTxid: null,
    pendingRequestStatus: 'pending'
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

test('buildOpReturnScript aplica la política pública de ecash-lib en la matriz UTF-8 completa', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })()
  const buildOpReturnScript = getOpReturnBuilder(wallet)
  const messageByteLengths = [0, 1, 72, 73, 74, 75, 76, 217, 218, 219, 220, 221] as const
  const derivedMaxMessageByteLength = OP_RETURN_MAX_BYTES - 5

  assert.equal(OP_RETURN_MAX_BYTES, 223)
  assert.equal(derivedMaxMessageByteLength, 218)

  for (const messageByteLength of messageByteLengths) {
    const message = messageByteLength === 0 ? ' \n\t ' : 'a'.repeat(messageByteLength)

    if (messageByteLength === 0) {
      assert.equal(buildOpReturnScript(message), null)
      continue
    }

    if (messageByteLength <= derivedMaxMessageByteLength) {
      const script = buildOpReturnScript(message)
      assert.ok(script)
      assertTonalliOpReturnRoundTrip(script, message)
      if (messageByteLength === 73) {
        assert.equal(script.toHex().slice(0, 4), '6a4b')
        assert.equal(script.bytecode.length, 77)
      }
      if (messageByteLength === 74) {
        assert.equal(script.toHex().slice(0, 6), '6a4c4c')
        assert.equal(script.bytecode.length, 79)
      }
      if (messageByteLength === derivedMaxMessageByteLength) {
        assert.equal(script.bytecode.length, OP_RETURN_MAX_BYTES)
        assert.doesNotThrow(() => getStackArray(script.toHex()))
      }
      continue
    }

    const candidateScriptByteLength = messageByteLength + 5
    let rejectedScript: OpReturnScriptLike | null | undefined
    assert.throws(
      () => {
        rejectedScript = buildOpReturnScript(message)
      },
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, new RegExp(`produce ${candidateScriptByteLength} bytes`))
        assert.match(err.message, new RegExp(`máximo permitido es ${OP_RETURN_MAX_BYTES} bytes`))
        assert.match(err.message, new RegExp(`Longitud UTF-8 del mensaje: ${messageByteLength} bytes`))
        return true
      }
    )
    assert.equal(rejectedScript, undefined)
  }
})

test('buildOpReturnScript conserva prefijo, contenido y fronteras con Unicode multibyte', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })()
  const buildOpReturnScript = getOpReturnBuilder(wallet)
  const unicodeCases = [
    { label: 'ASCII', message: 'A', expectedBytes: 1, accepted: true },
    { label: 'UTF-8 de dos bytes', message: 'é', expectedBytes: 2, accepted: true },
    { label: 'UTF-8 de tres bytes', message: '€', expectedBytes: 3, accepted: true },
    { label: 'emoji de cuatro bytes', message: '😀', expectedBytes: 4, accepted: true },
    { label: 'composición exacta de 73 bytes', message: `${'a'.repeat(64)}é€😀`, expectedBytes: 73, accepted: true },
    { label: 'composición exacta de 74 bytes', message: `${'a'.repeat(65)}é€😀`, expectedBytes: 74, accepted: true },
    { label: 'composición exacta de 218 bytes', message: `${'a'.repeat(209)}é€😀`, expectedBytes: 218, accepted: true },
    { label: 'composición exacta de 219 bytes', message: `${'a'.repeat(210)}é€😀`, expectedBytes: 219, accepted: false }
  ] as const

  for (const unicodeCase of unicodeCases) {
    assert.equal(new TextEncoder().encode(unicodeCase.message.trim()).length, unicodeCase.expectedBytes, unicodeCase.label)
    if (unicodeCase.label !== 'ASCII') {
      assert.notEqual(unicodeCase.message.length, unicodeCase.expectedBytes, unicodeCase.label)
    }

    if (unicodeCase.accepted) {
      const script = buildOpReturnScript(`  ${unicodeCase.message}  `)
      assert.ok(script)
      assertTonalliOpReturnRoundTrip(script, `  ${unicodeCase.message}  `)
      continue
    }

    assert.throws(
      () => buildOpReturnScript(unicodeCase.message),
      /produce 224 bytes; el máximo permitido es 223 bytes\. Longitud UTF-8 del mensaje: 219 bytes\./
    )
  }
})

test('buildOpReturnScript conserva trim sin truncamiento ni bytes adicionales', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })()
  const buildOpReturnScript = getOpReturnBuilder(wallet)
  const normalized = buildOpReturnScript('Tonalli 😀')
  const padded = buildOpReturnScript('  Tonalli 😀  ')

  assert.ok(normalized)
  assert.ok(padded)
  assert.equal(padded.toHex(), normalized.toHex())
  assertTonalliOpReturnRoundTrip(padded, '  Tonalli 😀  ')
})

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

test('approveSession fuerza namespace ecash con ecash:1 y signAndBroadcastTransaction', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qqtestaddress'

  let approvedPayload:
    | {
        id: number
        namespaces: Record<string, unknown>
      }
    | undefined

  const wallet = new (WcWallet as unknown as { new (): WcWallet })()
  ;(wallet as unknown as { web3wallet: unknown }).web3wallet = {
    async approveSession(payload: { id: number; namespaces: Record<string, unknown> }) {
      approvedPayload = payload
      return { topic: 'topic-1' }
    },
    getActiveSessions() {
      return {}
    }
  }

  await wallet.approveSession(
    777,
    {
      ecash: {
        chains: ['ecash:999'],
        methods: ['ecash_unknown'],
        events: ['unknownEvent'],
        accounts: ['ecash:1:ecash:qqlegacy']
      }
    } as unknown as SessionTypes.Namespaces,
    ['ecash:999']
  )

  assert.ok(approvedPayload)
  assert.equal(approvedPayload.id, 777)
  assert.deepEqual(approvedPayload.namespaces, {
    ecash: {
      chains: ['ecash:1', 'ecash:mainnet'],
      methods: ['ecash_signAndBroadcastTransaction', 'ecash_signAndBroadcast', 'ecash_getAddresses', 'ecash_signMessage'],
      events: ['accountsChanged'],
      accounts: ['ecash:1:qqtestaddress', 'ecash:mainnet:qqtestaddress']
    }
  })

  xolosWalletService.getAddress = originalGetAddress
})

test('proposal acepta ecash_signMessage junto con ecash_getAddresses', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    proposalSupportsEcashV2: (proposal: unknown) => boolean
  }

  const accepted = wallet.proposalSupportsEcashV2({
    id: 500,
    params: {
      requiredNamespaces: {
        ecash: {
          chains: ['ecash:1'],
          methods: ['ecash_getAddresses', 'ecash_signMessage']
        }
      },
      optionalNamespaces: {},
      proposer: { metadata: { name: 'Mining Gateway' } }
    }
  })

  assert.equal(accepted, true)
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

test('session_request ecash_signMessage no llama parseSignAndBroadcastParams y queda pendiente', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  const { wallet, responses, sessionRequest } = buildWalletHarness()
  ;(wallet as unknown as {
    parseSignAndBroadcastParams: (input: unknown) => { params: unknown; error: { code: number; message: string } | null }
  }).parseSignAndBroadcastParams = () => {
    throw new Error('parseSignAndBroadcastParams should not be called for ecash_signMessage')
  }

  await sessionRequest({
    topic: 't1',
    id: 104,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signMessage',
        params: {
          message: 'exact challenge message',
          domain: 'ecash.mx',
          purpose: 'mining-gateway-session',
          challengeId: 'challenge-1'
        }
      }
    }
  })

  assert.equal(responses.length, 0)
  assert.equal(wallet.getState().pendingRequest?.method, 'ecash_signMessage')
  assert.equal(wallet.getState().pendingRequest?.params.message, 'exact challenge message')

  xolosWalletService.getAddress = originalGetAddress
})

test('request raw firmado válido responde { txid } con controles locales', async () => {
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
  installReadyRawPreview(wallet)
  ;(wallet as unknown as { assertBroadcastFeePolicy: () => Promise<void> }).assertBroadcastFeePolicy = async () => {}

  await sessionRequest({
    topic: 't1',
    id: 104,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signAndBroadcastTransaction',
        params: {
          offerId: 'offer-2',
          rawHex: SIGNED_RAW_HEX
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

test('approvePendingRequest ecash_signMessage responde signature publicKey y address', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  const originalGetSignatory = xolosWalletService.getSignatory
  const originalSignMessage = xolosWalletService.signMessage

  xolosWalletService.getAddress = () => 'ecash:qsigner'
  xolosWalletService.getSignatory = () => ({
    address: 'ecash:qsigner',
    publicKeyHex: '02' + '11'.repeat(32),
    publicKey: new Uint8Array(),
    signatory: (() => undefined) as never
  })
  xolosWalletService.signMessage = async (message: string) => {
    assert.equal(message, 'exact challenge message')
    return 'signed-message'
  }

  const { wallet, responses, sessionRequest } = buildWalletHarness()

  await sessionRequest({
    topic: 't1',
    id: 1045,
    params: {
      chainId: 'ecash:1',
      request: {
        method: 'ecash_signMessage',
        params: {
          message: 'exact challenge message',
          address: 'ecash:qsigner',
          domain: 'ecash.mx',
          purpose: 'mining-gateway-session',
          challengeId: 'challenge-2'
        }
      }
    }
  })

  await wallet.approvePendingRequest()

  assert.equal(responses.length, 1)
  assert.deepEqual(responses[0].response.result, {
    signature: 'signed-message',
    publicKey: '02' + '11'.repeat(32),
    pubkey: '02' + '11'.repeat(32),
    address: 'ecash:qsigner',
    challengeId: 'challenge-2'
  })
  assert.equal(wallet.getState().pendingRequest, null)

  xolosWalletService.getAddress = originalGetAddress
  xolosWalletService.getSignatory = originalGetSignatory
  xolosWalletService.signMessage = originalSignMessage
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
    assert.equal(outputs[0].valueSats, '1200')
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

test('XEC estructurado con mensaje de 219 bytes responde -32602 antes de estado, cola o efectos', async () => {
  const chronik = getChronik() as unknown as {
    address: (address: string) => { utxos: () => Promise<unknown> }
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalAddress = chronik.address
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  const originalGetAddress = xolosWalletService.getAddress
  const originalGetSignatory = xolosWalletService.getSignatory
  let enqueueCalls = 0
  let activationCalls = 0
  let signerCalls = 0
  let utxoCalls = 0
  let outputsRouteCalls = 0
  let feePolicyCalls = 0
  let validateCalls = 0
  let broadcastCalls = 0

  xolosWalletService.getAddress = () => 'ecash:qtestaddress'
  xolosWalletService.getSignatory = () => {
    signerCalls += 1
    throw new Error('getSignatory no debe ejecutarse para un OP_RETURN fuera de política')
  }
  chronik.address = () => ({
    utxos: async () => {
      utxoCalls += 1
      return { utxos: [] }
    }
  })
  chronik.validateRawTx = async () => {
    validateCalls += 1
    return {}
  }
  chronik.broadcastTx = async () => {
    broadcastCalls += 1
    return { txid: '9'.repeat(64) }
  }

  try {
    const { wallet, responses, sessionRequest } = buildWalletHarness()
    ;(wallet as unknown as {
      enqueuePendingRequest: () => Promise<boolean>
      activatePendingRequest: () => Promise<void>
      buildSignBroadcastFromOutputs: () => Promise<{ txid: string }>
      assertBroadcastFeePolicy: () => Promise<void>
    }).enqueuePendingRequest = async () => {
      enqueueCalls += 1
      return true
    }
    ;(wallet as unknown as { activatePendingRequest: () => Promise<void> }).activatePendingRequest = async () => {
      activationCalls += 1
    }
    ;(wallet as unknown as { buildSignBroadcastFromOutputs: () => Promise<{ txid: string }> }).buildSignBroadcastFromOutputs = async () => {
      outputsRouteCalls += 1
      return { txid: '8'.repeat(64) }
    }
    ;(wallet as unknown as { assertBroadcastFeePolicy: () => Promise<void> }).assertBroadcastFeePolicy = async () => {
      feePolicyCalls += 1
    }
    const debugStateBefore = getWcDebugState()

    await sessionRequest({
      topic: 't1',
      id: 1072,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            offerId: 'offer-op-return-219',
            outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }],
            message: 'a'.repeat(219)
          }
        }
      }
    })

    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.error?.code, -32602)
    assert.equal(
      responses[0].response.error?.message,
      'message OP_RETURN produce 224 bytes; el máximo permitido es 223 bytes. Longitud UTF-8 del mensaje: 219 bytes.'
    )
    assert.equal(wallet.getState().pendingRequest, null)
    assert.equal(wallet.getState().pendingQueueSize, 0)
    assert.equal(getWcDebugState(), debugStateBefore)
    assert.deepEqual(
      {
        enqueueCalls,
        activationCalls,
        signerCalls,
        utxoCalls,
        outputsRouteCalls,
        feePolicyCalls,
        validateCalls,
        broadcastCalls
      },
      {
        enqueueCalls: 0,
        activationCalls: 0,
        signerCalls: 0,
        utxoCalls: 0,
        outputsRouteCalls: 0,
        feePolicyCalls: 0,
        validateCalls: 0,
        broadcastCalls: 0
      }
    )
  } finally {
    chronik.address = originalAddress
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
    xolosWalletService.getAddress = originalGetAddress
    xolosWalletService.getSignatory = originalGetSignatory
  }
})

test('XEC estructurado con mensaje de 218 bytes puede continuar y aprobarse', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'
  const message = 'a'.repeat(OP_RETURN_MAX_BYTES - 5)

  try {
    const { wallet, responses, sessionRequest } = buildWalletHarness()
    let outputsRouteCalls = 0
    ;(wallet as unknown as {
      buildSignBroadcastFromOutputs: (
        outputs: Array<{ address: string; valueSats: string }>,
        message?: string
      ) => Promise<{ txid: string }>
      emitOfferConsumed: () => Promise<void>
    }).buildSignBroadcastFromOutputs = async (outputs, receivedMessage) => {
      outputsRouteCalls += 1
      assert.equal(outputs.length, 1)
      assert.equal(receivedMessage, message)
      return { txid: '2'.repeat(64) }
    }
    ;(wallet as unknown as { emitOfferConsumed: () => Promise<void> }).emitOfferConsumed = async () => {}

    await sessionRequest({
      topic: 't1',
      id: 1073,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            offerId: 'offer-op-return-218',
            outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }],
            message
          }
        }
      }
    })

    assert.equal(responses.length, 0)
    assert.equal(wallet.getState().pendingRequest?.params.message, message)
    await wallet.approvePendingRequest()
    assert.equal(outputsRouteCalls, 1)
    assert.equal((responses[0].response.result as { txid: string }).txid, '2'.repeat(64))
  } finally {
    xolosWalletService.getAddress = originalGetAddress
  }
})

test('XEC estructurado fuera de política no se encola cuando otra solicitud está activa', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  try {
    const { wallet, responses, sessionRequest } = buildWalletHarness()
    const activeRequest: PendingRequest = {
      id: 1075,
      topic: 't1',
      method: 'ecash_signAndBroadcastTransaction',
      chainId: 'ecash:1',
      params: {
        offerId: 'active-op-return-intent',
        requestMode: 'intent',
        outputs: [{ address: 'ecash:qrecipient', valueSats: '1200' }]
      },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: Math.floor(Date.now() / 1000),
      rawTxPreviewStatus: 'idle'
    }
    setPendingRequest(wallet, activeRequest)
    let enqueueCalls = 0
    ;(wallet as unknown as { enqueuePendingRequest: () => Promise<boolean> }).enqueuePendingRequest = async () => {
      enqueueCalls += 1
      return true
    }
    const debugStateBefore = getWcDebugState()

    await sessionRequest({
      topic: 't1',
      id: 1076,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            offerId: 'queued-op-return-219',
            outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }],
            message: 'a'.repeat(219)
          }
        }
      }
    })

    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.error?.code, -32602)
    assert.equal(wallet.getState().pendingRequest?.id, activeRequest.id)
    assert.equal(wallet.getState().pendingQueueSize, 0)
    assert.equal(enqueueCalls, 0)
    assert.equal(getWcDebugState(), debugStateBefore)
  } finally {
    xolosWalletService.getAddress = originalGetAddress
  }
})

test('RMZ/ALP con message no soportado conserva su error existente fuera del gate XEC', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  try {
    const { wallet, responses, sessionRequest } = buildWalletHarness()
    await sessionRequest({
      topic: 't1',
      id: 1074,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            offerId: 'offer-token-message',
            mode: 'intent',
            outputs: [
              {
                address: 'ecash:qrecipient',
                valueSats: '546',
                token: {
                  protocol: 'ALP',
                  tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
                  amount: '1'
                }
              }
            ],
            message: 'a'.repeat(219)
          }
        }
      }
    })

    assert.equal(responses.length, 0)
    assert.equal(wallet.getState().pendingRequest?.params.message?.length, 219)
    await wallet.approvePendingRequest()
    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.error?.code, -32000)
    assert.equal(
      wallet.getState().pendingRequestError,
      'WalletConnect token intents no soportan message OP_RETURN adicional.'
    )
    assert.match(
      responses[0].response.error?.message ?? '',
      /WalletConnect token intents no soportan message OP_RETURN adicional\./
    )
  } finally {
    xolosWalletService.getAddress = originalGetAddress
  }
})

test('intent RMZ/ALP puro conserva la delegación productiva a wallet.sendETokens', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'
  const chronik = getChronik() as unknown as {
    token: (tokenId: string) => Promise<unknown>
  }
  const originalToken = chronik.token
  const serviceInternals = xolosWalletService as unknown as {
    wallet: unknown
    isReady: boolean
  }
  const originalWallet = serviceInternals.wallet
  const originalIsReady = serviceInternals.isReady

  const { wallet, responses, sessionRequest } = buildWalletHarness()
  let sendETokensCalled = false

  chronik.token = async (tokenId) => {
    assert.equal(tokenId, 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908')
    return {
      tokenType: { protocol: 'ALP' },
      genesisInfo: { decimals: 0 }
    }
  }
  serviceInternals.wallet = {
    async sendETokens(tokenId: string, outputs: Array<{ address: string; amount: number }>) {
      sendETokensCalled = true
      assert.equal(tokenId, 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908')
      assert.deepEqual(outputs, [{ address: 'ecash:qrecipient', amount: 160000 }])
      return 'e'.repeat(64)
    }
  }
  serviceInternals.isReady = true

  try {
    await sessionRequest({
      topic: 't1',
      id: 1071,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            offerId: 'offer-token-output',
            mode: 'intent',
            outputs: [
              {
                address: 'ecash:qrecipient',
                valueSats: '546',
                token: {
                  protocol: 'ALP',
                  tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
                  amount: '160000'
                }
              }
            ]
          }
        }
      }
    })

    assert.equal(
      (
        wallet.getState().pendingRequest?.params.outputs?.[0] as
          | { token?: { protocol: string; tokenId: string; amount: string } }
          | undefined
      )?.token?.amount,
      '160000'
    )

    await wallet.approvePendingRequest()

    assert.equal(sendETokensCalled, true)
    assert.equal(responses.length, 1)
    assert.equal((responses[0].response.result as { txid: string }).txid, 'e'.repeat(64))
  } finally {
    chronik.token = originalToken
    serviceInternals.wallet = originalWallet
    serviceInternals.isReady = originalIsReady
    xolosWalletService.getAddress = originalGetAddress
  }
})

const ambiguousTransactionSourceCases: Array<{
  label: string
  params: Record<string, unknown>
}> = [
  {
    label: 'rawHex + outputs con modo implícito',
    params: { rawHex: SIGNED_RAW_HEX, outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }] }
  },
  {
    label: 'rawHex + outputs con mode intent',
    params: { mode: 'intent', rawHex: SIGNED_RAW_HEX, outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }] }
  },
  {
    label: 'rawHex + outputs con mode tx',
    params: { mode: 'tx', rawHex: SIGNED_RAW_HEX, outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }] }
  },
  {
    label: 'rawHex + outputs con mode legacy',
    params: { mode: 'legacy', rawHex: SIGNED_RAW_HEX, outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }] }
  },
  {
    label: 'unsignedTxHex + outputs',
    params: { unsignedTxHex: SIGNED_RAW_HEX, outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }] }
  }
]

const ambiguousRawSourceAliasCases: Array<{
  label: string
  params: Record<string, unknown>
}> = [
  {
    label: 'alias iguales',
    params: { rawHex: SIGNED_RAW_HEX, unsignedTxHex: SIGNED_RAW_HEX }
  },
  {
    label: 'alias diferentes',
    params: { rawHex: SIGNED_RAW_HEX, unsignedTxHex: UNSIGNED_RAW_HEX }
  },
  {
    label: 'un alias vacío',
    params: { rawHex: '', unsignedTxHex: SIGNED_RAW_HEX }
  }
]

for (const ambiguousCase of ambiguousRawSourceAliasCases) {
  test(`parser rechaza ${ambiguousCase.label} con -32602`, () => {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      parseSignAndBroadcastParams: (input: unknown) => {
        params: unknown
        error: { code: number; message: string } | null
      }
    }
    const parsed = wallet.parseSignAndBroadcastParams(ambiguousCase.params)

    assert.equal(parsed.params, null)
    assert.equal(parsed.error?.code, -32602)
    assert.equal(
      parsed.error?.message,
      'AMBIGUOUS_RAW_SOURCE_ALIAS: rawHex y unsignedTxHex no pueden utilizarse juntos.'
    )
  })
}

for (const ambiguousCase of ambiguousTransactionSourceCases) {
  test(`parser rechaza ${ambiguousCase.label} con -32602`, () => {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      parseSignAndBroadcastParams: (input: unknown) => {
        params: unknown
        error: { code: number; message: string } | null
      }
    }
    const parsed = wallet.parseSignAndBroadcastParams(ambiguousCase.params)

    assert.equal(parsed.params, null)
    assert.equal(parsed.error?.code, -32602)
    assert.match(parsed.error?.message ?? '', /AMBIGUOUS_TRANSACTION_SOURCE/)
    assert.match(parsed.error?.message ?? '', /rawHex y params\.outputs no pueden utilizarse juntos/)
  })
}

test('solicitud mixta se rechaza antes de activación y preview', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qtestaddress'

  try {
    const { wallet, responses, sessionRequest } = buildWalletHarness()
    let activationCalls = 0
    let previewCalls = 0
    ;(wallet as unknown as {
      activatePendingRequest: () => Promise<void>
      buildRawTxPreview: () => Promise<RawTxPreview>
    }).activatePendingRequest = async () => {
      activationCalls += 1
    }
    ;(wallet as unknown as {
      buildRawTxPreview: () => Promise<RawTxPreview>
    }).buildRawTxPreview = async () => {
      previewCalls += 1
      return { ...VALID_RAW_TX_PREVIEW }
    }

    await sessionRequest({
      topic: 't1',
      id: 109,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            rawHex: SIGNED_RAW_HEX,
            outputs: [{ address: 'ecash:qrecipient', valueSats: 1200 }]
          }
        }
      }
    })

    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.error?.code, -32602)
    assert.match(responses[0].response.error?.message ?? '', /AMBIGUOUS_TRANSACTION_SOURCE/)
    assert.equal(activationCalls, 0)
    assert.equal(previewCalls, 0)
    assert.equal(wallet.getState().pendingRequest, null)
  } finally {
    xolosWalletService.getAddress = originalGetAddress
  }
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

test('parser: preserva output.token ALP en intents', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    parseSignAndBroadcastParams: (input: unknown) => {
      params:
        | {
            outputs?: Array<{
              token?: { protocol: 'ALP'; tokenId: string; amount: string }
            }>
            requestMode?: string
          }
        | null
      error: { code: number } | null
    }
  }
  const parsed = wallet.parseSignAndBroadcastParams({
    mode: 'intent',
    outputs: [
      {
        address: 'ecash:qrecipient',
        valueSats: '546',
        token: {
          protocol: 'ALP',
          tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
          amount: '160000'
        }
      }
    ]
  })
  assert.equal(parsed.error, null)
  assert.equal(parsed.params?.requestMode, 'intent')
  assert.deepEqual(parsed.params?.outputs?.[0]?.token, {
    protocol: 'ALP',
    tokenId: 'c923bd0f09c630c5e9980cf518c8d34b6353802a3cb7c3f34fa7cc85c9305908',
    amount: '160000'
  })
})

test('parser: legacy inputsUsed => mode legacy', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    parseSignAndBroadcastParams: (input: unknown) => { params: { requestMode?: string } | null; error: { code: number } | null }
  }
  const parsed = wallet.parseSignAndBroadcastParams({
    mode: 'legacy',
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
    mode: 'legacy',
    inputsUsed: ['no-es-outpoint'],
    outputs: [{ address: 'ecash:qrecipient', valueSats: 900 }]
  })
  assert.equal(parsed.params, null)
  assert.equal(parsed.error?.code, -32602)
  assert.match(parsed.error?.message ?? '', /txid:vout/)
})

test('clasifica rawHex como SIGNED, UNSIGNED o UNPARSEABLE', () => {
  const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
    classifyRawHex: (rawHex: string) => RawHexAnalysis
  }

  assert.equal(wallet.classifyRawHex(SIGNED_RAW_HEX).status, 'SIGNED')
  assert.equal(wallet.classifyRawHex(UNSIGNED_RAW_HEX).status, 'UNSIGNED')
  assert.equal(wallet.classifyRawHex('no-es-hex').status, 'UNPARSEABLE')
  assert.equal(wallet.classifyRawHex('00').status, 'UNPARSEABLE')
})

for (const ineligiblePreviewCase of [
  {
    label: 'UNPARSEABLE',
    rawHex: '00',
    message: 'No se pudo analizar la transacción rawHex localmente.'
  },
  {
    label: 'UNSIGNED',
    rawHex: UNSIGNED_RAW_HEX,
    message: 'WalletConnect rawHex unsigned no está habilitado. Utiliza un intent estructurado con params.outputs.'
  }
] as const) {
  test(`buildRawTxPreview rechaza ${ineligiblePreviewCase.label} sin validar en Chronik`, async () => {
    const chronik = getChronik() as unknown as {
      validateRawTx: (rawTx: string) => Promise<unknown>
    }
    const originalValidateRawTx = chronik.validateRawTx
    let validateCalls = 0
    chronik.validateRawTx = async () => {
      validateCalls += 1
      return {}
    }

    try {
      const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
        buildRawTxPreview: (rawHex: string) => Promise<RawTxPreview>
      }
      const preview = await wallet.buildRawTxPreview(ineligiblePreviewCase.rawHex)

      assert.equal(preview.summaryError, ineligiblePreviewCase.message)
      assert.equal(validateCalls, 0)
    } finally {
      chronik.validateRawTx = originalValidateRawTx
    }
  })
}

test('UNPARSEABLE falla cerrado sin fee policy, validateRawTx ni broadcastTx', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  let validateCalls = 0
  let broadcastCalls = 0
  let feePolicyCalls = 0

  chronik.validateRawTx = async () => {
    validateCalls += 1
    return {}
  }
  chronik.broadcastTx = async () => {
    broadcastCalls += 1
    return { txid: 'a'.repeat(64) }
  }

  try {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      assertBroadcastFeePolicy: () => Promise<void>
      signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }>
    }
    wallet.assertBroadcastFeePolicy = async () => {
      feePolicyCalls += 1
    }

    await assert.rejects(
      () => wallet.signAndBroadcastRawHex('00'),
      /No se pudo analizar la transacción rawHex localmente/
    )
    assert.equal(feePolicyCalls, 0)
    assert.equal(validateCalls, 0)
    assert.equal(broadcastCalls, 0)
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
  }
})

const ineligibleRawIngressCases = [
  {
    label: 'UNPARSEABLE',
    rawHex: '00',
    message: 'No se pudo analizar la transacción rawHex localmente.'
  },
  {
    label: 'UNSIGNED',
    rawHex: UNSIGNED_RAW_HEX,
    message: 'WalletConnect rawHex unsigned no está habilitado. Utiliza un intent estructurado con params.outputs.'
  }
] as const

for (const ineligibleCase of ineligibleRawIngressCases) {
  test(`${ineligibleCase.label} responde -32602 antes de payload, debug, queue, activación o preview`, async () => {
    const chronik = getChronik() as unknown as {
      validateRawTx: (rawTx: string) => Promise<unknown>
      broadcastTx: (rawTx: string) => Promise<{ txid: string }>
    }
    const originalValidateRawTx = chronik.validateRawTx
    const originalBroadcastTx = chronik.broadcastTx
    const originalGetAddress = xolosWalletService.getAddress
    const originalGetSignatory = xolosWalletService.getSignatory
    let enqueueCalls = 0
    let activationCalls = 0
    let previewCalls = 0
    let signerCalls = 0
    let outputsRouteCalls = 0
    let rawRouteCalls = 0
    let feePolicyCalls = 0
    let validateCalls = 0
    let broadcastCalls = 0

    xolosWalletService.getAddress = () => 'ecash:qtestaddress'
    xolosWalletService.getSignatory = () => {
      signerCalls += 1
      throw new Error('getSignatory no debe ejecutarse para rawHex no elegible')
    }
    chronik.validateRawTx = async () => {
      validateCalls += 1
      return {}
    }
    chronik.broadcastTx = async () => {
      broadcastCalls += 1
      return { txid: '9'.repeat(64) }
    }

    try {
      const { wallet, responses, sessionRequest } = buildWalletHarness()
      ;(wallet as unknown as {
        enqueuePendingRequest: () => Promise<boolean>
        activatePendingRequest: () => Promise<void>
        buildRawTxPreview: () => Promise<RawTxPreview>
        buildSignBroadcastFromOutputs: () => Promise<{ txid: string }>
        signAndBroadcastRawHex: () => Promise<{ txid: string }>
        assertBroadcastFeePolicy: () => Promise<void>
      }).enqueuePendingRequest = async () => {
        enqueueCalls += 1
        return true
      }
      ;(wallet as unknown as { activatePendingRequest: () => Promise<void> }).activatePendingRequest = async () => {
        activationCalls += 1
      }
      ;(wallet as unknown as { buildRawTxPreview: () => Promise<RawTxPreview> }).buildRawTxPreview = async () => {
        previewCalls += 1
        return { ...VALID_RAW_TX_PREVIEW }
      }
      ;(wallet as unknown as { buildSignBroadcastFromOutputs: () => Promise<{ txid: string }> }).buildSignBroadcastFromOutputs = async () => {
        outputsRouteCalls += 1
        return { txid: '7'.repeat(64) }
      }
      ;(wallet as unknown as { signAndBroadcastRawHex: () => Promise<{ txid: string }> }).signAndBroadcastRawHex = async () => {
        rawRouteCalls += 1
        return { txid: '8'.repeat(64) }
      }
      ;(wallet as unknown as { assertBroadcastFeePolicy: () => Promise<void> }).assertBroadcastFeePolicy = async () => {
        feePolicyCalls += 1
      }
      const debugStateBefore = getWcDebugState()

      await sessionRequest({
        topic: 't1',
        id: ineligibleCase.label === 'UNPARSEABLE' ? 902 : 903,
        params: {
          chainId: 'ecash:1',
          request: {
            method: 'ecash_signAndBroadcastTransaction',
            params: { offerId: `offer-${ineligibleCase.label.toLowerCase()}`, rawHex: ineligibleCase.rawHex }
          }
        }
      })

      assert.equal(responses.length, 1)
      assert.equal(responses[0].response.error?.code, -32602)
      assert.equal(responses[0].response.error?.message, ineligibleCase.message)
      assert.equal(wallet.getState().pendingRequest, null)
      assert.equal(wallet.getState().pendingQueueSize, 0)
      assert.equal(getWcDebugState(), debugStateBefore)
      assert.deepEqual(
        {
          enqueueCalls,
          activationCalls,
          previewCalls,
          signerCalls,
          outputsRouteCalls,
          rawRouteCalls,
          feePolicyCalls,
          validateCalls,
          broadcastCalls
        },
        {
          enqueueCalls: 0,
          activationCalls: 0,
          previewCalls: 0,
          signerCalls: 0,
          outputsRouteCalls: 0,
          rawRouteCalls: 0,
          feePolicyCalls: 0,
          validateCalls: 0,
          broadcastCalls: 0
        }
      )
    } finally {
      chronik.validateRawTx = originalValidateRawTx
      chronik.broadcastTx = originalBroadcastTx
      xolosWalletService.getAddress = originalGetAddress
      xolosWalletService.getSignatory = originalGetSignatory
    }
  })

  test(`${ineligibleCase.label} no se encola cuando otra solicitud ya está activa`, async () => {
    const originalGetAddress = xolosWalletService.getAddress
    xolosWalletService.getAddress = () => 'ecash:qtestaddress'

    try {
      const { wallet, responses, sessionRequest } = buildWalletHarness()
      const activeRequest: PendingRequest = {
        id: 980,
        topic: 't1',
        method: 'ecash_signAndBroadcastTransaction',
        chainId: 'ecash:1',
        params: {
          offerId: 'active-intent',
          requestMode: 'intent',
          outputs: [{ address: 'ecash:qrecipient', valueSats: '1200' }]
        },
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        createdAt: Math.floor(Date.now() / 1000),
        rawTxPreviewStatus: 'idle'
      }
      setPendingRequest(wallet, activeRequest)
      let enqueueCalls = 0
      let activationCalls = 0
      let previewCalls = 0
      ;(wallet as unknown as { enqueuePendingRequest: () => Promise<boolean> }).enqueuePendingRequest = async () => {
        enqueueCalls += 1
        return true
      }
      ;(wallet as unknown as { activatePendingRequest: () => Promise<void> }).activatePendingRequest = async () => {
        activationCalls += 1
      }
      ;(wallet as unknown as { buildRawTxPreview: () => Promise<RawTxPreview> }).buildRawTxPreview = async () => {
        previewCalls += 1
        return { ...VALID_RAW_TX_PREVIEW }
      }
      const debugStateBefore = getWcDebugState()

      await sessionRequest({
        topic: 't1',
        id: ineligibleCase.label === 'UNPARSEABLE' ? 981 : 982,
        params: {
          chainId: 'ecash:1',
          request: {
            method: 'ecash_signAndBroadcastTransaction',
            params: { offerId: `queued-${ineligibleCase.label.toLowerCase()}`, rawHex: ineligibleCase.rawHex }
          }
        }
      })

      assert.equal(responses.length, 1)
      assert.equal(responses[0].response.error?.code, -32602)
      assert.equal(responses[0].response.error?.message, ineligibleCase.message)
      assert.equal(wallet.getState().pendingRequest?.id, activeRequest.id)
      assert.equal(wallet.getState().pendingQueueSize, 0)
      assert.equal(getWcDebugState(), debugStateBefore)
      assert.equal(enqueueCalls, 0)
      assert.equal(activationCalls, 0)
      assert.equal(previewCalls, 0)
    } finally {
      xolosWalletService.getAddress = originalGetAddress
    }
  })
}

test('signAndBroadcastRawHex rechaza UNSIGNED directamente sin fee policy, validación o broadcast', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  let feePolicyCalls = 0
  let validateCalls = 0
  let broadcastCalls = 0

  chronik.validateRawTx = async () => {
    validateCalls += 1
    return {}
  }
  chronik.broadcastTx = async () => {
    broadcastCalls += 1
    return { txid: '9'.repeat(64) }
  }

  try {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }>
      assertBroadcastFeePolicy: () => Promise<void>
    }
    wallet.assertBroadcastFeePolicy = async () => {
      feePolicyCalls += 1
    }

    await assert.rejects(
      () => wallet.signAndBroadcastRawHex(UNSIGNED_RAW_HEX),
      /rawHex unsigned no está habilitado/
    )
    assert.equal(feePolicyCalls, 0)
    assert.equal(validateCalls, 0)
    assert.equal(broadcastCalls, 0)
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
  }
})

test('rawHex firmado ejecuta parseo local, fee policy, validación y broadcast en orden', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  const order: string[] = []
  let broadcastCalls = 0

  chronik.validateRawTx = async (rawTx) => {
    assert.equal(rawTx, SIGNED_RAW_HEX)
    order.push('validateRawTx')
    return {}
  }
  chronik.broadcastTx = async (rawTx) => {
    assert.equal(rawTx, SIGNED_RAW_HEX)
    order.push('broadcastTx')
    broadcastCalls += 1
    return { txid: 'b'.repeat(64) }
  }

  try {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      classifyRawHex: (rawHex: string) => RawHexAnalysis
      assertBroadcastFeePolicy: () => Promise<void>
      signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }>
    }
    const classifyRawHex = wallet.classifyRawHex.bind(wallet)
    wallet.classifyRawHex = (rawHex) => {
      order.push('Tx.fromHex')
      return classifyRawHex(rawHex)
    }
    wallet.assertBroadcastFeePolicy = async () => {
      order.push('assertBroadcastFeePolicy')
    }

    const result = await wallet.signAndBroadcastRawHex(SIGNED_RAW_HEX)
    assert.equal(result.txid, 'b'.repeat(64))
    assert.deepEqual(order, [
      'Tx.fromHex',
      'assertBroadcastFeePolicy',
      'validateRawTx',
      'broadcastTx'
    ])
    assert.equal(broadcastCalls, 1)
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
  }
})

test('rawHex firmado conserva el mismo raw normalizado y Tx desde preview hasta broadcast', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  const originalGetAddress = xolosWalletService.getAddress
  const normalizedRawHex = SIGNED_RAW_HEX
  let classifiedTx: unknown = null
  let feePolicyTx: unknown = null
  const validatedRawHex: string[] = []
  const broadcastRawHex: string[] = []
  const order: string[] = []

  xolosWalletService.getAddress = () => 'ecash:qtestaddress'
  chronik.validateRawTx = async (rawTx) => {
    validatedRawHex.push(rawTx)
    if (validatedRawHex.length === 1) {
      order.push('preview')
      return {
        size: 86,
        inputs: [{ sats: 1500n }],
        outputs: [{
          sats: 1000n,
          outputScript: '76a91400112233445566778899aabbccddeeff0011223388ac'
        }]
      }
    }
    order.push('validateRawTx')
    return {}
  }
  chronik.broadcastTx = async (rawTx) => {
    broadcastRawHex.push(rawTx)
    order.push('broadcastTx')
    return { txid: '6'.repeat(64) }
  }

  try {
    const { wallet, responses, sessionRequest } = buildWalletHarness()
    const classifyRawHex = (wallet as unknown as {
      classifyRawHex: (rawHex: string) => RawHexAnalysis
    }).classifyRawHex.bind(wallet)
    ;(wallet as unknown as {
      classifyRawHex: (rawHex: string) => RawHexAnalysis
    }).classifyRawHex = (rawHex) => {
      order.push('Tx.fromHex')
      const analysis = classifyRawHex(rawHex)
      classifiedTx = analysis.status === 'SIGNED' ? analysis.tx : null
      return analysis
    }
    ;(wallet as unknown as {
      assertBroadcastFeePolicy: (tx: unknown) => Promise<void>
    }).assertBroadcastFeePolicy = async (tx) => {
      order.push('assertBroadcastFeePolicy')
      feePolicyTx = tx
    }
    ;(wallet as unknown as { emitOfferConsumed: () => Promise<void> }).emitOfferConsumed = async () => {}

    await sessionRequest({
      topic: 't1',
      id: 903,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_signAndBroadcastTransaction',
          params: {
            offerId: 'offer-content-binding',
            mode: 'tx',
            rawHex: `  ${normalizedRawHex.toUpperCase()}\n`
          }
        }
      }
    })

    assert.equal(wallet.getState().pendingRequest?.params.rawHex, normalizedRawHex)
    assert.equal(wallet.getState().pendingRequest?.rawTxPreviewStatus, 'ready')
    assert.ok(classifiedTx)
    assert.deepEqual(validatedRawHex, [normalizedRawHex])
    assert.deepEqual(order, ['Tx.fromHex', 'preview'])

    await wallet.approvePendingRequest()

    assert.equal(feePolicyTx, classifiedTx)
    assert.deepEqual(validatedRawHex, [normalizedRawHex, normalizedRawHex])
    assert.deepEqual(broadcastRawHex, [normalizedRawHex])
    assert.equal(broadcastRawHex.length, 1)
    assert.deepEqual(order, [
      'Tx.fromHex',
      'preview',
      'assertBroadcastFeePolicy',
      'validateRawTx',
      'broadcastTx'
    ])
    assert.equal(responses.length, 1)
    assert.equal((responses[0].response.result as { txid: string }).txid, '6'.repeat(64))
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
    xolosWalletService.getAddress = originalGetAddress
  }
})

test('rechazo de fee policy impide validateRawTx y broadcastTx', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  let validateCalls = 0
  let broadcastCalls = 0

  chronik.validateRawTx = async () => {
    validateCalls += 1
    return {}
  }
  chronik.broadcastTx = async () => {
    broadcastCalls += 1
    return { txid: 'c'.repeat(64) }
  }

  try {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      assertBroadcastFeePolicy: () => Promise<void>
      signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }>
    }
    wallet.assertBroadcastFeePolicy = async () => {
      throw new Error('fee rejected')
    }

    await assert.rejects(() => wallet.signAndBroadcastRawHex(SIGNED_RAW_HEX), /fee rejected/)
    assert.equal(validateCalls, 0)
    assert.equal(broadcastCalls, 0)
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
  }
})

test('rechazo de validateRawTx impide broadcastTx', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  let broadcastCalls = 0

  chronik.validateRawTx = async () => {
    throw new Error('validation rejected')
  }
  chronik.broadcastTx = async () => {
    broadcastCalls += 1
    return { txid: 'd'.repeat(64) }
  }

  try {
    const wallet = new (WcWallet as unknown as { new (): WcWallet })() as unknown as {
      assertBroadcastFeePolicy: () => Promise<void>
      signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }>
    }
    wallet.assertBroadcastFeePolicy = async () => {}

    await assert.rejects(
      () => wallet.signAndBroadcastRawHex(SIGNED_RAW_HEX),
      /validation rejected/
    )
    assert.equal(broadcastCalls, 0)
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
  }
})

test('activación interna UNPARSEABLE mantiene preview fail-closed y bloquea aprobación directa', async () => {
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<unknown>
    broadcastTx: (rawTx: string) => Promise<{ txid: string }>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const originalBroadcastTx = chronik.broadcastTx
  let validateCalls = 0
  let broadcastCalls = 0
  let feePolicyCalls = 0

  chronik.validateRawTx = async () => {
    validateCalls += 1
    return {}
  }
  chronik.broadcastTx = async () => {
    broadcastCalls += 1
    return { txid: 'e'.repeat(64) }
  }

  try {
    const { wallet, responses } = buildWalletHarness()
    ;(wallet as unknown as { assertBroadcastFeePolicy: () => Promise<void> }).assertBroadcastFeePolicy = async () => {
      feePolicyCalls += 1
    }
    const activatePendingRequest = (wallet as unknown as {
      activatePendingRequest: (payload: unknown) => Promise<void>
    }).activatePendingRequest.bind(wallet)

    await activatePendingRequest({
      id: 901,
      topic: 't1',
      method: 'ecash_signAndBroadcastTransaction',
      chainId: 'ecash:1',
      params: { offerId: 'offer-unparseable', mode: 'tx', requestMode: 'tx', rawHex: '00' },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: Math.floor(Date.now() / 1000)
    })

    assert.equal(wallet.getState().pendingRequest?.rawTxPreviewStatus, 'error')
    assert.match(
      wallet.getState().pendingRequest?.rawTxPreview?.summaryError ?? '',
      /No se pudo analizar la transacción rawHex localmente/
    )

    await wallet.approvePendingRequest()

    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.error?.code, 4001)
    assert.equal(feePolicyCalls, 0)
    assert.equal(validateCalls, 0)
    assert.equal(broadcastCalls, 0)
  } finally {
    chronik.validateRawTx = originalValidateRawTx
    chronik.broadcastTx = originalBroadcastTx
  }
})

const blockedPreviewCases: Array<{
  label: string
  status: RawTxPreviewStatus
  preview?: RawTxPreview
}> = [
  { label: 'idle', status: 'idle' },
  { label: 'loading', status: 'loading' },
  {
    label: 'error',
    status: 'error',
    preview: { ...VALID_RAW_TX_PREVIEW, summaryError: 'preview failed' }
  },
  {
    label: 'summaryError',
    status: 'ready',
    preview: { ...VALID_RAW_TX_PREVIEW, summaryError: 'inconsistent preview' }
  }
]

for (const previewCase of blockedPreviewCases) {
  test(`approvePendingRequest bloquea rawHex en ${previewCase.label}`, async () => {
    const { wallet, responses } = buildWalletHarness()
    setPendingRequest(wallet, buildPendingRawRequest(previewCase.status, previewCase.preview))
    let rawProcessingCalls = 0
    ;(wallet as unknown as {
      signAndBroadcastRawHex: (rawHex: string) => Promise<{ txid: string }>
    }).signAndBroadcastRawHex = async () => {
      rawProcessingCalls += 1
      return { txid: 'f'.repeat(64) }
    }

    await wallet.approvePendingRequest()

    assert.equal(rawProcessingCalls, 0)
    assert.equal(responses.length, 1)
    assert.equal(responses[0].response.error?.code, 4001)
    assert.equal(
      responses[0].response.error?.message,
      previewCase.preview?.summaryError ?? 'No se puede aprobar sin un resumen válido.'
    )
  })
}

test('approvePendingRequest permite rawHex solo en ready con preview válido', async () => {
  const { wallet, responses } = buildWalletHarness()
  setPendingRequest(wallet, buildPendingRawRequest('ready', { ...VALID_RAW_TX_PREVIEW }, 910))
  let rawProcessingCalls = 0
  ;(wallet as unknown as {
    signAndBroadcastRawHex: (rawHex: string, analysis?: RawHexAnalysis) => Promise<{ txid: string }>
    emitOfferConsumed: () => Promise<void>
  }).signAndBroadcastRawHex = async () => {
    rawProcessingCalls += 1
    return { txid: '1'.repeat(64) }
  }
  ;(wallet as unknown as { emitOfferConsumed: () => Promise<void> }).emitOfferConsumed = async () => {}

  await wallet.approvePendingRequest()

  assert.equal(rawProcessingCalls, 1)
  assert.equal(responses.length, 1)
  assert.equal((responses[0].response.result as { txid: string }).txid, '1'.repeat(64))
})

test('preview tardío de otra solicitud no actualiza ni desbloquea la solicitud vigente', async () => {
  type PreviewValidation = {
    size: number
    inputs: Array<{ sats: bigint }>
    outputs: Array<{ sats: bigint; outputScript: string }>
  }
  const chronik = getChronik() as unknown as {
    validateRawTx: (rawTx: string) => Promise<PreviewValidation>
  }
  const originalValidateRawTx = chronik.validateRawTx
  const firstPreview = deferred<PreviewValidation>()
  const secondPreview = deferred<PreviewValidation>()
  let validateCalls = 0
  chronik.validateRawTx = async () => {
    validateCalls += 1
    return validateCalls === 1 ? firstPreview.promise : secondPreview.promise
  }

  const previewResult: PreviewValidation = {
    size: 86,
    inputs: [{ sats: 1500n }],
    outputs: [{
      sats: 1000n,
      outputScript: '76a91400112233445566778899aabbccddeeff0011223388ac'
    }]
  }

  try {
    const { wallet } = buildWalletHarness()
    const activatePendingRequest = (wallet as unknown as {
      activatePendingRequest: (payload: unknown) => Promise<void>
    }).activatePendingRequest.bind(wallet)
    const payload = (id: number) => ({
      id,
      topic: 't1',
      method: 'ecash_signAndBroadcastTransaction',
      chainId: 'ecash:1',
      params: {
        offerId: `offer-${id}`,
        mode: 'tx',
        requestMode: 'tx',
        rawHex: SIGNED_RAW_HEX
      },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      createdAt: Math.floor(Date.now() / 1000)
    })

    const firstActivation = activatePendingRequest(payload(920))
    assert.equal(wallet.getState().pendingRequest?.id, 920)
    assert.equal(wallet.getState().pendingRequest?.rawTxPreviewStatus, 'loading')

    const secondActivation = activatePendingRequest(payload(921))
    assert.equal(wallet.getState().pendingRequest?.id, 921)
    assert.equal(wallet.getState().pendingRequest?.rawTxPreviewStatus, 'loading')

    firstPreview.resolve(previewResult)
    await firstActivation
    assert.equal(wallet.getState().pendingRequest?.id, 921)
    assert.equal(wallet.getState().pendingRequest?.rawTxPreviewStatus, 'loading')
    assert.equal(wallet.getState().pendingRequest?.rawTxPreview, undefined)

    secondPreview.resolve(previewResult)
    await secondActivation
    assert.equal(wallet.getState().pendingRequest?.id, 921)
    assert.equal(wallet.getState().pendingRequest?.rawTxPreviewStatus, 'ready')
    assert.equal(wallet.getState().pendingRequest?.rawTxPreview?.totalOutputSats, '1000')
  } finally {
    chronik.validateRawTx = originalValidateRawTx
  }
})

test('ecash_getAddresses conserva la respuesta de la cuenta activa', async () => {
  const originalGetAddress = xolosWalletService.getAddress
  xolosWalletService.getAddress = () => 'ecash:qactive'

  try {
    const { responses, sessionRequest } = buildWalletHarness()
    await sessionRequest({
      topic: 't1',
      id: 930,
      params: {
        chainId: 'ecash:1',
        request: {
          method: 'ecash_getAddresses',
          params: {}
        }
      }
    })

    assert.equal(responses.length, 1)
    assert.deepEqual(responses[0].response.result, ['ecash:qactive'])
  } finally {
    xolosWalletService.getAddress = originalGetAddress
  }
})
