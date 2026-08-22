import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  SUPPORTED_NODE_RUNTIME,
  assertSupportedNodeRuntime,
  isSupportedNodeRuntime
} from './assert-supported-node-runtime.mjs'

describe('repository Node runtime policy', () => {
  test.each([
    ['20.19.0', false],
    ['22.21.1', false],
    ['24.17.9', false],
    ['24.18.0', true],
    ['24.18.7', true],
    ['24.19.0', true],
    ['24.99.99', true],
    ['25.0.0', false],
    ['24.18', false],
    ['v24.18.0', false],
    ['24.18.0-pre', false],
    ['', false]
  ])('classifies Node %s as supported=%s', (version, expected) => {
    expect(isSupportedNodeRuntime(version)).toBe(expected)
  })

  test('reports the canonical range on failure', () => {
    expect(() => assertSupportedNodeRuntime('22.0.0')).toThrow(
      `RMZWallet tests require Node.js ${SUPPORTED_NODE_RUNTIME}`
    )
  })

  test('passes as a CLI preflight on the current supported runtime', () => {
    const scriptPath = fileURLToPath(new URL(
      './assert-supported-node-runtime.mjs',
      import.meta.url
    ))
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8'
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`satisfies ${SUPPORTED_NODE_RUNTIME}`)
  })
})
