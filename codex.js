'use strict'
// Codex, OpenAI's coding agent, alongside Claude. Fleet drives it the way OpenAI's own
// SDK does, by running the installed `codex exec --json` and reading its event stream,
// so Fleet adds no dependency and uses whichever Codex, login and config the operator
// already has. Two halves:
//   - reading Codex's saved sessions (~/.codex/sessions) into the session list and the
//     console, the same way Claude transcripts are read;
//   - running a turn: the Codex events are translated into the events the Claude Agent
//     SDK emits, so a Codex agent goes through Fleet's ordinary turn loop and gets the
//     same console, tool blocks, Stop, queue and live status.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { gitBranch, turnSummary, toolTarget } = require('./fleet')
const { clampInput } = require('./history')

const RECENT_DAYS = 30
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 512 * 1024
const HISTORY_BYTES = 6 * 1024 * 1024
const BUSY_MS = 3 * 60 * 1000 // an open turn written to this recently is still working
const MAX_TEXT = 24000

const home = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

// ── The installed Codex ──────────────────────────────────────────────────────────
let found
function executable() {
  if (process.env.CLAUDE_FLEET_CODEX) return process.env.CLAUDE_FLEET_CODEX === 'none' ? null : process.env.CLAUDE_FLEET_CODEX
  if (found !== undefined) return found
  found = null
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    try { fs.accessSync(candidate, fs.constants.X_OK); found = candidate; break } catch {}
  }
  return found
}
const available = () => !!executable()
// The model Codex will use when Fleet does not pick one: whatever its config says.
function defaultModel() {
  try { return /^\s*model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(home(), 'config.toml'), 'utf8'))?.[1] || 'codex' }
  catch { return 'codex' }
}

// ── Reading saved sessions ───────────────────────────────────────────────────────
function recentFiles(now = Date.now()) {
  const root = path.join(home(), 'sessions'), cutoff = now - RECENT_DAYS * 86400000, out = []
  const dirs = dir => { try { return fs.readdirSync(dir) } catch { return [] } }
  for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    // A session resumed later lives in the folder of the day it began, so the file's
    // own time decides whether it is recent, not the folder's.
    const dir = path.join(root, y, m, d)
    for (const f of dirs(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const file = path.join(dir, f)
      try { const st = fs.statSync(file); if (st.mtimeMs >= cutoff) out.push({ file, st }) } catch {}
    }
  }
  return out
}

let names = { key: null, map: new Map() }
function threadNames() {
  const file = path.join(home(), 'session_index.jsonl')
  let st
  try { st = fs.statSync(file) } catch { return names.map }
  const key = `${st.size}:${st.mtimeMs}`
  if (names.key === key) return names.map
  const map = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try { const r = JSON.parse(line); if (r.id && r.thread_name) map.set(r.id, r.thread_name) } catch {}
  }
  names = { key, map }
  return map
}

function readSlice(file, size) {
  if (size <= HEAD_BYTES + TAIL_BYTES) return [fs.readFileSync(file, 'utf8')]
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(HEAD_BYTES), tail = Buffer.alloc(TAIL_BYTES)
    fs.readSync(fd, head, 0, HEAD_BYTES, 0)
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES)
    const h = head.toString('utf8'), t = tail.toString('utf8')
    return [h.slice(0, h.lastIndexOf('\n')), t.slice(t.indexOf('\n') + 1)]
  } finally { fs.closeSync(fd) }
}

// Text a person typed, without the context Codex injects as user messages (environment,
// AGENTS.md, permissions), which all arrive wrapped in tags or headings.
// Block by block: a message can start with an attached image (recorded as <image> tags)
// and still be the operator's own words.
function typed(content) {
  const blocks = Array.isArray(content) ? content : []
  const images = blocks.filter(b => b.type === 'input_image' || b.type === 'local_image').length
  const words = blocks.filter(b => b.type === 'input_text' || b.type === 'text').map(b => String(b.text || '').trim())
    .filter(t => t && !/^<\/?image\b/.test(t) && !/^<[\w-]+[\s>]/.test(t) && !/^# AGENTS\.md/.test(t)).join('\n\n')
  if (!words && !images) return ''
  return `${words}${images ? `${words ? '\n\n' : ''}[${images} image${images === 1 ? '' : 's'}]` : ''}`
}
const said = content => (Array.isArray(content) ? content : []).filter(b => b.type === 'output_text' || b.type === 'text').map(b => b.text || '').join('\n').trim()

const cache = new Map()
function summary(file, st) {
  const key = `${st.size}:${st.mtimeMs}`, hit = cache.get(file)
  if (hit && hit.key === key) return hit.data
  const data = { id: null, cwd: null, startedAt: null, version: null, model: null, firstPrompt: null, lastPrompt: null, latestResponse: null, latestResponseAt: null, messages: 0, userTurns: 0, openTurn: false, turnStartedAt: null, contextTokens: null, contextLimit: null, lastTs: null }
  let parts
  try { parts = readSlice(file, st.size) } catch { return null }
  for (const text of parts) for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    const p = r.payload || {}, at = Date.parse(r.timestamp) || null
    if (at) data.lastTs = at
    if (r.type === 'session_meta') {
      data.id ||= p.id || p.session_id; data.cwd ||= p.cwd; data.startedAt ||= Date.parse(p.timestamp) || at; data.version ||= p.cli_version || null
      // Not the operator's own conversations: Codex's auto-review sub-agents, and Codex
      // runs Claude Code started through its Codex plugin (Claude's sub-agents, in effect).
      if (p.source?.subagent || p.thread_source === 'guardian_review' || p.originator === 'Claude Code') data.internal = true
    }
    else if (r.type === 'turn_context') { if (p.cwd) data.cwd = p.cwd; if (p.model) data.model = p.model }
    else if (r.type === 'response_item' && p.type === 'message') {
      if (p.role === 'user') { const t = typed(p.content); if (t) { data.firstPrompt ||= t; data.lastPrompt = t; data.messages++; data.userTurns++ } }
      else if (p.role === 'assistant') { const t = said(p.content); if (t) { data.latestResponse = t.slice(-12000); data.latestResponseAt = r.timestamp; data.messages++ } }
    } else if (r.type === 'event_msg') {
      if (p.type === 'task_started') { data.openTurn = true; data.turnStartedAt = at; if (p.model_context_window) data.contextLimit = p.model_context_window }
      else if (p.type === 'task_complete') { data.openTurn = false; if (p.last_agent_message) { data.latestResponse = String(p.last_agent_message).slice(-12000); data.latestResponseAt = r.timestamp } }
      else if (p.type === 'token_count' && p.info?.last_token_usage) data.contextTokens = p.info.last_token_usage.input_tokens || data.contextTokens
    }
  }
  if (!data.id) data.id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] || null
  cache.set(file, { key, data })
  return data
}

// Session rows in the shape fleet.js gives Claude sessions, marked engine: 'codex'.
function sessions(now = Date.now()) {
  const titles = threadNames(), out = []
  for (const { file, st } of recentFiles(now)) {
    const s = summary(file, st)
    if (!s?.id || !s.cwd || !s.messages || s.internal) continue
    const lastActivity = Math.max(st.mtimeMs, s.lastTs || 0)
    const busy = s.openTurn && now - st.mtimeMs < BUSY_MS
    out.push({
      engine: 'codex', pid: null, sessionId: s.id, shortId: s.id.slice(0, 8), name: null,
      state: busy ? 'busy' : 'dead', rawStatus: busy ? 'busy' : 'saved', alive: busy, kind: null, entrypoint: 'codex', version: s.version,
      cwd: s.cwd, cwdShort: s.cwd.replace(os.homedir(), '~'), branch: gitBranch(s.cwd),
      latestResponse: s.latestResponse, latestResponseAt: s.latestResponseAt, links: [], transcriptTruncated: st.size > HEAD_BYTES + TAIL_BYTES,
      title: titles.get(s.id) || (s.firstPrompt ? s.firstPrompt.split('\n')[0].slice(0, 80) : null), lastPrompt: s.lastPrompt, permissionMode: null,
      model: s.model, contextTokens: s.contextTokens, contextLimit: s.contextLimit, outputTokens: 0, messages: s.messages, userTurns: s.userTurns,
      startedAt: s.startedAt, lastActivity, turn: { ...turnSummary([], { working: busy }), turnStartedAt: busy ? s.turnStartedAt : null },
      hasSocket: false, resumeCmd: `codex resume ${s.id}`, transcript: file,
    })
  }
  return out
}
const fileFor = sessionId => sessions().find(s => s.sessionId === sessionId)?.transcript || null

// ── A saved session as console entries ───────────────────────────────────────────
function unwrapShell(command) {
  const m = /^\/bin\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(String(command || ''))
  return m ? m[2].replace(m[1] === '"' ? /\\(["\\$`])/g : /'\\''/g, m[1] === '"' ? '$1' : "'") : String(command || '')
}
// Codex's tools, as the console names them.
function toolOf(name, input) {
  if (name === 'exec' || name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    let command = ''
    if (typeof input === 'string') command = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1]?.replace(/\\"/g, '"') || input
    else if (Array.isArray(input?.command)) {
      // ["bash", "-lc", "npm test"]: the command is the script, not the shell around it.
      const c = input.command
      command = c.length === 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && /^-l?c$/.test(c[1]) ? c[2] : c.join(' ')
    } else command = input?.cmd || input?.command || ''
    return { tool: 'Bash', input: { command: unwrapShell(command) } }
  }
  if (name === 'apply_patch') {
    const files = [...String(typeof input === 'string' ? input : input?.input || '').matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map(m => m[1].trim())
    return { tool: 'Edit', input: { file_path: files.join(', ') } }
  }
  return { tool: name || 'Tool', input: typeof input === 'string' ? { input } : input || {} }
}
function history(file, { alive = false, limit = 200 } = {}) {
  const st = fs.statSync(file)
  let text
  if (st.size <= HISTORY_BYTES) text = fs.readFileSync(file, 'utf8')
  else { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(HISTORY_BYTES); fs.readSync(fd, b, 0, HISTORY_BYTES, st.size - HISTORY_BYTES); fs.closeSync(fd); text = b.toString('utf8'); text = text.slice(text.indexOf('\n') + 1) }
  const messages = [], tools = new Map()
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.type !== 'response_item') continue
    const p = r.payload || {}, at = Date.parse(r.timestamp) || 0
    if (p.type === 'message') {
      const t = p.role === 'user' ? typed(p.content) : p.role === 'assistant' ? said(p.content) : ''
      if (t) messages.push({ id: p.id || `m${messages.length}`, role: p.role, text: t.slice(0, MAX_TEXT), at })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let args = p.input ?? p.arguments ?? p.action
      if (typeof args === 'string' && p.type === 'function_call') { try { args = JSON.parse(args) } catch {} }
      const { tool, input } = toolOf(p.name || (p.type === 'local_shell_call' ? 'local_shell' : ''), args)
      const entry = { id: p.call_id || p.id || `t${messages.length}`, role: 'tool', tool, at, status: 'running', input: clampInput(input), target: toolTarget(tool, input), text: '', result: null, ms: null, approval: 'auto' }
      tools.set(entry.id, entry); messages.push(entry)
    } else if (/_call_output$/.test(p.type || '')) {
      const entry = tools.get(p.call_id)
      if (!entry) continue
      const out = Array.isArray(p.output) ? p.output.map(b => b.text || '').join('\n') : typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      entry.status = /exit code:? [1-9]/i.test(out.slice(0, 200)) ? 'error' : 'done'
      entry.ms = at && entry.at ? Math.max(0, at - entry.at) : null
      entry.result = out.slice(0, 6000)
    }
  }
  if (!alive) for (const t of tools.values()) if (t.status === 'running') t.status = 'interrupted'
  return { messages: messages.slice(-limit), truncated: st.size > HISTORY_BYTES || messages.length > limit }
}

// ── Running a turn ───────────────────────────────────────────────────────────────
// Codex has no per-command approval in this mode, so Fleet's approval setting picks its
// sandbox instead: Ask reads only; Auto writes inside the project with no network;
// Approve everything adds network access. Nothing ever writes outside the project.
function sandboxArgs(mode) {
  if (mode === 'ask') return ['-s', 'read-only']
  if (mode === 'all') return ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']
  return ['-s', 'workspace-write']
}
const describeSandbox = mode => mode === 'ask' ? 'Codex reads the project but changes nothing.' : mode === 'all' ? 'Codex edits inside the project and can use the network. It does not ask before each command.' : 'Codex edits inside the project, without network access. It does not ask before each command.'

function toolUse(item) {
  if (item.type === 'command_execution') return { name: 'Bash', input: { command: unwrapShell(item.command) } }
  if (item.type === 'file_change') return { name: 'Edit', input: { file_path: (item.changes || []).map(c => c.path).join(', ') } }
  if (item.type === 'mcp_tool_call') return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments && typeof item.arguments === 'object' ? item.arguments : { arguments: item.arguments } }
  if (item.type === 'web_search') return { name: 'WebSearch', input: { query: item.query } }
  if (item.type === 'todo_list') return { name: 'TodoWrite', input: { todos: (item.items || []).map(t => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) } }
  return null
}
function toolResult(item) {
  if (item.type === 'command_execution') return { content: item.aggregated_output || '', is_error: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0) }
  if (item.type === 'file_change') return { content: (item.changes || []).map(c => `${c.kind} ${c.path}`).join('\n'), is_error: item.status === 'failed' }
  if (item.type === 'mcp_tool_call') return { content: item.error?.message || (item.result?.content || []).map(b => b.text || '').join('\n'), is_error: item.status === 'failed' || !!item.error }
  return { content: '', is_error: false }
}

// Codex events as Claude Agent SDK events, for Fleet's turn loop.
function translate(event, state) {
  const out = []
  const assistantSays = text => out.push({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  const start = item => { const use = toolUse(item); if (!use || state.started.has(item.id)) return; state.started.add(item.id); out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: use.name, input: use.input }] }, parent_tool_use_id: null }) }
  if (event.type === 'thread.started') out.push({ type: 'system', subtype: 'init', session_id: event.thread_id, model: state.model, parent_tool_use_id: null })
  else if (event.type === 'item.started' && event.item?.type !== 'todo_list') start(event.item)
  else if (event.type === 'item.completed') {
    const item = event.item || {}
    if (item.type === 'agent_message') { if (item.text?.trim()) { assistantSays(item.text); state.last = item.text } }
    else if (item.type === 'error') assistantSays(`Codex: ${item.message}`)
    else if (toolUse(item)) { start(item); const r = toolResult(item); out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: r.content, is_error: r.is_error }] }, parent_tool_use_id: null }) }
  } else if (event.type === 'turn.completed') {
    const u = event.usage || {}
    state.result = true
    out.push({ type: 'result', result: '', is_error: false, total_cost_usd: 0, modelUsage: { [state.model]: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cacheReadInputTokens: u.cached_input_tokens || 0, cacheCreationInputTokens: u.cache_write_input_tokens || 0 } }, parent_tool_use_id: null })
  } else if (event.type === 'turn.failed') { state.result = true; out.push({ type: 'result', is_error: true, errors: [event.error?.message || 'Codex could not finish this turn.'], parent_tool_use_id: null }) }
  else if (event.type === 'error') state.error = event.message
  return out
}

// One turn: `codex exec --json` (or `codex exec resume <thread>`), the prompt on stdin.
// Returns what Fleet's turn loop expects of a query: an async iterable of events, and
// close(), which ends the Codex process.
function query({ prompt, cwd, threadId = null, approvalMode = 'auto', model = '', images = [], signal, onStderr = () => {} }) {
  const bin = executable()
  if (!bin) throw new Error('Codex is not installed on this machine. Install it with npm install -g @openai/codex, then sign in with codex login.')
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...sandboxArgs(approvalMode), '-c', 'approval_policy="never"', ...(model ? ['-m', model] : []), ...images.flatMap(file => ['-i', file])]
  if (threadId) args.push('resume', threadId)
  args.push('-')
  const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const state = { model: model || defaultModel(), started: new Set(), result: false, last: '', error: null }
  const queue = [], waiters = []
  let ended = false, stderr = ''
  const push = event => { const w = waiters.shift(); if (w) w({ value: event, done: false }); else queue.push(event) }
  const finish = () => { ended = true; for (const w of waiters.splice(0)) w({ value: undefined, done: true }) }
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    for (const e of translate(event, state)) push(e)
  })
  // Codex logs its own MCP connection trouble to stderr; keep only what explains a failure.
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); onStderr(chunk.toString()) })
  child.on('error', error => { if (!state.result) push({ type: 'result', is_error: true, errors: [`Could not start Codex: ${error.message}`], parent_tool_use_id: null }); finish() })
  child.on('close', code => {
    if (!state.result && !signal?.aborted) {
      const reason = state.error || stderr.split('\n').filter(l => l.trim() && !/rmcp::|mcp_client|\bWARN\b/.test(l)).slice(-3).join('\n').replace(/\x1b\[[0-9;]*m/g, '') || `Codex exited with code ${code} before finishing the turn.`
      push({ type: 'result', is_error: true, errors: [reason.slice(0, 2000)], parent_tool_use_id: null })
    }
    finish()
  })
  const close = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM') }
  signal?.addEventListener('abort', close, { once: true })
  child.stdin.end(prompt)
  return {
    close,
    [Symbol.asyncIterator]() {
      return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => waiters.push(resolve)), return: () => { close(); return Promise.resolve({ value: undefined, done: true }) } }
    },
  }
}

module.exports = { available, executable, defaultModel, sessions, fileFor, history, query, translate, sandboxArgs, describeSandbox, unwrapShell, typed }
