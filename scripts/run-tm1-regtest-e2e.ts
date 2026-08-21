import {
  createNodeInteractiveTextIo,
  runTm1RegtestE2eCli
} from './tm1-regtest-e2e-cli'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000'
const DEFAULT_MESSAGE = 'Tonalli Memo TM1 Draft 0.2 regtest E2E'

class Tm1RegtestE2eArgumentError extends Error {
  readonly code = 'INVALID_ARGUMENT'
}

async function main(): Promise<void> {
  const endpoint = readOption('--endpoint') ?? readEnv('TM1_REGTEST_CHRONIK_URL') ?? DEFAULT_ENDPOINT
  const message = readOption('--message') ?? readEnv('TM1_REGTEST_MESSAGE') ?? DEFAULT_MESSAGE
  const controller = new AbortController()
  const requestExternalAbort = (): void => {
    if (!controller.signal.aborted) controller.abort()
  }
  process.on('SIGINT', requestExternalAbort)

  try {
    const result = await runTm1RegtestE2eCli({
      endpoint,
      message,
      isTty: process.stdin.isTTY === true,
      io: createNodeInteractiveTextIo(
        process.stdin,
        process.stdout,
        requestExternalAbort
      ),
      signal: controller.signal
    })
    process.exitCode = result.exitCode
  } finally {
    process.removeListener('SIGINT', requestExternalAbort)
  }
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Tm1RegtestE2eArgumentError()
  return value
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim().length > 0 ? value.trim() : undefined
}

void main().catch((error: unknown) => {
  const code = error instanceof Tm1RegtestE2eArgumentError
    ? error.code
    : 'UNEXPECTED_ERROR'
  console.error(`TM1 REGTEST E2E [${code}]`)
  process.exitCode = code === 'INVALID_ARGUMENT' ? 2 : 1
})
