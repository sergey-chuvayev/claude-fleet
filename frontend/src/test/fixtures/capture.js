#!/usr/bin/env node
'use strict'
// Captures the API fixtures the React migration is built against (plan section 11,
// work package 1). It starts the real Fleet server (`createApp`) on a throwaway Fleet
// home, with fake runtimes and synthetic state, and writes what the server answers.
//
//   node frontend/src/test/fixtures/capture.js              capture every pack
//   node frontend/src/test/fixtures/capture.js fleet-mixed  capture one pack
//   node frontend/src/test/fixtures/capture.js --serve fleet-mixed [--port 4310]
//                                                            keep that pack's server up
//                                                            (used by e2e/baseline)
//
// Nothing here touches the real Fleet home, ~/.claude or ~/.codex, calls a model, or
// talks to the network. Each pack runs in its own child process because the server's
// modules read their directories from the environment when they load.
//
// Determinism: the clock is fixed (Date.now and `new Date()`), TZ is UTC, ids come from a
// counter, the temp directory is rewritten to /fixture, and the per-process token and
// pid are replaced. Running the script twice yields byte-identical files.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawnSync, execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '../../../..')
const OUT = __dirname
const PACKS = ['fleet-mixed', 'conversation-heavy', 'teams-heavy', 'day-full', 'projects-collision', 'failure-lifecycle']

// ---------------------------------------------------------------------------------
// Parent: one child per pack.
// ---------------------------------------------------------------------------------
function fatal(error) { console.error(error?.stack || error); process.exit(1) }

// ---------------------------------------------------------------------------------
// Child: environment, clock, ids. Must run before the server's modules load.
// ---------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 9, 6, 10, 0, 0) // 2026-10-06 10:00 UTC, the baseline day
const MIN = 60000, HOUR = 3600000, DAY = 86400000
let clock = T0

async function runChild(name, { serve, port = 0 }) {
  process.env.TZ = 'UTC'
  // A fixed path (not mkdtemp): the server fingerprints rows that contain it, and the
  // fingerprints in the fixtures must not change from run to run.
  const root = path.join(fs.realpathSync('/tmp'), `fleet-fixture-${name}${serve ? '-serve' : ''}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const dirs = {
    root,
    user: path.join(root, 'user'),
    home: path.join(root, 'home'), // CLAUDE_FLEET_HOME: Fleet's own state
    claude: path.join(root, 'claude'), // CLAUDE_FLEET_DIR: the Claude directory Fleet reads
    codex: path.join(root, 'codex'),
    repos: path.join(root, 'repos'),
    bin: path.join(root, 'bin'),
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  Object.assign(process.env, {
    HOME: dirs.user, USERPROFILE: dirs.user,
    CLAUDE_FLEET_HOME: dirs.home, CLAUDE_FLEET_DIR: dirs.claude, CODEX_HOME: dirs.codex,
    CLAUDE_FLEET_DAY_CWD: dirs.repos, CLAUDE_FLEET_CONCURRENCY: '8',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2026-10-05T09:00:00Z', GIT_COMMITTER_DATE: '2026-10-05T09:00:00Z',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  })
  delete process.env.CLAUDE_FLEET_QUEUE
  // A Codex that is "installed": an executable that never runs a model.
  const codexBin = path.join(dirs.bin, 'codex')
  fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.CLAUDE_FLEET_CODEX = codexBin

  installClock()
  installIds()
  // The server logs every refused request; that is noise here, not a failure.
  if (!process.env.FIXTURE_VERBOSE) console.error = () => {}
  const ctx = makeContext(name, dirs)
  const pack = require(`./packs/${name}.js`)
  if (!serve) ctx.clean() // before prepare, which may write files of its own
  await ctx.start(pack)
  try {
    if (serve) {
      const server = await ctx.listen(port)
      console.log(`FIXTURE_SERVER http://127.0.0.1:${server.address().port}`)
      process.on('SIGTERM', () => ctx.stop().then(() => process.exit(0)))
      process.on('SIGINT', () => ctx.stop().then(() => process.exit(0)))
      return
    }
    await ctx.listen(0)
    await pack.capture(ctx)
    ctx.finish()
    console.log(`${name}: ${ctx.written} files`)
  } finally {
    if (!serve) { await ctx.stop(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0) }
  }
}

function installClock() {
  const RealDate = Date
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(clock) }
    static now() { return clock }
  }
  global.Date = FixedDate
}
function installIds() {
  let n = 0
  // The counter leads: the server slices the first 12 hex digits for short ids.
  crypto.randomUUID = () => `${(++n).toString(16).padStart(8, '0')}-f1e1-4000-8000-000000000000`
}

// ---------------------------------------------------------------------------------
// The context a pack gets: state builders and capture helpers.
// ---------------------------------------------------------------------------------
function makeContext(packName, dirs) {
  const ctx = { packName, dirs, written: 0, T0, MIN, HOUR, DAY }
  const outDir = path.join(OUT, packName)
  let app = null, manager = null, base = null, token = null
  ctx.setClock = ms => { clock = ms }
  ctx.advance = ms => { clock += ms }
  ctx.now = () => clock
  ctx.uid = (kind, n) => `${kind.toString(16).padStart(8, '0').slice(-8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
  ctx.sleep = ms => new Promise(r => setTimeout(r, ms))
  ctx.settle = async (ms = 30) => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); await ctx.sleep(ms) }

  // -- fake runtime: one init, one reply, one result ----------------------------------
  const scripted = []
  ctx.script = reply => scripted.push(reply) // next fake turn answers with this text
  let runs = 0
  const queryFactory = async args => {
    const prompt = typeof args.prompt === 'string' ? args.prompt : '(images)'
    const text = scripted.shift() ?? `Fixture reply to: ${prompt.slice(0, 60)}`
    const n = ++runs
    return {
      close() {}, interrupt() {},
      async *[Symbol.asyncIterator]() {
        await new Promise(r => setImmediate(r))
        yield { type: 'system', subtype: 'init', session_id: ctx.uid(0x5e55, n), model: 'claude-sonnet-fixture' }
        yield { type: 'result', result: text, is_error: false }
      },
    }
  }

  // -- external state: real files in the temp Claude and Codex directories ----------
  ctx.git = (name, { branch = 'main', commits = 1 } = {}) => {
    const dir = path.join(dirs.repos, name)
    fs.mkdirSync(dir, { recursive: true })
    const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
    run('init', '-q', '-b', 'main')
    for (let i = 0; i < commits; i++) { fs.writeFileSync(path.join(dir, `file-${i}.txt`), `fixture ${i}\n`); run('add', '.'); run('commit', '-q', '-m', `Fixture commit ${i}`) }
    // The trunk stays `main`; a different branch is checked out on top of it.
    if (branch !== 'main') run('checkout', '-q', '-b', branch)
    return fs.realpathSync(dir)
  }
  // A linked worktree of `repo` on its own branch. `merged` merges that branch back into
  // main (the main checkout stays on its own branch), `dirty` leaves an uncommitted file behind.
  ctx.worktree = (repo, name, { merged = false, dirty = false } = {}) => {
    const dir = path.join(dirs.repos, name)
    const run = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' })
    run(repo, 'worktree', 'add', '-q', '-b', `feat/${name}`, dir)
    fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`)
    run(dir, 'add', '.'); run(dir, 'commit', '-q', '-m', `Work on ${name}`)
    if (merged) {
      // main gains a commit on top of the branch, so the branch is an ancestor of the trunk.
      const out = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
      const tree = out(repo, 'rev-parse', `feat/${name}^{tree}`)
      const commit = out(repo, 'commit-tree', tree, '-p', `feat/${name}`, '-m', `Merge ${name}`)
      run(repo, 'update-ref', 'refs/heads/main', commit)
    }
    if (dirty) fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'not committed\n')
    return fs.realpathSync(dir)
  }
  ctx.claudeExternal = ({ id, cwd, name = null, alive = false, busy = false, entrypoint = 'cli', ageMin = 5, prompt = 'Fixture prompt', reply = 'Fixture reply.', extra = [], contextTokens = 42000 }) => {
    const at = clock - ageMin * MIN
    const stamp = ms => new Date(ms).toISOString()
    const records = [
      { type: 'user', timestamp: stamp(at - 2 * MIN), cwd, message: { content: prompt } },
      { type: 'assistant', timestamp: stamp(at), message: { model: 'claude-opus-fixture', content: [{ type: 'text', text: reply }], usage: { input_tokens: contextTokens, output_tokens: 120 } } },
      ...extra,
    ]
    const project = path.join(dirs.claude, 'projects', cwd.split(dirs.root).join('/fixture').replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(project, { recursive: true })
    const file = path.join(project, `${id}.jsonl`)
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
    fs.utimesSync(file, at / 1000, at / 1000)
    fs.mkdirSync(path.join(dirs.claude, 'sessions'), { recursive: true })
    if (alive) fs.writeFileSync(path.join(dirs.claude, 'sessions', `${id}.json`), JSON.stringify({ pid: 1, sessionId: id, cwd, name, status: busy ? 'busy' : 'idle', entrypoint, startedAt: at - 10 * MIN, updatedAt: at }))
    return id
  }
  ctx.codexExternal = ({ id, cwd, title = null, live = false, ageMin = 8, prompt = 'Fixture Codex prompt', reply = 'Fixture Codex reply.' }) => {
    const at = clock - ageMin * MIN
    const stamp = ms => new Date(ms).toISOString()
    const day = path.join(dirs.codex, 'sessions', '2026', '10', '06')
    fs.mkdirSync(day, { recursive: true })
    const rec = (ms, type, payload) => JSON.stringify({ timestamp: stamp(ms), type, payload })
    const lines = [
      rec(at - 3 * MIN, 'session_meta', { id, cwd, timestamp: stamp(at - 3 * MIN), cli_version: '0.0.0-fixture' }),
      rec(at - 3 * MIN, 'turn_context', { cwd, model: 'gpt-fixture' }),
      rec(at - 2 * MIN, 'event_msg', { type: 'task_started', model_context_window: 200000 }),
      rec(at - 2 * MIN, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }),
      rec(at - 1 * MIN, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }),
      rec(at - 1 * MIN, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 30000 } } }),
    ]
    if (!live) lines.push(rec(at, 'event_msg', { type: 'task_complete', last_agent_message: reply }))
    const file = path.join(day, `rollout-2026-10-06T00-00-00-${id}.jsonl`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    fs.utimesSync(file, at / 1000, at / 1000)
    if (title) fs.appendFileSync(path.join(dirs.codex, 'session_index.jsonl'), JSON.stringify({ id, thread_name: title }) + '\n')
    return id
  }

  // -- managed state ------------------------------------------------------------------
  ctx.managed = (id, overrides = {}) => {
    const s = {
      id, projectId: null, sessionId: null, name: id, cwd: dirs.repos, createRequestId: `req-${id}`,
      createdAt: clock - HOUR, updatedAt: clock - 5 * MIN, status: 'idle', approvalMode: 'ask', selectedModel: '',
      messages: [], approvals: [], model: 'claude-sonnet-fixture', contextTokens: 42000, error: null, currentTool: null,
      requestIds: [], queue: [], kind: 'agent', teamId: null, teamName: null, teamSnapshot: null, taskBoard: null, worktree: null,
      ...overrides,
    }
    manager.sessions.set(id, s)
    return s
  }
  ctx.message = (id, role, text, at, extra = {}) => ({ id, role, text, at, ...extra })
  ctx.tool = (id, tool, input, at, { status = 'done', result = 'ok', ms = 120, approval = 'auto', target = null } = {}) =>
    ({ id, role: 'tool', tool, at, status, input, target, text: '', result, ms, approval })
  ctx.save = () => manager.save()
  // Approvals written onto a session by a pack are only pictures until the server can
  // settle them: register each as pending, the way a running turn would.
  ctx.livePending = s => {
    for (const a of s.approvals) {
      manager.pending.set(a.id, { sessionId: s.id, input: a.input, tool: a.tool, finish: () => {
        s.approvals = s.approvals.filter(p => p.id !== a.id)
        manager.pending.delete(a.id)
        if (!s.approvals.length && s.status === 'approval') s.status = 'running'
        manager.changed(s)
      } })
    }
  }

  // -- server -------------------------------------------------------------------------
  const stubUpdater = {
    check: async () => {},
    status: () => ({ name: 'claude-fleet', current: '0.54.0', latest: '0.54.0', available: false, canInstall: true, channel: 'npm', checkedAt: T0, state: 'current', error: null, installed: null }),
    apply: async () => ({ name: 'claude-fleet', current: '0.54.0', latest: '0.54.0', available: false, canInstall: true, channel: 'npm', checkedAt: T0, state: 'installed', error: null, installed: '0.54.0' }),
  }
  const stubService = {
    managed: false,
    status: () => ({ supported: false, enabled: false, loaded: false, managed: false }),
    enable: () => ({ supported: false, enabled: false, loaded: false, managed: false }),
    disable: () => ({ supported: false, enabled: false, loaded: false, managed: false }),
    write() {}, load() {}, refreshApp() {},
  }
  ctx.prStatuses = new Map()
  const prStatus = { get: async url => ctx.prStatuses.get(url) || { ok: false, url, reason: 'missing' } }

  ctx.start = async pack => {
    const { ManagedSessions } = require(path.join(REPO, 'managed.js'))
    const { createApp } = require(path.join(REPO, 'server.js'))
    const { SearchJobs } = require(path.join(REPO, 'search.js'))
    manager = new ManagedSessions({ directory: dirs.home, queryFactory, externalSessions: () => require(path.join(REPO, 'fleet.js')).collect().sessions })
    ctx.manager = manager
    ctx.modules = {
      day: require(path.join(REPO, 'day.js')),
      projects: require(path.join(REPO, 'projects.js')),
    }
    const search = new SearchJobs({ queryFactory: async () => ({ close() {}, async *[Symbol.asyncIterator]() {
      yield { type: 'result', is_error: false, result: JSON.stringify({ answer: 'The fixture sessions discuss the dashboard and its pull request.', matches: [] }) }
    } }) })
    if (pack.prepare) await pack.prepare(ctx)
    ctx.createApp = () => createApp({ manager, search, updater: stubUpdater, service: stubService, prStatus })
    app = ctx.createApp()
    ctx.app = app
  }
  ctx.listen = async port => {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${app.server.address().port}`
    ctx.base = base
    const control = await (await fetch(base + '/api/control')).json()
    token = control.token
    ctx.token = token
    return app.server
  }
  ctx.stop = async () => {
    try { await app.close(); app.server.closeAllConnections() } catch {}
    try { await manager.close() } catch {}
  }

  // -- capture ------------------------------------------------------------------------
  ctx.secrets = []
  const instances = new Map()
  const scrub = text => {
    let out = text.split(dirs.root).join('/fixture')
    out = out.split(token || '\u0000').join('FIXTURE_TOKEN')
    ctx.secrets.forEach((secret, i) => { out = out.split(secret).join(`FIXTURE_TOKEN_${i + 2}`) })
    return out
  }
  const normalise = value => {
    if (Array.isArray(value)) return value.map(normalise)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        // A project's updatedAt is its file's mtime on the real disk.
        if (k === 'updatedAt' && 'file' in value) { out[k] = T0; continue }
        if (k === 'port' && typeof v === 'number') out[k] = 4310
        // Per-process identity, scrubbed like the token; a restart shows as a second value.
        if (k === 'instanceId' && typeof v === 'string') { if (!instances.has(v)) instances.set(v, instances.size ? `FIXTURE_INSTANCE_${instances.size + 1}` : 'FIXTURE_INSTANCE'); out[k] = instances.get(v); continue }
        if (k === 'buildId' && typeof v === 'string') { out[k] = 'FIXTURE_BUILD'; continue }
        else if ((k === 'searchMs' || k === 'aiMs' || k === 'ms') && typeof v === 'number' && v < 1000 && ctx.packName !== 'conversation-heavy') out[k] = 0
        else out[k] = normalise(v)
      }
      return out
    }
    return value
  }
  ctx.write = (file, data) => {
    const target = path.join(outDir, file.endsWith('.json') ? file : `${file}.json`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const json = JSON.stringify(normalise(data), null, 2)
    fs.writeFileSync(target, scrub(json) + '\n')
    ctx.written++
  }
  const record = async (method, route, { headers = {}, body, auth = false, raw } = {}) => {
    if (process.env.FIXTURE_VERBOSE) console.error(`${method} ${route}`)
    const h = { ...headers }
    let payload = raw
    if (method === 'POST') {
      if (auth) h['x-fleet-token'] = token
      if (auth) h.origin ||= base
      if (body !== undefined) { h['content-type'] ||= 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body) }
    }
    const res = await fetch(base + route, { method, headers: h, body: payload })
    const type = res.headers.get('content-type') || ''
    const text = await res.text()
    let parsed = null
    if (type.includes('json') && text) { try { parsed = JSON.parse(text) } catch { parsed = text } }
    return { status: res.status, type, etag: res.headers.get('etag'), text, body: type.includes('json') ? parsed : (type.includes('image') ? `(${text.length} bytes)` : text) }
  }
  ctx.record = record
  const envelope = (method, route, requestBody, res, note) => ({
    request: { method, path: route.replace(base, ''), ...(requestBody !== undefined ? { body: requestBody } : {}), ...(note ? { note } : {}) },
    response: { status: res.status, contentType: res.type.split(';')[0] || null, body: res.body },
  })
  ctx.get = async (file, route, opts = {}) => {
    const res = await record('GET', route, opts)
    ctx.write(file, envelope('GET', route, undefined, res, opts.note))
    return res
  }
  ctx.post = async (file, route, body, { auth = true, headers, note, raw } = {}) => {
    const res = await record('POST', route, { body, auth, headers, raw })
    ctx.write(file, envelope('POST', route, body ?? raw, res, note))
    return res
  }
  // Every GET route that does not depend on pack state.
  ctx.getCommon = async () => {
    await ctx.get('get-control', '/api/control')
    await ctx.get('get-models', '/api/models')
    await ctx.get('get-teams', '/api/teams')
    await ctx.get('get-settings-gateway', '/api/settings/gateway')
    await ctx.get('get-settings-approval-mode', '/api/settings/approval-mode')
    await ctx.get('get-service', '/api/service')
    await ctx.get('get-update', '/api/update')
    await ctx.get('get-progress', '/api/progress?days=7')
    await ctx.get('get-progress-30', '/api/progress?days=30')
    await ctx.get('get-projects', '/api/projects')
    await ctx.get('get-projects-archived', '/api/projects?archived=1')
    await ctx.get('get-worktrees', '/api/worktrees')
    await ctx.get('get-manifest', '/manifest.webmanifest')
    await ctx.get('get-theme-css', '/theme.css')
    await ctx.get('get-pr-status-missing', '/api/pr-status?url=' + encodeURIComponent('https://github.com/example-org/demo-repo/pull/9'))
    await ctx.get('get-team-missing', '/api/teams/does-not-exist')
    await ctx.get('get-managed-missing', '/api/managed/does-not-exist')
    await ctx.get('get-search-missing', '/api/search/does-not-exist')
    await ctx.get('get-unknown-route', '/api/nope')
  }
  // The sessions list with its conditional-request variants (plan section 7).
  ctx.getSessions = async () => {
    const full = await ctx.get('get-sessions', '/api/sessions')
    const known = (full.body.sessions || []).map(s => s.h).filter(Boolean).join(',')
    const ns = await record('GET', '/api/sessions', { headers: { 'if-none-match': full.etag } })
    ctx.write('get-sessions-not-modified', { request: { method: 'GET', path: '/api/sessions', headers: { 'If-None-Match': '<etag of get-sessions>' } }, response: { status: ns.status, body: ns.text || null } })
    const packed = await record('GET', '/api/sessions', { headers: { 'x-fleet-known': known } })
    ctx.write('get-sessions-packed', { request: { method: 'GET', path: '/api/sessions', headers: { 'X-Fleet-Known': '<every h in get-sessions>' } }, response: { status: packed.status, body: packed.body } })
    return full.body
  }
  // The detail of every managed session, and the first few external histories.
  ctx.getDetails = async ({ histories = 3 } = {}) => {
    const snapshot = (await record('GET', '/api/sessions')).body
    for (const s of snapshot.sessions.filter(x => x.managedId)) {
      await ctx.get(`managed/${s.managedId}`, `/api/managed/${s.managedId}`)
    }
    const first = snapshot.sessions.find(x => x.managedId)
    if (first) await ctx.get('get-managed-commands', `/api/managed/${first.managedId}/commands`)
    let n = 0
    for (const s of snapshot.sessions.filter(x => !x.managedId && x.sessionId)) {
      if (n++ >= histories) break
      await ctx.get(`history/${s.engine}-${s.sessionId}`, `/api/sessions/history?sessionId=${s.sessionId}`)
    }
    await ctx.get('get-history-missing', '/api/sessions/history?sessionId=00000000-0000-4000-8000-000000000000')
    return snapshot
  }
  // The generic request guards, once per pack that wants them.
  ctx.postGuards = async () => {
    await ctx.post('post-no-token', '/api/queue', { enabled: true }, { auth: false, note: 'no X-Fleet-Token' })
    await ctx.post('post-wrong-origin', '/api/queue', { enabled: true }, { headers: { origin: 'http://evil.example' }, note: 'foreign Origin' })
    await ctx.post('post-not-json', '/api/queue', 'enabled=1', { headers: { 'content-type': 'text/plain' }, note: 'wrong media type' })
    await ctx.post('post-malformed-json', '/api/queue', '{oops', { note: 'malformed JSON' })
    await ctx.post('post-unknown-route', '/api/nope', {}, { note: 'unknown POST path' })
    const put = await record('PUT', '/api/queue', { auth: true })
    ctx.write('put-method-not-allowed', envelope('PUT', '/api/queue', undefined, put))
  }
  // The server-sent event stream: connect, trigger a change, read what arrives.
  ctx.captureEvents = async (file, trigger) => {
    const chunks = []
    await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/events', res => {
        res.on('data', c => chunks.push(c.toString()))
        setTimeout(async () => { try { await trigger() } catch (e) { reject(e) } }, 100)
        setTimeout(() => { req.destroy(); resolve() }, 700)
      })
      req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e) })
    })
    ctx.write(file, { request: { method: 'GET', path: '/api/events' }, response: { status: 200, contentType: 'text/event-stream', stream: chunks.join('').split('\n\n').filter(Boolean) } })
  }
  ctx.writeText = (file, text) => {
    const target = path.join(outDir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, scrub(text))
    ctx.written++
  }
  ctx.clean = () => fs.rmSync(outDir, { recursive: true, force: true })
  ctx.finish = () => {
    const names = []
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : names.push(path.relative(outDir, path.join(d, f.name))) }
    walk(outDir)
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ pack: packName, clock: new Date(T0).toISOString(), files: names.filter(n => n !== 'index.json').sort() }, null, 2) + '\n')
  }
  return ctx
}

module.exports = { PACKS, T0 }

if (require.main === module) {
  const args = process.argv.slice(2)
  const serve = args.indexOf('--serve')
  if (serve >= 0) {
    runChild(args[serve + 1], { serve: true, port: Number(args[args.indexOf('--port') + 1]) || 0 }).catch(fatal)
  } else if (args[0] === '--child') {
    runChild(args[1], { serve: false }).catch(fatal)
  } else {
    const wanted = args.length ? args : PACKS
    for (const name of wanted) {
      if (!PACKS.includes(name)) fatal(new Error(`Unknown pack ${name}. Packs: ${PACKS.join(', ')}`))
      const result = spawnSync(process.execPath, [__filename, '--child', name], { stdio: 'inherit' })
      if (result.status !== 0) fatal(new Error(`Pack ${name} failed (exit ${result.status}).`))
    }
  }
}
