'use strict'
// Loaded before every test file. Fleet's state directory now defaults to the
// user's home, so without this a test run would create — and could write into —
// the real ~/.claude-fleet. Point it at a throwaway instead.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Codex's sessions too: tests must not read, or list, the real ~/.codex.
if (!process.env.CODEX_HOME) process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-codex-'))
if (!process.env.CLAUDE_FLEET_HOME) {
  process.env.CLAUDE_FLEET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-home-'))
}
