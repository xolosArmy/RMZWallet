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

  it('rehydrates through WalletProvider bootstrap instead of a racing hydrator or restoreWallet', () => {
    const hydrator = readFileSync(join(root, 'components/QuickStartHydrator.tsx'), 'utf8')
    const context = readFileSync(join(root, 'context/WalletContext.tsx'), 'utf8')
    const onboarding = readFileSync(join(root, 'routes/Onboarding.tsx'), 'utf8')
    expect(hydrator).not.toContain('activateQuickStartFromDevice')
    expect(hydrator).not.toContain('restoreWallet')
    expect(hydrator).not.toContain('loadQuickStartMnemonic')
    expect(context).toContain('hasQuickStartRecord')
    expect(context).toContain('QUICK_START_BOOTSTRAP_PENDING')
    expect(onboarding).not.toContain('consumeTonalliIntent')
    expect(onboarding).toContain('readTonalliIntent')

    const storage = readFileSync(join(root, 'services/quickStartStorage.ts'), 'utf8')
    const availabilityFn = storage.slice(
      storage.indexOf('export async function assertQuickStartStorageAvailable'),
      storage.indexOf('export async function storeQuickStartMnemonic')
    )
    expect(availabilityFn).toContain('PROBE_KEY_RECORD')
    expect(availabilityFn).not.toContain('persistNonExtractableDeviceKey')
    expect(availabilityFn).toContain('deleteRecord(PROBE_KEY_RECORD)')
    expect(availabilityFn).not.toMatch(/writeRecords\(\[\{ id: KEY_RECORD/)

    const walletService = readFileSync(join(root, 'services/XolosWalletService.ts'), 'utf8')
    const createQuickStart = walletService.slice(
      walletService.indexOf('async createQuickStartWallet()'),
      walletService.indexOf('async activateQuickStartWallet(')
    )
    expect(createQuickStart.indexOf('hasQuickStartMnemonic()')).toBeGreaterThanOrEqual(0)
    expect(createQuickStart).not.toContain('createNewWallet()')
    expect(createQuickStart).toContain('activateMnemonicLocalIdentity')
    expect(createQuickStart).toContain('storeQuickStartMnemonic')
    expect(createQuickStart.indexOf('storeQuickStartMnemonic'))
      .toBeLessThan(createQuickStart.lastIndexOf('initialize()'))
    expect(createQuickStart).toContain('QUICK_START_RECOVERY_FAILED')
    expect(createQuickStart).toContain('Chronik/network failure must not prevent first-create persistence')
    expect(createQuickStart).toContain('withQuickStartCreationLock')
    expect(createQuickStart.indexOf('withQuickStartCreationLock'))
      .toBeLessThan(createQuickStart.indexOf('hasBackedWalletCiphertextOnDevice'))
    expect(createQuickStart.indexOf('hasBackedWalletCiphertextOnDevice'))
      .toBeLessThan(createQuickStart.indexOf('hasQuickStartMnemonic()'))
    expect(createQuickStart).toContain('BACKED_WALLET_EXISTS')
    expect(createQuickStart).toContain('QUICK_START_IDENTITY_MISMATCH')
    expect(createQuickStart).not.toContain("throw new QuickStartUnavailableError(\n          error instanceof Error ? error.message")

    expect(walletService).toContain('hasBackedWalletCiphertextOnDevice()')
    expect(context).toContain('BACKED_WALLET_EXISTS')
    expect(context).toContain('hasBackedWalletCiphertextOnDevice')
    expect(onboarding).toContain('BACKED_WALLET_EXISTS')
    expect(onboarding).toContain('/onboarding/unlock')

    expect(storage).toContain('withQuickStartCreationLock')
    expect(storage).toContain('toAvailabilityError')
    expect(storage).toContain('QUICK_START_CREATION_LOCK_UNAVAILABLE')
    expect(storage).toContain('DataCloneError')
    const hasQuickStart = storage.slice(
      storage.indexOf('export async function hasQuickStartMnemonic'),
      storage.length
    )
    expect(hasQuickStart).toContain('QuickStartUnavailableError')
    expect(hasQuickStart).toContain('return false')
    expect(hasQuickStart).not.toContain('QUICK_START_STORAGE_CORRUPT')
    expect(hasQuickStart).not.toContain('QUICK_START_DEVICE_KEY_MISSING')

    const activateMnemonic = walletService.slice(
      walletService.indexOf('private async activateMnemonic('),
      walletService.indexOf('private ensureReady(')
    )
    expect(activateMnemonic).toContain('activateMnemonicLocalIdentity')
    expect(activateMnemonic).toContain('void wallet.initialize()')
    expect(context).toMatch(/loadFromStorage[\s\S]*optionalBalance: true/)
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
