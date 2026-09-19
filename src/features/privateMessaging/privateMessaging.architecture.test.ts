import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import * as PublicModuleExports from './index'
import {
  agentAuthenticationGrantsWalletCapability,
  isTmCommAgentSendEnabled,
  TM_COMM_AUTOMATIC_MEMO_PUBLICATION,
  TM_COMM_EMAIL_FALLBACK_IMPLEMENTED
} from './index'

const FEATURE_DIRECTORY = resolve(fileURLToPath(new URL('.', import.meta.url)))
const SERVER_DIRECTORY = resolve(FEATURE_DIRECTORY, '../../../server/tmComm')
const ROUTE_FILE = resolve(FEATURE_DIRECTORY, '../../routes/TmCommStaging.tsx')
const CLIENT_FILE = resolve(FEATURE_DIRECTORY, '../../routes/tmCommStagingClient.ts')
const ENTRYPOINT = resolve(FEATURE_DIRECTORY, 'index.ts')

const EXPECTED_PRODUCTION_FILES = Object.freeze([
  'aiAgentBoundary.ts',
  'authChallenge.ts',
  'contracts.ts',
  'emailFallbackContract.ts',
  'errors.ts',
  'index.ts',
  'memoPublicationBoundary.ts',
  'types.ts'
])

const ALLOWED_BARE_IMPORTS = new Set<string>()

const FORBIDDEN_MODULE_FRAGMENTS = Object.freeze([
  'agentWalletExecution',
  'XolosWalletService',
  'tonalliMemo',
  'sendXec',
  'sendETokens',
  'ecash-lib',
  'minimal-xec-wallet',
  'chronik'
])

const FORBIDDEN_AUTHORITY_IDENTIFIERS = new Set([
  'signMsg',
  'signMessage',
  'privateKey',
  'secretKey',
  'mnemonic',
  'WIF',
  'sendXec',
  'sendETokens',
  'broadcastTx',
  'broadcastTransaction',
  'createAgentWalletExecutionEngine',
  'localStorage',
  'sessionStorage'
])

const FORBIDDEN_SOURCE_PATTERNS = Object.freeze([
  /\bsigning\b/i,
  /\bsettlement\b/i,
  /\bbroadcast\b/i,
  /\bsendXec\b/,
  /\bsendETokens\b/,
  /\bagentWalletExecution\b/,
  /\bmnemonic\b/i,
  /\bprivate keys?\b/i
])

function listProductionSourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => extname(file) === '.ts' || extname(file) === '.tsx')
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
    .filter((file) => !/testkeys|testutils/i.test(file))
    .sort()
}

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, 'utf8')
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = []

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
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

function collectNamedImports(sourceFile: ts.SourceFile): string[] {
  const names: string[] = []

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        names.push(element.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return names
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

describe('privateMessaging architecture boundaries', () => {
  test('contains only the closed domain production files', () => {
    expect(listProductionSourceFiles(FEATURE_DIRECTORY)).toEqual(
      EXPECTED_PRODUCTION_FILES
    )
  })

  test('closed domain does not import wallet, memo, or financial modules', () => {
    for (const file of listProductionSourceFiles(FEATURE_DIRECTORY)) {
      const parsed = parseSourceFile(resolve(FEATURE_DIRECTORY, file))
      for (const specifier of collectModuleSpecifiers(parsed)) {
        if (!specifier.startsWith('.')) {
          expect(ALLOWED_BARE_IMPORTS.has(specifier)).toBe(true)
        }
        for (const fragment of FORBIDDEN_MODULE_FRAGMENTS) {
          expect(specifier).not.toContain(fragment)
        }
      }
    }
  })

  test('closed domain does not reference forbidden financial identifiers', () => {
    for (const file of listProductionSourceFiles(FEATURE_DIRECTORY)) {
      const parsed = parseSourceFile(resolve(FEATURE_DIRECTORY, file))
      for (const identifier of collectIdentifiers(parsed)) {
        expect(
          FORBIDDEN_AUTHORITY_IDENTIFIERS.has(identifier),
          `${file} references ${identifier}`
        ).toBe(false)
      }
    }
  })

  test('public barrel does not leak wallet or execution capabilities', () => {
    const exportedKeys = Object.keys(PublicModuleExports)
    expect(exportedKeys).not.toContain('signMsg')
    expect(exportedKeys).not.toContain('signMessage')
    expect(exportedKeys).not.toContain('privateKey')
    expect(exportedKeys).not.toContain('mnemonic')
    expect(exportedKeys).not.toContain('sendXec')
    expect(exportedKeys).not.toContain('sendETokens')
    expect(exportedKeys).not.toContain('createAgentWalletExecutionEngine')
    expect((PublicModuleExports as Record<string, unknown>).localStorage).toBeUndefined()
  })

  test('entrypoint stays inside the feature directory', () => {
    const parsed = parseSourceFile(ENTRYPOINT)
    for (const specifier of collectModuleSpecifiers(parsed)) {
      if (specifier.startsWith('.')) {
        expect(specifier).toMatch(/^\.\/[a-zA-Z0-9]+$/)
        expect(dirname(resolve(FEATURE_DIRECTORY, specifier))).toBe(FEATURE_DIRECTORY)
      }
    }
  })

  test('agent send and wallet capability remain disabled', () => {
    expect(isTmCommAgentSendEnabled()).toBe(false)
    expect(agentAuthenticationGrantsWalletCapability()).toBe(false)
    expect(TM_COMM_AUTOMATIC_MEMO_PUBLICATION).toBe(false)
    expect(TM_COMM_EMAIL_FALLBACK_IMPLEMENTED).toBe(false)
  })

  test('API server production files do not import financial authority', () => {
    const serverFiles = listProductionSourceFiles(SERVER_DIRECTORY)
    expect(serverFiles.length).toBeGreaterThan(0)

    for (const file of serverFiles) {
      const parsed = parseSourceFile(resolve(SERVER_DIRECTORY, file))
      const specifiers = collectModuleSpecifiers(parsed)
      const named = collectNamedImports(parsed)
      const identifiers = collectIdentifiers(parsed)

      for (const specifier of specifiers) {
        expect(specifier).not.toContain('agentWalletExecution')
        expect(specifier).not.toContain('XolosWalletService')
        expect(specifier).not.toContain('tonalliMemo')
        expect(specifier).not.toContain('minimal-xec-wallet')
      }

      expect(named).not.toContain('signMsg')
      expect(named).not.toContain('TxBuilder')
      expect(named).not.toContain('P2PKHSignatory')
      expect(identifiers).not.toContain('sendXec')
      expect(identifiers).not.toContain('sendETokens')
      expect(identifiers).not.toContain('broadcastTx')
      expect(identifiers).not.toContain('mnemonic')
      expect(identifiers).not.toContain('createAgentWalletExecutionEngine')
      expect(identifiers).not.toContain('localStorage')
    }
  })

  test('staging UI and client never call financial wallet methods', () => {
    for (const filePath of [ROUTE_FILE, CLIENT_FILE]) {
      const source = readFileSync(filePath, 'utf8')
      const parsed = parseSourceFile(filePath)
      const identifiers = collectIdentifiers(parsed)
      expect(identifiers).not.toContain('sendXec')
      expect(identifiers).not.toContain('sendETokens')
      expect(identifiers).not.toContain('sendXEC')
      expect(identifiers).not.toContain('sendRMZ')
      expect(identifiers).not.toContain('getMnemonic')
      expect(identifiers).not.toContain('broadcastTx')
      expect(identifiers).not.toContain('createAgentWalletExecutionEngine')
      expect(source).not.toMatch(/localStorage\.setItem/)
      for (const pattern of FORBIDDEN_SOURCE_PATTERNS.filter(item =>
        item.source.includes('sendXec') ||
        item.source.includes('sendETokens') ||
        item.source.includes('agentWalletExecution')
      )) {
        expect(source).not.toMatch(pattern)
      }
      expect(basename(filePath).length).toBeGreaterThan(0)
    }
  })
})
