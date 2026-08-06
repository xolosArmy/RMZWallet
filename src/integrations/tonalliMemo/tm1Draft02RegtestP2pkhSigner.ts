import {
  ALL_BIP143,
  Ecc,
  P2PKHSignatory,
  Script,
  Tx,
  TxBuilder,
  UnsignedTx,
  fromHex,
  isPushOp,
  sha256d,
  shaRmd160,
  toHex
} from 'ecash-lib'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_SIGHASH_POLICY,
  encodeTm1Draft02CandidateEffectiveContent,
  type Tm1Draft02Candidate
} from './tm1Draft02Candidate'
import {
  auditTm1Draft02UnsignedTransaction,
  serializeTm1Draft02UnsignedTransaction
} from './tm1Draft02UnsignedTransaction'

export const TM1_REGTEST_SIGNED_TRANSACTION_FORMAT =
  'tonalli.tm1-draft02.regtest-signed-transaction.v1'
export const TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION = 1

/**
 * Public deterministic testnet/regtest fixture WIF for secret key 1.
 * This key is intentionally unsafe for value and must never be used outside
 * isolated regtest fixtures.
 */
export const TM1_REGTEST_FIXTURE_WIF =
  'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'
export const TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
export const TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX =
  '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const TESTNET_WIF_VERSION = 0xef
const COMPRESSED_WIF_MARKER = 0x01
const SCHNORR_SIGNATURE_BYTES = 64

export type Tm1Draft02RegtestSignerErrorCode =
  | 'OPERATION_ABORTED'
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_SIGHASH_POLICY'
  | 'INVALID_FIXTURE_WIF'
  | 'INVALID_FIXTURE_SECRET_KEY'
  | 'FIXTURE_PUBLIC_KEY_MISMATCH'
  | 'FIXTURE_LOCKING_SCRIPT_MISMATCH'
  | 'INPUT_NOT_OWNED_BY_FIXTURE_KEY'
  | 'AUTHOR_IDENTITY_MISMATCH'
  | 'SIGNED_TRANSACTION_MISMATCH'
  | 'INVALID_P2PKH_SCRIPTSIG'
  | 'INVALID_P2PKH_SIGNATURE'

export class Tm1Draft02RegtestSignerError extends Error {
  readonly code: Tm1Draft02RegtestSignerErrorCode

  constructor(code: Tm1Draft02RegtestSignerErrorCode, message = code) {
    super(message)
    this.name = 'Tm1Draft02RegtestSignerError'
    this.code = code
  }
}

export type RegtestSignedTransaction = Readonly<{
  format: typeof TM1_REGTEST_SIGNED_TRANSACTION_FORMAT
  artifactVersion: typeof TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION
  environment: typeof TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
  sighashPolicy: typeof TM1_DRAFT_02_SIGHASH_POLICY
  fixturePublicKeyHex: typeof TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX
  fixtureLockingScriptHex: typeof TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
  inputCount: number
  feeSats: bigint
  txid: string
  rawTransactionHex: string
  rawTransactionBytes: Uint8Array
}>

export function signTm1Draft02RegtestCandidate(input: Readonly<{
  candidate: Tm1Draft02Candidate
  signal?: AbortSignal
}>): RegtestSignedTransaction {
  assertNotAborted(input.signal)

  const unsignedBytes = serializeTm1Draft02UnsignedTransaction(input.candidate)
  const audited = auditTm1Draft02UnsignedTransaction({
    effectiveContent: encodeTm1Draft02CandidateEffectiveContent(input.candidate),
    unsignedTransactionBytes: unsignedBytes
  })
  const candidate = audited.candidate

  if (candidate.environment !== TM1_DRAFT_02_CANDIDATE_ENVIRONMENT) {
    fail('INVALID_ENVIRONMENT')
  }
  if (candidate.sighashPolicy !== TM1_DRAFT_02_SIGHASH_POLICY) {
    fail('INVALID_SIGHASH_POLICY')
  }

  const secretKey = decodeCompressedRegtestWif(TM1_REGTEST_FIXTURE_WIF)
  const ecc = new Ecc()
  if (!ecc.isValidSeckey(secretKey)) fail('INVALID_FIXTURE_SECRET_KEY')

  const publicKey = ecc.derivePubkey(secretKey)
  if (toHex(publicKey) !== TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX) {
    fail('FIXTURE_PUBLIC_KEY_MISMATCH')
  }

  const fixtureLockingScript = Script.p2pkh(shaRmd160(publicKey))
  if (fixtureLockingScript.toHex() !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX) {
    fail('FIXTURE_LOCKING_SCRIPT_MISMATCH')
  }

  for (const candidateInput of candidate.inputs) {
    if (candidateInput.lockingScriptHex !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX) {
      fail('INPUT_NOT_OWNED_BY_FIXTURE_KEY')
    }
  }
  if (
    candidate.authorInputIndex !== TM1_DRAFT_02_AUTHOR_INPUT_INDEX ||
    candidate.authorLockingScriptHex !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX ||
    candidate.outputs[1].scriptHex !== TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
  ) {
    fail('AUTHOR_IDENTITY_MISMATCH')
  }

  assertNotAborted(input.signal)
  const signatory = P2PKHSignatory(secretKey, publicKey, ALL_BIP143)
  const signedTransaction = new TxBuilder({
    version: candidate.transactionVersion,
    locktime: candidate.locktime,
    inputs: candidate.inputs.map(candidateInput => ({
      input: {
        prevOut: {
          txid: candidateInput.txid,
          outIdx: candidateInput.outIdx
        },
        sequence: candidateInput.sequence,
        signData: {
          sats: candidateInput.sats,
          outputScript: new Script(fromHex(candidateInput.lockingScriptHex))
        }
      },
      signatory
    })),
    outputs: candidate.outputs.map(candidateOutput => ({
      sats: candidateOutput.sats,
      script: new Script(fromHex(candidateOutput.scriptHex))
    }))
  }).sign({ ecc })

  auditSignedTransaction(candidate, signedTransaction, publicKey, ecc)
  assertNotAborted(input.signal)

  const rawTransactionBytes = signedTransaction.ser()
  return Object.freeze({
    format: TM1_REGTEST_SIGNED_TRANSACTION_FORMAT,
    artifactVersion: TM1_REGTEST_SIGNED_TRANSACTION_ARTIFACT_VERSION,
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY,
    fixturePublicKeyHex: TM1_REGTEST_FIXTURE_PUBLIC_KEY_HEX,
    fixtureLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
    inputCount: candidate.inputs.length,
    feeSats: candidate.feePolicy.feeSats,
    txid: signedTransaction.txid(),
    rawTransactionHex: toHex(rawTransactionBytes),
    rawTransactionBytes: new Uint8Array(rawTransactionBytes)
  })
}

function auditSignedTransaction(
  candidate: Tm1Draft02Candidate,
  signedTransaction: Tx,
  publicKey: Uint8Array,
  ecc: Ecc
): void {
  if (
    signedTransaction.version !== candidate.transactionVersion ||
    signedTransaction.locktime !== candidate.locktime ||
    signedTransaction.inputs.length !== candidate.inputs.length ||
    signedTransaction.outputs.length !== candidate.outputs.length
  ) {
    fail('SIGNED_TRANSACTION_MISMATCH')
  }

  signedTransaction.inputs.forEach((signedInput, index) => {
    const expected = candidate.inputs[index]
    if (
      !expected ||
      typeof signedInput.prevOut.txid !== 'string' ||
      signedInput.prevOut.txid.toLowerCase() !== expected.txid ||
      signedInput.prevOut.outIdx !== expected.outIdx ||
      signedInput.sequence !== expected.sequence
    ) {
      fail('SIGNED_TRANSACTION_MISMATCH')
    }
  })

  signedTransaction.outputs.forEach((signedOutput, index) => {
    const expected = candidate.outputs[index]
    if (
      !expected ||
      signedOutput.sats !== expected.sats ||
      signedOutput.script.toHex() !== expected.scriptHex
    ) {
      fail('SIGNED_TRANSACTION_MISMATCH')
    }
  })

  const unsigned = UnsignedTx.fromTx(signedTransaction)
  signedTransaction.inputs.forEach((signedInput, index) => {
    const operations = signedInput.script?.ops()
    const signaturePush = operations?.next()
    const publicKeyPush = operations?.next()
    if (
      !operations ||
      !isPushOp(signaturePush) ||
      !isPushOp(publicKeyPush) ||
      operations.next() !== undefined ||
      signaturePush.data.length !== SCHNORR_SIGNATURE_BYTES + 1 ||
      publicKeyPush.data.length !== publicKey.length ||
      !bytesEqual(publicKeyPush.data, publicKey) ||
      signaturePush.data[SCHNORR_SIGNATURE_BYTES] !== (ALL_BIP143.toInt() & 0xff)
    ) {
      fail('INVALID_P2PKH_SCRIPTSIG')
    }

    const preimage = unsigned.inputAt(index).sigHashPreimage(ALL_BIP143)
    const sighash = sha256d(preimage.bytes)
    try {
      ecc.schnorrVerify(
        signaturePush.data.slice(0, SCHNORR_SIGNATURE_BYTES),
        sighash,
        publicKey
      )
    } catch {
      fail('INVALID_P2PKH_SIGNATURE')
    }
  })
}

function decodeCompressedRegtestWif(wif: string): Uint8Array {
  const decoded = decodeBase58(wif)
  if (decoded.length !== 38) fail('INVALID_FIXTURE_WIF')

  const payload = decoded.slice(0, -4)
  const checksum = decoded.slice(-4)
  if (!bytesEqual(checksum, sha256d(payload).slice(0, 4))) {
    fail('INVALID_FIXTURE_WIF')
  }
  if (
    payload[0] !== TESTNET_WIF_VERSION ||
    payload[payload.length - 1] !== COMPRESSED_WIF_MARKER
  ) {
    fail('INVALID_FIXTURE_WIF')
  }

  const secretKey = payload.slice(1, -1)
  if (secretKey.length !== 32) fail('INVALID_FIXTURE_WIF')
  return secretKey
}

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) fail('INVALID_FIXTURE_WIF')

  let accumulator = 0n
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) fail('INVALID_FIXTURE_WIF')
    accumulator = accumulator * 58n + BigInt(digit)
  }

  const decoded: number[] = []
  while (accumulator > 0n) {
    decoded.unshift(Number(accumulator & 0xffn))
    accumulator >>= 8n
  }
  for (const character of value) {
    if (character !== '1') break
    decoded.unshift(0)
  }
  return Uint8Array.from(decoded)
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('OPERATION_ABORTED')
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function fail(code: Tm1Draft02RegtestSignerErrorCode): never {
  throw new Tm1Draft02RegtestSignerError(code)
}
