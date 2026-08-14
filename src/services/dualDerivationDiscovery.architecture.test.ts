import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('dual derivation discovery security boundary', () => {
  test('discovery derives one public account state per engine and has no signing or broadcast primitive', () => {
    const discovery = source('./dualDerivationDiscovery.ts')
    const derivation = source('./derivationProfiles.ts')
    const legacy = source('./legacy899Compatibility.ts')

    expect(discovery).not.toContain('mnemonicToSeed')
    expect(discovery).not.toMatch(/getSignatory\s*\(/)
    expect(discovery).not.toMatch(/signTxBuilder\s*\(/)
    expect(discovery).not.toMatch(/broadcastTx\s*\(/)
    const publicBoundary = derivation.slice(
      derivation.indexOf('export function deriveAccountPublicState'),
      derivation.indexOf('/** @deprecated Prefer deriveAccountPublicState')
    )
    expect(publicBoundary.match(/mnemonicToSeed\s*\(/g)).toHaveLength(1)
    expect(discovery).not.toContain('deriveSigningMetadata')
    expect(derivation).toContain('seckey: undefined')
    expect(derivation).toContain('node.seckey() !== undefined')
    expect(legacy).toContain('deriveLegacy899AccountPublicState')
    expect(legacy).toContain('seed.fill(0)')
    expect(legacy).toContain('privateKey.fill(0)')
  })

  test('wallet scans use the public derivation boundary and reserve private derivation for signing', () => {
    const service = source('./XolosWalletService.ts')
    const ownerBoundary = service.slice(
      service.indexOf('private deriveHdOwner'),
      service.indexOf('private rememberHdOwners')
    )
    const rescanBoundary = service.slice(
      service.indexOf('private async scanAddressesForRescan'),
      service.lastIndexOf('\n}')
    )

    expect(ownerBoundary).toContain('derivePublicMetadata(')
    expect(ownerBoundary).not.toContain('deriveFromMnemonic(')
    expect(rescanBoundary).toContain('derivePublicMetadata(')
    expect(rescanBoundary).not.toContain('deriveFromMnemonic(')
  })

  test('FIRMA derives signatories only after fresh-state plan revalidation', () => {
    const service = source('./XolosWalletService.ts')
    const sendBoundary = service.slice(
      service.indexOf('async sendFirma'),
      service.indexOf('async sendToken')
    )

    expect(sendBoundary.indexOf('await this.buildFirmaSendPlan(')).toBeGreaterThanOrEqual(0)
    expect(sendBoundary.indexOf('planFingerprint')).toBeGreaterThan(
      sendBoundary.indexOf('await this.buildFirmaSendPlan(')
    )
    expect(sendBoundary.indexOf('this.deriveHdSignatory(')).toBeGreaterThan(
      sendBoundary.indexOf('planFingerprint')
    )
    expect(sendBoundary.indexOf('this.deriveHdSignatory(')).toBeGreaterThan(
      sendBoundary.indexOf('await this.buildFirmaSendPlan(')
    )
  })

  test('active identity consumers never read MinimalXECWallet walletInfo', () => {
    const service = source('./XolosWalletService.ts')
    const identityStart = service.indexOf('getKeyInfo()')
    const identityBoundary = service.slice(
      identityStart,
      service.indexOf('  signTxBuilder(', identityStart)
    )

    expect(identityBoundary).toContain('this.getCanonicalReceiveOwner()')
    expect(identityBoundary).not.toMatch(/walletInfo\?\.(xecAddress|publicKey|privateKey)/)
  })

  test('MinimalXECWallet is initialized only after its canonical compatibility binding', () => {
    const service = source('./XolosWalletService.ts')
    const buildBoundary = service.slice(
      service.indexOf('private buildWallet('),
      service.indexOf('private bindMinimalWalletToCanonicalProfile(')
    )
    const activationBoundary = service.slice(
      service.indexOf('private async activateMnemonic('),
      service.indexOf('private ensureReady(')
    )

    expect(buildBoundary).toContain('MINIMAL_WALLET_UTILITY_MNEMONIC')
    expect(buildBoundary).not.toContain('new MinimalXECWalletResolved(mnemonic')
    expect(activationBoundary.indexOf('this.bindMinimalWalletToCanonicalProfile(mnemonic)'))
      .toBeLessThan(activationBoundary.indexOf('await wallet.initialize()'))
  })

  test('missing stored metadata is detected read-only before profile persistence', () => {
    const service = source('./XolosWalletService.ts')
    const loadBoundary = service.slice(
      service.indexOf('async loadFromStorage'),
      service.indexOf('async unlockEncryptedWallet')
    )

    expect(loadBoundary).toContain('parseStoredDerivationProfileMetadata(')
    expect(loadBoundary).toContain('await this.detectDerivationProfiles(plainText)')
    expect(loadBoundary).toContain('resolveProfileForMissingMetadata(')
    expect(loadBoundary).toContain('await this.activateMnemonic(plainText, resolvedProfileId, true)')
    expect(loadBoundary).not.toContain('deriveHdSignatory(')
    expect(loadBoundary).not.toContain('broadcastTx(')
  })

  test('runtime consumers do not embed either BIP44 profile path', () => {
    const consumers = [
      source('./XolosWalletService.ts'),
      source('./firmaAlphaSend.ts'),
      source('../routes/Onboarding.tsx'),
      source('../routes/Settings.tsx')
    ].join('\n')

    expect(consumers).not.toContain("m/44'/899'")
    expect(consumers).not.toContain("m/44'/1899'")
  })
})
