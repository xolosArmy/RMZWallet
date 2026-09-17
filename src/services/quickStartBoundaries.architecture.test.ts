import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const quickStartFiles = [
  'services/quickStartStorage.ts',
  'services/welcomeFaucet.ts',
  'services/welcomeClaim.ts',
  'services/tonalliIntent.ts',
  'services/backupSession.ts',
  'components/QuickStartHydrator.tsx',
  'components/WelcomeXecCard.tsx',
  'components/ProgressiveBackupBanner.tsx',
  'components/TonalliIntentCapture.tsx',
  'domain/walletLifecycle.ts',
  'domain/walletCapabilities.ts'
]

const frozenImportPattern =
  /privateMessaging|tmComm|tm-comm|agentWalletExecution|agoraExchange|x402H3B|walletconnect\/WcWallet/i

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, acc)
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full)
  }
  return acc
}

describe('Quick Start seed and frozen-boundary architecture', () => {
  it('does not put the mnemonic in router state, URL or query params', () => {
    const onboarding = readFileSync(join(root, 'routes/Onboarding.tsx'), 'utf8')
    const backup = readFileSync(join(root, 'routes/BackupSeed.tsx'), 'utf8')
    expect(onboarding).not.toMatch(/navigate\([^)]*state:\s*\{[^}]*mnemonic/)
    expect(backup).not.toMatch(/state\?\.mnemonic/)
    expect(backup).not.toMatch(/interface BackupState[\s\S]*mnemonic:/)
    expect(backup).toContain('getMnemonic')
  })

  it('keeps Quick Start modules decoupled from TM-COMM and frozen financial stacks', () => {
    for (const relative of quickStartFiles) {
      const source = readFileSync(join(root, relative), 'utf8')
      expect(source, relative).not.toMatch(frozenImportPattern)
    }
  })

  it('never writes the mnemonic to localStorage, sessionStorage or fetch bodies from Quick Start files', () => {
    for (const relative of quickStartFiles) {
      const source = readFileSync(join(root, relative), 'utf8')
      expect(source, relative).not.toMatch(/localStorage\.setItem\([^)]*mnemonic/i)
      expect(source, relative).not.toMatch(/sessionStorage\.setItem\([^)]*mnemonic/i)
      expect(source, relative).not.toMatch(/JSON\.stringify\([^)]*mnemonic/)
    }
  })

  it('rehydrates through activateQuickStartFromDevice instead of legacy restoreWallet', () => {
    const hydrator = readFileSync(join(root, 'components/QuickStartHydrator.tsx'), 'utf8')
    expect(hydrator).toContain('activateQuickStartFromDevice')
    expect(hydrator).not.toContain('restoreWallet')
    expect(hydrator).not.toContain('loadQuickStartMnemonic')
  })

  it('does not import TM-COMM internals anywhere on this branch', () => {
    const files = walk(join(root))
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return /from ['"].*privateMessaging|from ['"].*tmComm|server\/tmComm/.test(source)
    })
    expect(offenders).toEqual([])
  })
})
