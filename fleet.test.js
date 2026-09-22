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

// The five browser files are classic scripts on one page, so anything they declare at
// the top level lands on the same object. Each one now keeps its own scope and
// publishes a single namespace, which is what makes a name chosen twice in two files
// harmless instead of a SyntaxError that takes the dashboard down before it runs.
// This is the test that keeps it that way: load them in page order and check that the
// page's globals gained nothing but those namespaces.
test('each browser script keeps its own scope and leaks only its namespace', () => {
  const vm = require('node:vm')
  const context = vm.createContext({
    window: {}, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {} }, querySelectorAll: () => [] }), body: { setAttribute() {}, removeAttribute() {} }, documentElement: { style: { setProperty() {} } }, hidden: false, readyState: 'complete' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  const before = new Set(Object.keys(context))
  const FILES = ['app.js', 'blocks.js', 'control.js', 'teams.js', 'ask.js', 'work-queue.js']
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    // A redeclaration is a SyntaxError raised when the script is instantiated, before
    // any statement runs. Runtime errors from the stub DOM are expected noise here.
    try { new vm.Script(source, { filename: file }).runInContext(context) }
    catch (error) { if (error && error.name === 'SyntaxError') throw new Error(`${file} failed to load: ${error.message}`) }
  }
  const added = Object.keys(context).filter(k => !before.has(k)).sort()
  assert.deepEqual(added, ['Fleet', 'FleetAsk', 'FleetBlocks', 'FleetControl', 'FleetQueue', 'FleetTeams'],
    'the only new globals may be the one namespace each file publishes')
  // Every namespace has to survive its own file's boot wiring. app.js and control.js
  // publish partway down rather than as the value their wrapper returns, precisely so
  // that an element missing from the wiring below cannot deny the next file its
  // dependency and take the whole page with it.
  for (const name of added) assert.equal(typeof context[name], 'object', `${name} must be published even when the boot wiring finds no DOM`)
  // The cross-file contract, stated once so a rename cannot quietly break a caller.
  for (const [name, keys] of [
    ['Fleet', ['$', 'esc', 'update', 'key', 'age', 'money', 'status', 'usageHtml', 'snapshot', 'render', 'tick', 'setSnapshot', 'setFilter', 'select', 'setChildrenCollapsed', 'setChildDetail', 'toast', 'modalIsOpen', 'openModal', 'closeModal', 'watchConversation', 'syncDetails']],
    ['FleetControl', ['selectControl', 'isWorking', 'updateLaunchTeam', 'renderUpdate', 'api', 'session', 'launchTeams', 'setLaunchTeams', 'setLaunchRequestId']],
    ['FleetBlocks', ['renderBlocks', 'proseHtml', 'codeHtml', 'highlight']],
    ['FleetTeams', ['open', 'board', 'reset', 'save', 'isEditing']],
  ]) for (const k of keys) assert.equal(typeof context[name][k], 'function', `${name}.${k} must stay part of the published surface`)
  // The one member that is a bag of functions rather than a function.
  for (const k of ['get', 'set', 'clear']) assert.equal(typeof context.Fleet.store[k], 'function', `Fleet.store.${k} must stay part of the published surface`)
})

// The contract list above only proves that what a namespace publishes is still there.
// It cannot see a name a file USES but never destructured: that resolves to nothing,
// and because the reference sits inside a handler rather than at the top level, loading
// the file proves nothing. `tick` shipped that way — control.js called it in six places
// while it stayed private to app.js, so every send, approval, stop and close reported
// "tick is not defined" after the server had already done the work. So: wire the page,
// then fire what it wired. A ReferenceError here means a file reached for a name the
// page does not hand it. Anything the stub DOM throws is expected noise and ignored.
test('every handler the browser scripts wire can reach the names it uses', () => {
  const vm = require('node:vm')
  const wired = []
  const context = vm.createContext({
    window: {}, document: { getElementById: () => null, addEventListener: (type, fn) => wired.push([`document ${type}`, fn]), querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {} }, querySelectorAll: () => [] }), body: { setAttribute() {}, removeAttribute() {} }, documentElement: { style: { setProperty() {} } }, hidden: false, readyState: 'complete' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }),
    addEventListener: (type, fn) => wired.push([`window ${type}`, fn]), removeEventListener() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: () => new Promise(() => {}),
    // The stream is wired both ways: addEventListener for named events, and `onopen` as
    // a property. The property assignment is the one that caught `tick`, so record both.
    EventSource: function () {
      const source = { addEventListener: (type, fn) => wired.push([`events ${type}`, fn]) }
      return new Proxy(source, { set(target, key, value) {
        if (typeof key === 'string' && key.startsWith('on') && typeof value === 'function') wired.push([`events ${key}`, value])
        target[key] = value
        return true
      } })
    },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  for (const file of ['app.js', 'blocks.js', 'control.js', 'teams.js', 'ask.js', 'work-queue.js']) {
    const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    try { new vm.Script(source, { filename: file }).runInContext(context) }
    catch (error) { if (error && error.name === 'SyntaxError') throw new Error(`${file} failed to load: ${error.message}`) }
  }
  assert.ok(wired.length > 10, 'the page should have wired its handlers before any of them is fired')
  const unresolved = []
  for (const [name, handler] of wired) {
    // An async handler rejects rather than throws, so settle it quietly either way.
    try { const result = handler({ data: 'null', target: {} }); if (result && typeof result.catch === 'function') result.catch(() => {}) }
    catch (error) { if (error && error.name === 'ReferenceError') unresolved.push(`${name}: ${error.message}`) }
  }
  assert.deepEqual(unresolved, [], 'a handler reached for a name no namespace hands it')
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
  const money = expression => vm.runInContext(`window.Fleet.${expression}`, context)
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
  vm.runInContext('window.Fleet.setSnapshot(fixture)', context)
  const list = elements.get('session-list').innerHTML
  assert.match(list, /data-delegation="dev-1"/)
  assert.match(list, /data-delegation="qa-1"/)
  assert.match(list, /data-delegation="dev-1"[^]*?Working[^]*?developer[^]*?sonnet-5/)
  assert.match(list, /data-delegation="qa-1"[^]*?Done[^]*?qa[^]*?haiku/)
  context.inspectorFixture={id:'dev-1',startedAt:now-45000,finishedAt:now,attempt:2,
    usage:{input_tokens:950,output_tokens:320,cache_read_input_tokens:12000},
    steps:[{id:'tool1',tool:'Bash',status:'done',ms:1000,input:{command:'<script>unsafe</script>'},result:'6 tests passed'}],report:'PASS with test evidence'}
  // The real path: select the delegation, then hand over what the session route
  // returned for it, exactly as loadChildDetail's completion does.
  vm.runInContext("window.Fleet.select('m1','dev-1');window.Fleet.setChildDetail('dev-1',inspectorFixture)",context)
  const detail=elements.get('detail-content').innerHTML
  assert.match(detail,/45s · attempt 2/)
  assert.match(detail,/950 input · 320 output · 12k cache read/)
  assert.match(detail,/Per-agent cost not reported/)
  assert.match(detail,/6 tests passed/)
  assert.match(detail,/&lt;script&gt;unsafe&lt;\/script&gt;/)
  assert.doesNotMatch(detail,/<script>unsafe/)
  context.inspectorFixture.usage=null
  context.inspectorFixture.runtimeUsage={total_tokens:1300}
  vm.runInContext("window.Fleet.setChildDetail('dev-1',inspectorFixture)",context)
  assert.match(elements.get('detail-content').innerHTML,/1k tokens reported/)

})

// The child row list caps itself at the most recent CHILD_ROW_LIMIT delegations, but
// a delegation selected before it aged out of that window must still draw as
// selected: the parent row has already given up aria-pressed to session-ancestor,
// so an unrendered selection would leave nothing in the whole list reading as chosen.
test('a delegation selected outside the visible tail still renders, and only it reads as selected', () => {
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
  // 25 delegations: the tail (CHILD_ROW_LIMIT = 20) keeps only the newest 20, so
  // the earliest 5, including the one selected below, start out of the window.
  const delegations = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, role: 'developer', model: 'claude-sonnet-5', status: 'completed' }))
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
      delegations,
    }],
  }
  context.fixture = fixture
  vm.runInContext('window.Fleet.setSnapshot(fixture); window.Fleet.select("m1", "d0")', context)
  const list = elements.get('session-list').innerHTML
  assert.match(list, /data-delegation="d0"/, 'the selected delegation must render even though it aged out of the visible tail')
  const pressedCount = (list.match(/aria-pressed="true"/g) || []).length
  assert.equal(pressedCount, 1, 'exactly one row in the whole list must read as selected')
  assert.match(list, /data-delegation="d0"[^]*?aria-pressed="true"/, 'the row reading as selected must be the one actually chosen')
  // 25 delegations, minus the pulled-forward selection (d0) and the 20-row tail
  // (d5..d24), leaves 4 (d1..d4) genuinely un-rendered: the count the "+N earlier"
  // line reports has to track that arithmetic, not just appear.
  assert.match(list, /class="session-child-more">\+4 earlier</, 'the "+N earlier" line must report exactly the delegations that are not drawn')
  // The list is oldest-first, so the cut rows are the oldest ones: the marker has to
  // sit ahead of the surviving rows, not trail the newest one.
  const moreIndex = list.indexOf('session-child-more')
  const firstRowIndex = list.indexOf('data-delegation=')
  assert.ok(moreIndex !== -1 && moreIndex < firstRowIndex, 'the "+N earlier" marker must sit at the elision point, ahead of the rows it is a stand-in for')
  // An injected role="status" is read by some screen readers and not others, and the
  // list this sits in is rewritten wholesale every poll: on the readers that do
  // announce it, it would repeat on a loop. Being a plain node already in the
  // reading order is what makes it announced once, everywhere, without looping.
  const marker = list.slice(moreIndex, list.indexOf('>', moreIndex) + 1)
  assert.ok(!/role=|aria-hidden=/.test(marker), 'the "+N earlier" marker must carry neither a role nor aria-hidden')
})

// A long-running initiative wedges its delegation rows between one session and the
// next, so the group folds. The fold must never cost the list its single selected
// row, and it must survive the poll that redraws the list two seconds later.
test('a sub-agent group folds behind a labelled header without ever hiding the selected row', () => {
  const vm = require('node:vm')
  const stored = new Map()
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
    localStorage: { getItem: k => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) },
    matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
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
        { id: 'rev-1', role: 'reviewer', model: 'claude-haiku', status: 'failed' },
      ],
    }],
  }
  context.fixture = fixture

  // Open by default: folding is something the operator asks for, never something
  // that quietly removes rows that were on screen a moment ago.
  vm.runInContext('window.Fleet.setSnapshot(fixture)', context)
  let list = elements.get('session-list').innerHTML
  assert.match(list, /data-fold-session="m1"[^>]*aria-expanded="true"/, 'the group header must render, open, for a session with delegations')
  // The header is the only summary of a folded group, so it has to carry what is in
  // there: how many, and how many of those still want attention.
  assert.match(list, /3 sub-agents · 1 working · 1 failed/)
  assert.match(list, /data-delegation="dev-1"/)

  // Folded: the header stays and names the group, the rows go.
  vm.runInContext('window.Fleet.setChildrenCollapsed("m1", true)', context)
  list = elements.get('session-list').innerHTML
  assert.match(list, /data-fold-session="m1"[^>]*aria-expanded="false"/)
  assert.match(list, /3 sub-agents · 1 working · 1 failed/, 'a folded group must still say what it is holding')
  assert.doesNotMatch(list, /data-delegation=/, 'a folded group draws none of its delegation rows')
  assert.equal((list.match(/aria-pressed="true"/g) || []).length, 1, 'exactly one row must still read as selected')

  // The fold outlives a reload: it is written through to storage, not held in memory.
  assert.deepEqual(JSON.parse(stored.get('fleet:children-collapsed')), ['m1'])

  // A selected delegation inside a folded group would leave the whole list with
  // nothing reading as chosen, so the group draws open for as long as it holds one.
  vm.runInContext('window.Fleet.select("m1", "qa-1")', context)
  list = elements.get('session-list').innerHTML
  assert.match(list, /data-delegation="qa-1"[^]*?aria-pressed="true"/, 'a folded group still holding the selection must draw open')
  assert.equal((list.match(/aria-pressed="true"/g) || []).length, 1)

  // A session with no sub-agents gets no header at all: an empty disclosure is a
  // control that promises something and then opens onto nothing.
  fixture.sessions[0].delegations = []
  vm.runInContext('window.Fleet.select("m1", null); window.Fleet.setSnapshot(fixture)', context)
  assert.doesNotMatch(elements.get('session-list').innerHTML, /data-fold-session=/)
})

// Every child row shares its data-session with the parent that owns it, so a poll
// that only touches age()/elapsed() text must not let focus drift from a selected
// child row up to the parent it happens to share an id with.
test('focus on a selected child row survives a re-render that changes the list HTML', () => {
  const vm = require('node:vm')
  const parseButtons = html => {
    const buttons = []
    const re = /<button\b([^>]*)>/g
    let match
    while ((match = re.exec(html))) {
      const attrs = match[1]
      const attr = name => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1]
      buttons.push({ closest: () => null, dataset: { session: attr('data-session'), delegation: attr('data-delegation'), filter: attr('data-filter') }, focus() { focused = this } })
    }
    return buttons
  }
  let focused = null
  let buttons = []
  const sessionList = {
    _html: '', get innerHTML() { return this._html }, set innerHTML(v) { this._html = v; buttons = parseButtons(v) },
    scrollTop: 0, contains: node => buttons.includes(node), querySelector: () => null,
    querySelectorAll: sel => sel === 'button' ? buttons : [],
  }
  const elements = new Map([['session-list', sessionList]])
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
  const documentStub = {
    getElementById, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    createElement: makeElement, body: { setAttribute() {}, removeAttribute() {} },
    documentElement: { style: { setProperty() {} } }, hidden: false, readyState: 'complete', activeElement: null,
  }
  const context = vm.createContext({
    window: {}, document: documentStub,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {}, fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8')
  new vm.Script(source, { filename: 'app.js' }).runInContext(context)

  const now = Date.now()
  const session = {
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
  }
  const fixture = () => ({ generatedAt: Date.now(), counts: { busy: 1, idle: 0, stale: 0, dead: 0 }, total: 1, archiveRule: { enabled: false, days: 14 }, sessions: [session] })
  context.fixture = fixture()
  vm.runInContext('window.Fleet.setSnapshot(fixture); window.Fleet.select("m1", "dev-1")', context)

  const devButton = buttons.find(b => b.dataset.delegation === 'dev-1')
  assert.ok(devButton, 'the delegation row must render')
  documentStub.activeElement = devButton

  // A normal poll tick: age() moves forward even though nothing about the selected
  // delegation itself changed, so the list HTML differs and update() redraws it.
  session.lastActivity = now - 2000
  context.fixture = fixture()
  vm.runInContext('window.Fleet.setSnapshot(fixture)', context)

  assert.ok(focused, 'focus must be restored to some row after the re-render')
  assert.equal(focused.dataset.delegation, 'dev-1', 'focus must stay on the child row, not jump to the parent session row that shares its data-session')
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

// Plan limits are account-wide, so the transcript that recorded the refusal is almost
// never the session the operator is looking at. The block has to travel between them.
test('a refused request in any transcript becomes the fleet-wide block, newest first', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-limit-')))
  const previous = process.env.CLAUDE_FLEET_DIR
  process.env.CLAUDE_FLEET_DIR = root
  try {
    const cwd = path.join(root, 'work')
    const project = path.join(root, 'projects', 'work')
    fs.mkdirSync(cwd)
    fs.mkdirSync(project, {recursive:true})
    fs.mkdirSync(path.join(root, 'sessions'))
    const refusal = (minutesAgo, rateLimitType) => ({
      type:'assistant', cwd, timestamp:new Date(Date.now() - minutesAgo * 60000).toISOString(),
      message:{role:'assistant',content:[{type:'text',text:'Claude AI usage limit reached'}]},
      error:'rate_limit', apiErrorStatus:429,
      quotaLimits:{status:'rejected',resetsAt:Math.round(Date.now()/1000)+1800,rateLimitType,overageDisabledReason:'org_spend_cap_reached'},
    })
    for (const [id, minutesAgo, type] of [['older',120,'five_hour'],['newer',5,'seven_day']]) {
      fs.writeFileSync(path.join(root, 'sessions', `${id}.json`), JSON.stringify({pid:process.pid,sessionId:id,cwd,status:'idle',updatedAt:Date.now()}))
      fs.writeFileSync(path.join(project, `${id}.jsonl`), [
        {type:'user',cwd,timestamp:new Date().toISOString(),message:{content:'go'}},
        refusal(minutesAgo, type),
      ].map(r=>JSON.stringify(r)).join('\n'))
    }
    delete require.cache[require.resolve('./fleet')]
    const {collect} = require('./fleet')
    const snap = collect()
    assert.equal(snap.rateLimit.rateLimitType, 'seven_day', 'the freshest refusal on the machine is the one that describes it')
    assert.equal(snap.rateLimit.reason, 'org_spend_cap_reached')
    assert.ok(snap.rateLimit.at > 0)
    // An allowed turn records no quota at all, so a transcript without one says nothing.
    fs.writeFileSync(path.join(project, 'newer.jsonl'), JSON.stringify({type:'user',cwd,timestamp:new Date().toISOString(),message:{content:'go'}}))
    fs.writeFileSync(path.join(project, 'older.jsonl'), JSON.stringify({type:'user',cwd,timestamp:new Date().toISOString(),message:{content:'go'}}))
    delete require.cache[require.resolve('./fleet')]
    assert.equal(require('./fleet').collect().rateLimit, null)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_FLEET_DIR
    else process.env.CLAUDE_FLEET_DIR = previous
    delete require.cache[require.resolve('./fleet')]
    fs.rmSync(root, {recursive:true, force:true})
  }
})

// The status bar is one line about the whole account, and the ways it can lie are all
// about absence: an unknown reading shown as zero, a stale one shown as live, a block
// shown without the time it clears.
test('the status bar reports absence honestly and swaps to the countdown when a window is nearly gone', () => {
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
  const now = Date.now()
  context.fixture = null
  const html = usage => { context.fixture = usage; return vm.runInContext(`window.Fleet.usageHtml(fixture, ${now})`, context) }
  assert.equal(html(null), '', 'no reading draws nothing rather than a zero')
  assert.equal(html({available:true, known:false, windows:[]}), '')
  assert.equal(html({available:false, known:true, windows:[{name:'five_hour',label:'5h',utilization:0,resetsAt:now}]}), '', 'an API key has no plan window to report')
  const calm = html({available:true, known:true, binding:'five_hour', windows:[{name:'five_hour',label:'5h',utilization:62,resetsAt:now+2*3600000},{name:'seven_day',label:'week',utilization:31,resetsAt:null}], stale:false, observedAt:now})
  assert.match(calm, /62%/)
  assert.match(calm, /mini-bar/, 'the binding window is the one that gets the bar')
  assert.match(calm, /week<\/b> 31%/, 'the rest stay bare numbers')
  assert.doesNotMatch(calm, /is-stale/)
  const critical = html({available:true, known:true, binding:'five_hour', windows:[{name:'five_hour',label:'5h',utilization:94,resetsAt:now+38*60000}], stale:false, observedAt:now})
  assert.match(critical, /38m left/, 'past 90% the countdown is the decision')
  assert.doesNotMatch(critical, /mini-bar/)
  const stale = html({available:true, known:true, binding:'five_hour', windows:[{name:'five_hour',label:'5h',utilization:62,resetsAt:now+3600000}], stale:true, observedAt:now-3600000})
  assert.match(stale, /is-stale/)
  assert.match(stale, /as of/, 'an idle hour must not look live')
  const blocked = html({available:true, known:true, binding:'five_hour', windows:[], stale:true, observedAt:null, blocked:{rateLimitType:'five_hour',resetsAt:now+38*60000,reason:'org_spend_cap_reached',at:now}})
  assert.match(blocked, /Rate limited/)
  assert.match(blocked, /five-hour window/)
  assert.match(blocked, /38m/)
  assert.match(blocked, /organisation spend cap reached/)
})

// A queued session's `state` stays 'idle', so the fleet counts keep working, which means
// the badge is the only thing telling the operator it is waiting rather than done. It was
// also the one status with no entry in the label map, which renders "undefined".
test('a waiting session says it is queued, and where it is in the queue', () => {
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
  const badge = session => { context.fixture = session; return vm.runInContext('window.Fleet.status(fixture)', context) }

  const queued = badge({ managed: true, managedStatus: 'queued', state: 'idle', queuePosition: 2 })
  assert.match(queued, /Queued · 2nd/, 'it says it is waiting, and how far down')
  assert.doesNotMatch(queued, /undefined/, 'every managed status needs an entry in the label map')
  assert.match(badge({ managed: true, managedStatus: 'queued', state: 'idle', queuePosition: 1 }), /Queued · 1st/)
  // Position is only known for managed rows the manager reported; absence must not
  // turn the badge into "Queued · undefinedth".
  assert.match(badge({ managed: true, managedStatus: 'queued', state: 'idle' }), /Queued<\/span>/)

  // The statuses this shares a map with must keep reading the way they always have.
  assert.match(badge({ managed: true, managedStatus: 'idle', state: 'idle' }), /Ready/)
  assert.match(badge({ managed: true, managedStatus: 'running', state: 'busy' }), /Working/)
  assert.match(badge({ managed: true, managedStatus: 'approval', state: 'idle' }), /Needs approval/)
})

// The handler test above fires what the page wires AT LOAD. This one is wired later, when
// an initiative board is first rendered, and it went unprotected: `adjustLimits` read a
// bare `controlSession`, which lives in control.js and was never published, so the button
// threw a ReferenceError and did nothing at all. Same class of bug as `tick`, one layer
// further in. So: render a board, press the button, and require it to reach its names.
test('the initiative board button can reach the names it uses', () => {
  const vm = require('node:vm')
  // A DOM small enough to read and real enough to run board() and its click handler.
  // querySelector hands back a persistent stub per selector so the code under test can
  // find what it just wrote, except '.initiative-limits', which must be absent the first
  // time or adjustLimits treats the editor as already open and returns.
  const byId = new Map()
  const makeElement = (tag = 'div') => {
    const stubs = new Map()
    let id = ''
    const element = {
      // Setting an id is what puts an element within reach of getElementById, which is
      // what lets board() see that its panel does not exist yet and create it once.
      get id() { return id }, set id(value) { id = value; byId.set(value, element) },
      tagName: tag.toUpperCase(), dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      innerHTML: '', textContent: '', value: '', placeholder: '', scrollTop: 0, open: false, disabled: false,
      listeners: {}, children: [],
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
      append(...nodes) { this.children.push(...nodes) }, before() {}, remove() {}, focus() {},
      setAttribute() {}, getAttribute: () => null, contains: () => false, closest() { return element },
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector === '.initiative-limits') return null
        if (!stubs.has(selector)) stubs.set(selector, makeElement())
        return stubs.get(selector)
      },
    }
    return element
  }
  // The chrome the board is mounted into already exists; the panel itself does not.
  for (const id of ['conversation', 'message-input', 'composer']) makeElement().id = id
  const context = vm.createContext({
    window: {},
    document: {
      getElementById: id => byId.get(id) ?? null,
      createElement: tag => makeElement(tag),
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      body: { setAttribute() {}, removeAttribute() {} }, documentElement: { style: { setProperty() {} } },
      hidden: false, readyState: 'complete',
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => s }, ResizeObserver: function () { return { observe() {}, disconnect() {} } }, navigator: {}, console,
  })
  context.window = context
  for (const file of ['app.js', 'blocks.js', 'control.js', 'teams.js', 'ask.js', 'work-queue.js']) {
    const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    try { new vm.Script(source, { filename: file }).runInContext(context) }
    catch (error) { if (error && error.name === 'SyntaxError') throw new Error(`${file} failed to load: ${error.message}`) }
  }

  // control.js has to hand the open conversation to teams.js; without it the board's
  // actions have no way to know which initiative they are for.
  assert.equal(typeof context.FleetControl.session, 'function', 'FleetControl must publish the open session')

  context.fixture = {
    id: 'i1', name: 'Bug fix', teamName: 'Bug fix', status: 'error', costUsd: 18.81, limits: null, selectedModel: 'opus',
    teamSnapshot: { manager: 'manager', roles: { manager: { model: 'opus' }, developer: { model: 'sonnet' } }, workflow: { budgetUsd: 10, maxAttempts: 3 } },
    taskBoard: { tasks: [], delegations: [] },
  }
  vm.runInContext('window.FleetTeams.board(fixture)', context)
  const panel = byId.get('initiative-board')
  assert.equal(panel.dataset.sessionId, 'i1', 'the panel records whose board it is showing')

  // The panel outlives the session in it, so the click must read the id from the panel
  // rather than from whichever session first created it.
  context.fixture = { ...context.fixture, id: 'i2', teamName: 'Second initiative' }
  vm.runInContext('window.FleetTeams.board(fixture)', context)
  assert.equal(panel.dataset.sessionId, 'i2', 'switching initiative updates it')

  const clicks = panel.listeners.click || []
  assert.ok(clicks.length, 'the board wires a click handler')
  const unresolved = []
  for (const handler of clicks) {
    try { handler({ target: { closest: () => ({ dataset: { adjustLimits: '' } }) } }) }
    catch (error) { if (error && error.name === 'ReferenceError') unresolved.push(error.message) }
  }
  assert.deepEqual(unresolved, [], 'the board action reached for a name no namespace hands it')

  context.fixture={...context.fixture,teamName:'Owner + review',teamSnapshot:require('./teams').getTeam('owner-review'),taskBoard:{tasks:[{
    id:'request',title:'Fix redirect',owner:'owner',status:'stale',attempt:2,criteria:['Keep query parameters.'],dependencies:[],reviews:{},snapshot:{commit:'1234567890abcdef',tree:'tree'},reviewErrors:1,
  }],delegations:[]}}
  vm.runInContext('window.FleetTeams.board(fixture)',context)
  assert.match(panel.innerHTML,/reviewed implementation 2/)
  assert.match(panel.innerHTML,/1234567890ab/)
  assert.match(panel.innerHTML,/Later code changes make that review stale/)
  assert.equal(byId.get('message-input').placeholder,'Message owner…')
})
