import { readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const FEATURE_DIRECTORY = resolve(fileURLToPath(new URL('.', import.meta.url)))
const ENTRYPOINT = resolve(FEATURE_DIRECTORY, 'index.ts')
const EXPECTED_PRODUCTION_FILES = Object.freeze([
  'index.ts',
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
  'externalSign',
  'tonalliMemo',
  'service',
  '/wallet/',
  'services/wallet',
  'chronik',
  'storage',
  'ledger',
  'lease',
  'transaction',
  'ecash-lib',
  'signPreparedTransaction'
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
  'postMessage'
])

function listProductionSourceFiles(): string[] {
  return readdirSync(FEATURE_DIRECTORY)
    .filter((file) => extname(file) === '.ts')
    .filter((file) => !file.endsWith('.test.ts'))
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
  const ids: string[] = []

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      ids.push(node.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return ids
}

describe('agentWalletApprovalReceiver architecture invariants', () => {
  test('contains only expected production files', () => {
    const files = listProductionSourceFiles()
    expect(files).toEqual([...EXPECTED_PRODUCTION_FILES].sort())
  })

  test('production files do not import forbidden modules or external authority', () => {
    for (const fileName of EXPECTED_PRODUCTION_FILES) {
      const filePath = resolve(FEATURE_DIRECTORY, fileName)
      const sourceFile = parseSourceFile(filePath)
      const specifiers = collectModuleSpecifiers(sourceFile)

      for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) {
          expect(
            ALLOWED_BARE_IMPORTS.has(specifier),
            `Forbidden bare import "${specifier}" in ${fileName}`
          ).toBe(true)
        } else {
          const lower = specifier.toLowerCase()
          for (const fragment of FORBIDDEN_MODULE_FRAGMENTS) {
            expect(
              lower.includes(fragment.toLowerCase()),
              `Forbidden import fragment "${fragment}" found in "${specifier}" in ${fileName}`
            ).toBe(false)
          }
        }
      }
    }
  })

  test('production files do not reference forbidden authority identifiers', () => {
    for (const fileName of EXPECTED_PRODUCTION_FILES) {
      const filePath = resolve(FEATURE_DIRECTORY, fileName)
      const sourceFile = parseSourceFile(filePath)
      const ids = collectIdentifiers(sourceFile)

      for (const id of ids) {
        expect(
          FORBIDDEN_AUTHORITY_IDENTIFIERS.has(id),
          `Forbidden authority identifier "${id}" detected in ${fileName}`
        ).toBe(false)
      }
    }
  })

  test('index entrypoint exists and defines cleanly isolated export surface', () => {
    const sourceFile = parseSourceFile(ENTRYPOINT)
    const specifiers = collectModuleSpecifiers(sourceFile)
    for (const specifier of specifiers) {
      expect(specifier.startsWith('.')).toBe(true)
    }
  })
})
