export function validateLocalPassword(password: string, message: string) {
  if (password.length < 6) return message
  return null
}

export function validateSeedPhraseWordCount(seedPhrase: string) {
  const wordsCount = seedPhrase.trim().split(/\s+/).filter(Boolean).length
  if (wordsCount !== 12 && wordsCount !== 24) return 'La frase seed debe contener 12 o 24 palabras.'
  return null
}
