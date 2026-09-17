'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Archive } = require('./archive.js')

const DAY = 24 * 60 * 60 * 1000
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-archive-'))
const dead = (sessionId, daysAgo) => ({ sessionId, state: 'dead', lastActivity: Date.now() - daysAgo * DAY })

test('archiving hides a session, survives a restart, and never touches the transcript', () => {
  const root = dir()
  try {
    const archive = new Archive({ directory: root })
    const session = dead('abc', 1)
    assert.equal(archive.isArchived(session), false)
    assert.equal(archive.set(['abc'], true), 1)
    assert.equal(archive.isArchived(session), true)

    // The store is Fleet's own; ~/.claude gains nothing and loses nothing.
    assert.deepEqual(fs.readdirSync(root), ['archive.json'])
    assert.equal(fs.statSync(path.join(root, 'archive.json')).mode & 0o777, 0o600)

    assert.equal(new Archive({ directory: root }).isArchived(session), true)
    archive.set(['abc'], false)
    assert.equal(archive.isArchived(session), false)
    assert.equal(new Archive({ directory: root }).isArchived(session), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the age rule only reaches offline sessions, and an explicit restore outranks it', () => {
  const root = dir()
  try {
    const archive = new Archive({ directory: root })
    assert.deepEqual(archive.setRule({ enabled: true, days: 7 }), { enabled: true, days: 7 })

    assert.equal(archive.isArchived(dead('old', 30)), true)
    assert.equal(archive.isArchived(dead('recent', 2)), false)
    // Alive, however long it has been quiet: it stays where it can be acted on.
    assert.equal(archive.isArchived({ sessionId: 'stale', state: 'stale', lastActivity: Date.now() - 90 * DAY }), false)
    assert.equal(archive.isArchived({ sessionId: 'busy', state: 'busy', lastActivity: Date.now() }), false)
    // A Fleet conversation is closed, not archived.
    assert.equal(archive.isArchived({ sessionId: 'm', managed: true, state: 'dead', lastActivity: 0 }), false)
    // Unknown age is not old age.
    assert.equal(archive.isArchived({ sessionId: 'nodate', state: 'dead', lastActivity: null }), false)

    // Restoring a rule-archived session must stick, or the next refresh undoes it.
    archive.set(['old'], false)
    assert.equal(archive.isArchived(dead('old', 30)), false)
    assert.equal(new Archive({ directory: root }).isArchived(dead('old', 30)), false)
    // Archiving it again clears the exemption rather than leaving both recorded.
    archive.set(['old'], true)
    assert.equal(archive.kept.has('old'), false)
    assert.equal(archive.isArchived(dead('old', 30)), true)

    // Turning the rule off releases everything it was hiding.
    archive.setRule({ enabled: false, days: 7 })
    assert.equal(archive.isArchived(dead('other', 30)), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the store rejects nonsense and a corrupt file hides nothing', () => {
  const root = dir()
  try {
    const archive = new Archive({ directory: root })
    assert.equal(archive.set(null, true), 0)
    assert.equal(archive.set([null, 42, '', {}], true), 0)
    // Duplicates in one request count once.
    assert.equal(archive.set(['a', 'a'], true), 1)
    // Days are clamped rather than trusted.
    assert.equal(archive.setRule({ enabled: true, days: 0 }).days, 1)
    assert.equal(archive.setRule({ enabled: true, days: 9999 }).days, 365)
    assert.equal(archive.setRule({ enabled: true, days: 'soon' }).days, 365, 'an unparseable day count keeps the stored one')
    assert.equal(archive.setRule({}).enabled, false)

    fs.writeFileSync(path.join(root, 'archive.json'), '{not json')
    const recovered = new Archive({ directory: root })
    assert.equal(recovered.isArchived(dead('a', 90)), false)
    assert.equal(recovered.rule.enabled, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the snapshot hides archived rows from the counts while still reporting them', async () => {
  const root = dir()
  const { createApp } = require('./server')
  const { ManagedSessions } = require('./managed')
  const manager = new ManagedSessions({ directory: path.join(root, 'managed'), queryFactory: async () => ({ close() {}, async *[Symbol.asyncIterator]() {} }) })
  const archive = new Archive({ directory: root })
  const sessions = [dead('old', 40), dead('new', 1), { sessionId: 'live', state: 'idle', lastActivity: Date.now() }]
  const app = createApp({ manager, archive, collectSessions: () => ({ sessions: sessions.map(s => ({ ...s })), counts: {}, total: sessions.length, generatedAt: Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const { token } = await (await fetch(base + '/api/control')).json()
    const post = (url, payload) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-token': token }, body: JSON.stringify(payload) })
    const snapshot = () => fetch(base + '/api/sessions').then(r => r.json())

    let snap = await snapshot()
    assert.equal(snap.total, 3)
    assert.equal(snap.archived, 0)
    assert.equal(snap.counts.dead, 2)

    assert.equal((await post('/api/archive', { ids: ['old'], archived: true })).status, 200)
    snap = await snapshot()
    assert.equal(snap.total, 2)
    assert.equal(snap.archived, 1)
    assert.equal(snap.counts.dead, 1, 'an archived session must leave the count it was inflating')
    // The row is still sent, flagged, so the dashboard can offer an Archived filter.
    assert.equal(snap.sessions.length, 3)
    assert.equal(snap.sessions.find(s => s.sessionId === 'old').archived, true)
    assert.equal(snap.sessions.find(s => s.sessionId === 'new').archived, false)

    assert.equal((await post('/api/archive/rule', { enabled: true, days: 7 })).status, 200)
    snap = await snapshot()
    assert.deepEqual(snap.archiveRule, { enabled: true, days: 7 })
    assert.equal(snap.archived, 1, 'the second offline session is newer than the threshold')

    assert.equal((await post('/api/archive/rule', { enabled: true, days: 30 })).status, 200)
    assert.equal((await snapshot()).archived, 1)

    // An archive action is a command, so it needs the CSRF token like every other one.
    assert.equal((await fetch(base + '/api/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)
  } finally { await app.close(); app.server.closeAllConnections(); await manager.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('a failed write leaves memory agreeing with disk', () => {
  const root = dir()
  try {
    const archive = new Archive({ directory: root })
    archive.set(['kept'], true)
    archive.file = path.join(root, 'missing-dir', 'archive.json')
    assert.throws(() => archive.set(['lost'], true))
    assert.equal(archive.archived.has('lost'), false, 'a session Fleet could not record must not look archived')
    assert.equal(archive.archived.has('kept'), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
