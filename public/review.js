'use strict'
// The review loop in the inspector: the state and CI of the pull requests a session
// mentioned (read by the server with gh), and a way to tell the session what to fix.
// Feedback goes through the same message route as the composer, so it queues behind a
// running turn exactly as a typed message does.
;(() => {
  const CUSTOM = 'custom', CI = 'ci'
  const LISTED = 5

  // Pure helpers, shared with the Node tests.
  // The pull requests worth tracking for a session: the latest few it mentioned.
  const prLinks = session => (session?.links || []).filter(l => l.kind === 'pr' && /^https:\/\/github\.com\//.test(l.url)).slice(-3)
  const names = list => list.length > LISTED ? `${list.slice(0, LISTED).join(', ')} and ${list.length - LISTED} more` : list.join(', ')
  // "CI failed on build, lint (PR #12). Fix it and push." for every PR whose CI is red.
  function ciFeedback(statuses) {
    const failed = (statuses || []).filter(s => s?.ok && s.ci?.result === 'fail')
    if (!failed.length) return ''
    return failed.map(s => `CI failed on ${names(s.ci.failing)}${s.number ? ` (PR #${s.number})` : ''}. Fix it and push.`).join(' ')
  }
  const PROBLEM = {
    missing: 'The gh CLI is not installed, so PR status is unavailable.',
    unauthenticated: 'gh is not signed in. Run gh auth login to see PR status.',
    'rate-limited': 'GitHub is rate limiting gh. PR status will retry in a few minutes.',
    'not-found': 'gh cannot see this pull request.',
    invalid: 'This is not a GitHub pull request link.',
    failed: 'gh could not read this pull request.',
  }
  const problem = reason => PROBLEM[reason] || PROBLEM.failed
  if (typeof module !== 'undefined' && module.exports) { module.exports = { prLinks, ciFeedback, problem, names }; return }

  const {$, esc} = window.Fleet
  const UI = window.FleetUI
  const POLL = 30000
  const drafts = new Map() // session key -> what was typed, kept while another session is open
  let current = null, timer = null, sending = false

  const STATE = { open: ['Open', 'running'], merged: ['Merged', 'done'], closed: ['Closed', 'hot'], unknown: ['Unknown', 'idle'] }
  const CI_LABEL = { pass: ['CI passing', 'done'], fail: ['CI failing', 'hot'], pending: ['CI running', 'needs'], none: ['No CI', 'idle'] }

  function prHtml(link, status) {
    const head = `<a class="work-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" title="${esc(link.url)}"><i class="ico ico-pr" aria-hidden="true"></i> ${esc(link.label)} <i class="ico ico-arrow" aria-hidden="true"></i></a>`
    if (!status) return `<li class="review-pr">${head}<span class="note">Checking…</span></li>`
    if (!status.ok) return `<li class="review-pr">${head}<span class="note">${esc(problem(status.reason))}</span></li>`
    const [stateText, stateTone] = STATE[status.state] || STATE.unknown
    const [ciText, ciTone] = CI_LABEL[status.ci.result]
    const failing = status.ci.failing.length ? `<p class="review-failing note">Failing: ${esc(names(status.ci.failing))}</p>` : ''
    return `<li class="review-pr">${head}${UI.pill(status.draft && status.state === 'open' ? 'Draft' : stateText, stateTone)}${status.state === 'open' ? UI.pill(ciText, ciTone) : ''}${failing}</li>`
  }

  function options(statuses, chosen) {
    const ci = ciFeedback(statuses)
    const list = [[CUSTOM, 'Write your own', 'Say what you want changed']]
    if (ci) list.push([CI, 'CI failed, fix it', ci])
    return { ci, html: list.map(([value, label, hint]) => `<option value="${value}" data-description="${esc(hint)}"${value === chosen ? ' selected' : ''}>${esc(label)}</option>`).join('') }
  }

  function renderStatus() {
    const box = $('review-status')
    if (!box || !current) return
    const { links, statuses } = current
    box.innerHTML = `<ul class="review-prs">${links.map((l, i) => prHtml(l, statuses[i])).join('')}</ul>`
    if (!current.form) return
    const select = $('review-preset'), quick = $('review-ci-send')
    const { ci, html } = options(statuses, select.value)
    if (select.innerHTML !== html && !window.FleetSelect?.isOpen($('review-panel'))) select.innerHTML = html
    if (select.value === CI && !ci) select.value = CUSTOM
    quick.hidden = !ci
    quick.title = ci
  }

  async function load() {
    const open = current
    if (!open) return
    const results = await Promise.all(open.links.map(l =>
      fetch(`/api/pr-status?url=${encodeURIComponent(l.url)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
        .then(r => r.ok ? r.json() : null).then(d => d?.status || { ok: false, reason: 'failed' }).catch(() => ({ ok: false, reason: 'failed' }))))
    if (current !== open) return
    open.statuses = results
    renderStatus()
  }

  async function send(message) {
    const open = current
    if (!open?.form || sending || !message.trim()) return
    const error = $('review-error')
    sending = true; error.hidden = true
    const buttons = $('review-panel').querySelectorAll('button')
    buttons.forEach(b => { b.disabled = true })
    try {
      await window.FleetControl.api(`/api/managed/${open.managedId}/messages`, { message: message.trim(), requestId: crypto.randomUUID() })
      drafts.delete(open.key)
      if (current === open) { $('review-text').value = ''; $('review-preset').value = CUSTOM; $('review-sent').textContent = 'Feedback sent to this session.' }
      window.Fleet.requestTick?.()
    } catch (e) {
      if (current === open) { error.hidden = false; error.textContent = e.message || 'Could not send feedback.' }
    } finally {
      sending = false
      buttons.forEach(b => { b.disabled = false })
    }
  }

  function mount(session, links) {
    const panel = $('review-panel')
    const form = !!(session.managed && session.managedId)
    current = { key: window.Fleet.key(session), managedId: session.managedId, links, urls: links.map(l => l.url).join(' '), statuses: [], form }
    panel.hidden = false
    panel.innerHTML = UI.section('Pull request', `<div id="review-status"></div>${form
      ? `<form id="review-form" class="review-form"><label class="review-field">Feedback to this session<select id="review-preset" aria-label="Feedback to send">${options([], CUSTOM).html}</select></label><textarea id="review-text" rows="3" maxlength="16000" placeholder="What should it change?" aria-label="Feedback message">${esc(drafts.get(current.key) || '')}</textarea><div class="ui-actions"><button type="button" class="button" id="review-ci-send" hidden>Send CI fix request</button><button type="submit" class="button resume">Send feedback <i class="ico ico-arrow" aria-hidden="true"></i></button></div><p id="review-sent" class="note" role="status"></p><p id="review-error" class="form-error" role="alert" hidden></p></form>`
      : '<p class="note">Continue this session in Fleet to send it feedback.</p>'}`, { aside: 'via gh', cls: 'review-section' })
    renderStatus()
    load()
  }

  // Called with the selected session on every render. Does nothing while the same
  // session shows the same links, so a draft and the focus in it survive the list polling.
  function show(session) {
    const links = prLinks(session)
    const key = session && window.Fleet.key(session)
    if (!links.length) {
      if (current) { clearInterval(timer); timer = null; current = null; $('review-panel').hidden = true; $('review-panel').innerHTML = '' }
      return
    }
    const same = current && current.key === key && current.urls === links.map(l => l.url).join(' ')
    if (same && current.form === !!(session.managed && session.managedId)) return
    if (current) { const text = $('review-text'); if (text) drafts.set(current.key, text.value) }
    mount(session, links)
    clearInterval(timer)
    timer = setInterval(() => { if (!document.hidden) load() }, POLL)
  }

  document.addEventListener('submit', event => {
    if (event.target.id !== 'review-form') return
    event.preventDefault()
    send($('review-text').value)
  })
  document.addEventListener('click', event => {
    if (event.target.closest('#review-ci-send')) send(ciFeedback(current?.statuses))
  })
  document.addEventListener('change', event => {
    if (event.target.id !== 'review-preset' || !current) return
    if (event.target.value === CI) $('review-text').value = ciFeedback(current.statuses)
    $('review-text').focus()
  })
  document.addEventListener('input', event => {
    if (event.target.id === 'review-text' && current) drafts.set(current.key, event.target.value)
  })

  window.FleetReview = { show }
})()
