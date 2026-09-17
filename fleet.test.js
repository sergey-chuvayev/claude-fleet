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
  for (const file of ['app.js', 'blocks.js', 'control.js']) {
    const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    // A redeclaration is a SyntaxError raised when the script is instantiated in the
    // shared scope, before any statement runs. Runtime errors from the stub DOM are
    // expected noise here and are not what this test guards.
    try { new vm.Script(source, { filename: file }).runInContext(context) }
    catch (error) { if (error && error.name === 'SyntaxError') throw new Error(`${file} failed to load in the shared scope: ${error.message}`) }
  }
})
