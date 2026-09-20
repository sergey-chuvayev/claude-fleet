'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// FleetTeams.board() drives real querySelector/innerHTML traffic (it reads which
// <details data-evidence> were open before it overwrites the panel, then bakes that
// back into the fresh markup). The stub DOM the other browser-script tests use always
// returns [] from querySelectorAll, which would make that mechanism a no-op and hide
// exactly the regression this file exists to catch. So this is a small real DOM:
// enough of a tree, enough of a selector engine, and nothing board() doesn't use.
function makeDom() {
  const byId = new Map()
  const kebab = k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())
  const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]))
  const VOID = new Set(['br', 'img', 'input', 'hr'])

  function parseAttrs(text) {
    const attrs = Object.create(null)
    const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
    let m
    while ((m = re.exec(text))) attrs[m[1].toLowerCase()] = m[2] !== undefined ? decode(m[2]) : m[3] !== undefined ? decode(m[3]) : ''
    return attrs
  }
  function tokenize(html) {
    const tokens = []
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^<>]*)?)\s*\/?>|([^<]+)/g
    let m
    while ((m = re.exec(html))) {
      if (m[1]) tokens.push({ type: 'close', tag: m[1].toLowerCase() })
      else if (m[2]) tokens.push({ type: 'open', tag: m[2].toLowerCase(), attrText: m[3] || '' })
      else if (m[4] !== undefined && m[4].trim()) tokens.push({ type: 'text', text: m[4] })
    }
    return tokens
  }
  // The selector grammar is deliberately narrow: tag, .class, [attr]/[attr="value"],
  // and a single '>' child combinator. That is the entire vocabulary board() queries with.
  function parseSegment(part) {
    const seg = { tag: null, classes: [], attrs: [] }
    const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g
    let m
    while ((m = re.exec(part))) {
      if (m[1]) seg.tag = m[1].toLowerCase()
      else if (m[2]) seg.classes.push(m[2])
      else if (m[3]) seg.attrs.push([m[3], m[4] === undefined ? null : m[4]])
    }
    return seg
  }
  function matchesSegment(el, seg) {
    if (!el || el.tagName === '#text') return false
    if (seg.tag && el.tagName !== seg.tag) return false
    const classes = (el.attrs.class || '').split(/\s+/)
    if (seg.classes.some(c => !classes.includes(c))) return false
    for (const [name, value] of seg.attrs) {
      if (!(name in el.attrs)) return false
      if (value !== null && el.attrs[name] !== value) return false
    }
    return true
  }
  function matches(el, selector) {
    const parts = selector.split('>').map(s => s.trim())
    const segs = parts.map(parseSegment)
    let node = el
    for (let i = segs.length - 1; i >= 0; i--) {
      if (!node || !matchesSegment(node, segs[i])) return false
      node = node.parent
    }
    return true
  }
  function descendants(el) {
    const out = []
    for (const child of el.children) {
      if (child.tagName === '#text') continue
      out.push(child)
      out.push(...descendants(child))
    }
    return out
  }

  class Elem {
    constructor(tag) {
      this.tagName = String(tag || '').toLowerCase()
      this.attrs = Object.create(null)
      this.children = []
      this.parent = null
      this._scrollTop = 0
      const self = this
      this.dataset = new Proxy({}, {
        get: (_, key) => typeof key === 'string' ? self.attrs['data-' + kebab(key)] : undefined,
        set: (_, key, value) => { self.attrs['data-' + kebab(key)] = String(value); return true },
      })
    }
    get id() { return this.attrs.id || '' }
    set id(v) { this.attrs.id = v; byId.set(v, this) }
    get open() { return 'open' in this.attrs }
    set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open }
    get scrollTop() { return this._scrollTop }
    set scrollTop(v) { this._scrollTop = v }
    get textContent() { return this.children.map(c => c.tagName === '#text' ? c.text : c.textContent).join('') }
    get innerHTML() { return this._html || '' }
    set innerHTML(html) {
      this._html = html
      const root = { tagName: '#root', children: [] }
      const stack = [root]
      for (const t of tokenize(html)) {
        const top = stack[stack.length - 1]
        if (t.type === 'text') top.children.push({ tagName: '#text', text: decode(t.text), parent: top === root ? this : top })
        else if (t.type === 'open') {
          const el = new Elem(t.tag)
          Object.assign(el.attrs, parseAttrs(t.attrText))
          el.parent = top === root ? this : top
          top.children.push(el)
          if (!VOID.has(t.tag)) stack.push(el)
        } else {
          for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === t.tag) { stack.length = i; break }
        }
      }
      this.children = root.children
    }
    querySelectorAll(sel) { return descendants(this).filter(el => matches(el, sel)) }
    querySelector(sel) { return descendants(this).find(el => matches(el, sel)) || null }
    closest(sel) { let el = this; while (el) { if (matches(el, sel)) return el; el = el.parent } return null }
    addEventListener() {} removeEventListener() {}
    before() {}
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) }
    setAttribute(name, value) { this.attrs[name] = String(value) }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
    focus() { dom.activeElement = this }
    blur() { if (dom.activeElement === this) dom.activeElement = null }
  }

  const dom = {
    activeElement: null,
    getElementById: id => byId.get(id) || null,
    createElement: tag => new Elem(tag),
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
  }
  return { document: dom }
}

// Loads the real browser scripts FleetTeams.board() depends on (esc from app.js,
// isWorking from control.js) into one shared scope, the same wiring the dashboard
// page gives them. Only teams.js must load clean; the others may throw once their
// own DOM-touching top-level code hits our stub, same tolerance update.test.js's
// loadDashboard() applies for the same reason.
function loadTeams() {
  const { document } = makeDom()
  const context = vm.createContext({
    document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {},
    fetch: () => new Promise(() => {}), EventSource: function () { return { addEventListener() {}, close() {} } },
    crypto: { randomUUID: () => 'x' }, CSS: { escape: s => String(s) },
    ResizeObserver: function () { return { observe() {}, disconnect() {} } },
    navigator: {}, location: { reload() {} }, console,
  })
  context.window = context
  for (const file of ['app.js', 'control.js', 'teams.js']) {
    const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    try { new vm.Script(source, { filename: file }).runInContext(context) }
    catch (error) { if (error && error.name === 'SyntaxError') throw error }
  }
  const conversation = document.createElement('div'); conversation.id = 'conversation'
  const composer = document.createElement('input'); composer.id = 'message-input'
  return { FleetTeams: context.window.FleetTeams, document }
}

function baseSession(overrides = {}) {
  return {
    id: 's1', teamName: 'Delivery', status: 'running', costUsd: 1, selectedModel: null,
    limits: null,
    teamSnapshot: {
      manager: 'manager',
      roles: { manager: { model: 'sonnet' }, developer: { model: 'sonnet' } },
      workflow: { budgetUsd: 10, maxAttempts: 3, reviewers: [] },
    },
    taskBoard: { tasks: [], delegations: [] },
    ...overrides,
  }
}

test('a handoff shows the model the delegation actually reported, falling back to the role\'s configured model', () => {
  const { FleetTeams, document } = loadTeams()
  const s = baseSession({
    taskBoard: {
      tasks: [
        { id: 't1', title: 'Reported', status: 'working', attempt: 1, owner: 'developer', criteria: ['Ship it'], dependencies: [] },
        { id: 't2', title: 'Not reported yet', status: 'working', attempt: 1, owner: 'developer', criteria: ['Ship it'], dependencies: [] },
      ],
      delegations: [
        { id: 'd1', taskId: 't1', role: 'developer', status: 'done', prompt: 'Go', report: 'Done', model: 'claude-opus-4-1-20250805' },
        { id: 'd2', taskId: 't2', role: 'developer', status: 'running', prompt: 'Go', report: null, model: null },
      ],
    },
  })
  FleetTeams.board(s)
  const panel = document.getElementById('initiative-board')
  const reported = panel.querySelector('[data-evidence="d1"]')
  const unreported = panel.querySelector('[data-evidence="d2"]')
  assert.equal(reported.querySelector('small').textContent, 'claude-opus-4-1-20250805', 'the model the delegation actually reported must win')
  assert.equal(unreported.querySelector('small').textContent, 'sonnet', 'with no reported model yet, the role\'s configured model is the fallback')
  // The roster is a separate fact: it always shows what the role is configured with,
  // never the in-flight delegation's actual model, and the manager reflects selectedModel.
  const roster = panel.querySelector('.initiative-roster')
  const roleRows = roster.querySelectorAll('.initiative-role')
  const developerRow = roleRows.find(r => r.textContent.includes('developer'))
  assert.equal(developerRow.querySelector('small').textContent.startsWith('sonnet'), true, 'the roster must show the configured model, not the in-flight actual model')
})

test('the manager roster row reflects selectedModel over the configured model', () => {
  const { FleetTeams, document } = loadTeams()
  const s = baseSession({ selectedModel: 'opus' })
  FleetTeams.board(s)
  const panel = document.getElementById('initiative-board')
  const managerRow = panel.querySelectorAll('.initiative-role').find(r => r.textContent.includes('manager'))
  assert.equal(managerRow.querySelector('small').textContent.startsWith('opus'), true)
})

test('open/closed state of the Assignment and Report disclosures, and the scroll position, survive a board re-render', () => {
  const { FleetTeams, document } = loadTeams()
  const s = baseSession({
    taskBoard: {
      tasks: [{ id: 't1', title: 'Task one', status: 'working', attempt: 1, owner: 'developer', criteria: ['Ship it'], dependencies: [] }],
      delegations: [{ id: 'd1', taskId: 't1', role: 'developer', status: 'running', prompt: 'Go build it', report: null, model: null }],
    },
  })
  FleetTeams.board(s)
  let panel = document.getElementById('initiative-board')
  // Both disclosures start collapsed: a wall of prompt/report text is exactly what
  // this feature removes from the default view.
  assert.equal(panel.querySelector('.handoff-mandate').open, false)
  assert.equal(panel.querySelector('.handoff-report').open, false)

  // The operator opens the Assignment (but not the Report), and scrolls.
  panel.querySelector('.handoff-mandate').open = true
  panel.querySelector('.initiative-body').scrollTop = 77

  // Something in the board changes (new activity), forcing a re-render.
  s.taskBoard.delegations[0].activity = 'Bash'
  FleetTeams.board(s)
  panel = document.getElementById('initiative-board')

  assert.equal(panel.querySelector('.handoff-mandate').open, true, 'an opened Assignment must stay open across a re-render')
  assert.equal(panel.querySelector('.handoff-report').open, false, 'an untouched Report must stay collapsed')
  assert.equal(panel.querySelector('.initiative-body').scrollTop, 77, 'scroll position must survive the re-render')

  // Calling board() again with nothing changed must be a no-op (fleetSignature short-circuit):
  // if it were not, a fresh innerHTML would reset scrollTop to 0 the way a naive re-render does.
  panel.querySelector('.initiative-body').scrollTop = 5
  FleetTeams.board(s)
  assert.equal(panel.querySelector('.initiative-body').scrollTop, 5, 'an unchanged signature must not touch the DOM at all')
})
