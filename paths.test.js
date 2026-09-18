'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { stateDir, defaultCwd, migrate } = require('./paths')

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-paths-'))
function withEnv(values, run) {
  const saved = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return run() }
  finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value) }
}

test('state directory follows CLAUDE_FLEET_HOME and is private', () => {
  const home = path.join(temp(), 'nested', 'state')
  const dir = withEnv({ CLAUDE_FLEET_HOME: home }, () => stateDir())
  assert.equal(dir, home)
  assert.ok(fs.existsSync(home))
  // It holds conversations and pasted images; other users have no business there.
  if (process.platform !== 'win32') assert.equal(fs.statSync(home).mode & 0o777, 0o700)
})

test('a checkout\'s .fleet is carried over once, without touching the original', () => {
  const legacy = temp(), fresh = temp()
  fs.writeFileSync(path.join(legacy, 'sessions.json'), '{"version":1,"sessions":[]}')
  fs.mkdirSync(path.join(legacy, 'attachments'))
  fs.writeFileSync(path.join(legacy, 'attachments', 'a.png'), 'x')
  migrate(fresh, legacy)
  assert.equal(fs.readFileSync(path.join(fresh, 'sessions.json'), 'utf8'), '{"version":1,"sessions":[]}')
  assert.ok(fs.existsSync(path.join(fresh, 'attachments', 'a.png')))
  // A copy, not a move: the old location stays intact and reversible.
  assert.ok(fs.existsSync(path.join(legacy, 'sessions.json')))
})

test('carrying over never overwrites state that is already there', () => {
  const legacy = temp(), fresh = temp()
  fs.writeFileSync(path.join(legacy, 'sessions.json'), 'old')
  fs.writeFileSync(path.join(fresh, 'sessions.json'), 'live')
  migrate(fresh, legacy)
  assert.equal(fs.readFileSync(path.join(fresh, 'sessions.json'), 'utf8'), 'live')
})

test('default working directory prefers the explicit override', () => {
  const dir = temp()
  assert.equal(withEnv({ CLAUDE_FLEET_DEFAULT_CWD: dir }, () => defaultCwd()), path.resolve(dir))
})

test('default working directory falls back to home when launched from the root', () => {
  const root = path.parse(process.cwd()).root
  const previous = process.cwd()
  process.chdir(root)
  try { assert.equal(withEnv({ CLAUDE_FLEET_DEFAULT_CWD: undefined }, () => defaultCwd()), os.homedir()) }
  finally { process.chdir(previous) }
})
