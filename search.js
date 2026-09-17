'use strict'
// "Did we discuss that?" across every Claude Code transcript on this machine.
//
// Two stages. First a local lexical pass (BM25 over the visible conversation text
// of each session, nothing leaves the machine) narrows hundreds of transcripts to
// a handful of candidate sessions with the passages that matched. Then one short,
// tool-less Claude call reads those excerpts and answers the question in words,
// saying which sessions are actually about it and what was discussed there.
//
// Reading is read-only and cached per file on size+mtime, like fleet.js. The AI
// call runs with persistSession:false so a search never becomes a transcript
// that the next search would then find.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')

const CLAUDE_DIR = process.env.CLAUDE_FLEET_DIR || path.join(os.homedir(), '.claude')
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')
const WINDOW_DAYS = Number(process.env.CLAUDE_FLEET_SEARCH_DAYS) || 60
const MAX_PASSAGE_CHARS = 4000 // indexed text per message; longer answers are cut, not dropped
const MAX_HITS = 12 // sessions returned
const MAX_SNIPPETS = 3 // passages per session
const SNIPPET_CHARS = 360
const AI_SESSIONS = 10 // sessions the model reads
const AI_SNIPPET_CHARS = 700
const MAX_JOBS = 20

// --- tokenising ----------------------------------------------------------------
// Question framing ("did we ever discuss…") carries no signal about the topic, so
// those words join the usual stopwords. Kept deliberately small: a rare word that
// happens to be common English ("call", "flow") is exactly what a search is for.
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
  'me my no not of on or our she so some than that the their them then there these they this to too us was we were what when where which who ' +
  'will with would you your yours yourself ' +
  'about after again also already any anything anywhere before between ever everything just like maybe more most much need only other over ' +
  'own really same still such thing things up very well while why ' +
  'discuss discussed discussing discussion talk talked talking mention mentioned mentioning say said remember recall session sessions ' +
  'conversation conversations chat ask asked question topic time earlier previously ago').split(/\s+/))

function stem(word) {
  if (word.length <= 4) return word
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.endsWith('sses')) return word.slice(0, -2)
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2)
  if (word.endsWith('es') && word.length > 5) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}
// Identifiers are indexed whole and by part, so "call_flow_engine" matches a
// question about the "call flow engine" and a question quoting the identifier.
function tokenize(text) {
  const out = []
  for (const raw of String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) || []) {
    const parts = raw.split(/[_.-]+/).filter(Boolean)
    if (parts.length > 1 && raw.length <= 60) out.push(raw)
    for (const part of parts) {
      if (STOP.has(part) || part.length < 2) continue
      out.push(stem(part))
    }
  }
  return out
}

// --- reading transcripts ---------------------------------------------------------
const fileCache = new Map() // path -> { key, doc }

function visibleText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n')
}
// Hook output and injected reminders ride inside user messages; they are context
// the operator never wrote, and full of memory indexes that would match anything.
function stripInjected(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, ' ')
    .trim()
}

function indexFile(file) {
  let st
  try { st = fs.statSync(file) } catch { return null }
  const key = `${st.size}:${st.mtimeMs}`
  const hit = fileCache.get(file)
  if (hit && hit.key === key) return hit.doc
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }

  const doc = { file, sessionId: path.basename(file, '.jsonl'), cwd: null, title: null, firstAt: null, lastAt: null, passages: [], postings: new Map(), totalLen: 0 }
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    // Tool results are user-typed lines too, and they are the bulk of a transcript.
    // They always carry tool_use_id, a token no typed message contains.
    const isUser = line.includes('"type":"user"')
    const isAssistant = !isUser && line.includes('"type":"assistant"')
    const isTitle = !isUser && !isAssistant && line.includes('"type":"ai-title"')
    if (!isUser && !isAssistant && !isTitle) continue
    if (isUser && line.includes('"tool_use_id"')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'ai-title') { if (d.aiTitle) doc.title = d.aiTitle; continue }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    if (d.isSidechain) continue // sub-agent chatter, not the operator's conversation
    if (d.cwd && !doc.cwd) doc.cwd = d.cwd
    const at = d.timestamp ? Date.parse(d.timestamp) || null : null
    if (at) { if (!doc.firstAt) doc.firstAt = at; doc.lastAt = at }
    let body = visibleText(d.message && d.message.content)
    if (d.type === 'user') body = stripInjected(body)
    body = body.trim()
    if (!body) continue
    if (body.length > MAX_PASSAGE_CHARS) body = body.slice(0, MAX_PASSAGE_CHARS)
    const tokens = tokenize(body)
    if (!tokens.length) continue
    const index = doc.passages.length
    doc.passages.push({ role: d.type, text: body, at, len: tokens.length })
    doc.totalLen += tokens.length
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    for (const [term, count] of tf) {
      let list = doc.postings.get(term)
      if (!list) doc.postings.set(term, list = [])
      list.push([index, count])
    }
  }
  fileCache.set(file, { key, doc })
  return doc
}

// The claude-mem plugin's indexer runs headless Claude sessions that summarise
// every OTHER session as XML observations. They are transcripts, but not
// conversations the operator had, and they mention everything, so they would
// crowd out the real answer on every question.
const isObserver = (dir, cwd) => /claude-mem/.test(dir) || /\/\.claude-mem\//.test(cwd || '')

function transcriptFiles(sinceMs) {
  const files = []
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS_DIR) } catch { return files }
  for (const dir of dirs) {
    if (isObserver(dir)) continue
    const full = path.join(PROJECTS_DIR, dir)
    let names = []
    try { names = fs.readdirSync(full) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(full, name)
      try { if (fs.statSync(file).mtimeMs >= sinceMs) files.push(file) } catch {}
    }
  }
  return files
}

// Every indexed transcript in the window. Unchanged files cost one stat().
function corpus({ days = WINDOW_DAYS } = {}) {
  const since = Date.now() - days * 86400000
  const docs = []
  for (const file of transcriptFiles(since)) {
    const doc = indexFile(file)
    if (doc && doc.passages.length && !isObserver('', doc.cwd)) docs.push(doc)
  }
  // Forget files that fell out of the window or were deleted.
  const live = new Set(docs.map(d => d.file))
  for (const file of fileCache.keys()) if (!live.has(file)) fileCache.delete(file)
  return docs
}

// Index in the background a few files at a time so the first search is quick
// without stalling the dashboard's own requests while the server starts.
async function warm({ days = WINDOW_DAYS, batch = 8 } = {}) {
  const since = Date.now() - days * 86400000
  const files = transcriptFiles(since)
  for (let i = 0; i < files.length; i += batch) {
    for (const file of files.slice(i, i + batch)) indexFile(file)
    await new Promise(resolve => setImmediate(resolve))
  }
  return files.length
}

// --- ranking ----------------------------------------------------------------------
const K1 = 1.2, B = 0.75

function snippet(text, terms) {
  const lower = text.toLowerCase()
  let start = -1
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at !== -1 && (start === -1 || at < start)) start = at
  }
  if (start === -1) start = 0
  const from = Math.max(0, start - Math.floor(SNIPPET_CHARS / 3))
  let piece = text.slice(from, from + SNIPPET_CHARS)
  if (from > 0) piece = '…' + piece.replace(/^\S*\s/, '')
  if (from + SNIPPET_CHARS < text.length) piece = piece.replace(/\s\S*$/, '') + '…'
  return piece.replace(/\s+/g, ' ').trim()
}

function search(question, { docs = corpus(), limit = MAX_HITS, now = Date.now() } = {}) {
  const terms = [...new Set(tokenize(question))]
  if (!terms.length) return { terms, hits: [], sessions: docs.length, passages: docs.reduce((n, d) => n + d.passages.length, 0) }
  const N = docs.reduce((n, d) => n + d.passages.length, 0)
  const avgdl = N ? docs.reduce((n, d) => n + d.totalLen, 0) / N : 1
  const df = new Map()
  for (const term of terms) {
    let n = 0
    for (const doc of docs) n += doc.postings.get(term)?.length || 0
    df.set(term, n)
  }
  const idf = term => Math.log(1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5))
  // Raw words from the question (not stemmed) for the snippet and the phrase bonus.
  const rawWords = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).filter(w => !STOP.has(w)))]
  const phrases = []
  for (let i = 0; i + 1 < rawWords.length; i++) phrases.push(`${rawWords[i]} ${rawWords[i + 1]}`)

  const hits = []
  for (const doc of docs) {
    const scores = new Map()
    for (const term of terms) {
      const list = doc.postings.get(term)
      if (!list) continue
      const w = idf(term)
      for (const [index, tf] of list) {
        const p = doc.passages[index]
        const s = w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * p.len / avgdl))
        scores.set(index, (scores.get(index) || 0) + s)
      }
    }
    if (!scores.size) continue
    const ranked = [...scores.entries()].map(([index, score]) => {
      const p = doc.passages[index]
      const lower = p.text.toLowerCase()
      // Words that appear together in the question and together in the passage.
      const phraseHits = phrases.filter(ph => lower.includes(ph)).length
      // A passage that covers more of the question's distinct terms is the better one.
      const covered = terms.filter(t => doc.postings.get(t)?.some(([i]) => i === index)).length
      return { index, score: score * (1 + 0.35 * phraseHits) * (0.6 + 0.4 * covered / terms.length) }
    }).sort((a, b) => b.score - a.score)
    const top = ranked.slice(0, MAX_SNIPPETS)
    let score = top[0].score + 0.3 * top.slice(1).reduce((n, r) => n + r.score, 0)
    // A gentle preference for recent sessions; it only reorders near-ties.
    const ageDays = doc.lastAt ? Math.max(0, (now - doc.lastAt) / 86400000) : 30
    score *= 1 + 0.15 * Math.exp(-ageDays / 14)
    hits.push({
      sessionId: doc.sessionId,
      title: doc.title,
      cwd: doc.cwd,
      project: doc.cwd ? doc.cwd.split('/').filter(Boolean).pop() : null,
      firstAt: doc.firstAt,
      lastAt: doc.lastAt,
      score: Math.round(score * 1000) / 1000,
      matches: scores.size,
      snippets: top.map(r => ({ role: doc.passages[r.index].role, at: doc.passages[r.index].at, text: snippet(doc.passages[r.index].text, rawWords.length ? rawWords : terms) })),
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return { terms, hits: hits.slice(0, limit), sessions: docs.length, passages: N }
}

// --- the answer ---------------------------------------------------------------------
const SYSTEM_PROMPT = `You help a developer remember what they discussed with Claude Code across many past sessions.
You are given their question and excerpts from the sessions a keyword search found. Excerpts are the only evidence you have.
Answer the question directly in 1-3 sentences: yes or no, where, and what the state of that discussion was (decided, fixed, parked, unanswered).
Then list only the sessions that are genuinely about the question, most relevant first. For each, write one or two sentences of context a reader can act on: what was discussed there and how it ended, in plain words, past tense. Add a short verbatim quote from the excerpt when one shows the match well.
If nothing matches, say so plainly and return no sessions. Never invent details that are not in the excerpts. Refer to sessions by their id exactly as given.`

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'Direct answer to the question, 1-3 sentences.' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          relevance: { type: 'string', enum: ['high', 'medium', 'low'] },
          context: { type: 'string', description: 'What was discussed there and how it ended. 1-2 sentences.' },
          quote: { type: 'string', description: 'Short verbatim excerpt, or empty.' },
        },
        required: ['sessionId', 'relevance', 'context'],
      },
    },
  },
  required: ['answer', 'matches'],
}

function when(ms) {
  if (!ms) return 'unknown date'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}
function buildPrompt(question, hits) {
  const lines = [`Question: ${question.trim()}`, '', `Candidate sessions (${Math.min(hits.length, AI_SESSIONS)} of ${hits.length} keyword matches):`]
  for (const hit of hits.slice(0, AI_SESSIONS)) {
    lines.push('', `## Session ${hit.sessionId}`, `Title: ${hit.title || '(untitled)'} · Project: ${hit.project || 'unknown'} · Last active: ${when(hit.lastAt)}`)
    for (const s of hit.snippets) lines.push(`- [${s.role === 'user' ? 'developer' : 'claude'} · ${when(s.at)}] ${s.text.slice(0, AI_SNIPPET_CHARS)}`)
  }
  lines.push('', 'Respond with JSON matching the schema: {"answer": string, "matches": [{"sessionId", "relevance", "context", "quote"}]}.')
  return lines.join('\n')
}

function parseAnswer(value) {
  let data = value
  if (typeof data === 'string') {
    const text = data.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try { data = JSON.parse(text) } catch { data = null }
  }
  if (!data || typeof data !== 'object' || typeof data.answer !== 'string') return null
  const matches = Array.isArray(data.matches) ? data.matches.filter(m => m && typeof m.sessionId === 'string').map(m => ({
    sessionId: m.sessionId.trim(),
    relevance: ['high', 'medium', 'low'].includes(m.relevance) ? m.relevance : 'medium',
    context: typeof m.context === 'string' ? m.context.trim().slice(0, 600) : '',
    quote: typeof m.quote === 'string' ? m.quote.trim().slice(0, 400) : '',
  })) : []
  return { answer: data.answer.trim().slice(0, 1500), matches }
}

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error }

class SearchJobs {
  constructor({ queryFactory, model = process.env.CLAUDE_FLEET_SEARCH_MODEL || 'haiku', getCorpus = corpus } = {}) {
    this.queryFactory = queryFactory || (async args => (await import('@anthropic-ai/claude-agent-sdk')).query(args))
    this.defaultModel = model
    this.getCorpus = getCorpus
    this.jobs = new Map()
    this.current = null // { id, controller, query }
  }
  get(id) {
    const job = this.jobs.get(id)
    if (!job) fail('Search not found.', 404)
    return structuredClone(job)
  }
  // Keyword results are ready when this returns; the answer arrives on the job later.
  start(body) {
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question || question.length > 500) fail('Ask a question of 1–500 characters.')
    const model = body.model === undefined || body.model === null || body.model === '' ? this.defaultModel : body.model
    if (typeof model !== 'string' || !/^[\w.:-]{1,80}$/.test(model)) fail('That model name is not valid.')
    this.stopCurrent('A newer search replaced this one.')
    const started = Date.now()
    const result = search(question, { docs: this.getCorpus() })
    const job = {
      id: randomUUID(), question, model, startedAt: started, status: 'thinking',
      terms: result.terms, hits: result.hits, sessions: result.sessions, passages: result.passages,
      searchMs: Date.now() - started, ai: null, error: null, aiMs: null,
    }
    this.jobs.set(job.id, job)
    while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value)
    if (!job.hits.length) {
      job.status = 'done'
      job.ai = { answer: 'Nothing in your recent sessions mentions this.', matches: [] }
      return structuredClone(job)
    }
    // The run handle is shared with stopCurrent(), so a stop that lands while the
    // SDK is still starting is still seen by the code that gets the query object.
    const run = { id: job.id, controller: new AbortController(), query: null, stopped: false }
    this.current = run
    run.done = this.answer(job, run).finally(() => { if (this.current === run) this.current = null })
    return structuredClone(job)
  }
  async answer(job, run) {
    const started = Date.now()
    const controller = run.controller
    try {
      const options = {
        cwd: os.tmpdir(), tools: [], settingSources: [], persistSession: false, maxTurns: 1,
        systemPrompt: SYSTEM_PROMPT, model: job.model, abortController: controller,
        outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        // Reading excerpts and reporting what they say needs no deliberation, and
        // adaptive thinking dominated the wait: measured 33s/2800 output tokens with
        // it against 9s/578 for the same answer with it off.
        thinking: { type: 'disabled' },
        canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'Search answers from excerpts only.' }),
      }
      if (process.env.CLAUDE_FLEET_EXECUTABLE && process.env.CLAUDE_FLEET_EXECUTABLE !== 'bundled') options.pathToClaudeCodeExecutable = process.env.CLAUDE_FLEET_EXECUTABLE
      const query = await this.queryFactory({ prompt: buildPrompt(job.question, job.hits), options })
      run.query = query
      // A stop can land while the runtime is starting, before there is anything to close.
      if (run.stopped || controller.signal.aborted) { try { query.close?.() } catch {} ; return }
      let parsed = null, text = '', failure = null
      for await (const event of query) {
        if (run.stopped || controller.signal.aborted) break
        if (event.type === 'assistant') text = visibleText(event.message?.content) || text
        if (event.type === 'result') {
          if (event.is_error) failure = (event.errors || []).join('\n') || event.result || 'Claude could not answer.'
          parsed = parseAnswer(event.structured_output) || parseAnswer(event.result) || parseAnswer(text)
        }
      }
      try { query.close?.() } catch {}
      if (run.stopped || controller.signal.aborted) return
      if (!parsed) throw new Error(failure || 'Claude returned no usable answer.')
      // Only sessions the keyword pass actually surfaced can be cited.
      const known = new Set(job.hits.map(h => h.sessionId))
      parsed.matches = parsed.matches.filter(m => known.has(m.sessionId))
      job.ai = parsed
      job.status = 'done'
    } catch (error) {
      if (run.stopped || controller.signal.aborted) return
      job.status = 'error'
      job.error = String(error.message || error).slice(0, 2000)
    } finally {
      job.aiMs = Date.now() - started
    }
  }
  stopCurrent(reason = 'Search stopped.') {
    const run = this.current
    if (!run || run.stopped) return
    run.stopped = true
    const job = this.jobs.get(run.id)
    if (job && job.status === 'thinking') { job.status = 'stopped'; job.error = reason }
    run.controller.abort()
    try { run.query?.close?.() } catch {}
    this.current = null
    return run
  }
  async close() {
    const run = this.stopCurrent('Fleet is shutting down.')
    try { await run?.done } catch {}
  }
}

module.exports = { SearchJobs, search, corpus, warm, indexFile, tokenize, stem, stripInjected, buildPrompt, parseAnswer, isObserver, SYSTEM_PROMPT, AI_SESSIONS, WINDOW_DAYS }
