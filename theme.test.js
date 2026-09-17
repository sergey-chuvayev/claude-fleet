'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readTheme, themeCss, FALLBACK } = require('./theme')

function warpDirectory({ settings, themes = {} }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-warp-'))
  if (settings != null) fs.writeFileSync(path.join(directory, 'settings.toml'), settings)
  if (Object.keys(themes).length) {
    fs.mkdirSync(path.join(directory, 'themes'))
    for (const [name, body] of Object.entries(themes)) fs.writeFileSync(path.join(directory, 'themes', name), body)
  }
  return directory
}

const GOTHAM = `name: Gotham Default
accent: "#2aa889"
cursor: "#2aa889"
background: "#0c1014"
foreground: "#99d1ce"
details: darker
terminal_colors:
  bright:
    black: "#11151c"
    yellow: "#edb443"
  normal:
    black: "#0c1014"
    red: "#c23127"
    yellow: "#edb443"
`

test('reads the active Warp theme and font size, and emits them as CSS variables', () => {
  const directory = warpDirectory({
    settings: '[appearance.themes]\ntheme = { custom = { name = "Gotham Default", path = "gotham.yaml" } }\n\n[appearance.text]\nfont_size = 15.0\n',
    themes: { 'gotham.yaml': GOTHAM },
  })
  try {
    const theme = readTheme(directory)
    assert.equal(theme.name, 'Gotham Default')
    assert.equal(theme.background, '#0c1014')
    assert.equal(theme.accent, '#2aa889')
    assert.equal(theme.fontSize, 15)
    assert.equal(theme.normal.red, '#c23127')
    assert.equal(theme.bright.black, '#11151c')
    // Slots the file omits keep the built-in value rather than becoming undefined.
    assert.equal(theme.normal.green, FALLBACK.normal.green)
    const css = themeCss(theme)
    assert.match(css, /--w-bg: #0c1014;/)
    assert.match(css, /--w-bright-yellow: #edb443;/)
    assert.match(css, /--w-font-size: 15px;/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('falls back safely for a missing, escaping, or malformed Warp configuration', () => {
  const missing = readTheme(path.join(os.tmpdir(), 'fleet-warp-does-not-exist'))
  assert.equal(missing.name, FALLBACK.name)
  assert.equal(missing.source, null)

  // A settings file must not be able to point the reader outside the themes directory.
  const escaping = warpDirectory({ settings: 'theme = { custom = { path = "../../../../etc/passwd" } }\n', themes: { 'unused.yaml': GOTHAM } })
  const junk = warpDirectory({ settings: 'theme = { custom = { path = "junk.yaml" } }\n', themes: { 'junk.yaml': 'name: Bad\nbackground: "javascript:alert(1)"\nfont_size: huge\n' } })
  try {
    assert.equal(readTheme(escaping).background, FALLBACK.background)
    const bad = readTheme(junk)
    assert.equal(bad.name, 'Bad')
    // A non-colour value is rejected, never passed through into the stylesheet.
    assert.equal(bad.background, FALLBACK.background)
    assert.ok(!themeCss(bad).includes('javascript:'))
  } finally {
    fs.rmSync(escaping, { recursive: true, force: true })
    fs.rmSync(junk, { recursive: true, force: true })
  }
})
