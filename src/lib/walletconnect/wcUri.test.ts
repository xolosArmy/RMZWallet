import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeWcUri } from './wcUri.ts'

test('sanitizeWcUri elimina saltos de línea y whitespace interno', () => {
  const input = '  wc:abc@2?relay-protocol=irn\n&symKey=123  '
  const output = sanitizeWcUri(input)
  assert.equal(output, 'wc:abc@2?relay-protocol=irn&symKey=123')
})

test('sanitizeWcUri elimina espacios en blanco internos', () => {
  const input = ' wc:abc @2 ?relay-protocol=irn &symKey=123 '
  const output = sanitizeWcUri(input)
  assert.equal(output, 'wc:abc@2?relay-protocol=irn&symKey=123')
})
