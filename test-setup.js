'use strict'
// Loaded before every test file. Fleet's state directory now defaults to the
// user's home, so without this a test run would create — and could write into —
// the real ~/.claude-fleet. Point it at a throwaway instead.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.env.CLAUDE_FLEET_HOME) {
  process.env.CLAUDE_FLEET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-home-'))
}
