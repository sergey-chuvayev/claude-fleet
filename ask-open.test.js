'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')

// "Open in Fleet" on a search hit used to assign bare `selected` and `filter` inside
// ask.js's strict-mode scope, a ReferenceError. It has to go through app.js's actions.
test('Open in Fleet selects the session through the published actions', async () => {
  const listeners = {}, calls = []
  const element = id => ({ addEventListener: (type, fn) => { listeners[id + ':' + type] = fn }, scrollIntoView: () => calls.push(['scroll', id]), textContent: '', value: '', focus() {} })
  const elements = new Map()
  const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id) }
  const noop = () => {}
  const window = {
    Fleet: { $, esc: s => s, key: s => s.sessionId, age: noop, update: noop, status: noop, toast: noop, modalIsOpen: () => false, openModal: noop,
      closeModal: () => calls.push(['close']), setFilter: f => calls.push(['filter', f]), select: k => calls.push(['select', k]), snapshot: () => null },
    FleetControl: { api: noop },
  }
  const context = vm.createContext({
    window, navigator: { platform: 'MacIntel' }, matchMedia: () => ({ matches: false }), CSS: { escape: s => s }, console,
    document: { addEventListener: noop, querySelector: () => ({ scrollIntoView: () => calls.push(['scroll-row']) }) },
  })
  new vm.Script(fs.readFileSync(path.join(__dirname, 'public', 'ask.js'), 'utf8'), { filename: 'ask.js' }).runInContext(context)
  const click = listeners['ask-results:click']
  assert.equal(typeof click, 'function')
  const button = { dataset: { openSession: 'abc-123' } }
  await click({ target: { closest: () => button } })
  assert.deepEqual(calls, [['close'], ['filter', 'all'], ['select', 'abc-123'], ['scroll-row']])
})
