'use strict'
// The list behind the launch dialog's project picker.
//
// Starting an agent used to mean typing an absolute path from memory into a bare text
// field, because a browser cannot offer a real directory picker: the File System Access
// API hands back a handle and never a path, and `webkitdirectory` yields relative names.
// The picker therefore has to be served from here.
//
// Fleet already knows where the operator works. Every Claude transcript records the cwd
// it ran in, so the directories worth suggesting are sitting in ~/.claude/projects. That
// misses a repo that has never been opened, so checkouts sitting next to the default
// directory are folded in as well.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { defaultCwd } = require('./paths.js')

// Not to be confused with Fleet's own state directory. This is the Claude directory
// Fleet reads, matching fleet.js.
const CLAUDE_DIR = process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude')
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')

const TTL_MS = 30000
// A transcript records its cwd within the first few lines, but one of those lines can be
// a large hook attachment, so the window is generous rather than line-counted.
const HEAD_BYTES = 256 * 1024
// The picker is a select, not a search field. Past this it stops being scannable, and
// the free-text path input is still there for anything that falls off the end.
const MAX_PROJECTS = 60

let cache = { at: 0, projects: null }

// The first cwd recorded in a transcript. Read from the head rather than the tail:
// the cwd is written early, and the head is the cheap end of a multi-megabyte file.
function cwdFromTranscript(file) {
  let text
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
      text = buf.toString('utf8', 0, read)
    } finally { fs.closeSync(fd) }
  } catch { return null }

  const lines = text.split('\n')
  // The window almost certainly cut the last line in half; half a line is not JSON.
  lines.pop()
  for (const line of lines) {
    if (!line || line[0] !== '{' || !line.includes('"cwd"')) continue
    try {
      const record = JSON.parse(line)
      if (typeof record.cwd === 'string' && record.cwd) return record.cwd
    } catch { continue }
  }
  return null
}

// The newest transcript in a project directory answers both questions at once: which
// directory this is, and when it was last worked in.
function newestTranscript(dir) {
  let files = []
  try { files = fs.readdirSync(dir) } catch { return null }
  let newest = null
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue
    let stat
    try { stat = fs.statSync(path.join(dir, name)) } catch { continue }
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file: path.join(dir, name), mtimeMs: stat.mtimeMs }
  }
  return newest
}

function fromTranscripts() {
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS_DIR) } catch { return [] }
  const found = []
  for (const slug of dirs) {
    // The slug is a lossy encoding of the path (every separator becomes a dash, and so
    // does every dash), so it is only ever used to find the transcript, never decoded.
    const newest = newestTranscript(path.join(PROJECTS_DIR, slug))
    if (!newest) continue
    const cwd = cwdFromTranscript(newest.file)
    if (!cwd) continue
    found.push({ path: cwd, lastUsed: newest.mtimeMs })
  }
  return found
}

// Repos the operator has never opened in Claude, so no transcript names them. One level
// down from the default directory covers the usual "all my checkouts live here" layout
// without walking the whole home directory.
function fromNeighbours(root) {
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    // .git is a directory in a checkout and a file in a worktree; both count.
    if (!fs.existsSync(path.join(full, '.git'))) continue
    found.push({ path: full, lastUsed: null })
  }
  return found
}

// claude-mem's headless indexer writes transcripts like anything else. They are not
// places the operator works, and they would sit at the top of the list by recency.
const isNoise = dir => dir.includes('observer-sessions') || dir.includes(`${path.sep}node_modules${path.sep}`)

function describe(dir) {
  const short = dir.startsWith(os.homedir()) ? dir.replace(os.homedir(), '~') : dir
  return {
    path: dir,
    // The home directory reads as its account name otherwise, which nobody thinks of
    // as the name of a project.
    name: short === '~' ? '~' : path.basename(dir) || dir,
    short,
    // Two checkouts can share a basename, so the option label needs the parent to
    // tell them apart.
    parent: path.dirname(short),
    git: fs.existsSync(path.join(dir, '.git')),
  }
}

// Newest first, because the next agent almost always starts where the last one did.
// Directories with no transcript have never been used and sort alphabetically after.
function rank(a, b) {
  if (a.lastUsed && b.lastUsed) return b.lastUsed - a.lastUsed
  if (a.lastUsed) return -1
  if (b.lastUsed) return 1
  return a.path.localeCompare(b.path)
}

function build() {
  const root = defaultCwd()
  const merged = new Map()
  for (const found of [...fromTranscripts(), ...fromNeighbours(root)]) {
    const dir = path.resolve(found.path)
    if (isNoise(dir)) continue
    // A directory that has been deleted or renamed is a dead suggestion.
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    const existing = merged.get(dir)
    // Both sources can name the same directory. Keep whichever knows it was used.
    if (!existing) merged.set(dir, found)
    else if (found.lastUsed && (!existing.lastUsed || found.lastUsed > existing.lastUsed)) merged.set(dir, found)
  }
  return [...merged.values()]
    .sort(rank)
    .slice(0, MAX_PROJECTS)
    .map(found => ({ ...describe(found.path), lastUsed: found.lastUsed ? Math.round(found.lastUsed) : null }))
}

// Cached because the dialog asks on every open, and the answer changes at the pace of
// someone starting a session, not of a page load.
function listProjects({ force = false } = {}) {
  if (!force && cache.projects && Date.now() - cache.at < TTL_MS) return cache.projects
  cache = { at: Date.now(), projects: build() }
  return cache.projects
}

module.exports = { listProjects }
