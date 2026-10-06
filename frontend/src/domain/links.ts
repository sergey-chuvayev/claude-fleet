// Links as the things they point at (public/ui.js linkLabel), shared by the Day board,
// project pages and Progress.

/** A link as the thing it points at: TECH-5163, api-allo#4638, Slack, Notion. */
export function linkLabel(url: string): string {
  const linear = /linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/.exec(url)
  if (linear?.[1]) return linear[1].toUpperCase()
  const pr = /github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url)
  if (pr?.[1] && pr[2]) return `${pr[1]}#${pr[2]}`
  const named: ReadonlyArray<readonly [RegExp, string]> = [
    [/slack\.com/, 'Slack'],
    [/notion\.(so|site)/, 'Notion'],
    [/granola\.ai/, 'Granola'],
    [/figma\.com/, 'Figma'],
    [/docs\.google\.com/, 'Google Doc'],
    [/usepylon\.com|pylon/, 'Pylon'],
  ]
  for (const [pattern, name] of named) if (pattern.test(url)) return name
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Link'
  }
}

/** Only web links become anchors; anything else (a javascript: url in a hand-edited file) is dropped. */
export const isWebLink = (url: string): boolean => /^https?:\/\//i.test(url)
