import type { ScriptUtxo } from 'chronik-client'
import { DUMMY_KEYPAIR } from 'ecash-agora'
import {
  ALL_BIP143,
  EccDummy,
  P2PKHSignatory,
  Script,
  TxBuilder,
  alpSend,
  emppScript,
  toHex
} from 'ecash-lib'
import type { Signatory, Tx, TxBuilderInput, TxBuilderOutput } from 'ecash-lib'
import { FIRMA_ALPHA } from '../config/firmaAlpha'
import { TOKEN_DUST_SATS } from '../dex/agoraPhase1'
import { formatTokenAmount } from '../utils/tokenFormat'

export const FIRMA_SEND_FEE_PER_KB = 1200n

export type FirmaSendPreview = Readonly<{
  tokenId: typeof FIRMA_ALPHA.tokenId
  destination: string
  amountAtoms: bigint
  balanceBeforeAtoms: bigint
  balanceAfterAtoms: bigint
  firmaChangeAtoms: bigint
  networkFeeSats: bigint
  inputOutpoints: string[]
  tokenInputOutpoints: string[]
  xecInputOutpoints: string[]
  planFingerprint: string
}>

export type FirmaSendPlan = Readonly<{
  preview: FirmaSendPreview
  walletScript: Script
  tokenInputs: ScriptUtxo[]
  xecInputs: ScriptUtxo[]
  outputs: TxBuilderOutput[]
}>

type BuildFirmaSendPlanParams = {
  walletAddress: string
  destination: string
  amountAtoms: bigint
  utxos: ScriptUtxo[]
}

const outpointKey = (utxo: ScriptUtxo) => `${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`

const compareOutpoints = (a: ScriptUtxo, b: ScriptUtxo) => outpointKey(a).localeCompare(outpointKey(b))

export const isCanonicalFirmaUtxo = (utxo: ScriptUtxo) => {
  const token = utxo.token
  return Boolean(
    token &&
      token.tokenId === FIRMA_ALPHA.tokenId &&
      token.tokenType.protocol === FIRMA_ALPHA.protocol &&
      token.tokenType.number === FIRMA_ALPHA.tokenType &&
      !token.isMintBaton &&
      token.atoms > 0n
  )
}

const selectFirmaInputs = (utxos: ScriptUtxo[], amountAtoms: bigint) => {
  const canonical = utxos.filter(isCanonicalFirmaUtxo)
  const balanceAtoms = canonical.reduce((total, utxo) => total + (utxo.token?.atoms ?? 0n), 0n)
  if (balanceAtoms < amountAtoms) {
    throw new Error(
      `FIRMA insuficiente. Disponible: ${formatTokenAmount(balanceAtoms, FIRMA_ALPHA.decimals)} FIRMA.`
    )
  }

  const sorted = [...canonical].sort((a, b) => {
    const aAtoms = a.token?.atoms ?? 0n
    const bAtoms = b.token?.atoms ?? 0n
    if (aAtoms !== bAtoms) return aAtoms > bAtoms ? -1 : 1
    return compareOutpoints(a, b)
  })
  const selected: ScriptUtxo[] = []
  let selectedAtoms = 0n
  for (const utxo of sorted) {
    selected.push(utxo)
    selectedAtoms += utxo.token?.atoms ?? 0n
    if (selectedAtoms >= amountAtoms) break
  }

  return { selected, selectedAtoms, balanceAtoms }
}

const buildInputs = (
  utxos: ScriptUtxo[],
  outputScript: Script,
  signatory: Signatory
): TxBuilderInput[] =>
  utxos.map((utxo) => ({
    input: {
      prevOut: utxo.outpoint,
      signData: { sats: utxo.sats, outputScript }
    },
    signatory
  }))

const txFee = (tx: Tx, inputSats: bigint) =>
  inputSats - tx.outputs.reduce((total, output) => total + output.sats, 0n)

const fingerprint = (params: {
  destinationScript: Script
  amountAtoms: bigint
  tokenChangeAtoms: bigint
  networkFeeSats: bigint
  inputs: ScriptUtxo[]
  tx: Tx
}) =>
  [
    FIRMA_ALPHA.tokenId,
    FIRMA_ALPHA.protocol,
    FIRMA_ALPHA.tokenType.toString(),
    toHex(params.destinationScript.bytecode),
    params.amountAtoms.toString(),
    params.tokenChangeAtoms.toString(),
    params.networkFeeSats.toString(),
    ...params.inputs.map(outpointKey),
    ...params.tx.outputs.map((output) => `${output.sats}:${toHex(output.script.bytecode)}`)
  ].join('|')

export function buildFirmaSendPlan(params: BuildFirmaSendPlanParams): FirmaSendPlan {
  if (params.amountAtoms <= 0n) {
    throw new Error('El monto FIRMA debe ser mayor a cero.')
  }

  let walletScript: Script
  let destinationScript: Script
  try {
    walletScript = Script.fromAddress(params.walletAddress.trim())
  } catch {
    throw new Error('No se encontró una dirección activa válida en la wallet.')
  }
  try {
    destinationScript = Script.fromAddress(params.destination.trim())
  } catch {
    throw new Error('La dirección eCash de destino no es válida.')
  }

  const selection = selectFirmaInputs(params.utxos, params.amountAtoms)
  const firmaChangeAtoms = selection.selectedAtoms - params.amountAtoms
  const sendAtoms = firmaChangeAtoms > 0n
    ? [params.amountAtoms, firmaChangeAtoms]
    : [params.amountAtoms]
  const fixedOutputs: TxBuilderOutput[] = [
    { sats: 0n, script: emppScript([alpSend(FIRMA_ALPHA.tokenId, FIRMA_ALPHA.tokenType, sendAtoms)]) },
    { sats: TOKEN_DUST_SATS, script: destinationScript }
  ]
  if (firmaChangeAtoms > 0n) {
    fixedOutputs.push({ sats: TOKEN_DUST_SATS, script: walletScript })
  }

  const pureXecUtxos = params.utxos
    .filter((utxo) => !utxo.token)
    .sort((a, b) => {
      if (a.sats !== b.sats) return a.sats > b.sats ? -1 : 1
      return compareOutpoints(a, b)
    })
  if (pureXecUtxos.length === 0) {
    throw new Error('XEC insuficiente: se necesita al menos un UTXO XEC puro para pagar la comisión.')
  }

  const dummySignatory = P2PKHSignatory(DUMMY_KEYPAIR.sk, DUMMY_KEYPAIR.pk, ALL_BIP143)
  const xecInputs: ScriptUtxo[] = []
  const tokenInputSats = selection.selected.reduce((total, utxo) => total + utxo.sats, 0n)
  const tokenOutputSats = BigInt(sendAtoms.length) * TOKEN_DUST_SATS
  const dustDeficit = tokenOutputSats > tokenInputSats ? tokenOutputSats - tokenInputSats : 0n
  let dummyTx: Tx | null = null
  let networkFeeSats = 0n

  for (const utxo of pureXecUtxos) {
    xecInputs.push(utxo)
    const allInputs = [...selection.selected, ...xecInputs]
    const builder = new TxBuilder({
      inputs: buildInputs(allInputs, walletScript, dummySignatory),
      outputs: [...fixedOutputs, walletScript]
    })
    try {
      const candidateTx = builder.sign({
        ecc: new EccDummy(),
        feePerKb: FIRMA_SEND_FEE_PER_KB,
        dustSats: TOKEN_DUST_SATS
      })
      const inputSats = allInputs.reduce((total, input) => total + input.sats, 0n)
      const candidateFee = txFee(candidateTx, inputSats)
      const pureXecSats = xecInputs.reduce((total, input) => total + input.sats, 0n)
      if (pureXecSats < candidateFee + dustDeficit) continue
      dummyTx = candidateTx
      networkFeeSats = candidateFee
      break
    } catch {
      // Add another pure-XEC input and retry without ever materializing wallet keys.
    }
  }

  if (!dummyTx) {
    throw new Error('XEC insuficiente para cubrir el dust de salida y la comisión de red.')
  }

  const inputs = [...selection.selected, ...xecInputs]
  const planFingerprint = fingerprint({
    destinationScript,
    amountAtoms: params.amountAtoms,
    tokenChangeAtoms: firmaChangeAtoms,
    networkFeeSats,
    inputs,
    tx: dummyTx
  })

  return {
    preview: {
      tokenId: FIRMA_ALPHA.tokenId,
      destination: params.destination.trim(),
      amountAtoms: params.amountAtoms,
      balanceBeforeAtoms: selection.balanceAtoms,
      balanceAfterAtoms: selection.balanceAtoms - params.amountAtoms,
      firmaChangeAtoms,
      networkFeeSats,
      inputOutpoints: inputs.map(outpointKey),
      tokenInputOutpoints: selection.selected.map(outpointKey),
      xecInputOutpoints: xecInputs.map(outpointKey),
      planFingerprint
    },
    walletScript,
    tokenInputs: selection.selected,
    xecInputs,
    outputs: [...fixedOutputs, walletScript]
  }
}

export function createSignedFirmaSendBuilder(
  plan: FirmaSendPlan,
  signatory: Signatory
): TxBuilder {
  return new TxBuilder({
    inputs: buildInputs([...plan.tokenInputs, ...plan.xecInputs], plan.walletScript, signatory),
    outputs: plan.outputs
  })
}
