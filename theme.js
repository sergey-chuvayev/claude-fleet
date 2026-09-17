'use strict'
// Reads the colours out of the local Warp configuration so Fleet matches the terminal
// the operator already uses. Nothing here is required: every failure falls back to the
// built-in palette, and only colour and font-size values are ever read.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HEX = /^#[0-9a-fA-F]{3,8}$/
const SLOTS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const FALLBACK = {
  name: 'Fleet Default',
  background: '#0c1014', foreground: '#99d1ce', accent: '#2aa889', cursor: '#2aa889',
  normal: { black: '#0c1014', red: '#c23127', green: '#2aa889', yellow: '#edb443', blue: '#195466', magenta: '#4e5166', cyan: '#33859e', white: '#99d1ce' },
  bright: { black: '#11151c', red: '#d26937', green: '#2aa889', yellow: '#edb443', blue: '#195466', magenta: '#888ca6', cyan: '#33859e', white: '#d3ebe9' },
  fontSize: 13,
  source: null,
}

const colour = value => (typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : null)
const unquote = value => value.trim().replace(/^["']|["']$/g, '').trim()

// A deliberately small YAML reader: Warp theme files are two levels of `key: value`.
function parseThemeYaml(text) {
  const out = {}
  let section = null, group = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const match = line.trim().match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!match) continue
    const [, key, rest] = match
    const value = unquote(rest)
    if (indent === 0) { section = key; group = null; if (value) out[key] = value; else out[key] = {} }
    else if (indent <= 3) { group = key; if (section && typeof out[section] === 'object') { if (value) out[section][key] = value; else out[section][key] = {} } }
    else if (section && group && out[section]?.[group] && typeof out[section][group] === 'object') out[section][group][key] = value
  }
  return out
}

// Warp's settings.toml, read only for the active theme path and the terminal font size.
function parseSettings(text) {
  const themeLine = text.match(/^\s*theme\s*=\s*(.+)$/m)?.[1] ?? ''
  const fontSize = Number(text.match(/^\s*font_size\s*=\s*([\d.]+)/m)?.[1])
  return {
    themePath: unquote(themeLine.match(/path\s*=\s*("[^"]*"|'[^']*')/)?.[1] ?? '') || null,
    fontSize: Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 32 ? fontSize : null,
  }
}

function readTheme(warpDirectory = process.env.CLAUDE_FLEET_WARP_DIR || path.join(os.homedir(), '.warp')) {
  const theme = structuredClone(FALLBACK)
  try {
    const settingsFile = path.join(warpDirectory, 'settings.toml')
    if (!fs.existsSync(settingsFile)) return theme
    const settings = parseSettings(fs.readFileSync(settingsFile, 'utf8'))
    if (settings.fontSize) theme.fontSize = settings.fontSize
    if (!settings.themePath) return theme
    // Confine the lookup to the themes directory; a settings file never picks arbitrary paths.
    const themesDirectory = path.join(warpDirectory, 'themes')
    const file = path.resolve(themesDirectory, settings.themePath)
    if (!file.startsWith(themesDirectory + path.sep) || !fs.existsSync(file)) return theme
    if (fs.statSync(file).size > 64 * 1024) return theme
    const parsed = parseThemeYaml(fs.readFileSync(file, 'utf8'))
    theme.source = path.basename(file)
    if (typeof parsed.name === 'string' && parsed.name.trim()) theme.name = parsed.name.trim().slice(0, 60)
    for (const key of ['background', 'foreground', 'accent', 'cursor']) theme[key] = colour(parsed[key]) || theme[key]
    for (const group of ['normal', 'bright']) for (const slot of SLOTS) {
      theme[group][slot] = colour(parsed.terminal_colors?.[group]?.[slot]) || theme[group][slot]
    }
  } catch { return structuredClone(FALLBACK) }
  return theme
}

function themeCss(theme) {
  const lines = [
    `--w-bg: ${theme.background};`,
    `--w-fg: ${theme.foreground};`,
    `--w-accent: ${theme.accent};`,
    `--w-cursor: ${theme.cursor};`,
    `--w-font-size: ${theme.fontSize}px;`,
    ...SLOTS.map(slot => `--w-${slot}: ${theme.normal[slot]};`),
    ...SLOTS.map(slot => `--w-bright-${slot}: ${theme.bright[slot]};`),
  ]
  return `/* Generated from ${theme.source ? `~/.warp/themes/${theme.source}` : 'the Fleet fallback palette'} — "${theme.name}". */\n:root {\n  ${lines.join('\n  ')}\n}\n`
}

module.exports = { readTheme, themeCss, parseThemeYaml, parseSettings, FALLBACK }
