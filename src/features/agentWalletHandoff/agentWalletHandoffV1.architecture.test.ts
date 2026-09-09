import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const FEATURE_DIRECTORY = resolve(fileURLToPath(new URL('.', import.meta.url)))
const ENTRYPOINT = resolve(FEATURE_DIRECTORY, 'index.ts')
const EXPECTED_PRODUCTION_FILES = Object.freeze([
  'constants.ts',
  'decoder.ts',
  'encoder.ts',
  'errors.ts',
  'index.ts',
  'primitives.ts'
])
const ALLOWED_BARE_IMPORTS = new Set(['@xolosarmy/tonalli-core'])

const FORBIDDEN_MODULE_FRAGMENTS = Object.freeze([
  'react',
  'route',
  'component',
  'hook',
  'context',
  'externalSign',
  'tonalliMemo',
  'integrations/x402',
  'service',
  'wallet',
  'chronik',
  'storage',
  'ledger',
  'lease',
  'transaction',
  'ecash-lib'
])

const FORBIDDEN_AUTHORITY_IDENTIFIERS = new Set([
  'UniversalAuthorizationCore',
  'ApprovalOnlyAuthorizationCore',
  'HumanApproval',
  'WalletLocalApprovalBinding',
  'contentHash',
  'Signer',
  'signApprovedContent',
  'seed',
  'mnemonic',
  'WIF',
  'privateKey',
  'Chronik',
  'broadcast',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'postMessage'
])

type Inspection = Readonly<{
  relativeImports: string[]
  violations: string[]
}>

const inspectSource = (filePath: string): Inspection => {
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const relativeImports: string[] = []
  const violations: string[] = []

  const inspectModuleSpecifier = (specifier: ts.Expression): void => {
    if (!ts.isStringLiteral(specifier)) {
      violations.push(`${basename(filePath)} has a nonliteral module specifier`)
      return
    }
    const moduleName = specifier.text
    if (moduleName.startsWith('.')) {
      relativeImports.push(moduleName)
      return
    }
    if (!ALLOWED_BARE_IMPORTS.has(moduleName)) {
      violations.push(`${basename(filePath)} imports forbidden bare module ${moduleName}`)
    }
    if (FORBIDDEN_MODULE_FRAGMENTS.some(fragment => moduleName.includes(fragment))) {
      violations.push(`${basename(filePath)} imports authority-bearing module ${moduleName}`)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) inspectModuleSpecifier(node.moduleSpecifier)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [specifier] = node.arguments
      if (specifier === undefined) {
        violations.push(`${basename(filePath)} has an empty dynamic import`)
      } else {
        inspectModuleSpecifier(specifier)
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      violations.push(`${basename(filePath)} uses require`)
    }

    if (ts.isIdentifier(node) && FORBIDDEN_AUTHORITY_IDENTIFIERS.has(node.text)) {
      violations.push(`${basename(filePath)} references forbidden authority ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { relativeImports, violations }
}

const resolveProductionImport = (fromFile: string, specifier: string): string => {
  const candidate = resolve(dirname(fromFile), specifier)
  const filePath = extname(candidate) === '' ? `${candidate}.ts` : candidate
  if (dirname(filePath) !== FEATURE_DIRECTORY) {
    throw new Error(`${basename(fromFile)} leaves the production feature boundary`)
  }
  return filePath
}

describe('Agent Wallet Handoff v1 production architecture', () => {
  test('has the exact frozen dependency closure and no authority-bearing references', () => {
    const productionFilesOnDisk = readdirSync(FEATURE_DIRECTORY, {
      withFileTypes: true
    })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .filter(entry => !entry.name.endsWith('.test.ts'))
      .map(entry => entry.name)
      .sort()
    const pending = [ENTRYPOINT]
    const visited = new Set<string>()
    const violations: string[] = []

    while (pending.length > 0) {
      const filePath = pending.pop()
      if (filePath === undefined || visited.has(filePath)) continue
      visited.add(filePath)
      const inspection = inspectSource(filePath)
      violations.push(...inspection.violations)
      for (const specifier of inspection.relativeImports) {
        try {
          pending.push(resolveProductionImport(filePath, specifier))
        } catch (error) {
          violations.push(error instanceof Error ? error.message : 'Invalid relative import')
        }
      }
    }

    expect(productionFilesOnDisk).toEqual(EXPECTED_PRODUCTION_FILES)
    expect(violations).toEqual([])
    expect([...visited].map(filePath => basename(filePath)).sort()).toEqual(
      EXPECTED_PRODUCTION_FILES
    )
  })
})
