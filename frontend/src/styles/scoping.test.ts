// Console stylesheets stay inside their own console. Today and Projects render the
// same #control-panel and #composer as Sessions, so a rule that names those parts
// must be scoped to its console, or it restyles the others once its file has loaded.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/** Every selector in a stylesheet (at-rule preludes skipped), split on top-level commas. */
function selectors(css: string): string[] {
  const out: string[] = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      const prelude = text.slice(start, i).trim()
      start = i + 1
      if (!prelude || prelude.startsWith('@')) continue
      let depth = 0
      let from = 0
      for (let j = 0; j < prelude.length; j++) {
        const c = prelude[j]
        if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === ',' && depth === 0) {
          out.push(prelude.slice(from, j).trim())
          from = j + 1
        }
      }
      out.push(prelude.slice(from).trim())
    } else if (ch === '}' || ch === ';') start = i + 1
  }
  return out
}

const CONSOLE_PARTS = /#control-panel|#composer|\.composer\b|#approvals|#agent-error|#queued-messages|\.now-line/

describe('console stylesheet scoping', () => {
  it('scopes every Projects console rule to .project-console', () => {
    const loose = selectors(read('../features/projects/projects.css')).filter(s => CONSOLE_PARTS.test(s) && !s.startsWith('.project-console'))
    expect(loose).toEqual([])
  })

  it('scopes every Today console rule to .day-console', () => {
    const loose = selectors(read('./today.css')).filter(s => CONSOLE_PARTS.test(s) && !s.startsWith('.day-console'))
    expect(loose).toEqual([])
  })

  it("keeps the Sessions console's column layout to the Sessions view", () => {
    for (const file of ['./console.css', '../features/inspector/session-inspector.css']) {
      const loose = selectors(read(file)).filter(s => s.includes('.detail:has(#composer)') && !s.startsWith('[data-view=sessions] .detail:has(#composer)'))
      expect(loose, file).toEqual([])
    }
  })

  it('finds the selectors it checks', () => {
    expect(selectors('a, b:is(c, d) { x:y } @media(max-width:1px) { e { x:y } }')).toEqual(['a', 'b:is(c, d)', 'e'])
  })
})
