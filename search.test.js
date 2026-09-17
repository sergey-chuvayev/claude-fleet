'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const until = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('timed out') }

// Build a throwaway ~/.claude tree and load search.js against it.
function fixture(projects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-search-'))
  for (const [dir, files] of Object.entries(projects)) {
    const full = path.join(root, 'projects', dir)
    fs.mkdirSync(full, { recursive: true })
    for (const [name, records] of Object.entries(files)) {
      fs.writeFileSync(path.join(full, name), records.map(r => JSON.stringify(r)).join('\n') + '\n')
    }
  }
  const previous = process.env.CLAUDE_FLEET_DIR
  process.env.CLAUDE_FLEET_DIR = root
  delete require.cache[require.resolve('./search')]
  const mod = require('./search')
  return {
    mod,
    cleanup() {
      if (previous === undefined) delete process.env.CLAUDE_FLEET_DIR
      else process.env.CLAUDE_FLEET_DIR = previous
      delete require.cache[require.resolve('./search')]
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
const said = (type, text, extra = {}) => ({ type, timestamp: new Date().toISOString(), cwd: '/Users/dev/projects/api', message: { content: [{ type: 'text', text }] }, ...extra })

test('indexing keeps the operator conversation and drops everything that only looks like one', () => {
  const { mod, cleanup } = fixture({
    '-Users-dev-projects-api': {
      'aaaaaaaa-1111-2222-3333-444444444444.jsonl': [
        { type: 'ai-title', aiTitle: 'Recording fallback decision' },
        said('user', 'Why did the recording fail for answered calls?'),
        said('assistant', 'Because the download ran inside the transaction and JDBC rolled it back.'),
        // A tool result is a "user" entry, and must not be indexed as something typed.
        { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'zebraword appears only in tool output' }] } },
        // Injected context rides inside a real user turn; the typed part survives, the rest does not.
        said('user', '<system-reminder>giraffeword memory index</system-reminder>\nPlease open a pull request.'),
        // Sub-agent chatter is not the operator's conversation.
        said('assistant', 'okapiword from a subagent', { isSidechain: true }),
      ],
    },
    // The claude-mem indexer summarises every other session; it would match anything.
    '-Users-dev--claude-mem-observer-sessions': {
      'bbbbbbbb-1111-2222-3333-444444444444.jsonl': [said('assistant', 'recording answered calls zebraword giraffeword observation')],
    },
  })
  try {
    const docs = mod.corpus()
    assert.equal(docs.length, 1, 'the observer project directory is excluded')
    const doc = docs[0]
    assert.equal(doc.title, 'Recording fallback decision')
    assert.equal(doc.sessionId, 'aaaaaaaa-1111-2222-3333-444444444444')
    assert.equal(doc.cwd, '/Users/dev/projects/api')
    const texts = doc.passages.map(p => p.text).join('\n')
    assert.match(texts, /rolled it back/)
    assert.match(texts, /open a pull request/)
    assert.doesNotMatch(texts, /zebraword/, 'tool results are not indexed')
    assert.doesNotMatch(texts, /giraffeword/, 'injected reminders are stripped')
    assert.doesNotMatch(texts, /okapiword/, 'sidechains are not indexed')
    assert.equal(mod.search('zebraword giraffeword okapiword').hits.length, 0)
    // An unchanged file is served from cache rather than parsed again.
    assert.equal(mod.indexFile(doc.file), doc)
  } finally { cleanup() }
})

test('ranking answers the question rather than the way it was phrased', () => {
  const { mod, cleanup } = fixture({
    '-Users-dev-projects-api': {
      'cafe0000-0000-0000-0000-000000000001.jsonl': [
        { type: 'ai-title', aiTitle: 'Cascade ordering' },
        said('user', 'The cascade rings members out of order on hop one.'),
        said('assistant', 'The Vonage callbacks arrive out of order, so the cascade guard drops the late leg.'),
      ],
      'cafe0000-0000-0000-0000-000000000002.jsonl': [
        { type: 'ai-title', aiTitle: 'Storybook deploy' },
        said('user', 'Did we ever discuss the Storybook deployment?'),
        said('assistant', 'Storybook deploys from main through Cloudflare Workers.'),
      ],
    },
  })
  try {
    const result = mod.search('did we ever discuss the cascade ringing out of order?')
    // "did we ever discuss" is framing, not topic: it must not pull in the other session.
    assert.deepEqual(result.terms.sort(), ['cascade', 'hop', 'order', 'out', 'ring'].filter(t => result.terms.includes(t)).sort())
    assert.ok(!result.terms.includes('discuss') && !result.terms.includes('we'))
    assert.equal(result.hits[0].title, 'Cascade ordering')
    assert.equal(result.hits[0].project, 'api')
    assert.ok(result.hits[0].snippets.length > 0)
    assert.match(result.hits[0].snippets[0].text, /cascade/i)
    // A question with no content words at all returns nothing rather than everything.
    assert.deepEqual(mod.search('did we discuss that?').hits, [])
  } finally { cleanup() }
})

test('a search job serves keyword hits first, then only the citations the search actually found', async () => {
  const { SearchJobs } = require('./search')
  const docs = [
    { file: 'a.jsonl', sessionId: 'sess-aaaa', title: 'Ring parity', cwd: '/x/api', firstAt: 1, lastAt: 2, totalLen: 3,
      passages: [{ role: 'assistant', text: 'ring parity gaps in RING_USERS', at: 2, len: 3 }],
      postings: new Map([['ring', [[0, 1]]], ['parity', [[0, 1]]], ['gap', [[0, 1]]]]) },
  ]
  const prompts = []
  const jobs = new SearchJobs({
    getCorpus: () => docs,
    queryFactory: async ({ prompt, options }) => {
      prompts.push({ prompt, options })
      return { close() {}, async *[Symbol.asyncIterator]() {
        yield { type: 'result', is_error: false, structured_output: { answer: 'Yes, in one session.', matches: [
          { sessionId: 'sess-aaaa', relevance: 'high', context: 'Ring parity gaps were traced to RING_USERS.', quote: 'ring parity gaps' },
          { sessionId: 'made-up', relevance: 'high', context: 'Invented session that never matched.' },
        ] } }
      } }
    },
  })
  try {
    const started = jobs.start({ question: 'ring parity gaps' })
    assert.equal(started.status, 'thinking')
    assert.equal(started.hits.length, 1, 'keyword hits are ready before Claude answers')
    await until(() => jobs.get(started.id).status === 'done')
    const job = jobs.get(started.id)
    assert.equal(job.ai.answer, 'Yes, in one session.')
    assert.deepEqual(job.ai.matches.map(m => m.sessionId), ['sess-aaaa'], 'a session the search never found cannot be cited')
    // The answering run reads excerpts only: no tools, no project settings, nothing persisted.
    const options = prompts[0].options
    assert.deepEqual(options.tools, [])
    assert.deepEqual(options.settingSources, [])
    assert.equal(options.persistSession, false)
    assert.equal(options.maxTurns, 1)
    assert.deepEqual(options.thinking, { type: 'disabled' }, 'thinking is the whole latency budget here')
    assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny')
    assert.match(prompts[0].prompt, /Session sess-aaaa/)
    assert.match(prompts[0].prompt, /ring parity gaps/)

    // Nothing matched: answered locally, without spending a model call.
    const empty = jobs.start({ question: 'flamingo choreography' })
    assert.equal(empty.status, 'done')
    assert.deepEqual(empty.ai.matches, [])
    assert.equal(prompts.length, 1)
    assert.throws(() => jobs.start({ question: '' }), /1–500/)
  } finally { await jobs.close() }
})

test('a failed answer keeps its keyword hits, and a newer search cancels the one still thinking', async () => {
  const { SearchJobs } = require('./search')
  const docs = [
    { file: 'a.jsonl', sessionId: 'sess-bbbb', title: 'Whisper toggle', cwd: '/x/api', firstAt: 1, lastAt: 2, totalLen: 2,
      passages: [{ role: 'user', text: 'the whisper toggle was ignored', at: 2, len: 2 }],
      postings: new Map([['whisper', [[0, 1]]], ['toggle', [[0, 1]]]]) },
  ]
  let closes = 0
  const jobs = new SearchJobs({
    getCorpus: () => docs,
    queryFactory: async ({ options }) => ({
      close() { closes++ },
      async *[Symbol.asyncIterator]() {
        // Hang until the run is aborted, the way a slow model call would.
        await new Promise(resolve => options.abortController.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'result', is_error: true, result: 'Claude could not answer.' }
      },
    }),
  })
  try {
    const first = jobs.start({ question: 'whisper toggle' })
    assert.equal(first.status, 'thinking')
    const second = jobs.start({ question: 'whisper toggle again' })
    await until(() => jobs.get(first.id).status === 'stopped')
    const stopped = jobs.get(first.id)
    assert.match(stopped.error, /newer search/)
    assert.equal(stopped.hits.length, 1, 'the cancelled search keeps the matches it already found')
    assert.ok(closes >= 1, 'the abandoned query is closed')
    jobs.stopCurrent()
    await until(() => jobs.get(second.id).status === 'stopped')
  } finally { await jobs.close() }
})

test('the answer parser accepts fenced JSON and refuses anything it cannot trust', () => {
  const { parseAnswer } = require('./search')
  const fenced = parseAnswer('```json\n{"answer":"Yes.","matches":[{"sessionId":"s1","relevance":"nonsense","context":"x"}]}\n```')
  assert.equal(fenced.answer, 'Yes.')
  assert.equal(fenced.matches[0].relevance, 'medium', 'an unknown relevance falls back rather than rendering raw')
  assert.equal(parseAnswer('not json at all'), null)
  assert.equal(parseAnswer({ matches: [] }), null)
  assert.deepEqual(parseAnswer({ answer: 'No.', matches: 'oops' }).matches, [])
})

test('the search endpoints need the CSRF token and report an unknown job as missing', async () => {
  const { createApp } = require('./server')
  const { SearchJobs } = require('./search')
  const { ManagedSessions } = require('./managed')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-search-http-'))
  const manager = new ManagedSessions({ directory: path.join(directory, '.fleet'), queryFactory: async () => ({ close() {}, async *[Symbol.asyncIterator]() {} }) })
  const search = new SearchJobs({ getCorpus: () => [], queryFactory: async () => ({ close() {}, async *[Symbol.asyncIterator]() {} }) })
  const app = createApp({ manager, search, collectSessions: () => ({ sessions: [], counts: {}, total: 0, generatedAt: Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const { token } = await (await fetch(base + '/api/control')).json()
    const ask = (headers, body) => fetch(base + '/api/search', { method: 'POST', headers, body })
    assert.equal((await ask({ 'content-type': 'application/json' }, '{"question":"hi"}')).status, 403)
    const created = await ask({ 'content-type': 'application/json', 'x-fleet-token': token, origin: base }, JSON.stringify({ question: 'anything at all' }))
    assert.equal(created.status, 201)
    const { job } = await created.json()
    assert.equal(job.status, 'done', 'an empty corpus answers immediately')
    assert.equal((await fetch(base + `/api/search/${job.id}`)).status, 200)
    assert.equal((await fetch(base + `/api/search/${randomUUID()}`)).status, 404)
    const bad = await ask({ 'content-type': 'application/json', 'x-fleet-token': token, origin: base }, JSON.stringify({ question: 'x', model: 'rm -rf /' }))
    assert.equal(bad.status, 400)
  } finally { await app.close(); app.server.closeAllConnections(); fs.rmSync(directory, { recursive: true, force: true }) }
})
