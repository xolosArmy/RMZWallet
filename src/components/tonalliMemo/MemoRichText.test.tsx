/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoRichText } from './MemoRichText'
import {
  extractValidUrls,
  parseRichTextSegments,
  trimTrailingPunctuation,
  validateHttpUrl
} from './memoRichTextParser'

afterEach(() => {
  cleanup()
})

describe('MemoRichText - Safe Linkification', () => {
  it('URL https simple se vuelve clickeable', () => {
    render(<MemoRichText text="Visita https://xolosarmy.xyz para más información" />)

    const link = screen.getByRole('link', { name: 'https://xolosarmy.xyz' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://xolosarmy.xyz/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
  })

  it('URL http simple se vuelve clickeable', () => {
    render(<MemoRichText text="Revisa http://insecure-example.org/test hoy" />)

    const link = screen.getByRole('link', { name: 'http://insecure-example.org/test' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('http://insecure-example.org/test')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
  })

  it('texto sin URL queda idéntico', () => {
    const { container } = render(<MemoRichText text="Mensaje común y corriente sin ningún enlace." />)
    expect(container.textContent).toBe('Mensaje común y corriente sin ningún enlace.')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('múltiples URLs funcionan', () => {
    render(
      <MemoRichText text="Primero visita https://e.cash y después http://xolosarmy.xyz/docs para aprender." />
    )

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)

    expect(links[0].textContent).toBe('https://e.cash')
    expect(links[0].getAttribute('href')).toBe('https://e.cash/')
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')

    expect(links[1].textContent).toBe('http://xolosarmy.xyz/docs')
    expect(links[1].getAttribute('href')).toBe('http://xolosarmy.xyz/docs')
    expect(links[1].getAttribute('target')).toBe('_blank')
    expect(links[1].getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
  })

  it('query string funciona', () => {
    render(<MemoRichText text="Búsqueda: https://example.com/search?q=ecash&category=crypto&lang=es" />)

    const link = screen.getByRole('link', {
      name: 'https://example.com/search?q=ecash&category=crypto&lang=es'
    })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://example.com/search?q=ecash&category=crypto&lang=es')
  })

  it('fragment funciona', () => {
    render(<MemoRichText text="Ver sección en https://example.com/docs#protocol-specification" />)

    const link = screen.getByRole('link', { name: 'https://example.com/docs#protocol-specification' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://example.com/docs#protocol-specification')
  })

  it('trailing "." no entra al href', () => {
    const { container } = render(<MemoRichText text="Visita https://example.com." />)

    const link = screen.getByRole('link', { name: 'https://example.com' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://example.com/')
    expect(link.getAttribute('href')?.endsWith('.')).toBe(false)
    expect(container.textContent).toBe('Visita https://example.com.')
  })

  it('trailing puntuación variada (, ! ? : ;) no entra al href', () => {
    const { container: c1 } = render(<MemoRichText text="Mira esto https://example.com," />)
    expect(screen.getByRole('link', { name: 'https://example.com' }).getAttribute('href')).toBe(
      'https://example.com/'
    )
    expect(c1.textContent).toBe('Mira esto https://example.com,')
    cleanup()

    const { container: c2 } = render(<MemoRichText text="¡Atención https://example.com/alert!" />)
    expect(screen.getByRole('link', { name: 'https://example.com/alert' }).getAttribute('href')).toBe(
      'https://example.com/alert'
    )
    expect(c2.textContent).toBe('¡Atención https://example.com/alert!')
    cleanup()

    const { container: c3 } = render(<MemoRichText text="¿Conoces https://example.com/faq?" />)
    expect(screen.getByRole('link', { name: 'https://example.com/faq' }).getAttribute('href')).toBe(
      'https://example.com/faq'
    )
    expect(c3.textContent).toBe('¿Conoces https://example.com/faq?')
  })

  it('paréntesis envolventes "(https://example.com)" quedan fuera del href', () => {
    const { container } = render(<MemoRichText text="Documentación oficial (https://example.com)" />)

    const link = screen.getByRole('link', { name: 'https://example.com' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://example.com/')
    expect(link.getAttribute('href')?.includes(')')).toBe(false)
    expect(container.textContent).toBe('Documentación oficial (https://example.com)')
  })

  it('paréntesis balanceados en Wikipedia permanecen dentro del href', () => {
    render(<MemoRichText text="Artículo: https://en.wikipedia.org/wiki/React_(software)" />)

    const link = screen.getByRole('link', { name: 'https://en.wikipedia.org/wiki/React_(software)' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/React_(software)')
  })

  it('paréntesis balanceados envueltos en paréntesis externos separan el exterior', () => {
    const { container } = render(
      <MemoRichText text="Leer (https://en.wikipedia.org/wiki/React_(software)) completo." />
    )

    const link = screen.getByRole('link', { name: 'https://en.wikipedia.org/wiki/React_(software)' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/React_(software)')
    expect(container.textContent).toBe(
      'Leer (https://en.wikipedia.org/wiki/React_(software)) completo.'
    )
  })

  it('javascript: nunca es link', () => {
    const { container } = render(<MemoRichText text="Intento de ataque: javascript:alert('xss')" />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe("Intento de ataque: javascript:alert('xss')")
  })

  it('data: nunca es link', () => {
    const { container } = render(
      <MemoRichText text="Payload: data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" />
    )

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe(
      'Payload: data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='
    )
  })

  it('file: y vbscript: nunca son links', () => {
    const { container } = render(
      <MemoRichText text="Rutas: file:///etc/passwd y vbscript:MsgBox(1)" />
    )

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe('Rutas: file:///etc/passwd y vbscript:MsgBox(1)')
  })

  it('texto tipo <script> se muestra como texto y jamás se ejecuta', () => {
    const malicious = '<script>window.__xss_executed = true;</script>'
    const { container } = render(<MemoRichText text={malicious} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe(malicious)
    expect((window as unknown as { __xss_executed?: boolean }).__xss_executed).toBeUndefined()
    // Verifies no script tag in DOM
    expect(container.querySelector('script')).toBeNull()
  })

  it('rel contiene noopener noreferrer nofollow ugc y target=_blank', () => {
    render(<MemoRichText text="Link: https://xolosarmy.xyz" />)

    const link = screen.getByRole('link', { name: 'https://xolosarmy.xyz' })
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('no esconde un dominio malicioso detrás de otro texto', () => {
    render(<MemoRichText text="No permitido esconder dominio: https://genuine-bank.com" />)

    const link = screen.getByRole('link')
    expect(link.textContent).toBe('https://genuine-bank.com')
    expect(link.getAttribute('href')).toContain('genuine-bank.com')
  })

  it('retorna null si text está vacío o no es string', () => {
    const { container: c1 } = render(<MemoRichText text="" />)
    expect(c1.innerHTML).toBe('')

    const { container: c2 } = render(<MemoRichText text={null as unknown as string} />)
    expect(c2.innerHTML).toBe('')
  })
})

describe('URL Parser Utility Functions', () => {
  it('validateHttpUrl solo aprueba http y https válidos', () => {
    expect(validateHttpUrl('https://xolosarmy.xyz')).not.toBeNull()
    expect(validateHttpUrl('http://xolosarmy.xyz')).not.toBeNull()
    expect(validateHttpUrl('javascript:alert(1)')).toBeNull()
    expect(validateHttpUrl('data:text/plain;base64,123')).toBeNull()
    expect(validateHttpUrl('file:///tmp/test')).toBeNull()
    expect(validateHttpUrl('ftp://example.com')).toBeNull()
    expect(validateHttpUrl('not-a-url')).toBeNull()
    expect(validateHttpUrl('http://')).toBeNull()
  })

  it('trimTrailingPunctuation elimina puntuación terminal respetando paréntesis balanceados', () => {
    expect(trimTrailingPunctuation('https://example.com.')).toEqual({
      url: 'https://example.com',
      trailing: '.'
    })
    expect(trimTrailingPunctuation('https://example.com)...')).toEqual({
      url: 'https://example.com',
      trailing: ')...'
    })
    expect(trimTrailingPunctuation('https://en.wikipedia.org/wiki/React_(software)')).toEqual({
      url: 'https://en.wikipedia.org/wiki/React_(software)',
      trailing: ''
    })
    expect(trimTrailingPunctuation('https://en.wikipedia.org/wiki/React_(software))')).toEqual({
      url: 'https://en.wikipedia.org/wiki/React_(software)',
      trailing: ')'
    })
  })

  it('parseRichTextSegments y extractValidUrls extraen URLs válidas', () => {
    const text = 'Ver https://e.cash y también (https://xolosarmy.xyz).'
    const segments = parseRichTextSegments(text)
    expect(segments).toEqual([
      { type: 'text', content: 'Ver ' },
      { type: 'link', content: 'https://e.cash', href: 'https://e.cash/' },
      { type: 'text', content: ' y también (' },
      { type: 'link', content: 'https://xolosarmy.xyz', href: 'https://xolosarmy.xyz/' },
      { type: 'text', content: ').' }
    ])

    const urls = extractValidUrls(text)
    expect(urls).toEqual(['https://e.cash', 'https://xolosarmy.xyz'])
  })
})
