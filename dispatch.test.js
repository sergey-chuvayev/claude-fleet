'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Dispatcher, clampLimit, DEFAULT_LIMIT, MAX_LIMIT } = require('./dispatch')

test('a turn starts while there is room and waits once there is not', () => {
  const d = new Dispatcher({ limit: 2 })
  assert.equal(d.admit('a', 0), true, 'the first turn starts')
  assert.equal(d.admit('b', 1), true, 'the second fills the limit')
  assert.equal(d.admit('c', 2), false, 'the third waits instead of being refused')
  assert.deepEqual(d.snapshot().waiting, ['c'])
  assert.equal(d.position('c'), 1)
  assert.equal(d.position('a'), 0, 'a running session is not in the queue')
})

test('the slot a finished run frees goes to whoever waited longest', () => {
  const d = new Dispatcher({ limit: 1 })
  assert.equal(d.admit('a', 0), true)
  for (const id of ['b', 'c', 'd']) assert.equal(d.admit(id, 1), false)
  assert.equal(d.next(0), 'b')
  assert.equal(d.next(1), null, 'the freed slot is taken; nobody else starts')
  assert.equal(d.next(0), 'c')
  assert.equal(d.next(0), 'd')
  assert.equal(d.next(0), null, 'an empty queue starts nobody')
})

test('re-sending does not cost a session the place it is holding', () => {
  const d = new Dispatcher({ limit: 1 })
  d.admit('a', 0)
  d.admit('b', 1)
  d.admit('c', 1)
  assert.equal(d.admit('b', 1), false, 'b is already waiting')
  assert.deepEqual(d.snapshot().waiting, ['b', 'c'], 'b keeps its place at the front')
})

test('pausing stops admission and lets running work finish', () => {
  const d = new Dispatcher({ limit: 4 })
  d.setPaused(true)
  assert.equal(d.admit('a', 0), false, 'nothing is admitted while paused, even with room')
  assert.equal(d.next(0), null, 'and nothing is handed a slot')
  d.setPaused(false)
  assert.equal(d.next(0), 'a', 'resuming releases what was held, in order')
})

test('lowering the limit stops admitting without interrupting work in flight', () => {
  const d = new Dispatcher({ limit: 4 })
  // Four are already running when the operator drops the limit to two.
  d.setLimit(2)
  assert.equal(d.admit('e', 4), false, 'no new work is admitted over the new limit')
  assert.equal(d.next(4), null, 'and the queue does not jump the reduced limit')
  assert.equal(d.next(3), null, 'still over')
  assert.equal(d.next(1), 'e', 'once the running count falls below it, the queue moves')
})

test('raising the limit releases what was waiting', () => {
  const d = new Dispatcher({ limit: 1 })
  d.admit('a', 0)
  d.admit('b', 1)
  assert.equal(d.next(1), null)
  d.setLimit(3)
  assert.equal(d.next(1), 'b', 'the extra room is handed to the queue immediately')
})

test('a session that gives up its place is skipped, and dropping is idempotent', () => {
  const d = new Dispatcher({ limit: 1 })
  d.admit('a', 0)
  d.admit('b', 1)
  d.admit('c', 1)
  assert.equal(d.drop('b'), true, 'b was waiting')
  assert.equal(d.drop('b'), false, 'dropping it again changes nothing')
  assert.equal(d.drop('a'), false, 'a was running, not waiting')
  assert.equal(d.next(0), 'c', 'the queue closes over the gap')
})

test('the limit is clamped, and nonsense falls back to the default', () => {
  assert.equal(clampLimit(0), 1, 'a limit of zero would stop Fleet entirely')
  assert.equal(clampLimit(-3), 1)
  assert.equal(clampLimit(99), MAX_LIMIT)
  assert.equal(clampLimit(2.9), 2, 'truncated, not rounded up past the limit')
  for (const bad of [undefined, null, 'lots', NaN, {}]) assert.equal(clampLimit(bad), DEFAULT_LIMIT, `${String(bad)} falls back`)
  assert.equal(new Dispatcher({ limit: 99 }).limit, MAX_LIMIT, 'the constructor clamps too')
})

test('the default limit matches the bound Fleet has always enforced', () => {
  // The refusal this replaces named four. Changing that number is a product decision,
  // not a side effect of adding a queue, so it is asserted rather than assumed.
  assert.equal(DEFAULT_LIMIT, 4)
  const d = new Dispatcher()
  assert.equal(d.admit('a', 3), true, 'the fourth still starts')
  assert.equal(d.admit('b', 4), false, 'the fifth waits where it used to be refused')
})
