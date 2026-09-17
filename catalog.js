'use strict'
// Lists the slash commands and skills a project can invoke, so the composer can
// offer them. Everything here is read-only and confined to the well-known Claude
// locations: a project's own `.claude`, the user's `~/.claude`, and the install
// paths named in the plugin registry. Nothing is executed and no file body is sent.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_ENTRIES = 400
const MAX_HEAD = 4096
const CACHE_MS = 5000
const cache = new Map()

// Read just enough of a file to parse its YAML front matter.
function frontMatter(file) {
  let handle
  try {
    handle = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(MAX_HEAD)
    const read = fs.readSync(handle, buffer, 0, MAX_HEAD, 0)
    const head = buffer.subarray(0, read).toString('utf8')
    const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return {}
    const fields = {}
    const lines = match[1].split('\n')
    for (let i = 0; i < lines.length; i++) {
      const pair = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
      if (!pair) continue
      const value = pair[2].trim()
      // A folded or literal block scalar (`>`, `>-`, `|`) continues on indented lines.
      if (/^[|>][-+]?\d*$/.test(value)) {
        const block = []
        while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s+\S/.test(lines[i + 1]))) block.push(lines[++i].trim())
        fields[pair[1]] = block.join(' ').trim()
      } else fields[pair[1]] = value.replace(/^["']|["']$/g, '')
    }
    return fields
  } catch { return {} }
  finally { if (handle !== undefined) try { fs.closeSync(handle) } catch {} }
}
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

function listCommands(directory, { scope, prefix = '' }, out) {
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    const full = path.join(directory, entry.name)
    // One level of nesting is enough: Claude names those commands `dir:command`.
    if (entry.isDirectory() && !prefix) { listCommands(full, { scope, prefix: `${entry.name}:` }, out); continue }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const fields = frontMatter(full)
    out.push({
      name: `${prefix}${entry.name.replace(/\.md$/, '')}`,
      kind: 'command', scope,
      description: clean(fields.description, 160),
      hint: clean(fields['argument-hint'], 60),
    })
  }
}
function listSkills(directory, { scope, prefix = '' }, out) {
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    if (!entry.isDirectory()) continue
    const file = path.join(directory, entry.name, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    const fields = frontMatter(file)
    out.push({
      name: `${prefix}${clean(fields.name, 60) || entry.name}`,
      kind: 'skill', scope,
      description: clean(fields.description, 160),
      hint: '',
    })
  }
}
function listPlugins(out) {
  let registry
  try { registry = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) }
  catch { return }
  for (const [key, installs] of Object.entries(registry.plugins || {})) {
    const install = Array.isArray(installs) ? installs[0] : null
    if (!install?.installPath) continue
    const plugin = String(key).split('@')[0]
    listCommands(path.join(install.installPath, 'commands'), { scope: 'plugin', prefix: `${plugin}:` }, out)
    listSkills(path.join(install.installPath, 'skills'), { scope: 'plugin', prefix: `${plugin}:` }, out)
  }
}

function collect(cwd) {
  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.entries
  const out = []
  if (cwd) {
    listCommands(path.join(cwd, '.claude', 'commands'), { scope: 'project' }, out)
    listSkills(path.join(cwd, '.claude', 'skills'), { scope: 'project' }, out)
  }
  const home = path.join(os.homedir(), '.claude')
  listCommands(path.join(home, 'commands'), { scope: 'user' }, out)
  listSkills(path.join(home, 'skills'), { scope: 'user' }, out)
  listPlugins(out)

  // A project entry wins over a user entry of the same name, as Claude resolves it.
  const rank = { project: 0, user: 1, plugin: 2 }
  const byName = new Map()
  for (const entry of out) {
    const previous = byName.get(entry.name)
    if (!previous || rank[entry.scope] < rank[previous.scope]) byName.set(entry.name, entry)
  }
  const entries = [...byName.values()].sort((a, b) => rank[a.scope] - rank[b.scope] || a.name.localeCompare(b.name))
  cache.set(cwd, { at: Date.now(), entries })
  return entries
}

module.exports = { collect, frontMatter }
