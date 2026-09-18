'use strict'
// Where Fleet keeps its own state. It used to sit in `.fleet/` next to the source,
// which is fine for a checkout and wrong for an installed package: `__dirname` is
// then inside node_modules, replaced wholesale on every update and not always
// writable. State belongs to the user, so it lives in the user's home.
// CLAUDE_FLEET_HOME overrides it (tests, fixtures, a second instance).
//
// Not to be confused with CLAUDE_FLEET_DIR, which points at the *Claude* directory
// Fleet reads (~/.claude).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// The pre-install layout. Only ever present in a source checkout.
const LEGACY_DIR = path.join(__dirname, '.fleet')
// Copied on first run of the new layout. attachments is a directory; the rest are files.
const CARRIED = ['sessions.json', 'archive.json', 'attachments']

let resolved = null

function target() {
  const override = process.env.CLAUDE_FLEET_HOME
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude-fleet')
}

// Copy a pre-install `.fleet/` into the home directory once, so upgrading from a
// checkout does not look like losing every conversation. The source is left alone:
// a copy is reversible, a move is not, and the old directory is simply ignored
// afterwards. Anything already in the destination wins — never overwrite live state.
function migrate(dir, legacy = LEGACY_DIR) {
  if (dir === legacy || !fs.existsSync(legacy)) return
  for (const name of CARRIED) {
    const from = path.join(legacy, name)
    const to = path.join(dir, name)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    try { fs.cpSync(from, to, { recursive: true, preserveTimestamps: true }) }
    catch (error) { console.error(`Could not carry over ${name} from ${legacy}: ${error.message}`) }
  }
}

// Created 0700: it holds conversations, pasted images and the session store.
function stateDir() {
  const dir = target()
  if (resolved === dir) return dir
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  migrate(dir)
  resolved = dir
  return dir
}

// The directory a new agent starts in when the operator has not picked one.
// `path.dirname(__dirname)` used to stand in for "the folder holding my projects",
// which stops being true the moment Fleet is installed rather than cloned.
function defaultCwd() {
  const override = process.env.CLAUDE_FLEET_DEFAULT_CWD
  if (override) return path.resolve(override)
  const cwd = process.cwd()
  // Launchers start the server from `/` or from inside the install; neither is a
  // useful suggestion, and neither is a directory the operator chose.
  const useless = cwd === path.parse(cwd).root || cwd.includes(`${path.sep}node_modules${path.sep}`) || cwd === __dirname
  return useless ? os.homedir() : cwd
}

module.exports = { stateDir, defaultCwd, migrate, LEGACY_DIR }
