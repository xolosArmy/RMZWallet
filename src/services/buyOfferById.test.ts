import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDecimalToAtoms } from '../dex/agoraPhase1.ts'
import { resolveAcceptedAtoms } from './buyOfferById.ts'

const makeAgoraPartial = (prepareAcceptedAtoms: (atoms: bigint) => bigint) => ({
  prepareAcceptedAtoms
})

test('resolveAcceptedAtoms compra la oferta completa si no se pasa desiredAtoms', () => {
  const calls: bigint[] = []
  const acceptedAtoms = resolveAcceptedAtoms({
    agoraPartial: makeAgoraPartial((atoms) => {
      calls.push(atoms)
      return atoms
    }),
    offeredAtoms: 100n
  })

  assert.equal(acceptedAtoms, 100n)
  assert.deepEqual(calls, [100n])
})

test('resolveAcceptedAtoms acepta una compra parcial valida', () => {
  const acceptedAtoms = resolveAcceptedAtoms({
    agoraPartial: makeAgoraPartial((atoms) => atoms),
    offeredAtoms: 100n,
    desiredAtoms: 1n
  })

  assert.equal(acceptedAtoms, 1n)
})

test('resolveAcceptedAtoms rechaza cantidad cero', () => {
  assert.throws(
    () =>
      resolveAcceptedAtoms({
        agoraPartial: makeAgoraPartial((atoms) => atoms),
        offeredAtoms: 100n,
        desiredAtoms: 0n
      }),
    /mayor a cero/
  )
})

test('resolveAcceptedAtoms rechaza cantidad negativa', () => {
  assert.throws(
    () =>
      resolveAcceptedAtoms({
        agoraPartial: makeAgoraPartial((atoms) => atoms),
        offeredAtoms: 100n,
        desiredAtoms: -1n
      }),
    /mayor a cero/
  )
})

test('resolveAcceptedAtoms rechaza cantidad superior a la oferta', () => {
  assert.throws(
    () =>
      resolveAcceptedAtoms({
        agoraPartial: makeAgoraPartial((atoms) => atoms),
        offeredAtoms: 100n,
        desiredAtoms: 101n
      }),
    /supera los RMZ disponibles/
  )
})

test('resolveAcceptedAtoms devuelve la cantidad ajustada por prepareAcceptedAtoms', () => {
  const acceptedAtoms = resolveAcceptedAtoms({
    agoraPartial: makeAgoraPartial((atoms) => atoms - (atoms % 10n)),
    offeredAtoms: 100n,
    desiredAtoms: 23n
  })

  assert.equal(acceptedAtoms, 20n)
})

test('parseDecimalToAtoms rechaza mas decimales de los permitidos por RMZ', () => {
  assert.throws(() => parseDecimalToAtoms('1.001', 2), /Maximo|Máximo/)
})
