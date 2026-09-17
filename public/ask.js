'use strict'
// Ask panel: one question, searched across every transcript on this machine.
// Keyword matches render the moment the server has them; the written answer
// arrives a few seconds later and reorders the cards by what Claude found relevant.
let askJob = null, askPoll = null, askRequest = 0
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
$('ask-shortcut').textContent = isMac ? '⌘K' : 'Ctrl K'

const openAsk = () => { renderAsk(); openModal('ask-backdrop', '#ask-input') }
$('ask-welcome').addEventListener('click', event => {
  const suggestion = event.target.closest('[data-question]')
  if (!suggestion) return
  $('ask-input').value = suggestion.dataset.question
  $('ask-input').focus()
})
$('ask-sessions').addEventListener('click', () => modalIsOpen('ask-backdrop') ? closeModal() : openAsk())
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openAsk() }
})

$('ask-form').addEventListener('submit', async event => {
  event.preventDefault()
  const question = $('ask-input').value.trim()
  if (!question) return
  const mine = ++askRequest
  clearInterval(askPoll); askPoll = null
  askJob = { status: 'searching', question, hits: [] }
  renderAsk()
  $('ask-submit').disabled = true
  try {
    const data = await api('/api/search', { question, model: $('ask-model').value })
    if (mine !== askRequest) return
    askJob = data.job
    renderAsk()
    if (askJob.status === 'thinking') askPoll = setInterval(pollAsk, 700)
  } catch (error) {
    if (mine !== askRequest) return
    askJob = { status: 'error', question, hits: [], error: error.message }
    renderAsk()
  } finally {
    if (mine === askRequest) $('ask-submit').disabled = false
  }
})
async function pollAsk() {
  const id = askJob?.id
  if (!id) return
  try {
    const data = await api(`/api/search/${id}`)
    if (data.job.id !== askJob?.id) return
    askJob = data.job
    renderAsk()
    if (askJob.status !== 'thinking') { clearInterval(askPoll); askPoll = null }
  } catch {}
}

const REL_WORD = { high: 'strong match', medium: 'related', low: 'loosely related' }
const dateOf = ms => ms ? new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''
const liveSession = id => snapshot?.sessions.find(s => s.sessionId === id) || null

function hitCard(hit, match) {
  const live = liveSession(hit.sessionId)
  const title = hit.title || live?.title || live?.name || 'Untitled session'
  const when = hit.lastAt ? `${dateOf(hit.lastAt)} · ${age(hit.lastAt)} ago` : ''
  const action = live
    ? `<button type="button" class="button ask-open" data-open-session="${esc(key(live))}">Open in Fleet ↗</button>`
    : `<button type="button" class="button ask-open" data-copy-resume="claude --resume ${esc(hit.sessionId)}" title="This session is not open right now">Copy resume command</button>`
  const snippets = (hit.snippets || []).map(s => `<p class="ask-snippet"><span class="ask-role">${s.role === 'user' ? 'you' : 'claude'}</span>${esc(s.text)}</p>`).join('')
  return `<article class="ask-hit" data-relevance="${esc(match?.relevance || '')}"><div class="ask-hit-head"><span class="ask-hit-title">${esc(title)}</span>${match ? `<span class="ask-rel">${REL_WORD[match.relevance] || 'related'}</span>` : ''}<span class="ask-hit-meta">${esc(hit.project || 'unknown project')}${when ? ` · ${esc(when)}` : ''}${live ? ' · <span class="ask-live">open now</span>' : ''}</span></div>${match?.context ? `<p class="ask-context">${esc(match.context)}</p>` : ''}${match?.quote ? `<blockquote class="ask-quote">${esc(match.quote)}</blockquote>` : ''}${snippets ? `<details class="ask-snippets"${match ? '' : ' open'}><summary>${hit.matches} matching passage${hit.matches === 1 ? '' : 's'} · keyword excerpts</summary>${snippets}</details>` : ''}<div class="ask-hit-actions">${action}</div></article>`
}

function renderAsk() {
  const job = askJob
  $('ask-welcome').hidden = !!job
  $('ask-results').setAttribute('aria-busy', String(job?.status === 'searching' || job?.status === 'thinking'))
  if (!job) return update('ask-results', '')
  const stats = job.id ? `<span class="ask-stats">${job.sessions} session${job.sessions === 1 ? '' : 's'} · ${job.passages} passages · ${job.searchMs} ms</span>` : ''
  let status
  if (job.status === 'searching') status = `<p class="ask-status is-live">Searching your transcripts…</p>`
  else if (job.status === 'thinking') status = `<p class="ask-status is-live">Reading the ${Math.min(job.hits.length, 10)} best matches with ${esc(job.model)}…</p>`
  else if (job.status === 'error') status = `<p class="ask-status is-failed">${esc(job.error || 'The answer failed.')}${job.hits.length ? ' Keyword matches are still shown below.' : ''}</p>`
  else if (job.status === 'stopped') status = `<p class="ask-status">${esc(job.error || 'Replaced by a newer search.')}</p>`
  else status = ''
  const answer = job.ai ? `<div class="ask-answer"><span class="ask-answer-label">Answer</span><p>${esc(job.ai.answer)}</p></div>` : ''

  let cards = ''
  if (job.ai && job.ai.matches.length) {
    const byId = new Map(job.hits.map(h => [h.sessionId, h]))
    const cited = job.ai.matches.map(m => [m, byId.get(m.sessionId)]).filter(([, h]) => h)
    const rest = job.hits.filter(h => !job.ai.matches.some(m => m.sessionId === h.sessionId))
    cards = cited.map(([m, h]) => hitCard(h, m)).join('')
    if (rest.length) cards += `<details class="ask-rest"><summary>${rest.length} other keyword match${rest.length === 1 ? '' : 'es'} Claude did not find relevant</summary>${rest.map(h => hitCard(h, null)).join('')}</details>`
  } else if (job.hits.length) {
    cards = `<p class="ask-section">Keyword matches${job.ai ? ' · none judged relevant' : ''}</p>` + job.hits.map(h => hitCard(h, null)).join('')
  } else if (job.id) {
    cards = '<p class="ask-empty">No matching threads yet. Try a project name, a feature, or a few words you remember.</p>'
  }
  update('ask-results', `<div class="ask-head"><span class="ask-question">“${esc(job.question)}”</span>${stats}</div>${status}${answer}${cards}`)
}

$('ask-results').addEventListener('click', async event => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.openSession) {
    selected = button.dataset.openSession
    filter = 'all'
    closeModal()
    render()
    if (matchMedia('(max-width:720px)').matches) $('detail').scrollIntoView({ behavior: 'instant', block: 'start' })
    else document.querySelector(`.session[data-session="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  if (button.dataset.copyResume) {
    try { await navigator.clipboard.writeText(button.dataset.copyResume); toast('Resume command copied') }
    catch { toast(button.dataset.copyResume) }
  }
})

// Live sessions may appear or vanish while the results are on screen; refresh the
// "open now" state and the Open button from the latest snapshot.
document.addEventListener('fleet-snapshot', () => { if (askJob && modalIsOpen('ask-backdrop')) renderAsk() })
