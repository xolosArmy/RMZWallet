import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { test, vi } from 'vitest'
import type {
  PendingRequest,
  RawTxPreview,
  RawTxPreviewStatus
} from '../../lib/walletconnect/WcWallet'
import ApproveRequestModal from './ApproveRequestModal'

vi.mock('../../services/XolosWalletService', () => ({
  xolosWalletService: {
    getKeyInfo: () => ({ xecAddress: 'ecash:qactive' })
  }
}))

const VALID_PREVIEW: RawTxPreview = {
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

function requestWithPreview(
  rawTxPreviewStatus: RawTxPreviewStatus,
  rawTxPreview?: RawTxPreview
): PendingRequest {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 1,
    topic: 'topic-preview',
    method: 'ecash_signAndBroadcastTransaction',
    chainId: 'ecash:1',
    params: {
      offerId: 'offer-preview',
      rawHex: '00',
      requestMode: 'tx'
    },
    expiresAt: now + 300,
    createdAt: now,
    rawTxPreview,
    rawTxPreviewStatus
  }
}

function renderModal(request: PendingRequest): string {
  return renderToStaticMarkup(
    <ApproveRequestModal
      open
      request={request}
      onApproved={() => undefined}
      onRejected={() => undefined}
    />
  )
}

function approvalButton(markup: string): string {
  const match = markup.match(/<button[^>]*>Aprobar compra<\/button>/)
  assert.ok(match, 'approval button should be present')
  return match[0]
}

test('UI deshabilita aprobación rawHex en idle', () => {
  const markup = renderModal(requestWithPreview('idle'))
  assert.match(approvalButton(markup), /disabled=""/)
  assert.match(markup, /No se puede aprobar sin un resumen válido/)
})

test('UI muestra cálculo y deshabilita aprobación rawHex en loading', () => {
  const markup = renderModal(requestWithPreview('loading'))
  assert.match(approvalButton(markup), /disabled=""/)
  assert.match(markup, /Calculando resumen…/)
})

test('UI muestra el error del resumen y deshabilita aprobación rawHex', () => {
  const markup = renderModal(requestWithPreview('error', {
    ...VALID_PREVIEW,
    summaryError: 'preview controlado falló'
  }))
  assert.match(approvalButton(markup), /disabled=""/)
  assert.match(markup, /preview controlado falló/)
})

test('UI bloquea status ready si el preview contiene summaryError', () => {
  const markup = renderModal(requestWithPreview('ready', {
    ...VALID_PREVIEW,
    summaryError: 'resumen inconsistente'
  }))
  assert.match(approvalButton(markup), /disabled=""/)
  assert.match(markup, /resumen inconsistente/)
})

test('UI habilita aprobación rawHex únicamente con preview ready válido', () => {
  const markup = renderModal(requestWithPreview('ready', { ...VALID_PREVIEW }))
  assert.doesNotMatch(approvalButton(markup), /disabled=""/)
  assert.match(markup, /1 inputs \/ 1 outputs \/ 86 bytes/)
})
