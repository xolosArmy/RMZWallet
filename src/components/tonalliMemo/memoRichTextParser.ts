export interface RichTextSegment {
  type: 'text' | 'link'
  content: string
  href?: string
}

/**
 * Validates whether a candidate string is an absolute http or https URL.
 * Strictly forbids javascript:, data:, file:, vbscript:, and other schemes.
 * Rejects userinfo/credentials (username or password) to prevent phishing attacks.
 * Requires a valid, non-empty hostname.
 */
export function validateHttpUrl(urlString: string): URL | null {
  try {
    const parsed = new URL(urlString)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    // Reject userinfo / credentials
    if (parsed.username !== '' || parsed.password !== '') {
      return null
    }
    // Require valid hostname
    if (!parsed.hostname) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Trims trailing punctuation and unbalanced closing brackets/parentheses from a candidate URL.
 * e.g., "https://example.com." -> url: "https://example.com", trailing: "."
 * "(https://example.com)" -> url: "https://example.com", trailing: ")"
 * "https://en.wikipedia.org/wiki/React_(software)" -> url: "https://en.wikipedia.org/wiki/React_(software)", trailing: ""
 */
export function trimTrailingPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl
  let trailing = ''

  while (url.length > 0) {
    const lastChar = url[url.length - 1]

    // Common trailing sentence punctuation and quotes
    if (/[.,;:!?>"'`]/.test(lastChar)) {
      trailing = lastChar + trailing
      url = url.slice(0, -1)
      continue
    }

    // Unbalanced closing parenthesis
    if (lastChar === ')') {
      const openCount = (url.match(/\(/g) || []).length
      const closeCount = (url.match(/\)/g) || []).length
      if (closeCount > openCount) {
        trailing = lastChar + trailing
        url = url.slice(0, -1)
        continue
      }
    }

    // Unbalanced closing square bracket
    if (lastChar === ']') {
      const openCount = (url.match(/\[/g) || []).length
      const closeCount = (url.match(/\]/g) || []).length
      if (closeCount > openCount) {
        trailing = lastChar + trailing
        url = url.slice(0, -1)
        continue
      }
    }

    // Unbalanced closing curly brace
    if (lastChar === '}') {
      const openCount = (url.match(/\{/g) || []).length
      const closeCount = (url.match(/\}/g) || []).length
      if (closeCount > openCount) {
        trailing = lastChar + trailing
        url = url.slice(0, -1)
        continue
      }
    }

    break
  }

  return { url, trailing }
}

/**
 * Parses raw text into alternating text and safe link segments.
 * Only http: and https: protocols are permitted.
 * User-entered HTML is never parsed or executed; it remains safe text.
 */
export function parseRichTextSegments(text: string): RichTextSegment[] {
  if (!text) return []

  // Match URLs starting with http:// or https:// up to whitespace or angle brackets/quotes
  const CANDIDATE_URL_REGEX = /\bhttps?:\/\/[^\s<>"']+/gi
  const segments: RichTextSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = CANDIDATE_URL_REGEX.exec(text)) !== null) {
    const matchStart = match.index
    const rawCandidate = match[0]

    // Capture preceding text
    if (matchStart > lastIndex) {
      segments.push({
        type: 'text',
        content: text.slice(lastIndex, matchStart)
      })
    }

    const { url: candidateUrl, trailing } = trimTrailingPunctuation(rawCandidate)
    const parsedUrl = candidateUrl ? validateHttpUrl(candidateUrl) : null

    if (parsedUrl) {
      segments.push({
        type: 'link',
        content: candidateUrl,
        href: parsedUrl.href
      })
      if (trailing) {
        segments.push({
          type: 'text',
          content: trailing
        })
      }
    } else {
      // If validation fails, retain rawCandidate as plain text
      segments.push({
        type: 'text',
        content: rawCandidate
      })
    }

    lastIndex = matchStart + rawCandidate.length
  }

  // Trailing text after final match
  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      content: text.slice(lastIndex)
    })
  }

  return segments
}

/**
 * Helper to extract all valid URLs from a text string.
 */
export function extractValidUrls(text: string): string[] {
  return parseRichTextSegments(text)
    .filter((s): s is RichTextSegment & { href: string } => s.type === 'link' && Boolean(s.href))
    .map((s) => s.content)
}
