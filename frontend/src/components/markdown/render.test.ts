import { describe, expect, it } from 'vitest'
import { highlightCode, renderMarkdown } from './render'

describe('renderMarkdown', () => {
  it('strips executable and form markup', () => {
    const html = renderMarkdown('hi <script>alert(1)</script><img src=x onerror=alert(1)><form><input></form><button>x</button>')
    expect(html).not.toMatch(/<script|onerror|<form|<input|<button/)
  })

  it('opens links in a new tab without a referrer', () => {
    const html = renderMarkdown('[docs](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('highlights fenced code by its declared language', () => {
    const html = renderMarkdown('```ts\nconst a: number = 1\n```')
    expect(html).toContain('class="hljs-keyword"')
    expect(html).toContain('block-code')
    expect(renderMarkdown('```ts\nconst a = 1\n```', { highlight: false })).not.toContain('hljs-keyword')
  })

  it('escapes code it cannot place', () => {
    expect(highlightCode('<b>', 'not-a-language')).not.toContain('<b>')
  })
})
