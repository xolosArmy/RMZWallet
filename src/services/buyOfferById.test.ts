import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { parseDecimalToAtoms } from '../dex/agoraPhase1.ts'
import { buildRmzBuyPreview } from '../features/dex/components/DexTakerRmz.tsx'
import { assertOneshotDesiredAtoms } from './agoraExchange.ts'
import {
  MISSING_OR_SPENT_MESSAGE,
  assertOfferOutputUnspent,
  findRemainingOfferId,
  isPartialAccept,
  resolveAcceptedAtoms,
  toFriendlyBroadcastError
} from './buyOfferById.ts'

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


test('isPartialAccept compara acceptedAtoms contra offeredAtoms de la oferta completa', () => {
  assert.equal(isPartialAccept({ acceptedAtoms: 1n, offeredAtoms: 100n }), true)
  assert.equal(isPartialAccept({ acceptedAtoms: 1n, offeredAtoms: 1n }), false)
})

test('findRemainingOfferId usa el vout real de Agora y no txid:2 hardcodeado', () => {
  const txid = 'a'.repeat(64)
  const remainingOfferId = findRemainingOfferId(
    [
      { outpoint: { txid: 'b'.repeat(64), outIdx: 2 } },
      { outpoint: { txid, outIdx: 4 } }
    ],
    txid
  )

  assert.equal(remainingOfferId, `${txid}:4`)
  assert.notEqual(remainingOfferId, `${txid}:2`)
})

test('buyOfferById no contiene remainingOfferId hardcodeado a txid:2', () => {
  const source = readFileSync(new URL('./buyOfferById.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('`${broadcast.txid}:2`'), false)
})

test('missingorspent se convierte en mensaje amigable', () => {
  const err = toFriendlyBroadcastError(new Error('Broadcast failed: Missing inputs: bad-txns-inputs-missingorspent'))
  assert.equal(err.message, MISSING_OR_SPENT_MESSAGE)
})

test('UTXOs stale del comprador devuelven el mismo mensaje amigable', () => {
  const err = toFriendlyBroadcastError(new Error('Missing inputs'))
  assert.equal(err.message, MISSING_OR_SPENT_MESSAGE)
})

test('assertOfferOutputUnspent rechaza oferta original ya gastada antes de construir tx', () => {
  assert.throws(
    () =>
      assertOfferOutputUnspent(
        {
          outputs: [
            {
              sats: 546n,
              outputScript: 'a914'.padEnd(46, '0'),
              spentBy: { txid: 'b'.repeat(64), outIdx: 0 }
            }
          ]
        } as never,
        0
      ),
    /ya fue comprada o modificada/
  )
})

test('assertOfferOutputUnspent rechaza output inexistente', () => {
  assert.throws(() => assertOfferOutputUnspent({ outputs: [] } as never, 0), /ya fue comprada o modificada/)
})

test('oferta oneshot rechaza compra parcial', () => {
  assert.throws(() => assertOneshotDesiredAtoms(1n, 100n), /oneshot solo se puede comprar completa/)
})

test('preview UI usa disponible, cantidad a comprar, estimado y restante sin mezclar cantidades', () => {
  const preview = buildRmzBuyPreview(
    {
      offeredDisplay: '100',
      askedDisplay: '50000',
      offeredAtoms: 10000n,
      askedSats: 5_000_000n,
      tokenDecimals: 2
    },
    '1'
  )

  assert.equal(preview.valid, true)
  if (preview.valid) {
    assert.equal(preview.desiredDisplay, '1')
    assert.equal(preview.estimatedXec, '500')
    assert.equal(preview.remainingDisplay, '99')
  }
})

test('si Agora aun no indexa la oferta restante, no se construye remainingOfferId falso', () => {
  assert.equal(findRemainingOfferId([{ outpoint: { txid: 'c'.repeat(64), outIdx: 2 } }], 'd'.repeat(64)), undefined)
})
