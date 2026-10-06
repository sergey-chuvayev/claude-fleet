'use strict'
// The state of a linked pull request (Open, Merged, Closed, Draft), shown beside its link
// in the inspector's Linked work. The server reads it with gh and caches it; this asks for
// a PR only while its session is on screen, and asks again only when the answer can have
// changed: an open PR after a minute, a merged or closed one not for ten.
;(() => {
  const TONE = { open: ['Open', 'running'], merged: ['Merged', 'done'], closed: ['Closed', 'hot'] }
  const PROBLEM = {
    missing: 'Install the gh CLI to see whether a pull request is merged.',
    unauthenticated: 'Run gh auth login to see whether a pull request is merged.',
    'rate-limited': 'GitHub is rate limiting gh. Pull request state will return in a few minutes.',
  }

  // Pure helpers, shared with the Node tests.
  // [text, tone] for the pill, or null when there is no state to show.
  function label(status) {
    if (!status || !status.ok) return null
    if (status.state === 'open' && status.draft) return ['Draft', 'idle']
    return TONE[status.state] || null
  }
  // The one line worth saying when gh itself is unavailable. A PR gh merely cannot read
  // stays quiet.
  const problem = statuses => {
    const hit = (statuses || []).find(s => s && !s.ok && PROBLEM[s.reason])
    return hit ? PROBLEM[hit.reason] : ''
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { label, problem }; return }

  const held = new Map() // url -> { status, at, loading }
  const stale = (entry, now) => !entry || (!entry.loading && now - entry.at > (entry.status.ok && entry.status.state !== 'open' ? 600000 : 60000))

  async function load(url) {
    const entry = { status: held.get(url)?.status || { ok: false }, at: Date.now(), loading: true }
    held.set(url, entry)
    let status
    try {
      const response = await fetch(`/api/pr-status?url=${encodeURIComponent(url)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
      status = (await response.json()).status
    } catch { status = { ok: false, reason: 'failed' } }
    const changed = JSON.stringify(status) !== JSON.stringify(entry.status)
    held.set(url, { status, at: Date.now(), loading: false })
    if (changed) window.Fleet.render()
  }

  // The latest known state of a PR, starting a lookup when it is missing or has aged.
  function get(url) {
    if (stale(held.get(url), Date.now())) load(url)
    return held.get(url)?.status
  }
  // The pill for a PR link, or '' until gh has answered.
  function pill(url) {
    const shown = label(get(url))
    return shown ? window.FleetUI.pill(shown[0], shown[1]) : ''
  }
  const note = urls => problem(urls.map(url => held.get(url)?.status))

  window.FleetPrState = { pill, note }
})()
