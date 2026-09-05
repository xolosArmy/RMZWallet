import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TONALLI_MEMO_DIR = fileURLToPath(new URL('.', import.meta.url))

function getProductionSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = `${dir}/${entry}`
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...getProductionSourceFiles(fullPath))
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.toLowerCase().includes('fixture')
    ) {
      files.push(fullPath)
    }
  }

  return files
}

describe('TM1 Canonical Anti-Drift Architecture Defense', () => {
  const productionFiles = getProductionSourceFiles(TONALLI_MEMO_DIR)

  it('scans only production implementation files avoiding test/fixture false positives', () => {
    expect(productionFiles.length).toBeGreaterThan(0)
    for (const filePath of productionFiles) {
      expect(filePath).not.toMatch(/\.test\.ts$/)
      expect(filePath.toLowerCase()).not.toMatch(/fixture/)
    }
  })

  it('prohibits duplicate TM1 LOKAD ID literal declarations in production code', () => {
    for (const filePath of productionFiles) {
      const content = readFileSync(filePath, 'utf8')
      // Prohibit declaring TM1_LOKAD_ID_HEX = '544d4d00' locally; must import from canonical package
      expect(content).not.toMatch(
        /const\s+(?:TM1_)?LOKAD_ID(?:_HEX)?\s*=\s*['"]544d4d00['"]/i
      )
      // Prohibit hardcoded OP_RETURN prefix checks like startsWith('6a04544d4d00')
      expect(content).not.toMatch(/['"]6a04544d4d00['"]/)
    }
  })

  it('prohibits duplicate minimal push or custom TM1 parser functions in production code', () => {
    for (const filePath of productionFiles) {
      const content = readFileSync(filePath, 'utf8')
      // Prohibit defining a custom readMinimalPush function
      expect(content).not.toMatch(/function\s+readMinimalPush\b/)
      // Prohibit defining custom opcode minimal push logic outside the canonical package
      expect(content).not.toMatch(/function\s+encodeMinimalPush\b/)
    }
  })

  it('ensures TM1 production modules import from @xolosarmy/tonalli-memo-protocol', () => {
    const candidateContent = readFileSync(`${TONALLI_MEMO_DIR}/tm1Draft02Candidate.ts`, 'utf8')
    const draftContent = readFileSync(`${TONALLI_MEMO_DIR}/tm1Draft02.ts`, 'utf8')

    expect(candidateContent).toContain("from '@xolosarmy/tonalli-memo-protocol'")
    expect(candidateContent).toContain('validateTm1CanonicalScript')
    expect(draftContent).toContain("from '@xolosarmy/tonalli-memo-protocol'")
  })
})
