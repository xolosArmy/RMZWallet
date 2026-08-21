import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'

const runtimeFactory = vi.hoisted(() => vi.fn())

vi.mock('../src/integrations/tonalliMemo/tm1RegtestRuntimeComposition', () => ({
  createTm1RegtestRuntime: runtimeFactory
}))

import {
  TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS,
  TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS,
  TM1_REGTEST_E2E_CONFIRMATION_POLL_MS,
  createInteractiveBroadcastDecisionProvider,
  createInteractiveSigningDecisionProvider,
  createNodeInteractiveTextIo,
  runTm1RegtestE2eCli,
  type Tm1RegtestE2eLineResult,
  type Tm1RegtestE2eTextIo
} from './tm1-regtest-e2e-cli'

const BINDING_HASH = '11'.repeat(26) + 'abcdef123456'
const ARTIFACT_HASH = '22'.repeat(26) + '123456abcdef'
const TXID = '33'.repeat(32)
const CONTENT_HASH = `sha256:${'44'.repeat(32)}` as const
const SIGN_PHRASE = 'SIGN abcdef123456'
const BROADCAST_PHRASE = 'BROADCAST 123456abcdef'

type SigningProvider = ReturnType<typeof createInteractiveSigningDecisionProvider>
type BroadcastProvider = ReturnType<typeof createInteractiveBroadcastDecisionProvider>
type SigningRequest = Parameters<SigningProvider['requestDecision']>[0]
type BroadcastRequest = Parameters<BroadcastProvider['requestDecision']>[0]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  runtimeFactory.mockReset()
})

describe('TM1 regtest E2E interactive SIGN provider', () => {
  test('1. exact SIGN phrase approves and displays the exact review', async () => {
    const io = scriptedIo([{ status: 'line', value: SIGN_PHRASE }])
    const decision = await createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      new AbortController().signal
    )

    expect(decision).toEqual({ status: 'approved' })
    expect(io.output()).toContain('SIGN AUTHORIZATION')
    expect(io.output()).toContain(`bindingHash: ${BINDING_HASH}`)
    expect(io.output()).toContain('This approval authorizes signing this exact prepared candidate.')
    expect(io.output()).toContain('It does not authorize broadcast.')
  })

  test.each([
    ['2. bare Enter rejects', ''],
    ['3. yes rejects', 'yes'],
    ['4. wrong SIGN fingerprint rejects', 'SIGN 000000000000'],
    ['5. BROADCAST phrase at SIGN rejects', BROADCAST_PHRASE],
    ['9. uppercase mismatch rejects', 'SIGN ABCDEF123456'],
    ['12a. leading material rejects', ` ${SIGN_PHRASE}`],
    ['12b. trailing material rejects', `${SIGN_PHRASE} `]
  ])('%s', async (_name, answer) => {
    const io = scriptedIo([{ status: 'line', value: answer }])
    await expect(createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      new AbortController().signal
    )).resolves.toMatchObject({ status: 'rejected' })
  })

  test('10. malformed bindingHash fails closed before a prompt', async () => {
    const io = scriptedIo([{ status: 'line', value: SIGN_PHRASE }])
    const decision = await createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest({ bindingHash: BINDING_HASH.toUpperCase() }),
      new AbortController().signal
    )

    expect(decision).toEqual({ status: 'rejected', reason: 'INVALID_REVIEW_HASH' })
    expect(io.prompts).toHaveLength(0)
  })

  test('12. SIGN EOF rejects', async () => {
    const io = scriptedIo([{ status: 'eof' }])
    await expect(createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      new AbortController().signal
    )).resolves.toEqual({ status: 'rejected', reason: 'END_OF_INPUT' })
  })

  test('14. already-aborted SIGN signal cannot approve', async () => {
    const controller = new AbortController()
    controller.abort()
    const io = scriptedIo([{ status: 'line', value: SIGN_PHRASE }])

    await expect(createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(io.prompts).toHaveLength(0)
    expect(io.lines).toHaveLength(0)
  })

  test('16. abort while SIGN prompt is pending ignores late input', async () => {
    const pending = deferred<Tm1RegtestE2eLineResult>()
    const io = pendingIo(pending.promise)
    const controller = new AbortController()
    const decision = createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      controller.signal
    )

    controller.abort()
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve({ status: 'line', value: SIGN_PHRASE })
    await Promise.resolve()
    expect(io.output()).not.toContain('status: approved')
  })
})

describe('TM1 regtest E2E interactive BROADCAST provider', () => {
  test('6. exact BROADCAST phrase approves and communicates transmission authority', async () => {
    const io = scriptedIo([{ status: 'line', value: BROADCAST_PHRASE }])
    const decision = await createInteractiveBroadcastDecisionProvider(io).requestDecision(
      broadcastRequest(),
      new AbortController().signal
    )

    expect(decision).toEqual({ status: 'approved' })
    expect(io.output()).toContain(`signedArtifactHash: ${ARTIFACT_HASH}`)
    expect(io.output()).toContain('authorizes possible broadcast of this exact signed artifact')
    expect(io.output()).toContain('does not transmit it')
    expect(io.output()).toContain('re-audits the artifact')
  })

  test.each([
    ['7. reused SIGN phrase at BROADCAST rejects', SIGN_PHRASE],
    ['8. wrong BROADCAST fingerprint rejects', 'BROADCAST 000000000000'],
    ['9b. uppercase BROADCAST fingerprint rejects', 'BROADCAST 123456ABCDEF']
  ])('%s', async (_name, answer) => {
    const io = scriptedIo([{ status: 'line', value: answer }])
    await expect(createInteractiveBroadcastDecisionProvider(io).requestDecision(
      broadcastRequest(),
      new AbortController().signal
    )).resolves.toMatchObject({ status: 'rejected' })
  })

  test('11. malformed signedArtifactHash fails closed before a prompt', async () => {
    const io = scriptedIo([{ status: 'line', value: BROADCAST_PHRASE }])
    const decision = await createInteractiveBroadcastDecisionProvider(io).requestDecision(
      broadcastRequest({ signedArtifactHash: 'not-a-hash' }),
      new AbortController().signal
    )

    expect(decision).toEqual({ status: 'rejected', reason: 'INVALID_REVIEW_HASH' })
    expect(io.prompts).toHaveLength(0)
  })

  test('13. BROADCAST EOF rejects', async () => {
    const io = scriptedIo([{ status: 'eof' }])
    await expect(createInteractiveBroadcastDecisionProvider(io).requestDecision(
      broadcastRequest(),
      new AbortController().signal
    )).resolves.toEqual({ status: 'rejected', reason: 'END_OF_INPUT' })
  })

  test('15. already-aborted BROADCAST signal cannot approve', async () => {
    const controller = new AbortController()
    controller.abort()
    const io = scriptedIo([{ status: 'line', value: BROADCAST_PHRASE }])

    await expect(createInteractiveBroadcastDecisionProvider(io).requestDecision(
      broadcastRequest(),
      controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(io.prompts).toHaveLength(0)
    expect(io.lines).toHaveLength(0)
  })

  test('17. abort while BROADCAST prompt is pending ignores late input', async () => {
    const pending = deferred<Tm1RegtestE2eLineResult>()
    const io = pendingIo(pending.promise)
    const controller = new AbortController()
    const decision = createInteractiveBroadcastDecisionProvider(io).requestDecision(
      broadcastRequest(),
      controller.signal
    )

    controller.abort()
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve({ status: 'line', value: BROADCAST_PHRASE })
    await Promise.resolve()
  })
})

describe('TM1 regtest E2E prompt lifecycle', () => {
  test('18. an aborted prompt settles exactly once', async () => {
    const pending = deferred<Tm1RegtestE2eLineResult>()
    const io = pendingIo(pending.promise)
    const controller = new AbortController()
    const decision = createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      controller.signal
    )
    let settlements = 0
    void decision.then(() => { settlements += 1 }, () => { settlements += 1 })

    controller.abort()
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    pending.reject(new Error('LATE_REJECTION'))
    await Promise.resolve()
    expect(settlements).toBe(1)
  })

  test('19. provider abort listener is removed after a normal decision', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const io = scriptedIo([{ status: 'line', value: SIGN_PHRASE }])

    await createInteractiveSigningDecisionProvider(io).requestDecision(
      signingRequest(),
      controller.signal
    )

    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  test('19b. node text I/O resolves EOF and closes resources', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const io = createNodeInteractiveTextIo(input, output, () => undefined)
    input.end()

    await expect(io.readLine('prompt: ', new AbortController().signal)).resolves.toEqual({
      status: 'eof'
    })
  })
})

describe('TM1 regtest E2E readline SIGINT bridge', () => {
  test('40. readline SIGINT during SIGN triggers external abort and ignores late input', async () => {
    const harness = nodeIoHarness()
    const decision = createInteractiveSigningDecisionProvider(harness.io).requestDecision(
      signingRequest(),
      harness.controller.signal
    )
    await waitForOutput(harness, `Type ${SIGN_PHRASE}`)

    harness.input.write('\x03')
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    harness.input.write(`${SIGN_PHRASE}\n`)
    await Promise.resolve()

    expect(harness.requestExternalAbort).toHaveBeenCalledTimes(1)
    expect(harness.controller.signal.aborted).toBe(true)
    expect(harness.transcript()).not.toContain('END_OF_INPUT')
  })

  test('41. readline SIGINT during BROADCAST triggers external abort and ignores late input', async () => {
    const harness = nodeIoHarness()
    const decision = createInteractiveBroadcastDecisionProvider(harness.io).requestDecision(
      broadcastRequest(),
      harness.controller.signal
    )
    await waitForOutput(harness, `Type ${BROADCAST_PHRASE}`)

    harness.input.write('\x03')
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    harness.input.write(`${BROADCAST_PHRASE}\n`)
    await Promise.resolve()

    expect(harness.requestExternalAbort).toHaveBeenCalledTimes(1)
    expect(harness.controller.signal.aborted).toBe(true)
    expect(harness.transcript()).not.toContain('END_OF_INPUT')
  })

  test('42. CLI readline SIGINT during SIGN exits 130, never rejection or expiry', async () => {
    const harness = nodeIoHarness()
    installRuntime()
    const run = runTm1RegtestE2eCli(runOptions(harness.io, true, harness.controller.signal))
    await waitForOutput(harness, `Type ${SIGN_PHRASE}`)

    harness.input.write('\x03')

    await expect(run).resolves.toEqual({ exitCode: 130, status: 'aborted' })
    expect(harness.transcript()).not.toMatch(/END_OF_INPUT|REJECTED|EXPIRED/)
  })

  test('43. CLI readline SIGINT during BROADCAST exits 130, never rejection or expiry', async () => {
    const harness = nodeIoHarness()
    installRuntime()
    const run = runTm1RegtestE2eCli(runOptions(harness.io, true, harness.controller.signal))
    await waitForOutput(harness, `Type ${SIGN_PHRASE}`)
    harness.input.write(`${SIGN_PHRASE}\n`)
    await waitForOutput(harness, `Type ${BROADCAST_PHRASE}`)

    harness.input.write('\x03')

    await expect(run).resolves.toEqual({ exitCode: 130, status: 'aborted' })
    expect(harness.transcript()).not.toMatch(/END_OF_INPUT|REJECTED|EXPIRED/)
  })

  test('44. duplicate readline SIGINT settles once and removes prompt resources', async () => {
    const harness = nodeIoHarness()
    const removeAbort = vi.spyOn(harness.controller.signal, 'removeEventListener')
    const decision = createInteractiveSigningDecisionProvider(harness.io).requestDecision(
      signingRequest(),
      harness.controller.signal
    )
    let settlements = 0
    void decision.then(() => { settlements += 1 }, () => { settlements += 1 })
    await waitForOutput(harness, `Type ${SIGN_PHRASE}`)
    const dataListenersDuringPrompt = harness.input.listenerCount('data')

    harness.input.write('\x03\x03')
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()

    expect(settlements).toBe(1)
    expect(harness.requestExternalAbort).toHaveBeenCalledTimes(1)
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(harness.input.listenerCount('data')).toBeLessThanOrEqual(dataListenersDuringPrompt)
    expect(harness.input.listenerCount('keypress')).toBe(0)
  })

  test('45. normal SIGN and BROADCAST approvals remain available', async () => {
    const harness = nodeIoHarness()
    const signing = createInteractiveSigningDecisionProvider(harness.io).requestDecision(
      signingRequest(),
      harness.controller.signal
    )
    await waitForOutput(harness, `Type ${SIGN_PHRASE}`)
    harness.input.write(`${SIGN_PHRASE}\n`)
    await expect(signing).resolves.toEqual({ status: 'approved' })

    const broadcast = createInteractiveBroadcastDecisionProvider(harness.io).requestDecision(
      broadcastRequest(),
      harness.controller.signal
    )
    await waitForOutput(harness, `Type ${BROADCAST_PHRASE}`)
    harness.input.write(`${BROADCAST_PHRASE}\n`)

    await expect(broadcast).resolves.toEqual({ status: 'approved' })
    expect(harness.requestExternalAbort).not.toHaveBeenCalled()
  })
})

describe('TM1 regtest E2E runtime lifecycle', () => {
  test('20. non-TTY rejects before runtime construction', async () => {
    const io = scriptedIo([])
    const run = await runTm1RegtestE2eCli(runOptions(io, false))

    expect(run).toEqual({ exitCode: 2, status: 'configurationError' })
    expect(runtimeFactory).not.toHaveBeenCalled()
  })

  test('21. nominal prepare, two-consent, broadcast, and confirm sequence', async () => {
    const io = scriptedIo([
      { status: 'line', value: SIGN_PHRASE },
      { status: 'line', value: BROADCAST_PHRASE }
    ])
    const harness = installRuntime()

    await expect(runTm1RegtestE2eCli(runOptions(io))).resolves.toEqual({
      exitCode: 0,
      status: 'confirmed'
    })
    expect(harness.calls).toEqual(['prepare', 'authorizeAndSign', 'approveAndBroadcast', 'confirm'])
    expect(io.output()).toContain('PREPARED')
    expect(io.output()).toContain('SIGNED')
    expect(io.output()).toContain('SUBMITTED')
    expect(io.output()).toContain('CONFIRMATION')
  })

  test('22. runtime receives two separate provider object identities and separate TTLs', async () => {
    const io = scriptedIo([
      { status: 'line', value: SIGN_PHRASE },
      { status: 'line', value: BROADCAST_PHRASE }
    ])
    installRuntime()
    await runTm1RegtestE2eCli(runOptions(io))

    const config = runtimeFactory.mock.calls[0]?.[0] as RuntimeConfigSnapshot
    expect(config.authorization.signing.decisionProvider).not.toBe(
      config.authorization.broadcast.decisionProvider
    )
    expect(config.authorization.signing.ttlMs).toBe(TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS)
    expect(config.authorization.broadcast.ttlMs).toBe(TM1_REGTEST_E2E_AUTHORIZATION_TTL_MS)
  })

  test('23. SIGN rejection prevents all later runtime calls', async () => {
    const io = scriptedIo([{ status: 'line', value: 'no' }])
    const harness = installRuntime()

    await expect(runTm1RegtestE2eCli(runOptions(io))).resolves.toMatchObject({ exitCode: 10 })
    expect(harness.calls).toEqual(['prepare', 'authorizeAndSign'])
  })

  test('24. BROADCAST rejection prevents broadcast completion and confirmation', async () => {
    const io = scriptedIo([
      { status: 'line', value: SIGN_PHRASE },
      { status: 'line', value: 'no' }
    ])
    const harness = installRuntime()

    await expect(runTm1RegtestE2eCli(runOptions(io))).resolves.toMatchObject({ exitCode: 12 })
    expect(harness.calls).toEqual(['prepare', 'authorizeAndSign', 'approveAndBroadcast'])
    expect(harness.broadcastCompleted).toBe(false)
  })

  test('25. external abort before SIGN exits 130', async () => {
    const pending = deferred<Tm1RegtestE2eLineResult>()
    const io = pendingIo(pending.promise)
    const controller = new AbortController()
    installRuntime()
    const run = runTm1RegtestE2eCli(runOptions(io, true, controller.signal))
    await vi.waitFor(() => expect(io.prompts).toHaveLength(1))
    controller.abort()

    await expect(run).resolves.toEqual({ exitCode: 130, status: 'aborted' })
  })

  test('26. external abort before BROADCAST exits 130', async () => {
    const pending = deferred<Tm1RegtestE2eLineResult>()
    const io = sequencedPendingIo(
      { status: 'line', value: SIGN_PHRASE },
      pending.promise
    )
    const controller = new AbortController()
    installRuntime()
    const run = runTm1RegtestE2eCli(runOptions(io, true, controller.signal))
    await vi.waitFor(() => expect(io.prompts).toHaveLength(2))
    controller.abort()

    await expect(run).resolves.toEqual({ exitCode: 130, status: 'aborted' })
  })

  test('27. abort after broadcasting waits for settlement and never claims cancellation', async () => {
    const io = scriptedIo([
      { status: 'line', value: SIGN_PHRASE },
      { status: 'line', value: BROADCAST_PHRASE }
    ])
    const controller = new AbortController()
    const harness = installRuntime({ onBroadcasting: () => controller.abort() })

    await expect(runTm1RegtestE2eCli(runOptions(io, true, controller.signal))).resolves.toEqual({
      exitCode: 130,
      status: 'aborted'
    })
    expect(harness.calls).not.toContain('confirm')
    expect(io.output()).toContain('Broadcast was not claimed cancelled')
  })

  test('39. unknown hostile errors do not expose cause, stack, or arbitrary messages', async () => {
    const io = scriptedIo([])
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error('SECRET_CAUSE') },
      get: () => { throw new Error('SECRET_STACK') }
    })
    runtimeFactory.mockImplementationOnce(() => { throw hostile })

    await expect(runTm1RegtestE2eCli(runOptions(io))).resolves.toMatchObject({ exitCode: 1 })
    expect(io.output()).not.toMatch(/SECRET_CAUSE|SECRET_STACK/)
  })
})

describe('TM1 regtest E2E bounded observation', () => {
  test('28. submitted confirmation polling is bounded', async () => {
    vi.useFakeTimers()
    const io = scriptedIo([
      { status: 'line', value: SIGN_PHRASE },
      { status: 'line', value: BROADCAST_PHRASE }
    ])
    const harness = installRuntime({ confirmationFailures: Number.POSITIVE_INFINITY })
    const run = runTm1RegtestE2eCli(runOptions(io))
    await vi.advanceTimersByTimeAsync(TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS)

    await expect(run).resolves.toEqual({ exitCode: 22, status: 'confirmationUnresolved' })
    expect(harness.confirmCalls).toBe(
      Math.floor(TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS / TM1_REGTEST_E2E_CONFIRMATION_POLL_MS) + 1
    )
  })

  test('29. confirm retries only CONFIRMATION_FAILED while state remains submitted', async () => {
    vi.useFakeTimers()
    const io = approvalIo()
    const harness = installRuntime({ confirmationFailures: 2 })
    const run = runTm1RegtestE2eCli(runOptions(io))
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(run).resolves.toMatchObject({ exitCode: 0 })
    expect(harness.confirmCalls).toBe(3)
  })

  test('30. arbitrary confirmation error is not retried', async () => {
    const harness = installRuntime({ confirmationErrorCode: 'TXID_MISMATCH' })
    await expect(runTm1RegtestE2eCli(runOptions(approvalIo()))).resolves.toMatchObject({
      exitCode: 22
    })
    expect(harness.confirmCalls).toBe(1)
  })

  test('31. confirmation deadline exits 22', async () => {
    vi.useFakeTimers()
    installRuntime({ confirmationFailures: Number.POSITIVE_INFINITY })
    const run = runTm1RegtestE2eCli(runOptions(approvalIo()))
    await vi.advanceTimersByTimeAsync(TM1_REGTEST_E2E_CONFIRMATION_DEADLINE_MS)
    await expect(run).resolves.toMatchObject({ exitCode: 22 })
  })

  test('32. mempool-only observation never exits 0', async () => {
    vi.useFakeTimers()
    installRuntime({ confirmationFailures: Number.POSITIVE_INFINITY })
    const run = runTm1RegtestE2eCli(runOptions(approvalIo()))
    await vi.runAllTimersAsync()
    await expect(run).resolves.not.toMatchObject({ exitCode: 0 })
  })

  test('33. broadcast uncertainty never invokes approveAndBroadcast twice', async () => {
    const harness = installRuntime({ broadcastUncertain: true, reconcileFailures: 0 })
    await expect(runTm1RegtestE2eCli(runOptions(approvalIo()))).resolves.toMatchObject({ exitCode: 0 })
    expect(harness.approveCalls).toBe(1)
  })

  test('34. broadcast uncertainty uses reconcile and never confirm', async () => {
    const harness = installRuntime({ broadcastUncertain: true, reconcileFailures: 0 })
    await runTm1RegtestE2eCli(runOptions(approvalIo()))
    expect(harness.reconcileCalls).toBe(1)
    expect(harness.confirmCalls).toBe(0)
  })

  test('35. unresolved broadcast uncertainty exits 21', async () => {
    vi.useFakeTimers()
    installRuntime({ broadcastUncertain: true, reconcileFailures: Number.POSITIVE_INFINITY })
    const run = runTm1RegtestE2eCli(runOptions(approvalIo()))
    await vi.runAllTimersAsync()
    await expect(run).resolves.toEqual({ exitCode: 21, status: 'broadcastUncertain' })
  })

  test('36. successful reconciliation exits 0', async () => {
    installRuntime({ broadcastUncertain: true, reconcileFailures: 0 })
    await expect(runTm1RegtestE2eCli(runOptions(approvalIo()))).resolves.toEqual({
      exitCode: 0,
      status: 'confirmed'
    })
  })

  test('37. safe logs never include the raw signed artifact', async () => {
    const io = approvalIo()
    installRuntime()
    await runTm1RegtestE2eCli(runOptions(io))
    expect(io.output()).not.toContain('raw-transaction-secret-marker')
  })

  test('38. safe logs never include a key marker', async () => {
    const io = approvalIo()
    installRuntime()
    await runTm1RegtestE2eCli(runOptions(io))
    expect(io.output()).not.toMatch(/fixture-wif-secret-marker/i)
  })
})

type ScriptedIo = Tm1RegtestE2eTextIo & Readonly<{
  lines: string[]
  prompts: string[]
  output: () => string
}>

type NodeIoHarness = Readonly<{
  controller: AbortController
  input: PassThrough
  io: Tm1RegtestE2eTextIo
  requestExternalAbort: ReturnType<typeof vi.fn>
  transcript: () => string
}>

function nodeIoHarness(): NodeIoHarness {
  const controller = new AbortController()
  const input = new PassThrough()
  const output = new PassThrough()
  let transcript = ''
  output.on('data', chunk => { transcript += String(chunk) })
  const requestExternalAbort = vi.fn(() => {
    if (!controller.signal.aborted) controller.abort()
  })

  return {
    controller,
    input,
    io: createNodeInteractiveTextIo(input, output, requestExternalAbort),
    requestExternalAbort,
    transcript: () => transcript
  }
}

async function waitForOutput(harness: NodeIoHarness, value: string): Promise<void> {
  await vi.waitFor(() => expect(harness.transcript()).toContain(value))
}

function scriptedIo(responses: readonly Tm1RegtestE2eLineResult[]): ScriptedIo {
  const remaining = [...responses]
  const lines: string[] = []
  const prompts: string[] = []
  return {
    lines,
    prompts,
    output: () => lines.join('\n'),
    writeLine: line => { lines.push(line) },
    readLine: async prompt => {
      prompts.push(prompt)
      return remaining.shift() ?? { status: 'eof' }
    }
  }
}

function pendingIo(promise: Promise<Tm1RegtestE2eLineResult>): ScriptedIo {
  const lines: string[] = []
  const prompts: string[] = []
  return {
    lines,
    prompts,
    output: () => lines.join('\n'),
    writeLine: line => { lines.push(line) },
    readLine: prompt => {
      prompts.push(prompt)
      return promise
    }
  }
}

function sequencedPendingIo(
  first: Tm1RegtestE2eLineResult,
  pending: Promise<Tm1RegtestE2eLineResult>
): ScriptedIo {
  let call = 0
  const lines: string[] = []
  const prompts: string[] = []
  return {
    lines,
    prompts,
    output: () => lines.join('\n'),
    writeLine: line => { lines.push(line) },
    readLine: async prompt => {
      prompts.push(prompt)
      call += 1
      return call === 1 ? first : pending
    }
  }
}

function approvalIo(): ScriptedIo {
  return scriptedIo([
    { status: 'line', value: SIGN_PHRASE },
    { status: 'line', value: BROADCAST_PHRASE }
  ])
}

function runOptions(
  io: Tm1RegtestE2eTextIo,
  isTty = true,
  signal = new AbortController().signal
) {
  return {
    endpoint: 'http://127.0.0.1:3000',
    message: 'TM1 Phase 6-G',
    isTty,
    io,
    signal
  }
}

function signingRequest(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    operationId: 'operation:sign',
    preparedId: 'prepared:1',
    bindingHash: BINDING_HASH,
    contentHash: CONTENT_HASH,
    expiresAt: Date.now() + 300_000,
    review: {
      preparedId: 'prepared:1',
      bindingHash: BINDING_HASH,
      message: 'TM1 Phase 6-G',
      network: {
        environment: 'deterministic-regtest-fixture',
        chainIdentity: 'regtest-genesis'
      },
      effectiveContent: new Uint8Array([1, 2, 3]),
      orderedInputs: [{
        index: 0,
        role: 'author',
        txid: TXID,
        outIdx: 0,
        sats: 20_000n,
        lockingScriptHex: '76a91400'.padEnd(50, '0') + '88ac'
      }],
      orderedOutputs: [{ index: 0, role: 'tm1_op_return', sats: 0n, scriptHex: '6a0101' }],
      feeSats: 500n
    },
    ...overrides
  }
}

function broadcastRequest(overrides: Partial<BroadcastRequest> = {}): BroadcastRequest {
  return {
    operationId: 'operation:broadcast',
    signedId: 'signed:1',
    txid: TXID,
    signedArtifactHash: ARTIFACT_HASH,
    contentHash: CONTENT_HASH,
    expiresAt: Date.now() + 300_000,
    review: {
      preparedId: 'prepared:1',
      signedId: 'signed:1',
      txid: TXID,
      signedArtifactHash: ARTIFACT_HASH,
      bindingHash: BINDING_HASH,
      orderedOutputs: [{ index: 0, role: 'tm1_op_return', sats: 0n, scriptHex: '6a0101' }],
      feeSats: 500n,
      signedArtifact: {
        format: 'tm1-regtest',
        artifactVersion: 1,
        environment: 'deterministic-regtest-fixture',
        sighashPolicy: 'ALL_BIP143',
        fixturePublicKeyHex: '02'.padEnd(66, '0'),
        fixtureLockingScriptHex: '76a91400'.padEnd(50, '0') + '88ac',
        inputCount: 1,
        feeSats: 500n,
        txid: TXID,
        rawTransactionByteLength: 100
      }
    },
    ...overrides
  }
}

type RuntimeConfigSnapshot = Readonly<{
  authorization: Readonly<{
    signing: Readonly<{ decisionProvider: SigningProvider; ttlMs: number }>
    broadcast: Readonly<{ decisionProvider: BroadcastProvider; ttlMs: number }>
  }>
}>

type RuntimeBehavior = Readonly<{
  confirmationFailures?: number
  confirmationErrorCode?: string
  broadcastUncertain?: boolean
  reconcileFailures?: number
  onBroadcasting?: () => void
}>

function installRuntime(behavior: RuntimeBehavior = {}) {
  const calls: string[] = []
  let confirmCalls = 0
  let reconcileCalls = 0
  let approveCalls = 0
  let broadcastCompleted = false
  let state: Record<string, unknown> = { status: 'idle' }
  const listeners = new Set<(value: Record<string, unknown>) => void>()
  const transition = (value: Record<string, unknown>): void => {
    state = value
    for (const listener of listeners) listener(value)
  }

  runtimeFactory.mockImplementationOnce((rawConfig: RuntimeConfigSnapshot) => {
    const config = rawConfig
    const prepared = preparedReview()
    const signed = signedReview()
    const receipt = submissionReceipt()
    const runtime = {
      getState: () => state,
      subscribe: (listener: (value: Record<string, unknown>) => void) => {
        listeners.add(listener)
        listener(state)
        return () => { listeners.delete(listener) }
      },
      prepare: async () => {
        calls.push('prepare')
        transition({ status: 'reviewReady', review: prepared })
        return prepared
      },
      authorizeAndSign: async (_preparedId: string, signal: AbortSignal) => {
        calls.push('authorizeAndSign')
        transition({ status: 'authorizing', review: prepared })
        const decision = await config.authorization.signing.decisionProvider.requestDecision(
          signingRequest(),
          signal
        )
        if (decision.status !== 'approved') {
          transition({ status: 'rejected', stage: 'signing', reason: decision.reason })
          throw codedError('SIGNING_REJECTED')
        }
        transition({ status: 'signedReviewReady', review: prepared, signedReview: signed })
        return signed
      },
      approveAndBroadcast: async (_signedId: string, signal: AbortSignal) => {
        approveCalls += 1
        calls.push('approveAndBroadcast')
        transition({ status: 'approvingBroadcast', signedReview: signed })
        const decision = await config.authorization.broadcast.decisionProvider.requestDecision(
          broadcastRequest(),
          signal
        )
        if (decision.status !== 'approved') {
          transition({ status: 'rejected', stage: 'broadcast', reason: decision.reason })
          throw codedError('BROADCAST_REJECTED')
        }
        transition({ status: 'broadcasting', signedReview: signed, broadcastAuthorizationId: 'auth:2' })
        behavior.onBroadcasting?.()
        if (behavior.broadcastUncertain) {
          transition(broadcastUncertainState(signed))
          throw codedError('BROADCAST_FAILED')
        }
        broadcastCompleted = true
        transition({ status: 'submitted', signedReview: signed, receipt })
        return receipt
      },
      confirm: async () => {
        confirmCalls += 1
        calls.push('confirm')
        if (behavior.confirmationErrorCode) throw codedError(behavior.confirmationErrorCode)
        if (confirmCalls <= (behavior.confirmationFailures ?? 0)) {
          transition({ status: 'submitted', signedReview: signed, receipt })
          throw codedError('CONFIRMATION_FAILED')
        }
        const confirmation = confirmationResult()
        transition({ status: 'confirmed', receipt, confirmation })
        return confirmation
      },
      reconcile: async () => {
        reconcileCalls += 1
        calls.push('reconcile')
        if (reconcileCalls <= (behavior.reconcileFailures ?? 0)) {
          transition(broadcastUncertainState(signed))
          throw codedError('CONFIRMATION_FAILED')
        }
        const confirmation = confirmationResult()
        transition({ status: 'confirmed', receipt, confirmation })
        return confirmation
      },
      reset: () => undefined
    }
    return runtime
  })

  return {
    calls,
    get confirmCalls() { return confirmCalls },
    get reconcileCalls() { return reconcileCalls },
    get approveCalls() { return approveCalls },
    get broadcastCompleted() { return broadcastCompleted }
  }
}

function preparedReview() {
  return {
    preparedId: 'prepared:1',
    bindingHash: BINDING_HASH,
    feeSats: 500n,
    orderedOutputs: [{ index: 0, role: 'tm1_op_return', sats: 0n, scriptHex: '6a0101' }]
  }
}

function signedReview() {
  return {
    preparedId: 'prepared:1',
    signedId: 'signed:1',
    txid: TXID,
    signedArtifactHash: ARTIFACT_HASH,
    bindingHash: BINDING_HASH,
    feeSats: 500n,
    orderedOutputs: [{ index: 0, role: 'tm1_op_return', sats: 0n, scriptHex: '6a0101' }],
    signedArtifact: { rawTransactionHex: 'raw-transaction-secret-marker' }
  }
}

function submissionReceipt() {
  return {
    submissionId: 'submission:1',
    preparedId: 'prepared:1',
    signedId: 'signed:1',
    txid: TXID
  }
}

function confirmationResult() {
  return {
    submissionId: 'submission:1',
    txid: TXID,
    confirmations: 1,
    blockHash: '55'.repeat(32),
    blockHeight: 101
  }
}

function broadcastUncertainState(signed: ReturnType<typeof signedReview>) {
  return {
    status: 'broadcastUncertain',
    signedReview: signed,
    uncertainty: {
      submissionId: 'submission:1',
      preparedId: 'prepared:1',
      signedId: 'signed:1',
      txid: TXID,
      signedArtifactHash: ARTIFACT_HASH
    }
  }
}

function codedError(code: string): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(code), { code })
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
