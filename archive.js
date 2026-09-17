'use strict'
// Which saved sessions the operator has put away. Archiving is a view over
// ~/.claude, never a change to it: an archived session still resumes with
// `claude --resume` and still answers an Ask. Fleet's own state, in .fleet/.
const fs = require('node:fs')
const path = require('node:path')

const DAY = 24 * 60 * 60 * 1000
const DEFAULT_RULE = { enabled: false, days: 14 }
// Two bounded maps rather than one unbounded log. Far past this, the oldest
// decisions have stopped mattering and the file should not keep growing.
const MAX_ENTRIES = 5000

const clampDays = (value, fallback) => {
  const days = Number(value)
  return Number.isFinite(days) ? Math.min(365, Math.max(1, Math.round(days))) : fallback
}
function toMap(list) {
  const map = new Map()
  if (!Array.isArray(list)) return map
  for (const entry of list) {
    if (!Array.isArray(entry)) continue
    const [id, at] = entry
    if (typeof id === 'string' && id && Number.isFinite(at)) map.set(id, at)
  }
  return map
}
// Newest wins: an archive that has outgrown its cap drops the sessions put away longest ago.
const trim = map => map.size <= MAX_ENTRIES ? map
  : new Map([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES))

class Archive {
  constructor({ directory = path.join(__dirname, '.fleet') } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = path.join(directory, 'archive.json')
    this.archived = new Map() // sessionId -> when it was put away
    this.kept = new Map() // sessionId -> when it was restored; exempt from the age rule
    this.rule = { ...DEFAULT_RULE }
    this.load()
  }
  load() {
    let data
    // A corrupt or absent archive means nothing is hidden, which is the safe failure.
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return }
    if (!data || typeof data !== 'object' || data.version !== 1) return
    this.rule = { enabled: !!(data.rule && data.rule.enabled), days: clampDays(data.rule && data.rule.days, DEFAULT_RULE.days) }
    this.archived = toMap(data.archived)
    this.kept = toMap(data.kept)
  }
  // Disk first, memory second: a failed write leaves Fleet showing what is actually stored.
  commit({ rule = this.rule, archived = this.archived, kept = this.kept }) {
    const tmp = `${this.file}.${process.pid}.tmp`
    const body = JSON.stringify({ version: 1, rule, archived: [...archived], kept: [...kept] })
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.rule = rule
    this.archived = archived
    this.kept = kept
  }
  // The age rule only ever reaches sessions whose process has exited. A session that
  // is alive, however long it has been quiet, stays in the list where it can be acted on.
  matchesRule(session, now = Date.now()) {
    if (!this.rule.enabled || session.state !== 'dead') return false
    return !!session.lastActivity && now - session.lastActivity > this.rule.days * DAY
  }
  isArchived(session, now = Date.now()) {
    const id = session && session.sessionId
    // A Fleet conversation is closed, not archived; it has its own lifecycle.
    if (!id || session.managed) return false
    if (this.archived.has(id)) return true
    if (this.kept.has(id)) return false
    return this.matchesRule(session, now)
  }
  set(ids, archived) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id && id.length <= 200))]
    if (!list.length) return 0
    if (list.length > MAX_ENTRIES) throw Object.assign(new Error('Too many sessions in one request.'), { status: 413 })
    const at = Date.now()
    const next = { archived: new Map(this.archived), kept: new Map(this.kept) }
    for (const id of list) {
      if (archived) { next.archived.set(id, at); next.kept.delete(id) }
      // Restoring has to outrank the age rule, or the next refresh puts it straight back.
      else { next.archived.delete(id); next.kept.set(id, at) }
    }
    this.commit({ archived: trim(next.archived), kept: trim(next.kept) })
    return list.length
  }
  setRule(input) {
    const rule = { enabled: !!(input && input.enabled), days: clampDays(input && input.days, this.rule.days) }
    this.commit({ rule })
    return this.rule
  }
}

module.exports = { Archive, DEFAULT_RULE, MAX_ENTRIES }
