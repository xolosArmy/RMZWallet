import { Address, Script, Tx, TxBuilder, fromHex } from 'ecash-lib'
import type { WalletSignatory } from '../../services/XolosWalletService'
import { ExternalSignError, type ExternalSignWireRequestV1 } from './contract'
import type { ExternalSignTxReviewV1 } from './review'

type SignedTx = Readonly<{ toHex: () => string }>
type Builder = Readonly<{
  inputs: Array<{ input: { prevOut: unknown; signData?: { sats: bigint; outputScript: Script } }; signatory?: WalletSignatory['signatory'] }>
  sign: () => SignedTx
}>

export type ExternalSignSignerDependencies = Readonly<{
  getSignatory: () => WalletSignatory
  builderFromTx?: (tx: Tx) => Builder
}>

export type ExternalSignResponseV1 = Readonly<{
  protocolId: 'tonalli.external-sign'
  protocolVersion: 1
  requestId: string
  intentId?: string
  mode: 'signOnly'
  contentHash: `sha256:${string}`
  signedTxHex: string
}>

export function signExternalTransactionOnly(
  request: ExternalSignWireRequestV1,
  review: ExternalSignTxReviewV1,
  contentHash: `sha256:${string}`,
  dependencies: ExternalSignSignerDependencies
): ExternalSignResponseV1 {
  const signer = dependencies.getSignatory()
  const signerScript = Address.parse(signer.address).toScriptHex().toLowerCase()
  if (review.inputs.some(input => input.outputScript !== signerScript)) throw new ExternalSignError('SIGNER_WALLET_CHANGED')
  const tx = Tx.fromHex(request.unsignedTxHex)
  const builder = dependencies.builderFromTx?.(tx) ?? TxBuilder.fromTx(tx)
  if (builder.inputs.length !== review.inputs.length) throw new ExternalSignError('SIGNER_INPUT_MISMATCH')
  for (let index = 0; index < builder.inputs.length; index += 1) {
    const reviewedInput = review.inputs[index]
    builder.inputs[index].input.signData = {
      sats: BigInt(reviewedInput.sats),
      outputScript: new Script(fromHex(reviewedInput.outputScript))
    }
    builder.inputs[index].signatory = signer.signatory
  }
  const signedTxHex = builder.sign().toHex()
  return Object.freeze({
    protocolId: request.protocolId,
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ...(request.intentId ? { intentId: request.intentId } : {}),
    mode: request.mode,
    contentHash,
    signedTxHex
  })
}
