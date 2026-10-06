// The one place agent text becomes HTML. Ported from public/blocks.js proseHtml and
// build/vendor-entry.js: marked (GFM, line breaks), DOMPurify with the same forbidden
// tags and attributes, links opened with noreferrer noopener, and highlight.js core
// with an explicit language list rather than the full build. Callers inject only the
// string this returns. The Markdown component that uses it arrives with package 4.
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { Marked } from 'marked'

const LANGUAGES = { bash, css, diff, go, java, javascript, json, kotlin, markdown, plaintext, python, rust, sql, swift, typescript, xml, yaml }
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['kt', 'kts'], { languageName: 'kotlin' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['rs'], { languageName: 'rust' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['patch'], { languageName: 'diff' })
hljs.configure({ ignoreUnescapedHTML: true })

const marked = new Marked({ gfm: true, breaks: true, async: false })

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** Highlighted HTML for code. hljs escapes its own output. */
export function highlightCode(code: string, language?: string | null): string {
  try {
    if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language, ignoreIllegals: true }).value
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

/** Sanitized HTML for Markdown prose; falls back to escaped plain text if parsing fails. */
export function renderMarkdown(source: string, { highlight = true }: { highlight?: boolean } = {}): string {
  let html: string
  try {
    html = marked.parse(source, { async: false })
  } catch {
    return `<pre class="block-plain">${escapeHtml(source)}</pre>`
  }
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  })
  const holder = document.createElement('div')
  holder.innerHTML = clean
  for (const link of holder.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noreferrer noopener')
  }
  if (highlight) {
    for (const code of holder.querySelectorAll('pre > code')) {
      const declared = [...code.classList].map(c => /^language-(.+)$/.exec(c)?.[1]).find(Boolean)
      code.innerHTML = highlightCode(code.textContent ?? '', declared)
      code.classList.add('hljs')
      code.parentElement?.classList.add('block-code')
    }
  }
  return holder.innerHTML
}
