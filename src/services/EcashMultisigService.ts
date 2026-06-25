import type { ScriptUtxo } from 'chronik-client'
import {
  ALL_BIP143,
  Address,
  Ecc,
  OP_0,
  OP_CHECKMULTISIG,
  OP_RETURN,
  Script,
  SigHashType,
  Tx,
  TxBuilder,
  UnsignedTx,
  flagSignature,
  fromHex,
  isPushOp,
  pushBytesOp,
  pushNumberOp,
  sha256d,
  shaRmd160,
  toHex,
  toHexRev
} from 'ecash-lib'
import type { Ecc as EccInterface, Signatory, UnsignedTxInput } from 'ecash-lib'
import {
  FEE_RATE_SATS_PER_BYTE,
  TONALLI_SERVICE_FEE_SATS,
  XEC_DUST_SATS,
  XEC_TONALLI_TREASURY_ADDRESS
} from '../config/xecFees'
import { triggerWalletRefresh } from '../utils/walletRefresh'
import { getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'

export type EcashMultisigVault = {
  id: string
  label: string
  m: number
  n: number
  pubkeysHex: string[]
  redeemScriptHex: string
  scriptHashHex: string
  address: string
  signerPubkeyHex: string
  createdAt: number
}

export type EcashMultisigProposal = {
  id: string
  vaultId: string
  to: string
  amountSats: string
  memo?: string
  partialTxHex: string
  signaturesCount: number
  requiredSignatures: number
  isComplete: boolean
  createdAt: number
}

export type EcashMultisigTxSummary = {
  outputs: Array<{
    index: number
    sats: string
    address: string | null
    scriptHex: string
  }>
  signaturesCount: number
  requiredSignatures: number
  isComplete: boolean
}

export type EcashMultisigProposalInspection = {
  vaultAddress: string
  inputsCount: number
  outputs: Array<{
    index: number
    sats: string
    address?: string
    scriptHex: string
    role: 'destination' | 'tonalli_fee' | 'change' | 'op_return' | 'unknown'
    memoText?: string
    memoHex?: string
    warning?: string
  }>
  signaturesByInput: Array<{
    inputIndex: number
    validSignatures: number
    requiredSignatures: number
    isComplete: boolean
  }>
  isComplete: boolean
  hasTokenInputs: boolean
  warnings: string[]
}

const STORAGE_KEY_VAULTS = 'tonalli_ecash_multisig_vaults'
const STORAGE_KEY_PROPOSALS = 'tonalli_ecash_multisig_proposals'
const FEE_PER_KB = BigInt(Math.ceil(FEE_RATE_SATS_PER_BYTE * 1000))
const MULTISIG_FEE_PER_KB = 2000n
const MAX_OP_RETURN_MEMO_BYTES = 80

const nowId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const normalizePubkeyHex = (value: string) => value.trim().toLowerCase()

export const normalizeMemo = (input?: string): string | undefined => {
  const memo = input?.trim()
  return memo ? memo : undefined
}

export const utf8Bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

export const validateMemoBytes = (bytes: Uint8Array) => {
  if (bytes.length > MAX_OP_RETURN_MEMO_BYTES) {
    throw new Error('El memo excede el limite de 80 bytes para OP_RETURN.')
  }
}

const validateMemoText = (memo: string) => {
  for (const char of memo) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new Error('El memo contiene caracteres de control no permitidos.')
    }
  }
}

const opReturnScript = (memo: string): Script => {
  const memoBytes = utf8Bytes(memo)
  validateMemoBytes(memoBytes)
  validateMemoText(memo)
  return Script.fromOps([OP_RETURN, pushBytesOp(memoBytes)])
}

const parseOpReturnOutput = (
  script: Script
): { memoText: string; memoHex: string; warning?: string } | null => {
  let ops: ReturnType<Script['ops']>
  try {
    ops = script.ops()
  } catch {
    return null
  }

  const allOps = []
  try {
    let op = ops.next()
    while (op !== undefined) {
      allOps.push(op)
      op = ops.next()
    }
  } catch {
    return null
  }

  if (allOps[0] !== OP_RETURN) {
    return null
  }

  if (allOps.length === 2 && isPushOp(allOps[1])) {
    const memoHex = toHex(allOps[1].data)
    return {
      memoText: new TextDecoder().decode(allOps[1].data),
      memoHex
    }
  }

  return {
    memoText: '',
    memoHex: script.toHex().slice(2),
    warning: 'OP_RETURN no estandar detectado.'
  }
}

const compareHexBytes = (left: string, right: string) => {
  const leftBytes = fromHex(left)
  const rightBytes = fromHex(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let idx = 0; idx < length; idx += 1) {
    const diff = leftBytes[idx] - rightBytes[idx]
    if (diff !== 0) return diff
  }
  return leftBytes.length - rightBytes.length
}

const validatePubkeyHex = (value: string) => {
  if (!/^(02|03)[0-9a-f]{64}$/i.test(value) && !/^04[0-9a-f]{128}$/i.test(value)) {
    throw new Error('Public key invalida. Usa public keys comprimidas 02/03... o sin comprimir 04... en hex.')
  }
}

const uniqueSortedPubkeys = (pubkeysHex: string[]) => {
  const normalized = pubkeysHex.map(normalizePubkeyHex).filter(Boolean)
  normalized.forEach(validatePubkeyHex)
  return Array.from(new Set(normalized)).sort(compareHexBytes)
}

const readJsonArray = <T>(key: string): T[] => {
  if (typeof window === 'undefined') return []
  const raw = localStorage.getItem(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

const writeJsonArray = <T>(key: string, items: T[]) => {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify(items))
}

const scriptFromHex = (hex: string) => new Script(fromHex(hex))

const addressToScript = (address: string): Script => {
  const parsed = Address.parse(address)
  const hash = fromHex(parsed.hash)
  if (parsed.type === 'p2pkh') return Script.p2pkh(hash)
  if (parsed.type === 'p2sh') return Script.p2sh(hash)
  throw new Error(`Tipo de direccion no soportado: ${parsed.type}`)
}

const multisigRedeemScript = (m: number, pubkeysHex: string[]) =>
  Script.fromOps([
    pushNumberOp(m),
    ...pubkeysHex.map((pubkeyHex) => pushBytesOp(fromHex(pubkeyHex))),
    pushNumberOp(pubkeysHex.length),
    OP_CHECKMULTISIG
  ])

const p2shAddressForRedeemScript = (redeemScript: Script) =>
  Address.fromScript(Script.p2sh(shaRmd160(redeemScript.bytecode))).toString()

const assertVaultConsensusShape = (vault: EcashMultisigVault) => {
  const pubkeysHex = uniqueSortedPubkeys(vault.pubkeysHex)
  if (vault.n !== pubkeysHex.length || vault.pubkeysHex.join(':') !== pubkeysHex.join(':')) {
    throw new Error('La boveda no tiene pubkeys unicas en orden lexicografico.')
  }
  if (vault.m < 1 || vault.m > vault.n || vault.n > 20) {
    throw new Error('La boveda debe cumplir 1 <= m <= n <= 20.')
  }

  const redeemScript = multisigRedeemScript(vault.m, pubkeysHex)
  if (redeemScript.bytecode.length > 520) {
    throw new Error('El redeemScript excede el limite de 520 bytes para P2SH.')
  }
  if (vault.redeemScriptHex !== redeemScript.toHex()) {
    throw new Error('El redeemScript guardado no coincide con m/n/pubkeys.')
  }

  const scriptHashHex = toHex(shaRmd160(redeemScript.bytecode))
  if (vault.scriptHashHex !== scriptHashHex) {
    throw new Error('El scriptHash de la boveda no coincide con el redeemScript.')
  }
  if (vault.address !== p2shAddressForRedeemScript(redeemScript)) {
    throw new Error('La direccion P2SH de la boveda no coincide con el redeemScript.')
  }
}

const p2shMultisigSpend = (signatures: Uint8Array[], redeemScript: Script) =>
  Script.fromOps([
    OP_0,
    ...signatures.map((signature) => pushBytesOp(signature)),
    pushBytesOp(redeemScript.bytecode)
  ])

const parseP2shMultisigSpend = (script?: Script) => {
  const invalid = { signatures: [] as Uint8Array[], redeemScript: null as Script | null, isValid: false }
  if (!script || script.bytecode.length === 0) {
    return invalid
  }

  const ops = script.ops()
  const allOps = []
  try {
    let op = ops.next()
    while (op !== undefined) {
      allOps.push(op)
      op = ops.next()
    }
  } catch {
    return invalid
  }

  if (allOps.length < 2 || allOps[0] !== OP_0) {
    return invalid
  }

  const lastOp = allOps[allOps.length - 1]
  if (!isPushOp(lastOp)) {
    return invalid
  }

  const signatureOps = allOps.slice(1, -1)
  if (!signatureOps.every(isPushOp)) {
    return invalid
  }
  const signatures = signatureOps.map((push) => push.data)

  return {
    signatures,
    redeemScript: new Script(lastOp.data),
    isValid: true
  }
}

const getTxInputKey = (txid: string | Uint8Array, outIdx: number) =>
  `${typeof txid === 'string' ? txid : toHexRev(txid)}:${outIdx}`

const buildUtxoMap = (utxos: ScriptUtxo[]) => {
  const map = new Map<string, ScriptUtxo>()
  utxos.forEach((utxo) => {
    map.set(getTxInputKey(utxo.outpoint.txid, utxo.outpoint.outIdx), utxo)
  })
  return map
}

const signatureHashType = (signature: Uint8Array) => {
  const flag = signature[signature.length - 1]
  return SigHashType.fromInt(flag)
}

const isAllBip143Signature = (signature: Uint8Array) => {
  const sigHashType = signatureHashType(signature)
  return Boolean(sigHashType && sigHashType.toInt() === ALL_BIP143.toInt())
}

const verifySignature = (
  ecc: EccInterface,
  signature: Uint8Array,
  sighash: Uint8Array,
  pubkey: Uint8Array
) => {
  if (!isAllBip143Signature(signature)) return false
  try {
    ecc.ecdsaVerify(signature.slice(0, -1), sighash, pubkey)
    return true
  } catch {
    return false
  }
}

const signaturesByPubkey = (
  ecc: EccInterface,
  input: UnsignedTxInput,
  signatures: Uint8Array[],
  pubkeysHex: string[]
) => {
  const byPubkey = new Map<string, Uint8Array>()
  const remaining = [...signatures]

  for (const pubkeyHex of pubkeysHex) {
    const pubkey = fromHex(pubkeyHex)
    const matchIdx = remaining.findIndex((signature) => {
      const sigHashType = signatureHashType(signature) ?? ALL_BIP143
      if (sigHashType.toInt() !== ALL_BIP143.toInt()) return false
      const sighash = sha256d(input.sigHashPreimage(sigHashType).bytes)
      return verifySignature(ecc, signature, sighash, pubkey)
    })
    if (matchIdx >= 0) {
      byPubkey.set(pubkeyHex, remaining[matchIdx])
      remaining.splice(matchIdx, 1)
    }
  }

  return byPubkey
}

const validateInputSpendShape = (inputScript: Script | undefined, vault: EcashMultisigVault) => {
  const parsed = parseP2shMultisigSpend(inputScript)
  if (!parsed.isValid) {
    throw new Error('scriptSig P2SH multisig invalido: debe ser OP_0 <firmas...> <redeemScript>.')
  }
  if (parsed.redeemScript?.toHex() !== vault.redeemScriptHex) {
    throw new Error('El redeemScript del input no coincide con la boveda.')
  }
  if (parsed.signatures.some((signature) => !isAllBip143Signature(signature))) {
    throw new Error('Todas las firmas deben incluir sighash ALL_BIP143.')
  }
  return parsed
}

const p2shMultisigSignatory = (
  sk: Uint8Array,
  signerPubkeyHex: string,
  redeemScript: Script,
  pubkeysHex: string[]
): Signatory => {
  return (ecc: EccInterface, input: UnsignedTxInput): Script => {
    const preimage = input.sigHashPreimage(ALL_BIP143)
    const signature = flagSignature(ecc.ecdsaSign(sk, sha256d(preimage.bytes)), ALL_BIP143)
    const existing = parseP2shMultisigSpend(input.txInput().script).signatures
    const byPubkey = signaturesByPubkey(ecc, input, existing, pubkeysHex)
    byPubkey.set(signerPubkeyHex, signature)
    const orderedSignatures = pubkeysHex
      .map((pubkeyHex) => byPubkey.get(pubkeyHex))
      .filter((sig): sig is Uint8Array => Boolean(sig))
    return p2shMultisigSpend(orderedSignatures, redeemScript)
  }
}

const countTxSignatures = (tx: Tx, vault: EcashMultisigVault) => {
  if (tx.inputs.length === 0) return 0
  return Math.min(
    ...tx.inputs.map((input) => {
      const parsed = parseP2shMultisigSpend(input.script)
      if (!parsed.isValid || parsed.redeemScript?.toHex() !== vault.redeemScriptHex) return 0
      return parsed.signatures.length
    })
  )
}

const countVerifiedTxSignatures = (tx: Tx, vault: EcashMultisigVault) => {
  if (tx.inputs.length === 0) return 0
  const ecc = new Ecc()
  const unsignedTx = UnsignedTx.fromTx(tx)
  const counts = tx.inputs.map((txInput, inputIdx) => {
    const parsed = validateInputSpendShape(txInput.script, vault)
    const byPubkey = signaturesByPubkey(ecc, unsignedTx.inputAt(inputIdx), parsed.signatures, vault.pubkeysHex)
    if (byPubkey.size !== parsed.signatures.length) {
      throw new Error('El partialTxHex contiene firmas invalidas o duplicadas.')
    }
    return byPubkey.size
  })
  return Math.min(...counts)
}

const inspectTx = (
  tx: Tx,
  vault: EcashMultisigVault,
  utxos: ScriptUtxo[]
): EcashMultisigProposalInspection => {
  const warnings: string[] = []
  const redeemScript = scriptFromHex(vault.redeemScriptHex)
  const utxoMap = buildUtxoMap(utxos)
  const ecc = new Ecc()

  if (tx.inputs.length === 0) {
    throw new Error('El partialTxHex no tiene inputs.')
  }

  let hasTokenInputs = false
  tx.inputs.forEach((txInput) => {
    const utxo = utxoMap.get(getTxInputKey(txInput.prevOut.txid, txInput.prevOut.outIdx))
    if (!utxo) {
      throw new Error('El partialTxHex no pertenece a esta boveda o el UTXO ya no esta disponible.')
    }
    if (utxo.token) {
      hasTokenInputs = true
    }
    txInput.signData = {
      sats: utxo.sats,
      redeemScript
    }
  })

  const unsignedTx = UnsignedTx.fromTx(tx)
  const signaturesByInput = tx.inputs.map((txInput, inputIndex) => {
    const parsed = validateInputSpendShape(txInput.script, vault)
    const byPubkey = signaturesByPubkey(
      ecc,
      unsignedTx.inputAt(inputIndex),
      parsed.signatures,
      vault.pubkeysHex
    )
    if (byPubkey.size !== parsed.signatures.length) {
      warnings.push(`Input ${inputIndex}: contiene firmas invalidas o duplicadas que no cuentan.`)
    }
    return {
      inputIndex,
      validSignatures: byPubkey.size,
      requiredSignatures: vault.m,
      isComplete: byPubkey.size >= vault.m
    }
  })

  if (hasTokenInputs) {
    warnings.push('La propuesta intenta gastar uno o mas UTXOs con token. La multifirma solo permite XEC puro.')
  }

  return {
    vaultAddress: vault.address,
    inputsCount: tx.inputs.length,
    outputs: tx.outputs.map((output, index) => {
      const scriptHex = output.script.toHex()
      const opReturn = parseOpReturnOutput(output.script)
      if (opReturn) {
        const opReturnWarnings = [
          opReturn.warning,
          output.sats === 0n ? undefined : 'OP_RETURN con sats distintos de 0.'
        ].filter((warning): warning is string => Boolean(warning))
        return {
          index,
          sats: output.sats.toString(),
          scriptHex,
          role: 'op_return' as const,
          memoText: opReturn.memoText,
          memoHex: opReturn.memoHex,
          ...(opReturnWarnings.length > 0 ? { warning: opReturnWarnings.join(' ') } : {})
        }
      }

      try {
        const address = Address.fromScript(output.script).toString()
        const role = address === vault.address
          ? 'change'
          : address === XEC_TONALLI_TREASURY_ADDRESS
            ? 'tonalli_fee'
            : 'destination'
        return {
          index,
          sats: output.sats.toString(),
          address,
          scriptHex,
          role
        }
      } catch {
        return {
          index,
          sats: output.sats.toString(),
          scriptHex,
          role: 'unknown' as const,
          warning: 'Script desconocido detectado. No firmes si no esperabas este output.'
        }
      }
    }),
    signaturesByInput,
    isComplete: signaturesByInput.every((item) => item.isComplete),
    hasTokenInputs,
    warnings
  }
}

const summarizeTx = (tx: Tx, vault: EcashMultisigVault): EcashMultisigTxSummary => {
  const signaturesCount = countTxSignatures(tx, vault)
  return {
    outputs: tx.outputs.map((output, index) => {
      let address: string | null = null
      try {
        address = Address.fromScript(output.script).toString()
      } catch {
        address = null
      }
      return {
        index,
        sats: output.sats.toString(),
        address,
        scriptHex: output.script.toHex()
      }
    }),
    signaturesCount,
    requiredSignatures: vault.m,
    isComplete: signaturesCount >= vault.m
  }
}

export class EcashMultisigService {
  createVault(input: {
    label: string
    m: number
    pubkeysHex: string[]
  }): EcashMultisigVault {
    const signerPubkeyHex = normalizePubkeyHex(xolosWalletService.getPublicKeyHex() ?? '')
    if (!signerPubkeyHex) {
      throw new Error('WALLET_LOCKED')
    }

    const pubkeysHex = uniqueSortedPubkeys(input.pubkeysHex)
    if (input.m < 1 || input.m > pubkeysHex.length || pubkeysHex.length > 20) {
      throw new Error('m debe cumplir 1 <= m <= n <= 20 firmantes.')
    }
    if (!pubkeysHex.includes(signerPubkeyHex)) {
      throw new Error('La public key de esta wallet debe estar incluida como firmante.')
    }

    const redeemScript = multisigRedeemScript(input.m, pubkeysHex)
    if (redeemScript.bytecode.length > 520) {
      throw new Error('El redeemScript excede el limite de 520 bytes para P2SH.')
    }
    const scriptHash = shaRmd160(redeemScript.bytecode)
    const p2shScript = Script.p2sh(scriptHash)
    const vault: EcashMultisigVault = {
      id: nowId(),
      label: input.label.trim() || `Multifirma ${input.m}-de-${pubkeysHex.length}`,
      m: input.m,
      n: pubkeysHex.length,
      pubkeysHex,
      redeemScriptHex: redeemScript.toHex(),
      scriptHashHex: toHex(scriptHash),
      address: Address.fromScript(p2shScript).toString(),
      signerPubkeyHex,
      createdAt: Date.now()
    }

    this.saveVault(vault)
    return vault
  }

  listVaults(): EcashMultisigVault[] {
    return readJsonArray<EcashMultisigVault>(STORAGE_KEY_VAULTS)
  }

  saveVault(vault: EcashMultisigVault): void {
    assertVaultConsensusShape(vault)
    const vaults = this.listVaults()
    const next = [vault, ...vaults.filter((item) => item.id !== vault.id)]
    writeJsonArray(STORAGE_KEY_VAULTS, next)
  }

  exportVault(vault: EcashMultisigVault): string {
    assertVaultConsensusShape(vault)
    const exported = {
      version: 1,
      label: vault.label,
      m: vault.m,
      n: vault.n,
      pubkeysHex: vault.pubkeysHex,
      redeemScriptHex: vault.redeemScriptHex,
      scriptHashHex: vault.scriptHashHex,
      address: vault.address,
      createdAt: vault.createdAt
    }
    return JSON.stringify(exported, null, 2)
  }

  importVault(json: string): EcashMultisigVault {
    const parsed = JSON.parse(json) as Partial<EcashMultisigVault> & { version?: number }
    const signerPubkeyHex = normalizePubkeyHex(xolosWalletService.getPublicKeyHex() ?? '')
    if (!signerPubkeyHex) {
      throw new Error('WALLET_LOCKED')
    }
    if (!Array.isArray(parsed.pubkeysHex)) {
      throw new Error('La boveda importada no contiene pubkeysHex validas.')
    }
    const m = Number(parsed.m)
    const n = Number(parsed.n)
    const pubkeysHex = uniqueSortedPubkeys(parsed.pubkeysHex)
    if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || m > n || n !== pubkeysHex.length || n > 20) {
      throw new Error('La boveda importada debe cumplir m/n/pubkeysHex validos.')
    }
    if (!pubkeysHex.includes(signerPubkeyHex)) {
      throw new Error('Esta wallet no es firmante de la boveda importada.')
    }

    const redeemScript = multisigRedeemScript(m, pubkeysHex)
    if (redeemScript.bytecode.length > 520) {
      throw new Error('El redeemScript importado excede el limite de 520 bytes para P2SH.')
    }
    const scriptHashHex = toHex(shaRmd160(redeemScript.bytecode))
    const address = p2shAddressForRedeemScript(redeemScript)
    if (parsed.redeemScriptHex !== redeemScript.toHex()) {
      throw new Error('Boveda importada manipulada: redeemScript no coincide con m/n/pubkeysHex.')
    }
    if (parsed.scriptHashHex !== scriptHashHex) {
      throw new Error('Boveda importada manipulada: scriptHash no coincide con redeemScript.')
    }
    if (parsed.address !== address) {
      throw new Error('Boveda importada manipulada: address no coincide con redeemScript.')
    }

    const vault: EcashMultisigVault = {
      id: nowId(),
      label: typeof parsed.label === 'string' && parsed.label.trim()
        ? parsed.label.trim()
        : `Multifirma ${m}-de-${n}`,
      m,
      n,
      pubkeysHex,
      redeemScriptHex: redeemScript.toHex(),
      scriptHashHex,
      address,
      signerPubkeyHex,
      createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
        ? parsed.createdAt
        : Date.now()
    }
    this.saveVault(vault)
    return vault
  }

  getVault(vaultId: string): EcashMultisigVault | null {
    return this.listVaults().find((vault) => vault.id === vaultId) ?? null
  }

  listProposals(vaultId?: string): EcashMultisigProposal[] {
    const proposals = readJsonArray<EcashMultisigProposal>(STORAGE_KEY_PROPOSALS)
    return vaultId ? proposals.filter((proposal) => proposal.vaultId === vaultId) : proposals
  }

  saveProposal(proposal: EcashMultisigProposal): void {
    const proposals = this.listProposals()
    const next = [proposal, ...proposals.filter((item) => item.id !== proposal.id)]
    writeJsonArray(STORAGE_KEY_PROPOSALS, next)
  }

  async getVaultUtxos(vault: EcashMultisigVault): Promise<ScriptUtxo[]> {
    assertVaultConsensusShape(vault)
    const response = await getChronik().address(vault.address).utxos()
    return response.utxos
  }

  async fundVault(input: {
    vault: EcashMultisigVault
    amountSats: bigint
    includeTonalliFee?: boolean
  }): Promise<string> {
    if (input.amountSats <= 0n) {
      throw new Error('El monto debe ser mayor a cero.')
    }
    assertVaultConsensusShape(input.vault)

    const keyInfo = xolosWalletService.getKeyInfo()
    const signatory = xolosWalletService.getSignatory()
    const currentAddress = keyInfo.address ?? keyInfo.xecAddress ?? signatory.address
    if (!currentAddress) {
      throw new Error('No se encontro la direccion de la wallet actual.')
    }

    const currentAddressScript = addressToScript(currentAddress)
    const vaultScript = addressToScript(input.vault.address)
    const fixedOutputs = [
      { sats: input.amountSats, script: vaultScript },
      ...(input.includeTonalliFee
        ? [{ sats: BigInt(TONALLI_SERVICE_FEE_SATS), script: addressToScript(XEC_TONALLI_TREASURY_ADDRESS) }]
        : [])
    ]

    const spendableUtxos = (await getChronik().address(currentAddress).utxos()).utxos
      .filter((utxo) => !utxo.token)
      .sort((a, b) => (a.sats > b.sats ? -1 : 1))

    if (spendableUtxos.length === 0) {
      throw new Error('La wallet actual no tiene UTXOs XEC puros disponibles.')
    }

    let signedTx: Tx | null = null
    for (let count = 1; count <= spendableUtxos.length; count += 1) {
      const selectedUtxos = spendableUtxos.slice(0, count)
      const txBuilder = new TxBuilder({
        inputs: selectedUtxos.map((utxo) => ({
          input: {
            prevOut: utxo.outpoint,
            signData: {
              sats: utxo.sats,
              outputScript: currentAddressScript
            }
          },
          signatory: signatory.signatory
        })),
        outputs: [...fixedOutputs, currentAddressScript]
      })

      try {
        signedTx = txBuilder.sign({
          feePerKb: FEE_PER_KB,
          dustSats: BigInt(XEC_DUST_SATS)
        })
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/insufficient/i.test(message) || count === spendableUtxos.length) {
          if (/insufficient/i.test(message)) {
            throw new Error('No hay suficiente XEC puro para fondear la boveda y cubrir la tarifa de red.')
          }
          throw err
        }
      }
    }

    if (!signedTx) {
      throw new Error('No se pudo construir la transaccion de fondeo.')
    }

    const result = await getChronik().broadcastTx(toHex(signedTx.ser()))
    if (!result.txid) {
      throw new Error('Chronik no devolvio txid.')
    }

    triggerWalletRefresh({
      refreshUtxos: true,
      refreshBalances: true,
      reason: 'ecash_multisig_fund_vault',
      txid: result.txid
    })
    return result.txid
  }

  async createProposal(input: {
    vault: EcashMultisigVault
    to: string
    amountSats: bigint
    includeTonalliFee?: boolean
    memo?: string
  }): Promise<EcashMultisigProposal> {
    if (input.amountSats <= 0n) {
      throw new Error('El monto debe ser mayor a cero.')
    }
    assertVaultConsensusShape(input.vault)

    const memo = normalizeMemo(input.memo)
    const memoScript = memo ? opReturnScript(memo) : null
    const redeemScript = scriptFromHex(input.vault.redeemScriptHex)
    const p2shScript = Script.fromAddress(input.vault.address)
    const destinationScript = Script.fromAddress(input.to)
    const fixedOutputs = [
      { sats: input.amountSats, script: destinationScript },
      ...(input.includeTonalliFee
        ? [{ sats: BigInt(TONALLI_SERVICE_FEE_SATS), script: Script.fromAddress(XEC_TONALLI_TREASURY_ADDRESS) }]
        : [])
    ]

    const spendableUtxos = (await this.getVaultUtxos(input.vault))
      .filter((utxo) => !utxo.token)
      .sort((a, b) => (a.sats > b.sats ? -1 : 1))

    if (spendableUtxos.length === 0) {
      throw new Error('La boveda no tiene UTXOs XEC puros disponibles.')
    }

    const signerPubkeyHex = normalizePubkeyHex(xolosWalletService.getPublicKeyHex() ?? '')
    if (!input.vault.pubkeysHex.includes(signerPubkeyHex)) {
      throw new Error('Esta wallet no es firmante de la boveda.')
    }

    const signedTx = await xolosWalletService.withPrivateKey(async (privateKey) => {
      for (let count = 1; count <= spendableUtxos.length; count += 1) {
        const selectedUtxos = spendableUtxos.slice(0, count)
        const txBuilder = new TxBuilder({
          inputs: selectedUtxos.map((utxo) => ({
            input: {
              prevOut: utxo.outpoint,
              signData: {
                sats: utxo.sats,
                redeemScript
              }
            },
            signatory: p2shMultisigSignatory(
              privateKey,
              signerPubkeyHex,
              redeemScript,
              input.vault.pubkeysHex
            )
          })),
          // TxBuilder preserves output order and uses the bare Script as the change placeholder.
          // Exact THORChain-specific ordering may still need a specialized proposal builder.
          outputs: memoScript
            ? [...fixedOutputs, p2shScript, { sats: 0n, script: memoScript }]
            : [...fixedOutputs, p2shScript]
        })

        try {
          return txBuilder.sign({
            feePerKb: MULTISIG_FEE_PER_KB,
            dustSats: BigInt(XEC_DUST_SATS)
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!/insufficient/i.test(message) || count === spendableUtxos.length) {
            throw err
          }
        }
      }

      throw new Error('No hay suficiente XEC en la boveda para cubrir monto y red.')
    })

    const signaturesCount = countVerifiedTxSignatures(signedTx, input.vault)
    const summary = summarizeTx(signedTx, input.vault)
    const proposal: EcashMultisigProposal = {
      id: nowId(),
      vaultId: input.vault.id,
      to: input.to,
      amountSats: input.amountSats.toString(),
      ...(memo ? { memo } : {}),
      partialTxHex: signedTx.toHex(),
      signaturesCount,
      requiredSignatures: summary.requiredSignatures,
      isComplete: signaturesCount >= input.vault.m,
      createdAt: Date.now()
    }
    this.saveProposal(proposal)
    return proposal
  }

  async signProposal(input: {
    vault: EcashMultisigVault
    partialTxHex: string
  }): Promise<{
    partialTxHex: string
    signaturesCount: number
    requiredSignatures: number
    isComplete: boolean
  }> {
    assertVaultConsensusShape(input.vault)
    const tx = Tx.fromHex(input.partialTxHex.trim())
    const redeemScript = scriptFromHex(input.vault.redeemScriptHex)
    const utxoMap = buildUtxoMap(await this.getVaultUtxos(input.vault))
    const signerPubkeyHex = normalizePubkeyHex(xolosWalletService.getPublicKeyHex() ?? '')

    if (!input.vault.pubkeysHex.includes(signerPubkeyHex)) {
      throw new Error('Esta wallet no es firmante de la boveda.')
    }

    if (tx.inputs.length === 0) {
      throw new Error('El partialTxHex no tiene inputs.')
    }

    tx.inputs.forEach((txInput) => {
      validateInputSpendShape(txInput.script, input.vault)
      const utxo = utxoMap.get(getTxInputKey(txInput.prevOut.txid, txInput.prevOut.outIdx))
      if (!utxo) {
        throw new Error('El partialTxHex no pertenece a esta boveda o el UTXO ya no esta disponible.')
      }
      if (utxo.token) {
        throw new Error('El partialTxHex intenta gastar un UTXO con token.')
      }
      txInput.signData = {
        sats: utxo.sats,
        redeemScript
      }
    })
    countVerifiedTxSignatures(tx, input.vault)

    const signedTx = xolosWalletService.withPrivateKey((privateKey) => {
      const ecc = new Ecc()
      const unsignedTx = UnsignedTx.fromTx(tx)

      tx.inputs.forEach((txInput, inputIdx) => {
        const unsignedInput = unsignedTx.inputAt(inputIdx)
        const existing = parseP2shMultisigSpend(txInput.script).signatures
        const byPubkey = signaturesByPubkey(ecc, unsignedInput, existing, input.vault.pubkeysHex)
        const preimage = unsignedInput.sigHashPreimage(ALL_BIP143)
        const signature = flagSignature(ecc.ecdsaSign(privateKey, sha256d(preimage.bytes)), ALL_BIP143)
        byPubkey.set(signerPubkeyHex, signature)
        const orderedSignatures = input.vault.pubkeysHex
          .map((pubkeyHex) => byPubkey.get(pubkeyHex))
          .filter((sig): sig is Uint8Array => Boolean(sig))
        txInput.script = p2shMultisigSpend(orderedSignatures, redeemScript)
      })

      return tx
    })

    const signaturesCount = countVerifiedTxSignatures(signedTx, input.vault)
    const summary = summarizeTx(signedTx, input.vault)
    return {
      partialTxHex: signedTx.toHex(),
      signaturesCount,
      requiredSignatures: summary.requiredSignatures,
      isComplete: signaturesCount >= input.vault.m
    }
  }

  describePartialTx(vault: EcashMultisigVault, partialTxHex: string): EcashMultisigTxSummary {
    assertVaultConsensusShape(vault)
    return summarizeTx(Tx.fromHex(partialTxHex.trim()), vault)
  }

  async inspectProposal(input: {
    vault: EcashMultisigVault
    partialTxHex: string
  }): Promise<EcashMultisigProposalInspection> {
    assertVaultConsensusShape(input.vault)
    const tx = Tx.fromHex(input.partialTxHex.trim())
    const utxos = await this.getVaultUtxos(input.vault)
    return inspectTx(tx, input.vault, utxos)
  }

  async broadcast(input: { vault: EcashMultisigVault, partialTxHex: string }): Promise<string> {
    assertVaultConsensusShape(input.vault)
    const tx = Tx.fromHex(input.partialTxHex.trim())
    const inspection = inspectTx(tx, input.vault, await this.getVaultUtxos(input.vault))
    if (inspection.hasTokenInputs) {
      throw new Error('El partialTxHex intenta gastar un UTXO con token.')
    }
    if (inspection.warnings.some((warning) => /firmas invalidas o duplicadas/i.test(warning))) {
      throw new Error('El partialTxHex contiene firmas invalidas o duplicadas.')
    }
    const incompleteInput = inspection.signaturesByInput.find((item) => !item.isComplete)
    if (incompleteInput) {
      throw new Error(
        `Faltan firmas en input ${incompleteInput.inputIndex}: ` +
        `${incompleteInput.validSignatures}/${incompleteInput.requiredSignatures}.`
      )
    }

    const result = await getChronik().broadcastTx(toHex(tx.ser()))
    if (!result.txid) {
      throw new Error('Chronik no devolvio txid.')
    }
    return result.txid
  }
}

export const ecashMultisigService = new EcashMultisigService()
