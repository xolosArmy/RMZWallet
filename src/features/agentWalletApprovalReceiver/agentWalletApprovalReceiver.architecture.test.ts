import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const FEATURE_DIRECTORY = resolve(fileURLToPath(new URL('.', import.meta.url)))
const ENTRYPOINT = resolve(FEATURE_DIRECTORY, 'index.ts')
const EXPECTED_PRODUCTION_FILES = Object.freeze([
  'format.ts',
  'index.ts',
  'ledger.ts',
  'receiver.ts',
  'types.ts'
])
const ALLOWED_BARE_IMPORTS = new Set(['@xolosarmy/tonalli-core'])

const FORBIDDEN_MODULE_FRAGMENTS = Object.freeze([
  'react',
  'route',
  'component',
  'hook',
  'context',
  'services/wallet',
  'chronik',
  'ecash-lib',
  'signPreparedTransaction',
  'txBuilder',
  'broadcast'
])

const FORBIDDEN_AUTHORITY_IDENTIFIERS = new Set([
  'Signer',
  'signApprovedContent',
  'signPreparedTransaction',
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
  'postMessage',
  'buildTransaction'
])

function listProductionSourceFiles(): string[] {
  return readdirSync(FEATURE_DIRECTORY)
    .filter((file) => extname(file) === '.ts')
    .filter((file) => !file.endsWith('.test.ts') && !file.includes('testUtils'))
    .sort()
}

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, 'utf8')
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = []

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function collectIdentifiers(sourceFile: ts.SourceFile): string[] {
  const identifiers: string[] = []

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      identifiers.push(node.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return identifiers
}

describe('agentWalletApprovalReceiver architecture boundaries', () => {
  test('capability.ts is completely deleted to prevent deep imports', () => {
    expect(existsSync(resolve(FEATURE_DIRECTORY, 'capability.ts'))).toBe(false)
  })

  test('contains only expected production files', () => {
    const files = listProductionSourceFiles()
    expect(files).toEqual(EXPECTED_PRODUCTION_FILES)
  })

  test('entrypoint exists and only imports allowed modules', () => {
    const parsed = parseSourceFile(ENTRYPOINT)
    const imports = collectModuleSpecifiers(parsed)

    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        expect(specifier).toMatch(/^\.\/[a-zA-Z0-9]+$/)
      } else {
        expect(ALLOWED_BARE_IMPORTS.has(specifier)).toBe(true)
      }
    }
  })

  test('does not import forbidden UI, signing, wallet or network modules', () => {
    const files = listProductionSourceFiles()

    for (const file of files) {
      const parsed = parseSourceFile(resolve(FEATURE_DIRECTORY, file))
      const imports = collectModuleSpecifiers(parsed)

      for (const specifier of imports) {
        for (const fragment of FORBIDDEN_MODULE_FRAGMENTS) {
          expect(
            specifier.toLowerCase(),
            `File ${file} imports forbidden module ${specifier}`
          ).not.toContain(fragment.toLowerCase())
        }
      }
    }
  })

  test('does not reference forbidden signing, persistent storage or network identifiers', () => {
    const files = listProductionSourceFiles()

    for (const file of files) {
      const parsed = parseSourceFile(resolve(FEATURE_DIRECTORY, file))
      const identifiers = collectIdentifiers(parsed)

      for (const id of identifiers) {
        expect(
          FORBIDDEN_AUTHORITY_IDENTIFIERS.has(id),
          `File ${file} contains forbidden identifier: ${id}`
        ).toBe(false)
      }
    }
  })

  test('index.ts does not export internal capability class, tokens, or internal bindings', async () => {
    const indexExports = (await import('./index')) as Record<string, unknown>
    expect(indexExports.INTERNAL_CAPABILITY_TOKEN).toBeUndefined()
    expect(indexExports.ApprovalRecordCapability).toBeUndefined()
    expect(indexExports.InternalApprovalBinding).toBeUndefined()
    expect(indexExports.createApprovalCapabilityInternal).toBeUndefined()
    expect(indexExports.WalletLocalApprovalBinding).toBeUndefined()
  })

  test('index.ts does not export in-memory test ledgers or per-call procedural functions', async () => {
    const indexExports = (await import('./index')) as Record<string, unknown>
    expect(indexExports.InMemoryWalletApprovalLedger).toBeUndefined()
    expect(indexExports._clearActiveReviewSessionsForTesting).toBeUndefined()
    expect(indexExports.prepareApprovalReview).toBeUndefined()
    expect(indexExports.recordWalletHumanDecision).toBeUndefined()
    expect(indexExports.createAgentWalletApprovalReceiver).toBeTypeOf('function')
  })
})
