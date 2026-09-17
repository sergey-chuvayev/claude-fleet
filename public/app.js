'use strict'
const $ = id => document.getElementById(id)
const STATES = ['busy', 'idle', 'stale', 'dead']
const LABELS = { busy: 'Working', idle: 'Waiting', stale: 'Stale', dead: 'Offline' }
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const key = s => s.managedId || `${s.sessionId || 'session'}:${s.pid}`
const percent = s => s.contextTokens == null ? null : Math.min(100, Math.max(0, s.contextTokens / s.contextLimit * 100))
const heat = p => p >= 90 ? 'hot' : p >= 75 ? 'warn' : ''
const tokens = n => n >= 1000000 ? `${(n / 1000000).toFixed(1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const age = timestamp => {
  if (!timestamp) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
  return secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs/60)}m` : secs < 86400 ? `${Math.floor(secs/3600)}h` : `${Math.floor(secs/86400)}d`
}
let snapshot = null, filter = 'all', selected = null, pending = false, toastTimer
function update(id, html) {
  const el = $(id)
  if (!el || el.innerHTML === html) return
  const active = document.activeElement
  const focusKey = el.contains(active) ? active.dataset.session || active.dataset.filter : null
  const top = el.scrollTop
  const responseTop = el.querySelector('.response')?.scrollTop || 0
  el.innerHTML = html
  el.scrollTop = top
  if (el.querySelector('.response')) el.querySelector('.response').scrollTop = responseTop
  if (focusKey) [...el.querySelectorAll('button')].find(b => b.dataset.session === focusKey || b.dataset.filter === focusKey)?.focus({ preventScroll: true })
}
function status(s) {
  // A Fleet conversation resumed in a terminal is driven there, whatever Fleet last recorded.
  if (s.managed && s.openElsewhere) {
    const where = s.openElsewhere.entrypoint === 'cli' ? 'In terminal' : 'Elsewhere'
    const title = `Open ${s.openElsewhere.entrypoint === 'cli' ? 'in a terminal' : 'in another program'}${s.openElsewhere.name ? ' (' + s.openElsewhere.name + ')' : ''}${s.openElsewhere.state === 'busy' ? ', working' : ', idle'}`
    return `<span class="badge elsewhere ${s.openElsewhere.state === 'busy' ? 'busy' : ''}" title="${esc(title)}"><span class="dot"></span>${where}</span>`
  }
  const label = s.managed ? ({starting:'Starting',running:'Working',approval:'Needs approval',stopping:'Stopping',stopped:'Stopped',error:'Error',idle:'Ready'})[s.managedStatus] : LABELS[s.state]
  return `<span class="badge ${s.managedStatus === 'approval' ? 'stale' : s.managedStatus === 'error' ? 'hot' : s.state}"><span class="dot"></span>${label}</span>`
}
// The row's third line is the story of the latest turn, the way a CI job row shows
// its steps: one segment per tool call coloured by the family of work, red where it
// failed; then the step in progress (or the last one), then how long the turn has run.
const isWorkingRow = s => s.openElsewhere ? s.openElsewhere.state === 'busy' : s.managed ? ['starting','running','stopping'].includes(s.managedStatus) : s.state === 'busy'
const STEP_ICON = { inspect: '▤', change: '✎', run: '⚡', delegate: '✳', ask: '?', other: '▸' }
const STEP_WORD = { inspect: 'inspecting', change: 'changing files', run: 'running commands', delegate: 'delegating', ask: 'asking', other: 'other' }
const stepCategory = name => ['Read','Grep','Glob','LS','WebFetch','WebSearch'].includes(name) ? 'inspect' : ['Edit','Write','MultiEdit','NotebookEdit'].includes(name) ? 'change' : ['Bash','BashOutput','KillShell'].includes(name) ? 'run' : ['Task','Skill','Agent'].includes(name) ? 'delegate' : ['AskUserQuestion','ExitPlanMode','EnterPlanMode'].includes(name) ? 'ask' : 'other'
const elapsed = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}s` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`
function turnRow(s) {
  const t = s.turn
  if (!t || (!t.steps.length && !t.current && !t.last)) return ''
  const working = isWorkingRow(s)
  const failed = t.steps.filter(st => !st.ok).length
  const tally = {}
  for (const st of t.steps) tally[st.k] = (tally[st.k] || 0) + 1
  const spoken = Object.entries(tally).map(([k, n]) => `${n} ${STEP_WORD[k] || k}`).join(', ') + (failed ? `, ${failed} failed` : '')
  const bar = t.steps.map(st => `<i class="${st.ok ? 'k-' + st.k : 'k-failed'}" title="${esc(st.t)}${st.target ? ' · ' + esc(st.target) : ''}${st.ok ? '' : ' · failed'}"></i>`).join('')
  const step = t.current || t.last
  const icon = step ? STEP_ICON[stepCategory(step.t)] || '▸' : ''
  const label = step ? `${esc(step.t)}${step.target ? ` <span class="step-target">${esc(step.target)}</span>` : ''}` : ''
  const when = working && t.turnStartedAt ? elapsed(Date.now() - t.turnStartedAt) : step && step.at ? age(step.at) + ' ago' : ''
  const aria = `This turn: ${spoken || 'no tool steps'}${step ? '. ' + (working ? 'Now' : 'Last') + ': ' + step.t + (step.target ? ' ' + step.target : '') : ''}`
  return `<span class="turn" aria-label="${esc(aria)}"><span class="steps ${failed ? 'has-failed' : ''}" aria-hidden="true">${bar}</span>${step ? `<span class="step-now ${working ? 'is-live' : ''}"><span class="step-icon" aria-hidden="true">${icon}</span>${label}</span>` : ''}${when ? `<span class="step-when">${when}</span>` : ''}</span>`
}
// "There are answers you have not looked at": the row's newest activity is later
// than the last time it was open. Selecting a session marks it read.
let seen = {}
try { seen = JSON.parse(store.get('fleet:seen') || '{}') } catch { seen = {} }
function markSeen(k, at) {
  if (!k || !at || seen[k] === at) return
  seen[k] = at
  // Keep the map from growing without bound as sessions come and go.
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 200)
  seen = Object.fromEntries(entries)
  store.set('fleet:seen', JSON.stringify(seen))
}
const hasUnseen = s => !!s.lastActivity && key(s) !== selected && (seen[key(s)] || 0) < s.lastActivity

function render() {
  if (!snapshot) return
  const {sessions, counts, total} = snapshot
  const background = sessions.filter(s => s.background)
  // How many spawned sessions each visible session is running, for its row badge.
  const spawnCounts = new Map()
  for (const s of background) if (s.spawnedByPid) spawnCounts.set(s.spawnedByPid, (spawnCounts.get(s.spawnedByPid) || 0) + 1)
  const foreground = sessions.filter(s => !s.background)
  const visibleCounts = { busy:0, idle:0, stale:0, dead:0 }
  for (const s of foreground) visibleCounts[s.state] = (visibleCounts[s.state] || 0) + 1
  const pool = filter === 'background' ? background : foreground
  // Ordering comes from the server (approval, then busy, then most recent) and
  // finding a specific session is what the Ask modal is for.
  const shown = pool.filter(s => filter === 'all' || filter === 'background' || s.state === filter)
  if (!shown.some(s => key(s) === selected)) selected = shown[0] ? key(shown[0]) : null
  $('shown-count').textContent = shown.length
  update('filters', [['all','All sessions',total - background.length],...STATES.map(s => [s,LABELS[s],(visibleCounts[s] || 0)]),...(background.length ? [['background','Background',background.length]] : [])].map(([s,label,n]) => `<button class="filter" data-filter="${s}" aria-pressed="${filter === s}">${label}<span>${n}</span></button>`).join(''))
  update('session-list', shown.length ? shown.map(s => {
    const p = percent(s)
    return `<button class="session" data-session="${esc(key(s))}" aria-pressed="${selected === key(s)}" aria-controls="detail" title="${hasUnseen(s) ? 'New output since you last opened this' : ''}"><span><span class="session-top">${hasUnseen(s) ? '<span class="unseen" aria-label="New output"></span>' : ''}${status(s)}<span class="session-name">${esc((s.managed ? 'FLEET · ' : '') + (s.name || s.shortId || 'Unnamed session'))}</span>${spawnCounts.get(s.pid) ? `<span class="spawn-badge" title="Running ${spawnCounts.get(s.pid)} background session(s)">⑂ ${spawnCounts.get(s.pid)}</span>` : ''}${s.background ? `<span class="spawn-owner" title="Started by ${esc(s.spawnedByName || 'a program')}, not from a terminal">via ${esc(s.spawnedByName || 'a program')}</span>` : ''}</span><span class="session-title">${esc(s.title || s.lastPrompt || 'Untitled session')}</span><span class="session-meta"><span>${esc(s.cwd?.split('/').filter(Boolean).pop() || 'No project')}</span><span class="branch">⑂ ${esc(s.branch || 'No branch')}</span>${s.links?.length ? `<span>↗ ${s.links.length}</span>` : ''}</span>${turnRow(s)}</span><span class="session-context ${heat(p)}">${p === null ? '—' : Math.round(p)+'%'}<span class="mini-bar"><i class="${heat(p)}" style="width:${p || 0}%"></i></span><small>${age(s.lastActivity)} ago</small></span></button>`
  }).join('') : `<div class="empty">${filter === 'background' ? 'No background sessions right now.' : total ? 'No sessions match your filters.<br>Try another search or select All sessions.' : 'Your fleet is quiet.<br>Start a Claude Code session and it will appear here automatically.'}</div>`)
  const current = shown.find(s => key(s) === selected)
  if (current) markSeen(key(current), current.lastActivity)
  renderDetail(current)
  if (typeof selectControl === 'function') selectControl(current)
}
function renderDetail(s) {
  if (!s) { update('detail-content','<div class="detail-empty"><span class="empty-symbol">⌘</span><h2>The full picture.</h2><p>Select a session to inspect it.</p></div>'); return }
  const p = percent(s)
  const links = (s.links || []).filter(l => /^https:\/\/(github\.com|linear\.app)\//.test(l.url))
  const facts = [['Project',s.cwdShort],['Branch',s.branch],['Model',s.model?.replace('claude-','')],['Permissions',s.permissionMode || 'Default'],['Control',s.managed ? 'Fleet-managed' : 'Terminal · monitor only'],['Session',s.sessionId]]
  update('detail-content', `<div class="detail-top"><span class="eyebrow">SESSION INSPECTOR</span>${status(s)}</div><h2>${esc(s.title || s.name || 'Untitled session')}</h2><div class="detail-name">${esc(s.name || s.shortId)} · Active ${age(s.lastActivity)} ago</div><div class="context-label"><span>Context window</span><span class="${heat(p)}">${p === null ? 'Not available' : `${tokens(s.contextTokens)} / ${tokens(s.contextLimit)} · ${Math.round(p)}%`}</span></div><div class="mini-bar"><i class="${heat(p)}" style="width:${p || 0}%"></i></div>${p >= 75 ? `<p class="note ${heat(p)}">${p >= 90 ? 'Context nearly full. Compaction may happen soon.' : 'Context is getting full.'}</p>` : ''}${s.managed ? '' : `<section class="detail-section"><h3>Latest response <span>${s.latestResponseAt ? age(s.latestResponseAt)+' ago' : ''}</span></h3><div class="response ${s.latestResponse ? '' : 'missing'}">${esc(s.latestResponse || 'No assistant response recorded yet.')}</div></section>`}${s.lastPrompt && !s.managed ? `<section class="detail-section"><h3>Latest request</h3><div class="response">${esc(s.lastPrompt)}</div></section>` : ''}<section class="detail-section"><h3>Linked work <span>From transcript</span></h3>${links.length ? `<div class="links">${links.map(l => `<a class="work-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${l.kind === 'pr' ? '⑂' : '◩'} ${esc(l.label)} ↗</a>`).join('')}</div><p class="note" style="margin-top:9px">Recorded references, not live status.</p>` : '<p class="note">GitHub PR and Linear issue URLs appear here when mentioned in the conversation.</p>'}</section><section class="detail-section"><h3>Environment</h3><dl class="facts">${facts.map(([label,value]) => `<dt>${label}</dt><dd>${esc(value ?? '—')}</dd>`).join('')}</dl></section>${s.transcriptTruncated ? '<p class="note">Showing the most recent 6 MB of this transcript. Earlier responses and links may be absent.</p>' : ''}<div class="detail-actions"><span class="subtle">${s.messages} recorded messages</span>${s.resumeCmd && !s.managed ? '<button class="button resume" id="copy-resume">Copy resume command ↗</button>' : ''}</div>`)
}
// ── Modals ───────────────────────────────────────────────────────────────────
// Ask and New agent are overlays, not panels that push the workspace down. One at
// a time, Escape and backdrop close them, Tab stays inside, and focus returns to
// whatever opened it.
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
let openModalId = null, modalReturnFocus = null
const modalIsOpen = id => openModalId === id
function openModal(id, focusSelector) {
  const backdrop = $(id)
  if (!backdrop) return
  if (openModalId && openModalId !== id) closeModal()
  if (openModalId !== id) {
    modalReturnFocus = document.activeElement
    backdrop.hidden = false
    openModalId = id
    document.body.setAttribute('data-modal', '')
    document.querySelector(`[aria-controls="${id}"]`)?.setAttribute('aria-expanded', 'true')
  }
  const target = (focusSelector && backdrop.querySelector(focusSelector)) || backdrop.querySelector(FOCUSABLE)
  target?.focus()
  if (target && target.select) target.select()
}
function closeModal() {
  if (!openModalId) return
  const backdrop = $(openModalId)
  if (backdrop) backdrop.hidden = true
  document.querySelector(`[aria-controls="${openModalId}"]`)?.setAttribute('aria-expanded', 'false')
  openModalId = null
  document.body.removeAttribute('data-modal')
  const back = modalReturnFocus
  modalReturnFocus = null
  if (back && back.isConnected) back.focus()
}
document.addEventListener('keydown', event => {
  if (!openModalId) return
  if (event.key === 'Escape') { event.preventDefault(); return closeModal() }
  if (event.key !== 'Tab') return
  const items = [...$(openModalId).querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement)
  if (!items.length) return
  const first = items[0], last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
})
document.addEventListener('mousedown', event => {
  if (!openModalId) return
  // The backdrop itself, or an explicit close button. Never a click inside the dialog.
  if (event.target === $(openModalId) || event.target.closest('[data-close-modal]')) closeModal()
})

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3000) }
document.addEventListener('click', async event => {
  const b = event.target.closest('button')
  if (!b) return
  if (b.dataset.filter) { filter = b.dataset.filter; render() }
  if (b.dataset.session) {
    selected = b.dataset.session; render()
    if (matchMedia('(max-width:720px)').matches) $('detail').scrollIntoView({behavior:'instant',block:'start'})
  }
  if (b.id === 'copy-resume') {
    const s = snapshot?.sessions.find(s => key(s) === selected)
    if (!s?.resumeCmd) return
    try { await navigator.clipboard.writeText(s.resumeCmd); toast('Resume command copied') }
    catch { toast('Clipboard unavailable. The command is shown below.'); const code = document.createElement('pre'); code.className = 'response'; code.textContent = s.resumeCmd; $('detail').append(code) }
  }
})
async function tick() {
  if (pending) return
  pending = true; $('refresh').disabled = true
  try {
    const r = await fetch('/api/sessions', {cache:'no-store',signal:AbortSignal.timeout(8000)})
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    if (!Array.isArray(data.sessions) || !data.counts) throw new Error('Invalid response')
    snapshot = data; render()
    // Other panels (the ask results) re-read the snapshot to refresh "open now" state.
    document.dispatchEvent(new CustomEvent('fleet-snapshot'))
    $('connection').textContent = 'Live connection'; $('connection-dot').className = 'dot busy'
    $('updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`
    $('error').hidden = !data.storageError
    if (data.storageError) $('error').textContent = data.storageError
  } catch {
    $('connection').textContent = 'Disconnected'; $('connection-dot').className = 'dot stale'
    $('error').textContent = snapshot ? 'Connection lost. Showing the last successful snapshot; retrying automatically.' : 'Unable to connect to the local server. Retrying automatically.'
    $('error').hidden = false
    if (!snapshot) { update('session-list','<div class="empty">Waiting for the local server…</div>'); renderDetail(null) }
  } finally { pending = false; $('refresh').disabled = false }
}
$('refresh').addEventListener('click',tick)
tick()
setInterval(() => { if (!document.hidden) tick() },2000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })

// Layout the operator controls: a draggable split between the session list and the
// inspector, and a resizable console. Both are remembered per browser; a storage
// failure (private window, blocked site data) only costs the remembered size.
const LAYOUT = { split: 'fleet:split', height: 'fleet:conv-height' }
const store = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch {} },
  clear(key) { try { localStorage.removeItem(key) } catch {} },
}
const SPLIT_DEFAULT = 58, LIST_MIN = 300, DETAIL_MIN = 380

function applySplit(percent, { save = true } = {}) {
  const value = Math.round(percent * 10) / 10
  document.documentElement.style.setProperty('--split', `${value}%`)
  $('splitter')?.setAttribute('aria-valuenow', String(Math.round(value)))
  if (save) store.set(LAYOUT.split, String(value))
}
// Clamp in pixels so neither pane can be squeezed past the point of being usable.
function clampSplit(percent, width) {
  if (!width) return percent
  return Math.min(Math.max(percent, LIST_MIN / width * 100), (width - DETAIL_MIN) / width * 100)
}
function initSplitter() {
  const splitter = $('splitter'), workspace = document.querySelector('.workspace')
  if (!splitter || !workspace) return
  const saved = Number(store.get(LAYOUT.split))
  if (Number.isFinite(saved) && saved > 0) applySplit(saved, { save: false })

  const move = event => {
    const rect = workspace.getBoundingClientRect()
    if (!rect.width) return
    applySplit(clampSplit((event.clientX - rect.left) / rect.width * 100, rect.width))
  }
  const stop = event => {
    splitter.removeAttribute('data-dragging')
    document.body.removeAttribute('data-resizing')
    splitter.releasePointerCapture?.(event.pointerId)
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', stop)
    removeEventListener('pointercancel', stop)
  }
  splitter.addEventListener('pointerdown', event => {
    if (event.button) return
    event.preventDefault()
    splitter.setAttribute('data-dragging', '')
    document.body.setAttribute('data-resizing', '')
    splitter.setPointerCapture?.(event.pointerId)
    addEventListener('pointermove', move)
    addEventListener('pointerup', stop)
    addEventListener('pointercancel', stop)
  })
  splitter.addEventListener('dblclick', () => { store.clear(LAYOUT.split); applySplit(SPLIT_DEFAULT, { save: false }) })
  splitter.addEventListener('keydown', event => {
    const step = { ArrowLeft: -2, ArrowRight: 2, Home: -100, End: 100 }[event.key]
    if (step === undefined) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      store.clear(LAYOUT.split)
      return applySplit(SPLIT_DEFAULT, { save: false })
    }
    event.preventDefault()
    const width = workspace.getBoundingClientRect().width
    const current = Number(splitter.getAttribute('aria-valuenow')) || SPLIT_DEFAULT
    applySplit(clampSplit(current + step, width), { save: true })
  })
  // A window resize can leave a stored split too narrow for one of the panes.
  addEventListener('resize', () => {
    const width = workspace.getBoundingClientRect().width
    const current = Number(splitter.getAttribute('aria-valuenow')) || SPLIT_DEFAULT
    const clamped = clampSplit(current, width)
    if (Math.abs(clamped - current) > 0.5) applySplit(clamped, { save: false })
  })
}

// The console is rebuilt whenever a different agent is selected, so its height is
// restored on each build and written back when the native resize grip is released.
let conversationObserver = null
function watchConversation(element) {
  if (!element) return
  const saved = store.get(LAYOUT.height)
  if (saved) element.style.height = saved
  conversationObserver ||= new ResizeObserver(entries => {
    for (const entry of entries) if (entry.target.style.height) store.set(LAYOUT.height, entry.target.style.height)
  })
  conversationObserver.disconnect()
  conversationObserver.observe(element)
}
window.FleetLayout = { watchConversation }
initSplitter()

// The session details sit behind a disclosure: with a console on screen the terminal
// is the point, and the facts below it are reference material. A session with no
// console (a terminal one, monitor-only) has nothing else to show, so it stays open.
const DETAILS_KEY = 'fleet:details-open'
function syncDetails() {
  const toggle = $('details-toggle'), content = $('detail-content'), hasConsole = !!$('composer')
  if (!toggle || !content) return
  toggle.hidden = !hasConsole
  const open = !hasConsole || store.get(DETAILS_KEY) === '1'
  content.hidden = !open
  toggle.setAttribute('aria-expanded', String(open))
}
$('details-toggle')?.addEventListener('click', () => {
  const open = $('details-toggle').getAttribute('aria-expanded') !== 'true'
  store.set(DETAILS_KEY, open ? '1' : '0')
  syncDetails()
})
window.FleetLayout.syncDetails = syncDetails
