import type { ScriptUtxo } from 'chronik-client'
import { DUMMY_KEYPAIR } from 'ecash-agora'
import {
  ALL_BIP143,
  Address,
  EccDummy,
  P2PKHSignatory,
  Script,
  TxBuilder,
  alpSend,
  emppScript,
  fromHex,
  shaRmd160,
  toHex
} from 'ecash-lib'
import type { Signatory, Tx, TxBuilderInput, TxBuilderOutput } from 'ecash-lib'
import { FIRMA_ALPHA } from '../config/firmaAlpha'
import { TOKEN_DUST_SATS } from '../dex/agoraPhase1'
import { formatTokenAmount } from '../utils/tokenFormat'
import {
  getDerivationPath,
  isDerivationProfileId
} from './derivationProfiles'
import type { DerivationProfileId } from './derivationProfiles'

export const FIRMA_SEND_FEE_PER_KB = 1200n

export type FirmaHdBranch = 'receive' | 'change'

export type FirmaInputOwner = Readonly<{
  profileId: DerivationProfileId
  account: 0
  address: string
  hdPath: string
  branch: FirmaHdBranch
  index: number
  publicKeyHex: string
}>

export type FirmaOwnedUtxo = Readonly<{
  utxo: ScriptUtxo
  owner: FirmaInputOwner
}>

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
  changeAddress: string
  changeHdPath: string
  planFingerprint: string
}>

export type FirmaSendPlan = Readonly<{
  preview: FirmaSendPreview
  changeOwner: FirmaInputOwner
  tokenInputs: FirmaOwnedUtxo[]
  xecInputs: FirmaOwnedUtxo[]
  outputs: TxBuilderOutput[]
  estimatedTx: Tx
}>

type BuildFirmaSendPlanParams = {
  changeOwner: FirmaInputOwner
  destination: string
  amountAtoms: bigint
  ownedUtxos: FirmaOwnedUtxo[]
}

export type FirmaInputSignatoryResolver = (owner: FirmaInputOwner) => Signatory

const outpointKey = (ownedUtxo: FirmaOwnedUtxo) => {
  const { outpoint } = ownedUtxo.utxo
  return `${outpoint.txid}:${outpoint.outIdx}`
}

const compareOutpoints = (a: FirmaOwnedUtxo, b: FirmaOwnedUtxo) =>
  outpointKey(a).localeCompare(outpointKey(b))

const ownerScript = (owner: FirmaInputOwner): Script => {
  if (
    !isDerivationProfileId(owner.profileId) ||
    owner.account !== 0 ||
    !owner.hdPath.trim() ||
    owner.index < 0 ||
    !Number.isInteger(owner.index) ||
    owner.hdPath !== getDerivationPath(owner.profileId, owner.branch, owner.index)
  ) {
    throw new Error('La metadata HD propietaria de un input FIRMA no es válida.')
  }
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(owner.publicKeyHex)) {
    throw new Error('La public key HD propietaria de un input FIRMA no es válida.')
  }

  let script: Script
  try {
    script = Script.fromAddress(owner.address)
  } catch {
    throw new Error('La dirección HD propietaria de un input FIRMA no es válida.')
  }

  const addressFromPublicKey = Address.p2pkh(shaRmd160(fromHex(owner.publicKeyHex))).toString()
  if (toHex(Script.fromAddress(addressFromPublicKey).bytecode) !== toHex(script.bytecode)) {
    throw new Error('La public key HD no corresponde a la dirección propietaria del input FIRMA.')
  }
  return script
}

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

const selectFirmaInputs = (ownedUtxos: FirmaOwnedUtxo[], amountAtoms: bigint) => {
  const canonical = ownedUtxos.filter(({ utxo }) => isCanonicalFirmaUtxo(utxo))
  const balanceAtoms = canonical.reduce((total, { utxo }) => total + (utxo.token?.atoms ?? 0n), 0n)
  if (balanceAtoms < amountAtoms) {
    throw new Error(
      `FIRMA insuficiente. Disponible: ${formatTokenAmount(balanceAtoms, FIRMA_ALPHA.decimals)} FIRMA.`
    )
  }

  const sorted = [...canonical].sort((a, b) => {
    const aAtoms = a.utxo.token?.atoms ?? 0n
    const bAtoms = b.utxo.token?.atoms ?? 0n
    if (aAtoms !== bAtoms) return aAtoms > bAtoms ? -1 : 1
    return compareOutpoints(a, b)
  })
  const selected: FirmaOwnedUtxo[] = []
  let selectedAtoms = 0n
  for (const ownedUtxo of sorted) {
    selected.push(ownedUtxo)
    selectedAtoms += ownedUtxo.utxo.token?.atoms ?? 0n
    if (selectedAtoms >= amountAtoms) break
  }

  return { selected, selectedAtoms, balanceAtoms }
}

const buildInputs = (
  ownedUtxos: FirmaOwnedUtxo[],
  resolveSignatory: FirmaInputSignatoryResolver
): TxBuilderInput[] =>
  ownedUtxos.map((ownedUtxo) => ({
    input: {
      prevOut: ownedUtxo.utxo.outpoint,
      signData: {
        sats: ownedUtxo.utxo.sats,
        outputScript: ownerScript(ownedUtxo.owner)
      }
    },
    signatory: resolveSignatory(ownedUtxo.owner)
  }))

const txFee = (tx: Tx, inputSats: bigint) =>
  inputSats - tx.outputs.reduce((total, output) => total + output.sats, 0n)

const inputCommitment = ({ utxo, owner }: FirmaOwnedUtxo) => {
  const token = utxo.token
  const tokenCommitment = token
    ? [
        token.tokenId,
        token.tokenType.protocol,
        token.tokenType.number,
        token.atoms,
        token.isMintBaton ? 'baton' : 'atoms'
      ].join(':')
    : 'pure-xec'
  return [
    outpointKey({ utxo, owner }),
    utxo.sats,
    owner.address,
    owner.profileId,
    owner.account,
    owner.hdPath,
    owner.branch,
    owner.index,
    owner.publicKeyHex.toLowerCase(),
    tokenCommitment
  ].join(':')
}

const fingerprint = (params: {
  destinationScript: Script
  changeOwner: FirmaInputOwner
  amountAtoms: bigint
  tokenChangeAtoms: bigint
  networkFeeSats: bigint
  inputs: FirmaOwnedUtxo[]
  tx: Tx
}) =>
  [
    FIRMA_ALPHA.tokenId,
    FIRMA_ALPHA.protocol,
    FIRMA_ALPHA.tokenType.toString(),
    toHex(params.destinationScript.bytecode),
    params.changeOwner.address,
    params.changeOwner.profileId,
    params.changeOwner.account,
    params.changeOwner.hdPath,
    params.changeOwner.publicKeyHex.toLowerCase(),
    params.amountAtoms.toString(),
    params.tokenChangeAtoms.toString(),
    params.networkFeeSats.toString(),
    ...params.inputs.map(inputCommitment),
    ...params.tx.outputs.map((output) => `${output.sats}:${toHex(output.script.bytecode)}`)
  ].join('|')

export function buildFirmaSendPlan(params: BuildFirmaSendPlanParams): FirmaSendPlan {
  if (params.amountAtoms <= 0n) {
    throw new Error('El monto FIRMA debe ser mayor a cero.')
  }

  const changeScript = ownerScript(params.changeOwner)
  if (params.ownedUtxos.some(({ owner }) =>
    owner.profileId !== params.changeOwner.profileId || owner.account !== params.changeOwner.account
  )) {
    throw new Error('No se pueden combinar inputs FIRMA de perfiles de derivación distintos.')
  }
  let destinationScript: Script
  try {
    destinationScript = Script.fromAddress(params.destination.trim())
  } catch {
    throw new Error('La dirección eCash de destino no es válida.')
  }

  const selection = selectFirmaInputs(params.ownedUtxos, params.amountAtoms)
  const firmaChangeAtoms = selection.selectedAtoms - params.amountAtoms
  const sendAtoms = firmaChangeAtoms > 0n
    ? [params.amountAtoms, firmaChangeAtoms]
    : [params.amountAtoms]
  const fixedOutputs: TxBuilderOutput[] = [
    { sats: 0n, script: emppScript([alpSend(FIRMA_ALPHA.tokenId, FIRMA_ALPHA.tokenType, sendAtoms)]) },
    { sats: TOKEN_DUST_SATS, script: destinationScript }
  ]
  if (firmaChangeAtoms > 0n) {
    fixedOutputs.push({ sats: TOKEN_DUST_SATS, script: changeScript })
  }

  const pureXecUtxos = params.ownedUtxos
    .filter(({ utxo }) => !utxo.token)
    .sort((a, b) => {
      if (a.utxo.sats !== b.utxo.sats) return a.utxo.sats > b.utxo.sats ? -1 : 1
      return compareOutpoints(a, b)
    })
  if (pureXecUtxos.length === 0) {
    throw new Error('XEC insuficiente: se necesita al menos un UTXO XEC puro para pagar la comisión.')
  }

  const dummySignatory = P2PKHSignatory(DUMMY_KEYPAIR.sk, DUMMY_KEYPAIR.pk, ALL_BIP143)
  const xecInputs: FirmaOwnedUtxo[] = []
  const tokenInputSats = selection.selected.reduce((total, { utxo }) => total + utxo.sats, 0n)
  const tokenOutputSats = BigInt(sendAtoms.length) * TOKEN_DUST_SATS
  const dustDeficit = tokenOutputSats > tokenInputSats ? tokenOutputSats - tokenInputSats : 0n
  let dummyTx: Tx | null = null
  let networkFeeSats = 0n

  for (const ownedUtxo of pureXecUtxos) {
    xecInputs.push(ownedUtxo)
    const allInputs = [...selection.selected, ...xecInputs]
    const builder = new TxBuilder({
      inputs: buildInputs(allInputs, () => dummySignatory),
      outputs: [...fixedOutputs, changeScript]
    })
    try {
      const candidateTx = builder.sign({
        ecc: new EccDummy(),
        feePerKb: FIRMA_SEND_FEE_PER_KB,
        dustSats: TOKEN_DUST_SATS
      })
      const inputSats = allInputs.reduce((total, { utxo }) => total + utxo.sats, 0n)
      const candidateFee = txFee(candidateTx, inputSats)
      const pureXecSats = xecInputs.reduce((total, { utxo }) => total + utxo.sats, 0n)
      if (pureXecSats < candidateFee + dustDeficit) continue
      dummyTx = candidateTx
      networkFeeSats = candidateFee
      break
    } catch {
      // Add another wallet-owned pure-XEC input and retry without deriving wallet keys.
    }
  }

  if (!dummyTx) {
    throw new Error('XEC insuficiente para cubrir el dust de salida y la comisión de red.')
  }

  const inputs = [...selection.selected, ...xecInputs]
  const planFingerprint = fingerprint({
    destinationScript,
    changeOwner: params.changeOwner,
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
      changeAddress: params.changeOwner.address,
      changeHdPath: params.changeOwner.hdPath,
      planFingerprint
    },
    changeOwner: params.changeOwner,
    tokenInputs: selection.selected,
    xecInputs,
    outputs: [...fixedOutputs, changeScript],
    estimatedTx: dummyTx
  }
}

export function createSignedFirmaSendBuilder(
  plan: FirmaSendPlan,
  resolveSignatory: FirmaInputSignatoryResolver
): TxBuilder {
  return new TxBuilder({
    inputs: buildInputs([...plan.tokenInputs, ...plan.xecInputs], resolveSignatory),
    outputs: plan.outputs
  })
}
