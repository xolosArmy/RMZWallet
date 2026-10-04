import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const readSource = (relativeUrl: string) =>
  readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8')

describe('wallet secret history regression', () => {
  test('onboarding never puts mnemonic or password into router state', () => {
    const source = readSource('./Onboarding.tsx')
    expect(source).not.toMatch(/state:\s*\{[^}]*mnemonic/s)
    expect(source).not.toMatch(/state:\s*\{[^}]*password/s)
    expect(source).not.toContain("navigate('/backup', { state: { password")
  })

  test('backup reads mnemonic from the active wallet and clears the history entry on completion', () => {
    const source = readSource('./BackupSeed.tsx')
    expect(source).toContain('const mnemonic = getMnemonic()')
    expect(source).not.toContain('backupState?.mnemonic')
    expect(source).not.toContain('backupState?.password')
    expect(source).toContain("navigate('/', { replace: true, state: null })")
  })
})
