'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { openDashboard, findBrowser, profileDir, MAC_BROWSERS } = require('./open')

const URL = 'http://127.0.0.1:7777'
const HOME = '/Users/op'
const CHROME = MAC_BROWSERS[0]

// Nothing here launches a window: the spawn and the filesystem probe are both injected,
// so the tests assert on the decision rather than on a browser appearing.
function record() {
  const calls = []
  return { calls, spawn: (command, args) => { calls.push({ command, args }); return { on() {}, unref() {} } } }
}
const only = (...present) => file => present.includes(file)

test('a Chromium is opened as an app window, in the profile the installed bundle uses', () => {
  const { calls, spawn } = record()
  const result = openDashboard(URL, { env: {}, platform: 'darwin', home: HOME, exists: only(CHROME), spawn })

  assert.equal(result.mode, 'app')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, CHROME)
  // --app is the flag that removes the tab strip and the address bar.
  assert.ok(calls[0].args.includes(`--app=${URL}`))
  // Shared with build/make-app.sh: a terminal launch and a Spotlight launch must be the
  // same window, which means the same Chrome profile.
  assert.ok(calls[0].args.includes(`--user-data-dir=${path.join(HOME, 'Library', 'Application Support', 'ClaudeFleetApp')}`))
})

test('with no Chromium installed it still opens, as an ordinary browser tab', () => {
  const { calls, spawn } = record()
  const result = openDashboard(URL, { env: {}, platform: 'darwin', home: HOME, exists: () => false, spawn })

  assert.equal(result.mode, 'browser')
  assert.deepEqual(calls[0], { command: 'open', args: [URL] })
})

test('--browser asks for a tab even when a Chromium is available', () => {
  const { calls, spawn } = record()
  const result = openDashboard(URL, { env: {}, platform: 'darwin', home: HOME, exists: only(CHROME), spawn, app: false })

  assert.equal(result.mode, 'browser')
  assert.deepEqual(calls[0], { command: 'open', args: [URL] })
})

test('on Linux a bare browser name is resolved down PATH, and xdg-open is the fallback', () => {
  const env = { PATH: ['/nowhere', '/usr/bin'].join(path.delimiter) }
  const chromium = '/usr/bin/chromium'

  assert.equal(findBrowser({ env, platform: 'linux', exists: only(chromium) }), chromium)
  // An empty PATH entry must not resolve to the current directory.
  assert.equal(findBrowser({ env: { PATH: '' }, platform: 'linux', exists: () => true }), null)

  const { calls, spawn } = record()
  openDashboard(URL, { env: { PATH: '' }, platform: 'linux', home: HOME, exists: () => false, spawn })
  assert.deepEqual(calls[0], { command: 'xdg-open', args: [URL] })
})

test('CLAUDE_FLEET_BROWSER outranks the known list, so an unlisted Chromium still works', () => {
  const custom = '/opt/vivaldi/vivaldi'
  const found = findBrowser({ env: { CLAUDE_FLEET_BROWSER: custom }, platform: 'darwin', exists: only(custom, CHROME) })
  assert.equal(found, custom)
})

test('the app profile is per-platform and overridable', () => {
  assert.equal(profileDir({ env: {}, platform: 'darwin', home: HOME }),
    path.join(HOME, 'Library', 'Application Support', 'ClaudeFleetApp'))
  assert.equal(profileDir({ env: {}, platform: 'linux', home: HOME }),
    path.join(HOME, '.local', 'share', 'ClaudeFleetApp'))
  assert.equal(profileDir({ env: { XDG_DATA_HOME: '/xdg' }, platform: 'linux', home: HOME }),
    path.join('/xdg', 'ClaudeFleetApp'))
  assert.equal(profileDir({ env: { CLAUDE_FLEET_APP_PROFILE: '/tmp/p' }, platform: 'darwin', home: HOME }), '/tmp/p')
})
