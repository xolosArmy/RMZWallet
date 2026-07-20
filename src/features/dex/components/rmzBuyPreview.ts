import { formatAtomsToDecimal, formatSatsToXec, parseDecimalToAtoms } from '../../../dex/agoraPhase1'

export type RmzOfferSummary = {
  offeredDisplay: string
  askedDisplay: string
  offeredAtoms: bigint
  askedSats: bigint
  tokenDecimals: number
}

export type RmzBuyPreview =
  | { valid: false; error: string }
  | {
      valid: true
      desiredDisplay: string
      estimatedXec: string
      remainingDisplay: string
    }

export const buildRmzBuyPreview = (offerSummary: RmzOfferSummary | null, buyAmountInput: string): RmzBuyPreview => {
  if (!offerSummary || !buyAmountInput.trim()) {
    return { valid: false, error: 'Ingresa una cantidad de RMZ.' }
  }

  try {
    const desiredAtoms = parseDecimalToAtoms(buyAmountInput, offerSummary.tokenDecimals)
    if (desiredAtoms <= 0n) {
      return { valid: false, error: 'La cantidad debe ser mayor a cero.' }
    }
    if (desiredAtoms > offerSummary.offeredAtoms) {
      return { valid: false, error: 'La cantidad supera los RMZ disponibles.' }
    }

    const estimatedSats = (offerSummary.askedSats * desiredAtoms) / offerSummary.offeredAtoms
    const remainingAtoms = offerSummary.offeredAtoms - desiredAtoms
    return {
      valid: true,
      desiredDisplay: formatAtomsToDecimal(desiredAtoms, offerSummary.tokenDecimals),
      estimatedXec: formatSatsToXec(estimatedSats),
      remainingDisplay: formatAtomsToDecimal(remainingAtoms, offerSummary.tokenDecimals)
    }
  } catch (err) {
    return { valid: false, error: (err as Error).message }
  }
}
