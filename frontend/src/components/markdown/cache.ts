// Rendering is the expensive part of a conversation: parsing, sanitizing and
// highlighting 200 messages. These caches key the output by content and mode, so a
// block that re-renders with the same text, or a session the operator switches back
// to, costs a map lookup. Bounded, least recently used first out.
import { highlightCode, renderMarkdown } from './render'

const LIMIT = 400

function bounded() {
  const map = new Map<string, string>()
  return (key: string, make: () => string): string => {
    const hit = map.get(key)
    if (hit !== undefined) {
      map.delete(key)
      map.set(key, hit)
      return hit
    }
    const value = make()
    map.set(key, value)
    if (map.size > LIMIT) map.delete(map.keys().next().value as string)
    return value
  }
}

const markdown = bounded()
const code = bounded()

/** Sanitized Markdown HTML, cached by source and highlight mode. */
export const cachedMarkdown = (source: string, highlight: boolean): string =>
  markdown(`${highlight ? 'h' : 'p'}\u0000${source}`, () => renderMarkdown(source, { highlight }))

/** Highlighted (and therefore escaped) code HTML, cached by language and code. */
export const cachedHighlight = (source: string, language: string | null): string =>
  code(`${language ?? ''}\u0000${source}`, () => highlightCode(source, language))
