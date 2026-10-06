'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Updater, isNewer, detectChannel, CHECK_EVERY, installArgs } = require('./update')

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-update-'))
// A clock the test moves, so nothing sleeps to prove a cache expired.
function clock(start = 1_700_000_000_000) {
  let at = start
  return { now: () => at, advance: ms => { at += ms } }
}
function updater(options = {}) {
  return new Updater({
    directory: options.directory || temp(),
    name: '@scope/fleet',
    version: '1.0.0',
    channel: 'npm',
    latestVersion: async () => '1.1.0',
    install: async () => {},
    ...options,
  })
}

test('only a newer release counts as an update', () => {
  assert.ok(isNewer('1.0.1', '1.0.0'))
  assert.ok(isNewer('1.1.0', '1.0.9'))
  assert.ok(isNewer('2.0.0', '1.99.99'))
  assert.ok(!isNewer('1.0.0', '1.0.0'))
  assert.ok(!isNewer('0.9.9', '1.0.0'))
  // 10 is not "less than" 9.
  assert.ok(isNewer('0.10.0', '0.9.0'))
  // A prerelease on the registry must never nag a released install…
  assert.ok(!isNewer('1.1.0-beta.1', '1.0.0'))
  // …but running a prerelease, the matching release is an upgrade.
  assert.ok(isNewer('1.1.0', '1.1.0-beta.1'))
  assert.ok(!isNewer('nonsense', '1.0.0'))
  assert.ok(!isNewer('1.0.1', undefined))
})

test('a published newer version is offered and installable on npm', async () => {
  const fleet = updater()
  const status = await fleet.check()
  assert.equal(status.latest, '1.1.0')
  assert.ok(status.available)
  assert.ok(status.canInstall)
})

test('a git checkout is told to pull instead of being offered an install', async () => {
  const fleet = updater({ channel: 'source' })
  const status = await fleet.check()
  assert.ok(status.available)
  assert.ok(!status.canInstall)
  await assert.rejects(() => fleet.apply(), /git pull/)
})

test('the check is cached until it goes stale, and concurrent callers share one request', async () => {
  const time = clock()
  let calls = 0
  const fleet = updater({ now: time.now, latestVersion: async () => { calls++; return '1.1.0' } })
  await Promise.all([fleet.check(), fleet.check(), fleet.check()])
  assert.equal(calls, 1)
  await fleet.check()
  assert.equal(calls, 1, 'a fresh answer is reused')
  time.advance(CHECK_EVERY + 1)
  await fleet.check()
  assert.equal(calls, 2, 'a stale answer is refreshed')
  await fleet.check({ force: true })
  assert.equal(calls, 3, 'force ignores the cache')
})

test('a registry that is unreachable leaves the last known answer and raises no alarm', async () => {
  const directory = temp()
  const time = clock()
  await updater({ directory, now: time.now }).check()
  time.advance(CHECK_EVERY + 1)
  const fleet = updater({ directory, now: time.now, latestVersion: async () => { throw new Error('ENOTFOUND') } })
  const status = await fleet.check()
  assert.equal(status.latest, '1.1.0')
  assert.equal(status.error, null)
  assert.equal(status.state, 'idle')
})

test('the cached answer is dropped once Fleet itself has moved on', async () => {
  const directory = temp()
  await updater({ directory }).check()
  // Same store, but this copy is already the version the cache was excited about.
  const fleet = new Updater({ directory, name: '@scope/fleet', version: '1.1.0', channel: 'npm', latestVersion: async () => '1.1.0', install: async () => {} })
  assert.equal(fleet.latest, null)
  assert.ok(!fleet.status().available)
})

test('installing asks npm for the exact published version', async () => {
  const specs = []
  const fleet = updater({ install: async spec => { specs.push(spec) } })
  await fleet.check()
  const status = await fleet.apply()
  assert.deepEqual(specs, ['@scope/fleet@1.1.0'])
  assert.equal(status.state, 'installed')
  assert.equal(status.installed, '1.1.0')
})

test('there is nothing to install when Fleet is already current', async () => {
  const fleet = updater({ latestVersion: async () => '1.0.0' })
  await fleet.check()
  await assert.rejects(() => fleet.apply(), /up to date/)
})

test('a failed install is reported, not swallowed', async () => {
  const fleet = updater({ install: async () => { throw new Error('npm failed: EACCES') } })
  await fleet.check()
  await assert.rejects(() => fleet.apply(), /EACCES/)
  assert.equal(fleet.status().state, 'failed')
  assert.match(fleet.status().error, /EACCES/)
})

test('a second install cannot start while one is running', async () => {
  let release
  const fleet = updater({ install: () => new Promise(resolve => { release = resolve }) })
  await fleet.check()
  const first = fleet.apply()
  await assert.rejects(() => fleet.apply(), /already installing/)
  release()
  await first
})

test('this checkout is recognised as source, and an installed copy as npm', () => {
  assert.equal(detectChannel(__dirname), 'source')
  assert.equal(detectChannel(path.join('/usr', 'lib', 'node_modules', '@scope', 'fleet')), 'npm')
  assert.equal(detectChannel(path.join(os.tmpdir(), 'somewhere-else')), 'unknown')
})

test('the update endpoints report status, need the token, and hand over the port', async () => {
  const { createApp } = require('./server')
  const { ManagedSessions } = require('./managed')
  const { Archive } = require('./archive')
  const directory = temp()
  const manager = new ManagedSessions({ directory: path.join(directory, 'state'), queryFactory: async () => ({ close() {}, async *[Symbol.asyncIterator]() {} }) })
  const fleet = updater({ directory })
  let restarted = 0
  const app = createApp({
    manager,
    archive: new Archive({ directory }),
    updater: fleet,
    restart: async () => { restarted++ },
    collectSessions: () => ({ sessions: [], counts: {}, total: 0, generatedAt: Date.now() }),
  })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const control = await (await fetch(base + '/api/control')).json()
    assert.equal(typeof control.version, 'string', 'the page needs to know which Fleet it is talking to')

    // The first GET answers from an empty cache and kicks the check off behind it.
    const first = await (await fetch(base + '/api/update')).json()
    assert.equal(first.update.available, false)
    await fleet.check()
    const second = await (await fetch(base + '/api/update')).json()
    assert.equal(second.update.latest, '1.1.0')
    assert.ok(second.update.available)

    // Installing is a state change, so it needs the CSRF token like every other POST.
    const post = (headers) => fetch(base + '/api/update', { method: 'POST', headers, body: '{}' })
    assert.equal((await post({ 'content-type': 'application/json' })).status, 403)
    const applied = await post({ 'content-type': 'application/json', 'x-fleet-token': control.token, origin: base })
    assert.equal(applied.status, 200)
    const body = await applied.json()
    assert.equal(body.update.installed, '1.1.0')
    assert.ok(body.update.restarting, 'the page must know to wait rather than reload immediately')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(restarted, 1)
  } finally { await app.close(); app.server.closeAllConnections(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('an update installs past npm\'s metadata cache, which lags a fresh publish', () => {
  const args = installArgs('@sergeychuvayev/claude-fleet@0.22.0')
  assert.ok(args.includes('--prefer-online'))
  assert.strictEqual(args.at(-1), '@sergeychuvayev/claude-fleet@0.22.0')
})

// A replacement Fleet that fails to start used to vanish: it ran with its output thrown
// away, leaving a closed window and nothing to read. Its output now goes to the log,
// and an early exit is written down with its code.
test('a restarted Fleet writes to the log, and a replacement that dies says so', async () => {
  const { relaunch } = require('./server')
  const directory = temp()
  try {
    const log = path.join(directory, 'logs', 'claude-fleet.log')
    const crashing = path.join(directory, 'crash.js')
    fs.writeFileSync(crashing, "console.error('Error: Cannot find module ./missing'); process.exit(3)")
    const failed = relaunch({ entry: crashing, args: ['start', '--no-open'], port: 7999, why: 'Restarting after an update', log, watchMs: 3000 })
    assert.equal(await failed.settled, false)
    const text = fs.readFileSync(log, 'utf8')
    assert.match(text, /Restarting after an update: starting .*crash\.js start --no-open on port 7999/)
    assert.match(text, /Cannot find module \.\/missing/, 'the replacement\'s own error lands in the log')
    assert.match(text, /exited before it was up \(code 3\)/)

    const staying = path.join(directory, 'stay.js')
    fs.writeFileSync(staying, "console.log('listening on', process.env.PORT); setTimeout(() => {}, 2000)")
    const ok = relaunch({ entry: staying, args: [], port: 7998, why: 'Restarting after an update', log, watchMs: 500 })
    assert.equal(await ok.settled, true)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.match(fs.readFileSync(log, 'utf8'), /listening on 7998/, 'it runs on the port it was handed')
    ok.child.kill()
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
