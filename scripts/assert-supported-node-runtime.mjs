import { pathToFileURL } from 'node:url'

export const SUPPORTED_NODE_RUNTIME = '>=24.18.0 <25'

export function isSupportedNodeRuntime(version) {
  if (typeof version !== 'string') return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (match === null) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return Number.isSafeInteger(major) &&
    Number.isSafeInteger(minor) &&
    Number.isSafeInteger(patch) &&
    major === 24 &&
    minor >= 18
}

export function assertSupportedNodeRuntime(version = process.versions.node) {
  if (!isSupportedNodeRuntime(version)) {
    throw new Error(
      `Unsupported Node.js runtime ${String(version)}; RMZWallet tests require Node.js ${SUPPORTED_NODE_RUNTIME}.`
    )
  }
  return version
}

function isDirectExecution() {
  const entryPath = process.argv[1]
  return typeof entryPath === 'string' &&
    import.meta.url === pathToFileURL(entryPath).href
}

if (isDirectExecution()) {
  try {
    const version = assertSupportedNodeRuntime()
    process.stdout.write(
      `Node.js ${version} satisfies ${SUPPORTED_NODE_RUNTIME}.\n`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unsupported Node.js runtime.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
