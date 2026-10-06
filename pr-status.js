'use strict'
// PR state (open, merged, closed, draft) for the pull requests a session mentions, read with the gh CLI.
//
// Fleet holds no GitHub credentials: this runs `gh pr view` as the operator and uses
// whatever login gh already has. A missing or signed-out gh is an answer ("unavailable"),
// never an error that reaches the list. Results are cached per PR, identical requests share
// one gh call, at most two run at once, and an unavailable or rate-limited gh is left alone
// for a few minutes instead of being asked again by every poll.
const fs = require('node:fs')
const { execFile } = require('node:child_process')

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/
const FIELDS = 'state,isDraft,number'
const OPEN_TTL = 60000, SETTLED_TTL = 600000
const BACKOFF = 300000, ERROR_TTL = 60000
const MAX_CACHED = 200, MAX_PARALLEL = 2, TIMEOUT = 10000
const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

// gh's JSON for one PR, reduced to what the inspector shows.
function parsePr(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!data || typeof data !== 'object') throw new Error('Unexpected gh output.')
  const state = String(data.state || '').toLowerCase()
  return {
    state: ['open', 'merged', 'closed'].includes(state) ? state : 'unknown',
    draft: !!data.isDraft,
    number: Number(data.number) || null,
  }
}

// Why gh did not answer, from how it failed.
function classify(error) {
  const text = `${error && error.stderr || ''} ${error && error.message || ''}`
  if (error && error.code === 'ENOENT') return 'missing'
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401|bad credentials/i.test(text)) return 'unauthenticated'
  if (/rate limit/i.test(text)) return 'rate-limited'
  if (/could not resolve to a pullrequest|HTTP 404|not found/i.test(text)) return 'not-found'
  return 'failed'
}

function ghExecutable(env = process.env, exists = fs.existsSync) {
  if (env.CLAUDE_FLEET_GH) return env.CLAUDE_FLEET_GH
  const onPath = String(env.PATH || '').split(':').filter(Boolean)
  return [...onPath.map(dir => `${dir}/gh`), ...GH_PATHS].find(file => exists(file)) || 'gh'
}

const defaultRun = args => new Promise((resolve, reject) => {
  execFile(ghExecutable(), args, { timeout: TIMEOUT, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout))
})

function createPrStatus({ run = defaultRun, now = Date.now } = {}) {
  const cache = new Map()      // url -> { at, ttl, value }
  const inflight = new Map()   // url -> Promise
  const waiting = []
  let running = 0, unavailable = null // { reason, until }

  const slot = () => new Promise(resolve => { waiting.push(resolve); pump() })
  function pump() {
    while (running < MAX_PARALLEL && waiting.length) { running++; waiting.shift()() }
  }
  const release = () => { running--; pump() }
  const remember = (url, value, ttl) => {
    cache.delete(url)
    cache.set(url, { at: now(), ttl, value })
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
    return value
  }

  async function fetchOne(url) {
    await slot()
    try {
      const pr = parsePr(await run(['pr', 'view', url, '--json', FIELDS]))
      const ttl = pr.state === 'merged' || pr.state === 'closed' ? SETTLED_TTL : OPEN_TTL
      return remember(url, { ok: true, url, ...pr, checkedAt: now() }, ttl)
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'failed' : classify(error)
      // These say something about gh, not about this PR, so every PR waits.
      if (reason === 'missing' || reason === 'unauthenticated' || reason === 'rate-limited') unavailable = { reason, until: now() + BACKOFF }
      return remember(url, { ok: false, url, reason, checkedAt: now() }, reason === 'not-found' ? SETTLED_TTL : ERROR_TTL)
    } finally { release() }
  }

  // The status of one PR link. Never rejects: a PR gh cannot read comes back as
  // { ok: false, reason }.
  async function get(url) {
    if (!PR_URL.test(String(url))) return { ok: false, url: String(url), reason: 'invalid' }
    if (unavailable && unavailable.until > now()) return { ok: false, url, reason: unavailable.reason, retryAt: unavailable.until }
    unavailable = null
    const hit = cache.get(url)
    if (hit && now() - hit.at < hit.ttl) return hit.value
    if (!inflight.has(url)) inflight.set(url, fetchOne(url).finally(() => inflight.delete(url)))
    return inflight.get(url)
  }
  return { get }
}

module.exports = { createPrStatus, parsePr, classify, ghExecutable, PR_URL }
