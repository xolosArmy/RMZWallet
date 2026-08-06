import { ChronikClient } from 'chronik-client'
import { XEC_DUST_SATS } from '../src/config/xecFees'
import { encodeTm1Draft02Post } from '../src/integrations/tonalliMemo/tm1Draft02'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  createTm1Draft02Candidate,
  revalidateTm1Draft02Candidate,
  type Tm1Draft02FreshUtxo
} from '../src/integrations/tonalliMemo/tm1Draft02Candidate'
import { planTm1Draft02Post } from '../src/integrations/tonalliMemo/tm1Draft02Plan'
import {
  TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
  signTm1Draft02RegtestCandidate
} from '../src/integrations/tonalliMemo/tm1Draft02RegtestP2pkhSigner'
import {
  TM1_CHRONIK_REGTEST_CHAIN_IDENTITY,
  Tm1ChronikRegtestDeliveryTransport,
  Tm1ChronikRegtestDeliveryTransportError
} from '../src/integrations/tonalliMemo/tm1ChronikRegtestDeliveryTransport'
import { Tm1InMemoryDeliveryTransport } from '../src/integrations/tonalliMemo/tm1RegtestDeliveryTransport'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000'
const DEFAULT_MESSAGE = 'Tonalli Memo TM1 Draft 0.2 regtest E2E'
const FIXTURE_HASH160 = TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX.slice(6, 46)
const FIXTURE_REGTEST_ADDRESS = 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r'
const MAX_FEE_SATS = 10_000n

type ProcessLike = Readonly<{
  env?: Record<string, string | undefined>
  argv?: readonly string[]
  exitCode?: number
}>

type ChronikUtxo = Readonly<{
  outpoint?: Readonly<{ txid?: unknown; outIdx?: unknown }>
  sats?: unknown
  token?: unknown
}>

type ChronikScriptEndpoint = Readonly<{
  utxos: () => Promise<unknown>
}>

type ChronikClientWithScriptAndTx = ChronikClient & Readonly<{
  script: (scriptType: string, payload: string) => ChronikScriptEndpoint
  tx: (txid: string) => Promise<unknown>
}>

class HarnessError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
  }
}

async function main(): Promise<void> {
  const endpoint = readOption('--endpoint') ?? readEnv('TM1_REGTEST_CHRONIK_URL') ?? DEFAULT_ENDPOINT
  const message = readOption('--message') ?? readEnv('TM1_REGTEST_MESSAGE') ?? DEFAULT_MESSAGE

  printBanner(endpoint, message)

  const transport = new Tm1ChronikRegtestDeliveryTransport(endpoint)
  const attestation = await transport.attestNetwork()
  if (attestation.chainIdentity !== TM1_CHRONIK_REGTEST_CHAIN_IDENTITY) {
    throw new HarnessError(
      'CHAIN_IDENTITY_MISMATCH',
      `Chronik respondió con una identidad inesperada: ${attestation.chainIdentity}`
    )
  }
  console.log(`✓ Génesis atestado: ${attestation.chainIdentity}`)

  const chronik = new ChronikClient([transport.endpointUrl]) as ChronikClientWithScriptAndTx
  const freshUtxos = await readFixtureUtxos(chronik)
  if (freshUtxos.length === 0) {
    throw new HarnessError(
      'FIXTURE_UTXO_REQUIRED',
      [
        'No hay UTXOs XEC puros para la llave fixture de regtest.',
        `Fondea esta dirección únicamente dentro de regtest: ${FIXTURE_REGTEST_ADDRESS}`,
        `Locking script esperado: ${TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX}`,
        'Después mina suficientes bloques para que cualquier coinbase utilizada sea gastable y vuelve a ejecutar el harness.'
      ].join('\n')
    )
  }
  console.log(`✓ UTXOs fixture detectados: ${freshUtxos.length}`)

  const preview = encodeTm1Draft02Post({
    eventData: message,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX
  })
  const plan = planTm1Draft02Post({
    preview,
    utxos: freshUtxos,
    activeLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX
  })

  const candidate = createTm1Draft02Candidate({
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    transactionVersion: TM1_DRAFT_02_TX_VERSION,
    locktime: TM1_DRAFT_02_LOCKTIME,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
    authorLockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
    inputs: plan.inputs.map(input => ({
      txid: input.txid,
      outIdx: input.outIdx,
      sequence: TM1_DRAFT_02_SEQUENCE,
      sats: input.sats,
      lockingScriptHex: input.lockingScriptHex
    })),
    outputs: plan.outputs.map(output => ({
      sats: output.sats,
      scriptHex: output.scriptHex
    })),
    dustSats: BigInt(XEC_DUST_SATS),
    maxFeeSats: MAX_FEE_SATS,
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY
  })

  revalidateTm1Draft02Candidate(candidate, freshUtxos)
  console.log(`✓ Candidato revalidado: ${candidate.inputs.length} input(s), comisión ${candidate.feePolicy.feeSats} sats`)

  const signedArtifact = signTm1Draft02RegtestCandidate({ candidate })
  await new Tm1InMemoryDeliveryTransport().submit(signedArtifact)
  console.log(`✓ Transacción firmada y auditada: ${signedArtifact.txid}`)

  const receipt = await transport.submit(signedArtifact)
  console.log(`✓ Broadcast aceptado por Chronik: ${receipt.txid}`)

  const observed = await readSubmittedTransaction(chronik, receipt.txid)
  console.log(`✓ Chronik devolvió el mismo txid: ${observed.txid}`)
  console.log(`✓ Estado: ${observed.confirmed ? 'confirmada en bloque' : 'aceptada en mempool'}`)
  console.log('TM1 REGTEST E2E: ÉXITO')
}

async function readFixtureUtxos(
  chronik: ChronikClientWithScriptAndTx
): Promise<readonly Tm1Draft02FreshUtxo[]> {
  let response: unknown
  try {
    response = await chronik.script('p2pkh', FIXTURE_HASH160).utxos()
  } catch (error) {
    throw new HarnessError(
      'FIXTURE_UTXO_LOOKUP_FAILED',
      `No se pudieron consultar los UTXOs fixture: ${errorMessage(error)}`
    )
  }

  const record = asRecord(response)
  if (!record || !Array.isArray(record.utxos)) {
    throw new HarnessError('INVALID_UTXO_RESPONSE', 'Chronik devolvió una respuesta UTXO no reconocida.')
  }

  return Object.freeze(record.utxos.flatMap((value): Tm1Draft02FreshUtxo[] => {
    const utxo = asRecord(value) as ChronikUtxo | undefined
    const outpoint = asRecord(utxo?.outpoint)
    const txid = outpoint?.txid
    const outIdx = outpoint?.outIdx
    const sats = utxo?.sats

    if (
      typeof txid !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(txid) ||
      typeof outIdx !== 'number' ||
      !Number.isSafeInteger(outIdx) ||
      outIdx < 0 ||
      typeof sats !== 'bigint' ||
      sats <= 0n ||
      utxo?.token != null
    ) {
      return []
    }

    return [Object.freeze({
      txid: txid.toLowerCase(),
      outIdx,
      sats,
      lockingScriptHex: TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX,
      token: null
    })]
  }))
}

async function readSubmittedTransaction(
  chronik: ChronikClientWithScriptAndTx,
  expectedTxid: string
): Promise<Readonly<{ txid: string; confirmed: boolean }>> {
  let response: unknown
  try {
    response = await chronik.tx(expectedTxid)
  } catch (error) {
    throw new HarnessError(
      'TX_LOOKUP_FAILED',
      `El broadcast fue aceptado, pero Chronik no devolvió la transacción ${expectedTxid}: ${errorMessage(error)}`
    )
  }

  const record = asRecord(response)
  const txid = record?.txid
  if (typeof txid !== 'string' || txid.toLowerCase() !== expectedTxid) {
    throw new HarnessError('TX_LOOKUP_MISMATCH', 'Chronik devolvió una transacción distinta a la transmitida.')
  }

  return Object.freeze({
    txid: txid.toLowerCase(),
    confirmed: asRecord(record?.block) !== undefined
  })
}

function readOption(name: string): string | undefined {
  const argv = processLike().argv ?? []
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new HarnessError('INVALID_ARGUMENT', `Falta un valor para ${name}.`)
  }
  return value
}

function readEnv(name: string): string | undefined {
  const value = processLike().env?.[name]
  return value && value.trim().length > 0 ? value.trim() : undefined
}

function processLike(): ProcessLike {
  return (globalThis as unknown as { process?: ProcessLike }).process ?? {}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function printBanner(endpoint: string, message: string): void {
  console.log('TM1 Draft 0.2 · Harness E2E regtest')
  console.log(`Endpoint: ${endpoint}`)
  console.log(`Dirección fixture: ${FIXTURE_REGTEST_ADDRESS}`)
  console.log(`Mensaje: ${JSON.stringify(message)}`)
}

void main().catch((error: unknown) => {
  if (error instanceof HarnessError) {
    console.error(`TM1 REGTEST E2E FALLÓ [${error.code}]`)
    console.error(error.message)
  } else if (error instanceof Tm1ChronikRegtestDeliveryTransportError) {
    console.error(`TM1 REGTEST E2E FALLÓ [${error.code}]`)
    console.error(error.message)
  } else {
    console.error('TM1 REGTEST E2E FALLÓ [UNEXPECTED_ERROR]')
    console.error(errorMessage(error))
  }
  const process = processLike() as { exitCode?: number }
  process.exitCode = 1
})
