'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('collect extracts visible responses and safe work links, resolves relative worktrees and caches updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'))
  const previous = process.env.CLAUDE_FLEET_DIR
  process.env.CLAUDE_FLEET_DIR = root
  try {
    const project = path.join(root, 'projects', 'fixture')
    const cwd = path.join(root, 'worktree')
    fs.mkdirSync(project, {recursive:true})
    fs.mkdirSync(path.join(root, 'sessions'))
    fs.mkdirSync(cwd)
    fs.mkdirSync(path.join(root, 'git-dir'))
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../git-dir')
    fs.writeFileSync(path.join(root, 'git-dir', 'HEAD'), 'ref: refs/heads/feat/dashboard\n')
    fs.writeFileSync(path.join(root, 'sessions', 'fixture.json'), JSON.stringify({pid:process.pid,sessionId:'fixture',cwd,status:'busy',updatedAt:Date.now()}))
    fs.writeFileSync(path.join(root, 'sessions', 'broken.json'), '{broken')
    const file = path.join(project, 'fixture.jsonl')
    const records = [
      {type:'user',message:{content:'See https://linear.app/team/issue/TECH-42/dashboard'}},
      {type:'assistant',timestamp:new Date().toISOString(),message:{content:[{type:'text',text:'Ready: https://github.com/org/repo/pull/123 and https://github.com/org/repo/pull/123'},{type:'tool_use',input:{text:'https://github.com/org/repo/pull/999'}}],usage:{input_tokens:155000,output_tokens:12}}},
      {type:'assistant',message:{content:[{type:'tool_use',input:{}}]}},
    ]
    fs.writeFileSync(file, records.map(JSON.stringify).join('\n')+'\n{partial')
    delete require.cache[require.resolve('./fleet')]
    const {collect} = require('./fleet')
    let s = collect().sessions[0]
    assert.equal(s.state,'busy')
    assert.equal(s.branch,'feat/dashboard')
    assert.match(s.latestResponse,/Ready:/)
    assert.equal(s.links.length,2)
    assert.deepEqual(s.links.map(l=>l.label),['TECH-42','PR #123'])
    assert.equal(s.contextTokens,155000)
    assert.equal(s.transcriptTruncated,false)
    fs.appendFileSync(file,'\n'+JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'New response <script>alert(1)</script>'}]}}))
    s = collect().sessions[0]
    assert.equal(s.latestResponse,'New response <script>alert(1)</script>')
    assert.equal(collect().sessions[0].latestResponse,s.latestResponse)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_FLEET_DIR
    else process.env.CLAUDE_FLEET_DIR = previous
    delete require.cache[require.resolve('./fleet')]
    fs.rmSync(root,{recursive:true,force:true})
  }
})

test('sessions started by a program are flagged and attributed, CLI sessions are not', () => {
  const { collect } = require('./fleet')
  const snapshot = collect()
  for (const s of snapshot.sessions) {
    if (s.entrypoint === 'cli') {
      assert.ok(!s.background, `${s.name} is a terminal session and must not be marked background`)
      assert.equal(s.spawnedByName, undefined)
    } else if (s.entrypoint) {
      assert.equal(s.background, true, `${s.name} was started by ${s.entrypoint} and must be marked background`)
      // Attribution always resolves to something nameable, session or program.
      assert.equal(typeof s.spawnedByName, 'string')
      assert.ok(s.spawnedByName.length > 0)
      if (s.spawnedByPid) assert.notEqual(s.spawnedByPid, s.pid, 'a session cannot be its own parent')
    }
  }
  // Background sessions are still reported; the dashboard is what hides them.
  assert.equal(snapshot.total, snapshot.sessions.length)
})

test('turnSummary tells the story of the latest turn with exact failure attribution', () => {
  const { turnSummary, toolCategory } = require('./fleet')
  const t0 = 1_000_000
  const events = [
    { at: t0, kind: 'user' },
    { at: t0 + 1, kind: 'tool', id: 'a', tool: 'Read', target: 'src/Ring.kt' },
    { at: t0 + 2, kind: 'tool', id: 'b', tool: 'Bash', target: 'Run the suite' },
    { at: t0 + 3, kind: 'error', id: 'b', tool: 'Bash' },          // the Bash step failed
    { at: t0 + 4, kind: 'answer' },
    // A new turn starts here; everything above must drop out of the summary.
    { at: t0 + 10, kind: 'user' },
    { at: t0 + 11, kind: 'tool', id: 'c', tool: 'Grep', target: 'ringMode' },
    { at: t0 + 12, kind: 'tool', id: 'd', tool: 'Edit', target: 'ring/Ring.kt' },
    { at: t0 + 13, kind: 'tool', id: 'e', tool: 'Bash', target: 'Run tests again' },
  ]
  const working = turnSummary(events, { working: true })
  assert.deepEqual(working.steps.map(s => [s.t, s.k, s.ok]), [['Grep', 'inspect', true], ['Edit', 'change', true], ['Bash', 'run', true]])
  assert.equal(working.turnStartedAt, t0 + 10)
  // Working and the turn has not ended in text, so the last tool is "current".
  assert.deepEqual(working.current, { t: 'Bash', target: 'Run tests again', at: t0 + 13 })
  assert.equal(working.last, null)

  // Idle: same steps, but reported as "last" rather than "current".
  const idle = turnSummary(events, { working: false })
  assert.equal(idle.current, null)
  assert.equal(idle.last.t, 'Bash')

  // The earlier turn's failure is attributed to the right step by id, not by name.
  const first = turnSummary(events.slice(0, 5), { working: false })
  assert.deepEqual(first.steps.map(s => [s.t, s.ok]), [['Read', true], ['Bash', false]])
  assert.equal(first.answers, 1)
  // A turn that ended in an answer has no current step even when marked working.
  assert.equal(turnSummary(events.slice(0, 5), { working: true }).current, null)

  // A failed result with no matching call still surfaces, rather than vanishing.
  const orphan = turnSummary([{ at: t0, kind: 'user' }, { at: t0 + 1, kind: 'error', id: 'zzz', tool: 'Write' }])
  assert.deepEqual(orphan.steps.map(s => [s.t, s.ok]), [['Write', false]])

  assert.equal(toolCategory('WebFetch'), 'inspect')
  assert.equal(toolCategory('NotebookEdit'), 'change')
  assert.equal(toolCategory('SomethingNew'), 'other')
  assert.deepEqual(turnSummary([]).steps, [])
})

// app.js, blocks.js and control.js are classic scripts sharing one global scope, so
// a duplicate top-level `const`/`let` in any of them is a SyntaxError that takes the
// whole dashboard down. `node --check` cannot see across files; this does.
test('the browser scripts load together without redeclaring a shared-scope identifier', () => {
  const vm = require('node:vm')
  const context = vm.createContext({
    window: {}, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {} }, querySelectorAll: () => [] }), body: { setAttribute() {}, removeAttribute() {} }, documentElement: { style: { setProperty() {} } }, hidden: false, readyState: 'complete' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  for (const file of ['app.js', 'blocks.js', 'control.js', 'teams.js']) {
    const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    // A redeclaration is a SyntaxError raised when the script is instantiated in the
    // shared scope, before any statement runs. Runtime errors from the stub DOM are
    // expected noise here and are not what this test guards.
    try { new vm.Script(source, { filename: file }).runInContext(context) }
    catch (error) { if (error && error.name === 'SyntaxError') throw new Error(`${file} failed to load in the shared scope: ${error.message}`) }
  }
})

test('a terminal session survives registry removal and restart, and resumes its saved conversation', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-handoff-')))
  const previous = process.env.CLAUDE_FLEET_DIR
  process.env.CLAUDE_FLEET_DIR = root
  let manager
  try {
    const cwd = path.join(root, 'work')
    const project = path.join(root, 'projects', 'work')
    fs.mkdirSync(cwd)
    fs.mkdirSync(project, {recursive:true})
    fs.mkdirSync(path.join(root, 'sessions'))
    const sessionId = 'saved-terminal'
    const registry = path.join(root, 'sessions', 'terminal.json')
    const record = {type:'user',cwd,timestamp:new Date().toISOString(),message:{content:'Continue my work'}}
    fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), JSON.stringify(record)+'\n'+JSON.stringify({type:'ai-title',aiTitle:'My saved work'})+'\n')
    fs.writeFileSync(registry, JSON.stringify({sessionId,pid:process.pid,cwd,entrypoint:'cli'}))
    const observer = path.join(root, 'projects', 'observer-sessions')
    fs.mkdirSync(observer)
    fs.writeFileSync(path.join(observer, 'observer.jsonl'), JSON.stringify(record))
    fs.writeFileSync(path.join(project, 'sidechain.jsonl'), JSON.stringify({...record,isSidechain:true}))
    fs.writeFileSync(path.join(project, 'broken.jsonl'), '{broken')
    fs.writeFileSync(path.join(project, 'empty.jsonl'), JSON.stringify({type:'ai-title',aiTitle:'No conversation'}))
    delete require.cache[require.resolve('./fleet')]
    let {collect} = require('./fleet')
    assert.equal(collect().sessions.length, 1, 'indexer, subagent and empty transcripts must not become offline sessions')
    assert.equal(collect().sessions.filter(s=>s.sessionId===sessionId).length, 1)
    assert.equal(collect().sessions[0].alive, true)
    fs.unlinkSync(registry)
    let saved = collect().sessions.find(s=>s.sessionId===sessionId)
    assert.ok(saved, 'deleting the process registration must not delete the conversation')
    assert.equal(saved.alive, false)
    assert.equal(saved.state, 'dead')
    assert.equal(saved.cwd, cwd)
    assert.equal(saved.title, 'My saved work')
    delete require.cache[require.resolve('./fleet')]
    ;({collect} = require('./fleet'))
    assert.ok(collect().sessions.some(s=>s.sessionId===sessionId), 'history must survive a Fleet restart')
    const {ManagedSessions} = require('./managed')
    let resumed
    manager = new ManagedSessions({directory:path.join(root,'managed'),externalSessions:()=>collect().sessions,queryFactory:async args=>{
      resumed=args.options.resume
      return {close(){},async *[Symbol.asyncIterator](){yield {type:'result',result:'Resumed',is_error:false}}}
    }})
    manager.create({cwd,prompt:'Keep going',resumeSessionId:sessionId,requestId:require('node:crypto').randomUUID()})
    for(let i=0;i<100 && !resumed;i++) await new Promise(resolve=>setTimeout(resolve,5))
    assert.equal(resumed, sessionId)
    // A reopened terminal replaces the offline row instead of duplicating it.
    fs.writeFileSync(registry, JSON.stringify({sessionId,pid:process.pid,cwd,entrypoint:'cli'}))
    const reopened=collect().sessions.filter(s=>s.sessionId===sessionId)
    assert.equal(reopened.length,1)
    assert.equal(reopened[0].alive,true)
  } finally {
    if(manager) await manager.close()
    if(previous===undefined) delete process.env.CLAUDE_FLEET_DIR
    else process.env.CLAUDE_FLEET_DIR=previous
    delete require.cache[require.resolve('./fleet')]
    fs.rmSync(root,{recursive:true,force:true})
  }
})

// Cost is the one number on a row that is money, so its edge cases matter more than most:
// a fraction of a cent rendered as "$0.00" reads as "this was free", which is a lie.
test('the cost label never rounds a real spend down to nothing', () => {
  const vm = require('node:vm')
  const context = vm.createContext({
    window: {}, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {} }, querySelectorAll: () => [] }), body: { setAttribute() {}, removeAttribute() {} }, documentElement: { style: { setProperty() {} } }, hidden: false, readyState: 'complete' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8')
  try { new vm.Script(source, { filename: 'app.js' }).runInContext(context) }
  catch (error) { if (error && error.name === 'SyntaxError') throw error }
  const money = expression => vm.runInContext(expression, context)
  // Nothing to show rather than a zero: a monitored terminal session reports no cost,
  // and "$0.00" would claim it was free rather than unknown.
  assert.equal(money('money(0)'), null)
  assert.equal(money('money(null)'), null)
  assert.equal(money('money(undefined)'), null)
  assert.equal(money('money(-1)'), null)
  assert.equal(money('money(0.004)'), '<$0.01')
  assert.equal(money('money(0.0001)'), '<$0.01')
  assert.equal(money('money(0.01)'), '$0.01')
  assert.equal(money('money(0.426)'), '$0.43')
  assert.equal(money('money(12.3)'), '$12.30')
})

// A Task-tool sub-agent has no PID and never earns a row of its own in the process
// registry; the list payload is the only place it can appear, nested under the
// session that ran it.
test('a team session renders one nested child row per delegation, with role, model and status', () => {
  const vm = require('node:vm')
  const elements = new Map()
  const makeElement = () => ({
    _html: '',
    get innerHTML() { return this._html }, set innerHTML(v) { this._html = v },
    textContent: '', scrollTop: 0, hidden: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    contains: () => false, querySelector: () => null, querySelectorAll: () => [],
    focus() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, closest: () => null, append() {}, remove() {},
  })
  const getElementById = id => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id) }
  const context = vm.createContext({
    window: {},
    document: {
      getElementById, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      createElement: makeElement, body: { setAttribute() {}, removeAttribute() {} },
      documentElement: { style: { setProperty() {} } }, hidden: false, readyState: 'complete', activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8')
  new vm.Script(source, { filename: 'app.js' }).runInContext(context)

  const now = Date.now()
  const fixture = {
    generatedAt: now, counts: { busy: 1, idle: 0, stale: 0, dead: 0 }, total: 1,
    archiveRule: { enabled: false, days: 14 },
    sessions: [{
      managedId: 'm1', sessionId: 's1', shortId: 's1', name: 'Fix login', title: 'Fix login',
      branch: 'main', cwd: '/repo', cwdShort: '~/repo', state: 'busy', managedStatus: 'running',
      managed: true, alive: true, pid: null, lastActivity: now, startedAt: now,
      lastPrompt: 'Fix login', latestResponse: null, model: 'claude-sonnet-5',
      contextTokens: null, contextLimit: 200000, permissionMode: 'default', approvalMode: 'auto',
      selectedModel: '', messages: 3, links: [], approvals: 0,
      turn: { steps: [], current: null, last: null, turnStartedAt: null, answers: 0 },
      error: null, currentTool: null, resumeCmd: null, kind: 'initiative', teamId: 'delivery', teamName: 'Delivery',
      taskProgress: { total: 1, verified: 0, blocked: 0 }, worktreeBranch: null, costUsd: 0.05,
      delegations: [
        { id: 'dev-1', role: 'developer', model: 'claude-sonnet-5', status: 'running' },
        { id: 'qa-1', role: 'qa', model: 'claude-haiku', status: 'completed' },
      ],
    }],
  }
  context.fixture = fixture
  vm.runInContext('snapshot = fixture; render()', context)
  const list = elements.get('session-list').innerHTML
  assert.match(list, /data-delegation="dev-1"/)
  assert.match(list, /data-delegation="qa-1"/)
  assert.match(list, /data-delegation="dev-1"[^]*?Working[^]*?developer[^]*?sonnet-5/)
  assert.match(list, /data-delegation="qa-1"[^]*?Done[^]*?qa[^]*?haiku/)
})

// The list route is polled every couple of seconds, so it carries only enough to draw
// the child row: never the mandate or report that made it into the delegation.
test('the session list carries a compact delegation summary, with the role model as a fallback, and nothing else', async () => {
  const { execFileSync } = require('node:child_process')
  const { randomUUID } = require('node:crypto')
  const { ManagedSessions } = require('./managed')
  const { createApp } = require('./server')
  const tasksMod = require('./tasks')
  const delay = ms => new Promise(r => setTimeout(r, ms))
  const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(5) } throw Error('Condition timed out') }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-managed-'))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-initiative-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi'); git('add', 'README.md'); git('commit', '-qm', 'initial')
  const manager = new ManagedSessions({ directory, queryFactory: async () => ({ close() {}, async *[Symbol.asyncIterator]() { yield { type: 'result', result: 'done', is_error: false } } }) })
  const app = createApp({ manager, collectSessions: () => ({ sessions: [], counts: {}, total: 0, generatedAt: Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const s = manager.create({ cwd: repo, prompt: 'Fix login', requestId: randomUUID(), teamId: 'delivery' })
    await until(() => s.status === 'idle')
    const task = tasksMod.act(s, { action: 'create', title: 'Fix login', owner: 'developer', criteria: ['Keep redirect query parameters.'] })
    tasksMod.start(s, 'dev-1', { subagent_type: 'developer', prompt: `Fleet task: ${task.id}\nA secret mandate that must not reach the polled list.` })
    const body = await (await fetch(base + '/api/sessions')).json()
    const row = body.sessions.find(x => x.managedId === s.id)
    // No model has been reported yet, so this falls back to the developer role's own.
    assert.deepEqual(row.delegations, [{ id: 'dev-1', role: 'developer', model: 'sonnet', status: 'running' }])
    assert.equal(JSON.stringify(body).includes('secret mandate'), false)
  } finally {
    await app.close?.(); await manager.close()
    fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true })
  }
})
