import React, { useMemo } from 'react'
import { parseRichTextSegments } from './memoRichTextParser'

export interface MemoRichTextProps {
  text: string
  className?: string
}

/**
 * MemoRichText renders plain text with safe, clickable hyperlinks for http/https URLs.
 * - External links use target="_blank" and rel="noopener noreferrer nofollow ugc".
 * - All text is rendered via React text nodes to prevent script execution or HTML injection.
 * - Does not use dangerouslySetInnerHTML.
 */
export function MemoRichText({ text, className }: MemoRichTextProps) {
  const segments = useMemo(() => parseRichTextSegments(text), [text])

  if (!text) return null

  // If text contains no links, render as simple text without unnecessary wrapper
  if (segments.length === 1 && segments[0].type === 'text') {
    return className ? <span className={className}>{text}</span> : <>{text}</>
  }

  const content = segments.map((segment, index) => {
    if (segment.type === 'link' && segment.href) {
      return (
        <a
          key={`link-${index}`}
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="memo-rich-link"
        >
          {segment.content}
        </a>
      )
    }
    return <React.Fragment key={`text-${index}`}>{segment.content}</React.Fragment>
  })

  return className ? <span className={className}>{content}</span> : <>{content}</>
}

export default MemoRichText
