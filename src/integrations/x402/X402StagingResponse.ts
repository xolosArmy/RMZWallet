export type X402StagingResponse = Readonly<{
  notice: string
  authorizationOnly: true
  broadcasted: false
  payer: string
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= maxLength

export const parseX402StagingResponse = (value: unknown): X402StagingResponse | null => {
  if (!isRecord(value)) return null
  if (!isBoundedText(value.notice, 500)) return null
  if (!isBoundedText(value.payer, 200)) return null
  if (value.authorizationOnly !== true || value.broadcasted !== false) return null

  return Object.freeze({
    notice: value.notice,
    authorizationOnly: true,
    broadcasted: false,
    payer: value.payer
  })
}
