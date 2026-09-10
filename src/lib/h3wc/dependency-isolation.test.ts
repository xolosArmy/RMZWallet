import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const packageJson = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
  dependencies: Record<string, string>
}
const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8')) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>
}

describe('H3WC dependency isolation', () => {
  test('pins the legacy runtime and isolates the modern spine under aliases', () => {
    expect(packageJson.dependencies['@walletconnect/core']).toBe('2.23.4')
    expect(packageJson.dependencies['@walletconnect/web3wallet']).toBe('^1.16.1')
    expect(packageJson.dependencies['@xolosarmy/h3wc-core']).toBe('npm:@walletconnect/core@2.23.10')
    expect(packageJson.dependencies['@xolosarmy/h3wc-walletkit']).toBe('npm:@reown/walletkit@1.5.6')

    expect(lock.packages['node_modules/@walletconnect/core']?.version).toBe('2.23.4')
    expect(lock.packages['node_modules/@walletconnect/web3wallet']?.version).toBe('1.16.1')
    expect(lock.packages['node_modules/@walletconnect/web3wallet']?.dependencies?.['@walletconnect/core']).toBe('2.17.1')
    expect(lock.packages['node_modules/@xolosarmy/h3wc-core']?.version).toBe('2.23.10')
    expect(lock.packages['node_modules/@xolosarmy/h3wc-walletkit']?.version).toBe('1.5.6')
    expect(lock.packages['node_modules/@xolosarmy/h3wc-walletkit']?.dependencies?.['@walletconnect/core']).toBe('2.23.10')
    expect(lock.packages['node_modules/@xolosarmy/h3wc-walletkit']?.dependencies?.['@walletconnect/sign-client']).toBe('2.23.10')
  })
})

