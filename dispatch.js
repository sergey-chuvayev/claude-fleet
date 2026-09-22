'use strict'
// Admission control for managed runs.
//
// Fleet has always bounded how many agents run at once, but it enforced that bound by
// REFUSING the fifth: "Four agents are already running. Stop one or wait for it to
// finish." That is the right limit and the wrong answer. It makes the operator the
// scheduler — they have to notice a run ended and resend by hand — which is exactly the
// job Fleet should be doing for them.
//
// This module holds the order instead. A turn that cannot start now waits, and the run
// that frees a slot hands it to whoever has waited longest.
//
// It owns ORDER ONLY. The waiting turn's payload stays on its session (`s.queue`), the
// same place a mid-turn message already waits, so there is one answer to "what is this
// session about to send" rather than two that can disagree.
//
// Everything here is pure and synchronous: it takes the number of runs in flight as an
// argument rather than reaching for the manager, so the ordering can be tested without
// starting an agent.

const DEFAULT_LIMIT = 4
const MIN_LIMIT = 1
// Above this the limit stops being a limit: the machine, the API and the operator's
// attention all run out well before it, and an unbounded fan-out is how you discover
// your rate limit the expensive way.
const MAX_LIMIT = 8

// Unspecified falls back to the default; a number that was specified gets clamped.
// `Number(null)` is 0, so "no limit given" would otherwise read as "a limit of zero"
// and clamp to one, quietly throttling Fleet to a single agent.
const clampLimit = value => {
  if (value === null || value === undefined || value === '') return DEFAULT_LIMIT
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n)) : DEFAULT_LIMIT
}

class Dispatcher {
  constructor({ limit = DEFAULT_LIMIT, paused = false } = {}) {
    this.limit = clampLimit(limit)
    this.paused = !!paused
    // Session ids, oldest first. Ids rather than sessions: a session can be closed
    // while it waits, and holding the object would keep a dead one alive.
    this.waiting = []
  }

  // May this session start a turn right now? False means it has been put in line, and
  // its caller should park the payload on the session rather than start it.
  // Calling twice for a session already waiting does not move it: re-sending must not
  // cost a session the place it has been holding.
  admit(id, running) {
    if (this.waiting.includes(id)) return false
    if (!this.paused && running < this.limit) return true
    this.waiting.push(id)
    return false
  }

  // Who gets the slot that just opened, or null if none should start. Lowering the
  // limit therefore stops admitting without touching what is already running: a limit
  // is a rate of entry here, never a reason to interrupt work in progress.
  next(running) {
    if (this.paused || running >= this.limit) return null
    return this.waiting.length ? this.waiting.shift() : null
  }

  // A session that was closed, stopped or failed gives up its place.
  drop(id) {
    const before = this.waiting.length
    this.waiting = this.waiting.filter(waiting => waiting !== id)
    return this.waiting.length !== before
  }

  // 1-based, for telling the operator how far down the queue they are. 0 = not waiting.
  position(id) {
    return this.waiting.indexOf(id) + 1
  }

  setLimit(value) {
    this.limit = clampLimit(value)
    return this.limit
  }

  // Pausing stops admission and lets running work finish. Stopping the work in flight
  // is what the stop button is for, and conflating the two would make pause frightening
  // to press.
  setPaused(value) {
    this.paused = !!value
    return this.paused
  }

  snapshot() {
    return { limit: this.limit, paused: this.paused, waiting: [...this.waiting] }
  }
}

module.exports = { Dispatcher, clampLimit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT }
