'use strict'
// Data layer: reads Claude Code's on-disk session state. Read-only, no writes anywhere.
const fs = require('fs')
const path = require('path')
const os = require('os')

const CLAUDE_DIR = process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude')
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions')
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')
const SOCKS_DIR = '/tmp/cc-socks'

const STALE_MS = 3 * 24 * 60 * 60 * 1000
const MAX_TAIL_BYTES = 6 * 1024 * 1024

// --- caches -----------------------------------------------------------------
const transcriptCache = new Map() // path -> { key, data }
const branchCache = new Map() // cwd -> { at, branch }
let indexCache = { at: 0, map: new Map() } // sessionId -> jsonl path

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Map sessionId -> transcript file. Rebuilt every 10s; new sessions appear fast enough.
function transcriptIndex() {
  if (Date.now() - indexCache.at < 10000) return indexCache.map
  const map = new Map()
  let dirs = []
  try {
    dirs = fs.readdirSync(PROJECTS_DIR)
  } catch {
    dirs = []
  }
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir)
    let files = []
    try {
      files = fs.readdirSync(full)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      map.set(f.slice(0, -6), path.join(full, f))
    }
  }
  indexCache = { at: Date.now(), map }
  return map
}

// The one argument that says what a tool acted on, for a step's label.
function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return null
  const first = value => (typeof value === 'string' ? value.split('\n')[0].trim().slice(0, 120) : null)
  if (name === 'Bash' || name === 'BashOutput') return first(input.description) || first(input.command)
  if (name === 'Task') return first(input.description)
  if (name === 'WebSearch') return first(input.query)
  if (name === 'WebFetch') return first(input.url)
  if (name === 'Grep' || name === 'Glob') return first(input.pattern)
  if (name === 'Skill') return first(input.skill)
  const filePath = input.file_path || input.path || input.notebook_path
  return typeof filePath === 'string' ? filePath.split('/').slice(-2).join('/').slice(0, 120) : null
}

// Which family of work a tool represents. The steps bar colours by this, and a
// developer reads "mostly inspecting" vs "changing files" vs "running things".
function toolCategory(name) {
  if (['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'].includes(name)) return 'inspect'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'change'
  if (['Bash', 'BashOutput', 'KillShell'].includes(name)) return 'run'
  if (['Task', 'Skill', 'Agent'].includes(name)) return 'delegate'
  if (['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'].includes(name)) return 'ask'
  return 'other'
}

// Events a transcript entry represents. One entry can yield several: an assistant
// message may hold text and multiple tool calls; a user entry may carry results.
// Successful results are dropped, a failed one is kept so it can mark its step.
function classify(d) {
  const content = d.message && d.message.content
  const out = []
  if (d.type === 'user') {
    if (typeof content === 'string') { if (content.trim()) out.push({ kind: 'user' }); return out }
    if (!Array.isArray(content)) return out
    for (const b of content) {
      if (b.type === 'tool_result' && b.is_error) out.push({ kind: 'error', id: b.tool_use_id || null })
    }
    if (!content.some(b => b.type === 'tool_result') && content.some(b => b.type === 'text' && (b.text || '').trim())) out.push({ kind: 'user' })
    return out
  }
  if (d.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'tool_use') out.push({ kind: 'tool', id: b.id || null, tool: b.name || 'Tool', target: toolTarget(b.name, b.input) })
    }
    if (!out.length && content.some(b => b.type === 'text' && (b.text || '').trim())) out.push({ kind: 'answer' })
  }
  return out
}

// The story of the latest turn: the tool steps since the last user message, each
// marked ok or failed by exact id, plus what is happening right now if anything.
const MAX_STEPS = 40
function turnSummary(events, { working = false } = {}) {
  if (!Array.isArray(events) || !events.length) return { steps: [], turnStartedAt: null, current: null, answers: 0 }
  let lastUser = -1
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'user') { lastUser = i; break }
  const turn = events.slice(lastUser + 1)
  const steps = []
  const byId = new Map()
  let answers = 0
  for (const e of turn) {
    if (e.kind === 'tool') {
      const step = { t: e.tool, k: toolCategory(e.tool), ok: true, at: e.at, target: e.target || null }
      steps.push(step)
      if (e.id) byId.set(e.id, step)
    } else if (e.kind === 'error') {
      const step = e.id && byId.get(e.id)
      if (step) step.ok = false
      else steps.push({ t: e.tool || 'Tool', k: 'other', ok: false, at: e.at, target: null })
    } else if (e.kind === 'answer') answers++
  }
  const lastEvent = turn[turn.length - 1]
  // "Current" only while the session is working and the turn has not ended in text.
  const current = working && steps.length && lastEvent && lastEvent.kind === 'tool' ? steps[steps.length - 1] : null
  return {
    steps: steps.slice(-MAX_STEPS).map(({ t, k, ok, target }) => ({ t, k, ok, target })),
    turnStartedAt: lastUser >= 0 ? events[lastUser].at : (events[0] && events[0].at) || null,
    current: current ? { t: current.t, target: current.target, at: current.at } : null,
    last: !current && steps.length ? (({ t, target, at, ok }) => ({ t, target, at, ok }))(steps[steps.length - 1]) : null,
    answers,
  }
}

// Pull the latest state records out of a transcript. Cached on size+mtime so an
// unchanged (idle) session costs one stat() per refresh instead of a full read.
function readTranscript(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  const key = `${st.size}:${st.mtimeMs}`
  const hit = transcriptCache.get(file)
  if (hit && hit.key === key) return hit.data

  let text
  try {
    if (st.size <= MAX_TAIL_BYTES) {
      text = fs.readFileSync(file, 'utf8')
    } else {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(MAX_TAIL_BYTES)
      fs.readSync(fd, buf, 0, MAX_TAIL_BYTES, st.size - MAX_TAIL_BYTES)
      fs.closeSync(fd)
      text = buf.toString('utf8')
      text = text.slice(text.indexOf('\n') + 1) // drop the partial first line
    }
  } catch {
    return null
  }

  const data = {
    recentConversation: [],
    latestResponse: null,
    latestResponseAt: null,
    links: [],
    truncated: st.size > MAX_TAIL_BYTES,
    title: null,
    lastPrompt: null,
    permissionMode: null,
    mode: null,
    model: null,
    contextTokens: null,
    outputTokens: 0,
    messages: 0,
    userTurns: 0,
    oneM: false,
    maxContext: 0,
    firstTs: null,
    lastTs: null,
    // Recent events, classified for the row's activity strip. Stamps are kept raw
    // and bucketed against "now" at request time, so the mtime cache stays valid.
    events: [],
    cwd: null,
    gitBranch: null,
  }

  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain) continue
    // The model field always reads "claude-opus-5"; only the transcript text
    // carries the [1m] suffix that distinguishes a 1M-context session.
    if (!data.oneM && line.indexOf('[1m]') !== -1 && /claude-[a-z0-9.-]+\[1m\]/.test(line)) data.oneM = true
    if (d.cwd) data.cwd = d.cwd
    if (d.gitBranch) data.gitBranch = d.gitBranch
    if (d.timestamp) {
      if (!data.firstTs) data.firstTs = d.timestamp
      data.lastTs = d.timestamp
    }
    if (d.timestamp) {
      const at = Date.parse(d.timestamp)
      if (at) for (const event of classify(d)) {
        data.events.push({ at, ...event })
        if (data.events.length > 400) data.events.shift()
      }
    }
    // Inspect visible conversation text only, excluding tool arguments and results.
    if (d.type === 'assistant' || d.type === 'user') {
      const content = d.message && d.message.content
      const visible = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(b => b.type === 'text').map(b => b.text || '').join('\n\n') : ''
      const toolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result')
      const cleaned = visible.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (!toolResult && cleaned) {
        data.recentConversation.push({role:d.type,text:cleaned.slice(-1600)})
        if (data.recentConversation.length > 12) data.recentConversation.shift()
      }
      if (d.type === 'assistant' && visible.trim()) {
        data.latestResponse = visible.slice(-12000)
        data.latestResponseAt = d.timestamp || null
      }
      for (const match of visible.matchAll(/https:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+|linear\.app\/[A-Za-z0-9_-]+\/issue\/[A-Za-z]+-\d+(?:\/[A-Za-z0-9_-]+)?)/g)) {
        const url = match[0]
        if (!data.links.some(link => link.url === url)) {
          const pr = url.includes('github.com/')
          data.links.push({ url, kind: pr ? 'pr' : 'linear', label: pr ? 'PR #' + url.split('/').pop() : url.match(/issue\/([A-Za-z]+-\d+)/)[1] })
        }
      }
      data.links = data.links.slice(-20)
    }
    switch (d.type) {
      case 'ai-title':
        if (d.aiTitle) data.title = d.aiTitle
        break
      case 'last-prompt':
        if (d.lastPrompt) data.lastPrompt = d.lastPrompt
        break
      case 'permission-mode':
        data.permissionMode = d.permissionMode
        break
      case 'mode':
        data.mode = d.mode
        break
      case 'user':
        data.userTurns++
        data.messages++
        break
      case 'assistant': {
        data.messages++
        const m = d.message || {}
        if (m.model) data.model = m.model
        const u = m.usage
        if (u) {
          data.contextTokens =
            (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          if (data.contextTokens > data.maxContext) data.maxContext = data.contextTokens
          data.outputTokens += u.output_tokens || 0
        }
        break
      }
    }
  }

  transcriptCache.set(file, { key, data })
  return data
}

// Resolve the real branch from disk. jsonl gitBranch says "HEAD" inside worktrees.
function gitBranch(cwd) {
  if (!cwd) return null
  const hit = branchCache.get(cwd)
  if (hit && Date.now() - hit.at < 30000) return hit.branch
  let branch = null
  try {
    let gitPath = path.join(cwd, '.git')
    const st = fs.statSync(gitPath)
    if (st.isFile()) {
      const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/)
      if (m) gitPath = path.resolve(cwd, m[1].trim())
    }
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim()
    branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7)
  } catch {
    branch = null
  }
  branchCache.set(cwd, { at: Date.now(), branch })
  return branch
}

function contextLimit(model, oneM, maxSeen) {
  if (oneM) return 1000000
  if (maxSeen > 200000) return 1000000 // usage above the standard window proves the 1M variant
  return 200000
}

// A session whose entrypoint is not the CLI was started by a program rather than by
// a person: an SDK run, a plugin's worker, a background indexer. The registry records
// no parent, so ownership is resolved through the process tree instead, and left
// unattributed when the chain leads to a daemon rather than to another session.
let treeCache = { at: 0, map: new Map() }
function processTree() {
  if (Date.now() - treeCache.at < 4000) return treeCache.map
  const map = new Map()
  try {
    const out = require('node:child_process').execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 << 20 })
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (match) map.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3].split('/').pop() })
    }
  } catch {}
  treeCache = { at: Date.now(), map }
  return map
}
function attributeBackground(sessions) {
  const byPid = new Map(sessions.filter(s => s.pid).map(s => [s.pid, s]))
  const tree = processTree()
  for (const session of sessions) {
    if (!session.pid || session.entrypoint === 'cli' || session.entrypoint === null) continue
    session.background = true
    let pid = tree.get(session.pid)?.ppid, hops = 0, comm = null
    while (pid && pid > 1 && hops++ < 12) {
      const owner = byPid.get(pid)
      if (owner && owner !== session) {
        session.spawnedByPid = owner.pid
        session.spawnedByName = owner.name || owner.title || owner.shortId
        break
      }
      comm = tree.get(pid)?.comm || comm
      pid = tree.get(pid)?.ppid
    }
    // No owning session in the chain: name the program that is running it instead.
    if (!session.spawnedByPid) session.spawnedByName = session.cwdShort?.includes('.claude-mem') ? 'claude-mem' : comm || 'a background program'
  }
}

function collect() {
  let files = []
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    files = []
  }
  const index = transcriptIndex()
  const now = Date.now()
  const sessions = []

  // The registry describes running processes, not saved conversations: Claude
  // removes registrations on exit. Join it with durable transcripts so handoff
  // remains possible after exit and after Fleet itself restarts.
  const registrations = []
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))
      if (meta && typeof meta === 'object') registrations.push(meta)
    } catch {}
  }
  const registered = new Set(registrations.map(meta => meta.sessionId))
  for (const [sessionId, file] of index) {
    if (registered.has(sessionId) || file.includes('observer-sessions')) continue
    const t = readTranscript(file)
    if (!t?.cwd || !t.messages || t.cwd.includes('observer-sessions')) continue
    registrations.push({sessionId, cwd:t.cwd, startedAt:t.firstTs, status:'stopped'})
  }

  for (const meta of registrations) {
    const alive = isAlive(meta.pid)
    const file = meta.sessionId ? index.get(meta.sessionId) : null
    const t = file ? readTranscript(file) : null

    const lastActivity = Math.max(
      meta.updatedAt || 0,
      t && t.lastTs ? Date.parse(t.lastTs) : 0
    )
    const cwd = (t && t.cwd) || meta.cwd || null
    const rawStatus = meta.status || 'unknown'

    let state
    if (!alive) state = 'dead'
    else if (rawStatus === 'busy') state = 'busy'
    else if (now - lastActivity > STALE_MS) state = 'stale'
    else state = 'idle'

    const model = t && t.model
    const ctx = t && t.contextTokens

    sessions.push({
      pid: meta.pid || null,
      sessionId: meta.sessionId,
      shortId: meta.sessionId ? meta.sessionId.slice(0, 8) : null,
      name: meta.name || null,
      state,
      rawStatus,
      alive,
      kind: meta.kind || null,
      entrypoint: meta.entrypoint || null,
      version: meta.version || null,
      cwd,
      cwdShort: cwd ? cwd.replace(os.homedir(), '~') : null,
      branch: gitBranch(cwd),
      latestResponse: (t && t.latestResponse) || null,
      latestResponseAt: (t && t.latestResponseAt) || null,
      links: (t && t.links) || [],
      transcriptTruncated: !!(t && t.truncated),
      title: (t && t.title) || null,
      lastPrompt: (t && t.lastPrompt) || null,
      permissionMode: (t && t.permissionMode) || null,
      model: model ? model + (t && (t.oneM || t.maxContext > 200000) ? ' [1m]' : '') : null,
      contextTokens: ctx || null,
      contextLimit: contextLimit(model, t && t.oneM, (t && t.maxContext) || 0),
      outputTokens: t ? t.outputTokens : 0,
      messages: t ? t.messages : 0,
      userTurns: t ? t.userTurns : 0,
      startedAt: meta.startedAt || null,
      lastActivity: lastActivity || null,
      turn: turnSummary(t && t.events, { working: state === 'busy' }),
      hasSocket: fs.existsSync(path.join(SOCKS_DIR, `${meta.pid}.sock`)),
      resumeCmd: meta.sessionId ? `claude --resume ${meta.sessionId}` : null,
      transcript: file || null,
    })
  }

  attributeBackground(sessions)

  const order = { busy: 0, idle: 1, stale: 2, dead: 3 }
  sessions.sort((a, b) => {
    const d = (order[a.state] ?? 9) - (order[b.state] ?? 9)
    return d !== 0 ? d : (b.lastActivity || 0) - (a.lastActivity || 0)
  })

  const counts = { busy: 0, idle: 0, stale: 0, dead: 0 }
  for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1

  return { generatedAt: now, counts, total: sessions.length, sessions }
}

// Look up a transcript by session id without going through the process registry.
// Both caches apply, so an idle session costs one stat().
function transcriptFor(sessionId) {
  if (!sessionId) return null
  const file = transcriptIndex().get(sessionId)
  return file ? readTranscript(file) : null
}

module.exports = { collect, gitBranch, transcriptFor, turnSummary, toolTarget, toolCategory }
