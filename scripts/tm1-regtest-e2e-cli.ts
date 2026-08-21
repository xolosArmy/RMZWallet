import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import {
  createTm1RegtestRuntime,
  type Tm1RegtestRuntimeConfig
} from '../src/integrations/tonalliMemo/tm1RegtestRuntimeComposition'

export const TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS = 300_000
export const TM1_REGTEST_E2E_CONFIRMATION_POLL_MS = 1_000
export const TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS = 120_000

const FIXTURE_LOCKING_SCRIPT_HEX =
  '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'
const MAX_FEE_SATS = 10_000n
const CANONICAL_HASH = /^[0-9a-f]{64}$/
const SIGNING_REQUESTER = Object.freeze({
  declaredOrigin: 'https://sign.tm1-regtest-e2e.invalid',
  displayName: 'Tonalli Memo Regtest E2E SIGN'
})
const BROADCAST_REQUESTER = Object.freeze({
  declaredOrigin: 'https://broadcast.tm1-regtest-e2e.invalid',
  displayName: 'Tonalli Memo Regtest E2E BROADCAST'
})

type SigningDecisionProvider =
  Tm1RegtestRuntimeConfig['authorization']['signing']['decisionProvider']
type BroadcastDecisionProvider =
  Tm1RegtestRuntimeConfig['authorization']['broadcast']['decisionProvider']
type SigningDecisionRequest = Parameters<SigningDecisionProvider['requestDecision']>[0]
type BroadcastDecisionRequest = Parameters<BroadcastDecisionProvider['requestDecision']>[0]
type Tm1RegtestRuntime = ReturnType<typeof createTm1RegtestRuntime>
type Tm1RegtestRuntimeState = ReturnType<Tm1RegtestRuntime['getState']>

export type Tm1RegtestE2eLineResult = Readonly<
  | { status: 'line'; value: string }
  | { status: 'eof' }
>

export interface Tm1RegtestE2eTextIo {
  writeLine(line: string): void
  readLine(prompt: string, signal: AbortSignal): Promise<Tm1RegtestE2eLineResult>
}

export type Tm1RegtestE2eRunOptions = Readonly<{
  endpoint: string
  message: string
  isTty: boolean
  io: Tm1RegtestE2eTextIo
  signal: AbortSignal
}>

export type Tm1RegtestE2eRunResult = Readonly<{
  exitCode: 0 | 1 | 2 | 10 | 11 | 12 | 13 | 20 | 21 | 22 | 130
  status:
    | 'confirmed'
    | 'configurationError'
    | 'signingRejected'
    | 'signingExpired'
    | 'broadcastRejected'
    | 'broadcastExpired'
    | 'operationFailed'
    | 'broadcastUncertain'
    | 'confirmationUnresolved'
    | 'aborted'
    | 'unexpectedError'
}>

export function createNodeInteractiveTextIo(
  input: Readable,
  output: Writable,
  onInterrupt: () => void
): Tm1RegtestE2eTextIo {
  return Object.freeze({
    writeLine: (line: string): void => {
      output.write(`${line}\n`)
    },
    readLine: (prompt: string, signal: AbortSignal): Promise<Tm1RegtestE2eLineResult> =>
      readNodeLine(input, output, prompt, signal, onInterrupt)
  })
}

export function createInteractiveSigningDecisionProvider(
  io: Tm1RegtestE2eTextIo
): SigningDecisionProvider {
  return Object.freeze({
    requestDecision: async (request: SigningDecisionRequest, signal: AbortSignal) => {
      if (signal.aborted) throw abortError()
      const fingerprint = approvalFingerprint(request.bindingHash)
      if (fingerprint === null) {
        io.writeLine('SIGN AUTHORIZATION: INVALID_REVIEW_HASH')
        return Object.freeze({ status: 'rejected' as const, reason: 'INVALID_REVIEW_HASH' })
      }

      writeSigningReview(io, request, fingerprint)
      const answer = await readLineOrAbort(
        io,
        `Type SIGN ${fingerprint} to authorize: `,
        signal
      )
      if (answer.status === 'eof') {
        return Object.freeze({ status: 'rejected' as const, reason: 'END_OF_INPUT' })
      }
      return answer.value === `SIGN ${fingerprint}`
        ? Object.freeze({ status: 'approved' as const })
        : Object.freeze({ status: 'rejected' as const, reason: 'SIGN_APPROVAL_MISMATCH' })
    }
  })
}

export function createInteractiveBroadcastDecisionProvider(
  io: Tm1RegtestE2eTextIo
): BroadcastDecisionProvider {
  return Object.freeze({
    requestDecision: async (request: BroadcastDecisionRequest, signal: AbortSignal) => {
      if (signal.aborted) throw abortError()
      const fingerprint = approvalFingerprint(request.signedArtifactHash)
      if (fingerprint === null) {
        io.writeLine('BROADCAST AUTHORIZATION: INVALID_REVIEW_HASH')
        return Object.freeze({ status: 'rejected' as const, reason: 'INVALID_REVIEW_HASH' })
      }

      writeBroadcastReview(io, request, fingerprint)
      const answer = await readLineOrAbort(
        io,
        `Type BROADCAST ${fingerprint} to authorize: `,
        signal
      )
      if (answer.status === 'eof') {
        return Object.freeze({ status: 'rejected' as const, reason: 'END_OF_INPUT' })
      }
      return answer.value === `BROADCAST ${fingerprint}`
        ? Object.freeze({ status: 'approved' as const })
        : Object.freeze({ status: 'rejected' as const, reason: 'BROADCAST_APPROVAL_MISMATCH' })
    }
  })
}

export async function runTm1RegtestE2eCli(
  options: Tm1RegtestE2eRunOptions
): Promise<Tm1RegtestE2eRunResult> {
  if (!options.isTty) {
    options.io.writeLine('CONFIGURATION_ERROR [NON_INTERACTIVE_STDIN]')
    return result(2, 'configurationError')
  }
  if (options.signal.aborted) return aborted(options.io)

  const signingDecisionProvider = createInteractiveSigningDecisionProvider(options.io)
  const broadcastDecisionProvider = createInteractiveBroadcastDecisionProvider(options.io)

  let runtime: Tm1RegtestRuntime
  try {
    runtime = createTm1RegtestRuntime({
      chronikEndpointUrl: options.endpoint,
      authorization: {
        signing: {
          decisionProvider: signingDecisionProvider,
          ttlMs: TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS,
          requester: SIGNING_REQUESTER
        },
        broadcast: {
          decisionProvider: broadcastDecisionProvider,
          ttlMs: TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS,
          requester: BROADCAST_REQUESTER
        }
      }
    })
  } catch (error) {
    return configurationFailure(options.io, error)
  }

  let dispatchStarted = false
  const unsubscribe = runtime.subscribe(state => {
    if (state.status === 'broadcasting') dispatchStarted = true
  })

  try {
    let prepared: Awaited<ReturnType<Tm1RegtestRuntime['prepare']>>
    try {
      prepared = await runtime.prepare({
        message: options.message,
        activeLockingScriptHex: FIXTURE_LOCKING_SCRIPT_HEX,
        maxFeeSats: MAX_FEE_SATS
      }, options.signal)
    } catch (error) {
      return operationFailure(options.io, runtime.getState(), error, options.signal)
    }
    writePrepared(options.io, prepared)

    let signed: Awaited<ReturnType<Tm1RegtestRuntime['authorizeAndSign']>>
    try {
      signed = await runtime.authorizeAndSign(prepared.preparedId, options.signal)
    } catch (error) {
      return operationFailure(options.io, runtime.getState(), error, options.signal)
    }
    writeSigned(options.io, signed)

    let receipt: Awaited<ReturnType<Tm1RegtestRuntime['approveAndBroadcast']>>
    try {
      receipt = await runtime.approveAndBroadcast(signed.signedId, options.signal)
    } catch (error) {
      const state = runtime.getState()
      if (state.status === 'broadcastUncertain') {
        writeBroadcastUncertain(options.io, state)
        if (options.signal.aborted && dispatchStarted) return abortedAfterDispatch(options.io)
        return observeBroadcastUncertain(runtime, options.io, options.signal)
      }
      return operationFailure(options.io, state, error, options.signal)
    }
    writeSubmitted(options.io, receipt)

    if (options.signal.aborted && dispatchStarted) return abortedAfterDispatch(options.io)
    return observeSubmitted(runtime, receipt.submissionId, options.io, options.signal)
  } catch (error) {
    return unexpectedFailure(options.io, error)
  } finally {
    unsubscribe()
  }
}

async function observeSubmitted(
  runtime: Tm1RegtestRuntime,
  submissionId: string,
  io: Tm1RegtestE2eTextIo,
  signal: AbortSignal
): Promise<Tm1RegtestE2eRunResult> {
  const deadline = Date.now() + TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS
  const maximumAttempts = Math.floor(
    TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS / TM1_REGTEST_E2E_CONFIRMATION_POLL_MS
  ) + 1

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const confirmation = await runtime.confirm(submissionId, signal)
      writeConfirmation(io, 'CONFIRMATION', confirmation)
      return result(0, 'confirmed')
    } catch (error) {
      if (signal.aborted || safeErrorCode(error) === 'ABORTED') return aborted(io)
      const state = runtime.getState()
      if (safeErrorCode(error) !== 'CONFIRMATION_FAILED' || state.status !== 'submitted') {
        io.writeLine(`CONFIRMATION [${safeErrorCode(error) ?? 'UNEXPECTED_ERROR'}]`)
        return result(22, 'confirmationUnresolved')
      }
      if (attempt + 1 >= maximumAttempts || Date.now() >= deadline) {
        io.writeLine(`CONFIRMATION TIMEOUT submissionId=${submissionId}`)
        return result(22, 'confirmationUnresolved')
      }
      try {
        await abortableDelay(TM1_REGTEST_E2E_CONFIRMATION_POLL_MS, signal)
      } catch {
        return aborted(io)
      }
    }
  }

  return result(22, 'confirmationUnresolved')
}

async function observeBroadcastUncertain(
  runtime: Tm1RegtestRuntime,
  io: Tm1RegtestE2eTextIo,
  signal: AbortSignal
): Promise<Tm1RegtestE2eRunResult> {
  const deadline = Date.now() + TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS
  const maximumAttempts = Math.floor(
    TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS / TM1_REGTEST_E2E_CONFIRMATION_POLL_MS
  ) + 1

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const confirmation = await runtime.reconcile(signal)
      writeConfirmation(io, 'RECONCILIATION', confirmation)
      return result(0, 'confirmed')
    } catch (error) {
      if (signal.aborted || safeErrorCode(error) === 'ABORTED') return aborted(io)
      const state = runtime.getState()
      if (
        safeErrorCode(error) !== 'CONFIRMATION_FAILED' ||
        state.status !== 'broadcastUncertain'
      ) {
        io.writeLine(`RECONCILIATION [${safeErrorCode(error) ?? 'UNEXPECTED_ERROR'}]`)
        return result(21, 'broadcastUncertain')
      }
      if (attempt + 1 >= maximumAttempts || Date.now() >= deadline) {
        io.writeLine('RECONCILIATION TIMEOUT: broadcast remains uncertain')
        return result(21, 'broadcastUncertain')
      }
      try {
        await abortableDelay(TM1_REGTEST_E2E_CONFIRMATION_POLL_MS, signal)
      } catch {
        return aborted(io)
      }
    }
  }

  return result(21, 'broadcastUncertain')
}

function writeSigningReview(
  io: Tm1RegtestE2eTextIo,
  request: Parameters<SigningDecisionProvider['requestDecision']>[0],
  fingerprint: string
): void {
  io.writeLine('REGTEST ONLY')
  io.writeLine('SIGN AUTHORIZATION')
  io.writeLine(`operationId: ${request.operationId}`)
  io.writeLine(`preparedId: ${request.preparedId}`)
  io.writeLine(`bindingHash: ${request.bindingHash}`)
  io.writeLine(`contentHash: ${request.contentHash}`)
  io.writeLine(`expiresAt: ${formatTimestamp(request.expiresAt)}`)
  io.writeLine(`network.environment: ${request.review.network.environment}`)
  io.writeLine(`network.chainIdentity: ${request.review.network.chainIdentity}`)
  io.writeLine(`message: ${JSON.stringify(request.review.message)}`)
  io.writeLine(`effectiveContent.hex: ${bytesToHex(request.review.effectiveContent)}`)
  for (const input of request.review.orderedInputs) {
    io.writeLine(
      `input[${input.index}]: role=${input.role} txid=${input.txid} outIdx=${input.outIdx} sats=${input.sats} lockingScriptHex=${input.lockingScriptHex}`
    )
  }
  writeOutputs(io, request.review.orderedOutputs)
  io.writeLine(`feeSats: ${request.review.feeSats}`)
  io.writeLine('This approval authorizes signing this exact prepared candidate.')
  io.writeLine('It does not authorize broadcast.')
  io.writeLine(`Required phrase: SIGN ${fingerprint}`)
}

function writeBroadcastReview(
  io: Tm1RegtestE2eTextIo,
  request: Parameters<BroadcastDecisionProvider['requestDecision']>[0],
  fingerprint: string
): void {
  io.writeLine('REGTEST ONLY')
  io.writeLine('BROADCAST AUTHORIZATION')
  io.writeLine(`operationId: ${request.operationId}`)
  io.writeLine(`signedId: ${request.signedId}`)
  io.writeLine(`txid: ${request.txid}`)
  io.writeLine(`signedArtifactHash: ${request.signedArtifactHash}`)
  io.writeLine(`bindingHash: ${request.review.bindingHash}`)
  io.writeLine(`contentHash: ${request.contentHash}`)
  io.writeLine(`expiresAt: ${formatTimestamp(request.expiresAt)}`)
  writeOutputs(io, request.review.orderedOutputs)
  io.writeLine(`feeSats: ${request.review.feeSats}`)
  io.writeLine('This approval authorizes possible broadcast of this exact signed artifact.')
  io.writeLine('The authorization adapter itself does not transmit it.')
  io.writeLine(
    'The publication orchestrator re-audits the artifact and performs final checks before dispatch.'
  )
  io.writeLine(`Required phrase: BROADCAST ${fingerprint}`)
}

function writePrepared(
  io: Tm1RegtestE2eTextIo,
  prepared: Awaited<ReturnType<Tm1RegtestRuntime['prepare']>>
): void {
  io.writeLine('PREPARED')
  io.writeLine(`preparedId: ${prepared.preparedId}`)
  io.writeLine(`bindingHash: ${prepared.bindingHash}`)
  io.writeLine(`feeSats: ${prepared.feeSats}`)
  writeOutputs(io, prepared.orderedOutputs)
}

function writeSigned(
  io: Tm1RegtestE2eTextIo,
  signed: Awaited<ReturnType<Tm1RegtestRuntime['authorizeAndSign']>>
): void {
  io.writeLine('SIGNED')
  io.writeLine(`signedId: ${signed.signedId}`)
  io.writeLine(`txid: ${signed.txid}`)
  io.writeLine(`signedArtifactHash: ${signed.signedArtifactHash}`)
  io.writeLine(`feeSats: ${signed.feeSats}`)
}

function writeSubmitted(
  io: Tm1RegtestE2eTextIo,
  receipt: Awaited<ReturnType<Tm1RegtestRuntime['approveAndBroadcast']>>
): void {
  io.writeLine('SUBMITTED')
  io.writeLine(`submissionId: ${receipt.submissionId}`)
  io.writeLine(`preparedId: ${receipt.preparedId}`)
  io.writeLine(`signedId: ${receipt.signedId}`)
  io.writeLine(`txid: ${receipt.txid}`)
}

function writeBroadcastUncertain(
  io: Tm1RegtestE2eTextIo,
  state: Extract<Tm1RegtestRuntimeState, { status: 'broadcastUncertain' }>
): void {
  io.writeLine('BROADCAST_UNCERTAIN')
  io.writeLine(`submissionId: ${state.uncertainty.submissionId}`)
  io.writeLine(`signedId: ${state.uncertainty.signedId}`)
  io.writeLine(`txid: ${state.uncertainty.txid}`)
  io.writeLine(`signedArtifactHash: ${state.uncertainty.signedArtifactHash}`)
  io.writeLine('Broadcast may have succeeded. The CLI will not retransmit.')
}

function writeConfirmation(
  io: Tm1RegtestE2eTextIo,
  label: 'CONFIRMATION' | 'RECONCILIATION',
  confirmation: Awaited<ReturnType<Tm1RegtestRuntime['confirm']>>
): void {
  io.writeLine(label)
  io.writeLine(`submissionId: ${confirmation.submissionId}`)
  io.writeLine(`txid: ${confirmation.txid}`)
  io.writeLine(`confirmations: ${confirmation.confirmations}`)
  if (confirmation.blockHash !== undefined) io.writeLine(`blockHash: ${confirmation.blockHash}`)
  if (confirmation.blockHeight !== undefined) io.writeLine(`blockHeight: ${confirmation.blockHeight}`)
}

function writeOutputs(
  io: Tm1RegtestE2eTextIo,
  outputs: readonly Readonly<{
    index: number
    role: string
    sats: bigint
    scriptHex: string
  }>[]
): void {
  for (const output of outputs) {
    io.writeLine(
      `output[${output.index}]: role=${output.role} sats=${output.sats} scriptHex=${output.scriptHex}`
    )
  }
}

function approvalFingerprint(hash: unknown): string | null {
  return typeof hash === 'string' && CANONICAL_HASH.test(hash) ? hash.slice(-12) : null
}

async function readLineOrAbort(
  io: Tm1RegtestE2eTextIo,
  prompt: string,
  signal: AbortSignal
): Promise<Tm1RegtestE2eLineResult> {
  if (signal.aborted) throw abortError()

  const pending = Promise.resolve(io.readLine(prompt, signal))
  void pending.catch(() => undefined)

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    pending.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(safeError(error))
      }
    )
  })
}

function readNodeLine(
  input: Readable,
  output: Writable,
  prompt: string,
  signal: AbortSignal,
  onInterrupt: () => void
): Promise<Tm1RegtestE2eLineResult> {
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    const readline = createInterface({ input, output, terminal: true })
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      readline.removeListener('close', onClose)
      readline.removeListener('SIGINT', onSigint)
      readline.close()
    }
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    const onAbort = (): void => finish(() => reject(abortError()))
    const onClose = (): void => finish(() => resolve(Object.freeze({ status: 'eof' })))
    const onSigint = (): void => {
      try {
        onInterrupt()
      } catch {
        // The prompt still fails closed if the trusted bridge unexpectedly throws.
      }
      finish(() => reject(abortError()))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    readline.once('close', onClose)
    readline.on('SIGINT', onSigint)
    if (signal.aborted) {
      onAbort()
      return
    }
    readline.question(prompt, answer => {
      finish(() => resolve(Object.freeze({ status: 'line', value: answer })))
    })
  })
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function operationFailure(
  io: Tm1RegtestE2eTextIo,
  state: Tm1RegtestRuntimeState,
  error: unknown,
  signal: AbortSignal
): Tm1RegtestE2eRunResult {
  const code = safeErrorCode(error)
  if (signal.aborted || code === 'ABORTED' || code === 'OPERATION_ABORTED') return aborted(io)
  if (code === 'SIGNING_REJECTED' || (state.status === 'rejected' && state.stage === 'signing')) {
    io.writeLine('SIGN AUTHORIZATION [REJECTED]')
    return result(10, 'signingRejected')
  }
  if (
    code === 'SIGNING_AUTHORIZATION_EXPIRED' ||
    (state.status === 'expired' && state.stage === 'signing')
  ) {
    io.writeLine('SIGN AUTHORIZATION [EXPIRED]')
    return result(11, 'signingExpired')
  }
  if (code === 'BROADCAST_REJECTED' || (state.status === 'rejected' && state.stage === 'broadcast')) {
    io.writeLine('BROADCAST AUTHORIZATION [REJECTED]')
    return result(12, 'broadcastRejected')
  }
  if (
    code === 'BROADCAST_AUTHORIZATION_EXPIRED' ||
    (state.status === 'expired' && state.stage === 'broadcast')
  ) {
    io.writeLine('BROADCAST AUTHORIZATION [EXPIRED]')
    return result(13, 'broadcastExpired')
  }

  io.writeLine(`OPERATION_FAILED [${code ?? 'UNEXPECTED_ERROR'}]`)
  return result(20, 'operationFailed')
}

function configurationFailure(
  io: Tm1RegtestE2eTextIo,
  error: unknown
): Tm1RegtestE2eRunResult {
  const code = safeErrorCode(error)
  const configurationCodes = new Set([
    'INVALID_RUNTIME_CONFIGURATION',
    'WEB_CRYPTO_UNAVAILABLE',
    'INVALID_ENDPOINT_URL',
    'NON_LOCAL_ENDPOINT_FORBIDDEN',
    'ENDPOINT_CREDENTIALS_FORBIDDEN',
    'ENDPOINT_PORT_REQUIRED',
    'ENDPOINT_PATH_FORBIDDEN'
  ])
  const isConfigurationError = code !== undefined && configurationCodes.has(code)
  io.writeLine(`CONFIGURATION_ERROR [${isConfigurationError ? code : 'UNEXPECTED_ERROR'}]`)
  return result(
    isConfigurationError ? 2 : 1,
    isConfigurationError ? 'configurationError' : 'unexpectedError'
  )
}

function unexpectedFailure(
  io: Tm1RegtestE2eTextIo,
  error: unknown
): Tm1RegtestE2eRunResult {
  io.writeLine(`TM1 REGTEST E2E [${safeErrorCode(error) ?? 'UNEXPECTED_ERROR'}]`)
  return result(1, 'unexpectedError')
}

function aborted(io: Tm1RegtestE2eTextIo): Tm1RegtestE2eRunResult {
  io.writeLine('ABORTED')
  return result(130, 'aborted')
}

function abortedAfterDispatch(io: Tm1RegtestE2eTextIo): Tm1RegtestE2eRunResult {
  io.writeLine('ABORTED AFTER DISPATCH REQUEST')
  io.writeLine('Broadcast was not claimed cancelled; no retransmission will occur.')
  return result(130, 'aborted')
}

function result(
  exitCode: Tm1RegtestE2eRunResult['exitCode'],
  status: Tm1RegtestE2eRunResult['status']
): Tm1RegtestE2eRunResult {
  return Object.freeze({ exitCode, status })
}

function safeErrorCode(error: unknown): string | undefined {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

function safeError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  } catch {
    // A hostile rejection must not escape through prototype inspection.
  }
  return new Error('PROMPT_FAILED')
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('ABORTED', 'AbortError')
  const error = new Error('ABORTED')
  error.name = 'AbortError'
  return error
}

function formatTimestamp(value: number): string {
  if (!Number.isSafeInteger(value)) return 'INVALID_EXPIRY'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'INVALID_EXPIRY' : date.toISOString()
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
