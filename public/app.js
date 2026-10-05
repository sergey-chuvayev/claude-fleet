'use strict'
// An isolated scope, the way teams.js and blocks.js already do it. Everything in
// here used to sit in the page's shared global scope alongside control.js, blocks.js
// and ask.js, where a name chosen twice in two files is a SyntaxError that takes the
// whole dashboard down before a line of it runs. What the other files legitimately
// need is window.Fleet, published partway down; nothing else escapes.
// The leading semicolon is load-bearing: without it the directive above and the
// parenthesis below join into a call on the string "use strict".
;(() => {
const $ = id => document.getElementById(id)
// The one thing the core borrows back from control.js, which owns the control
// token every write is authenticated with. Resolved per call, not at load: app.js
// runs first, and every caller here is an event handler that fires long after.
const api = (...args) => window.FleetControl.api(...args)
const STATES = ['busy', 'idle', 'stale', 'dead']
const LABELS = { busy: 'Working', idle: 'Waiting', stale: 'Stale', dead: 'Offline' }
const DATE_FILTERS = ['today', 'week']
const DATE_LABELS = { all: 'All time', today: 'Today', week: 'This week' }
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const key = s => s.managedId || s.sessionId || `session:${s.pid}`
const percent = s => s.contextTokens == null ? null : Math.min(100, Math.max(0, s.contextTokens / s.contextLimit * 100))
const heat = p => p >= 90 ? 'hot' : p >= 75 ? 'warn' : ''
const tokens = n => n >= 1000000 ? `${(n / 1000000).toFixed(1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
// 1 → 1st. Only ever sees a queue position, so the teens rule is enough to be correct.
const ordinal = n => `${n}${[11,12,13].includes(n % 100) ? 'th' : ({1:'st',2:'nd',3:'rd'})[n % 10] || 'th'}`
const age = timestamp => {
  if (!timestamp) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
  return secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs/60)}m` : secs < 86400 ? `${Math.floor(secs/3600)}h` : `${Math.floor(secs/86400)}d`
}
// "Today" resets at local midnight; "This week" is a rolling 7 days, so it never
// jumps forward mid-session the way a calendar-week reset would.
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const matchesDate = (s, when) => {
  if (when === 'all') return true
  if (!s.startedAt) return false
  const started = new Date(s.startedAt).getTime()
  return when === 'today' ? started >= startOfToday() : started >= Date.now() - 7 * 86400000
}
// Everything Fleet remembers between visits goes through here. It is declared before
// its first reader on purpose: a `const` used above its declaration throws a
// ReferenceError that the callers' own try/catch would quietly absorb, leaving every
// remembered preference silently reset on each load.
const store = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch {} },
  clear(key) { try { localStorage.removeItem(key) } catch {} },
}
let checkedAt = 0, renderedAt = 0, tickAt = 0, tickQueued = null
let snapshot = null, filter = 'all', dateFilter = 'all', filterMenuOpen = false, selected = null, pending = false, toastTimer
// A delegation row nested under a team session. Keyed on the delegation id, never on
// its position or status, so a sub-agent finishing does not move the operator's focus.
let selectedChild = null, childDetail = null, childDetailFor = null, childDetailError = null, childRequest = 0, lastChildId = null
const DELEGATION_LABEL = { running: 'Working', completed: 'Done', failed: 'Failed', interrupted: 'Interrupted' }
const DELEGATION_BADGE = { running: 'busy', completed: 'idle', failed: 'hot', interrupted: 'stale' }
const STEP_LABEL = { running: 'Running', done: 'Done', error: 'Failed', interrupted: 'Interrupted', unreported: 'Unreported' }
const formatModel = m => m ? String(m).replace('claude-', '') : 'Model pending'
// A child row shares its data-session with the parent that owns it, so the session
// id alone is not a unique row key: folding in data-delegation is what tells a
// delegation row apart from its parent when the list redraws underneath focus.
// The fold header shares no data-session with anything, so it needs a key of its own:
// without one it reads as unkeyed and the poll two seconds after a click would drop
// the focus ring off the control the operator just used.
const rowFocusKey = b => b.dataset.foldSession ? `fold::${b.dataset.foldSession}` : b.dataset.delegation ? `${b.dataset.session}::${b.dataset.delegation}` : b.dataset.session || b.dataset.filter
function update(id, html) {
  const el = $(id)
  if (!el || el.innerHTML === html) return
  const active = document.activeElement
  const focusKey = el.contains(active) ? rowFocusKey(active) : null
  const top = el.scrollTop
  const responseTop = el.querySelector('.response')?.scrollTop || 0
  el.innerHTML = html
  el.scrollTop = top
  if (el.querySelector('.response')) el.querySelector('.response').scrollTop = responseTop
  if (focusKey) [...el.querySelectorAll('button')].find(b => rowFocusKey(b) === focusKey)?.focus({ preventScroll: true })
}
function status(s) {
  // A Fleet conversation resumed in a terminal is driven there, whatever Fleet last recorded.
  if (s.managed && s.openElsewhere) {
    const where = s.openElsewhere.entrypoint === 'cli' ? 'In terminal' : 'Elsewhere'
    const title = `Open ${s.openElsewhere.entrypoint === 'cli' ? 'in a terminal' : 'in another program'}${s.openElsewhere.name ? ' (' + s.openElsewhere.name + ')' : ''}${s.openElsewhere.state === 'busy' ? ', working' : ', idle'}`
    return `<span class="badge elsewhere ${s.openElsewhere.state === 'busy' ? 'busy' : ''}" title="${esc(title)}"><span class="dot"></span>${where}</span>`
  }
  // A queued session is waiting for a free agent, not idle. Its state is 'idle' so the
  // fleet counts stay the four they have always been, which is exactly why the badge has
  // to say otherwise — and say how far down the queue it is, since "Queued" alone leaves
  // the operator wondering whether anything is going to happen.
  const label = s.managed ? ({starting:'Starting',running:'Working',approval:'Needs approval',stopping:'Stopping',stopped:'Stopped',error:'Error',queued:`Queued${s.queuePosition ? ` · ${ordinal(s.queuePosition)}` : ''}`,idle:'Ready'})[s.managedStatus] : LABELS[s.state]
  return `<span class="badge ${s.managedStatus === 'approval' ? 'stale' : s.managedStatus === 'error' ? 'hot' : s.managedStatus === 'queued' ? 'dead' : s.state}"><span class="dot"></span>${label}</span>`
}
// The row's third line is the story of the latest turn, the way a CI job row shows
// its steps: one segment per tool call coloured by the family of work, red where it
// failed; then the step in progress (or the last one), then how long the turn has run.
const isWorkingRow = s => s.openElsewhere ? s.openElsewhere.state === 'busy' : s.managed ? ['starting','running','stopping'].includes(s.managedStatus) : s.state === 'busy'
const STEP_ICON = { inspect: '▤', change: '✎', run: '⚡', delegate: '✳', ask: '?', other: '▸' }
const STEP_WORD = { inspect: 'inspecting', change: 'changing files', run: 'running commands', delegate: 'delegating', ask: 'asking', other: 'other' }
const stepCategory = name => ['Read','Grep','Glob','LS','WebFetch','WebSearch'].includes(name) ? 'inspect' : ['Edit','Write','MultiEdit','NotebookEdit'].includes(name) ? 'change' : ['Bash','BashOutput','KillShell'].includes(name) ? 'run' : ['Task','Skill','Agent'].includes(name) ? 'delegate' : ['AskUserQuestion','ExitPlanMode','EnterPlanMode'].includes(name) ? 'ask' : 'other'
const elapsed = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}s` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`
// What a managed conversation has cost so far. Only Fleet's own runs report a cost, so a
// monitored terminal session shows nothing rather than a misleading zero. Fractions of a
// cent round to $0.00 and read as broken, so anything non-zero but tiny says so instead.
const money = value => !(value > 0) ? null : value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`
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

// A Task-tool sub-agent never gets a process of its own, so this is the only row it
// ever gets: nested under the session that ran it, for as long as that session lives.
function childRowHtml(s, d) {
  const cls = DELEGATION_BADGE[d.status] || ''
  const label = DELEGATION_LABEL[d.status] || d.status
  return `<button class="session session-child" data-session="${esc(key(s))}" data-delegation="${esc(d.id)}" aria-pressed="${selectedChild === d.id}" aria-controls="detail"><span><span class="session-top"><span class="badge ${cls}"><span class="dot"></span>${esc(label)}</span><span class="session-name"><i class="ico ico-pr" aria-hidden="true"></i> ${esc(d.role)}</span></span><span class="session-title">${esc(formatModel(d.model))}</span></span><span class="session-context"></span></button>`
}
// A session's sub-agents fold away behind a header of their own. An initiative can sit
// between two sessions with twenty delegation rows wedged in the gap, which buries the
// list those rows belong to. Folding is per session and remembered, so putting one
// team's sub-agents away leaves every other team's on screen.
const COLLAPSED_KEY = 'fleet:children-collapsed'
let collapsedChildren = new Set()
try { collapsedChildren = new Set(JSON.parse(store.get(COLLAPSED_KEY) || '[]')) } catch { collapsedChildren = new Set() }
const childGroupId = k => `children-${String(k).replace(/[^\w-]/g, '_')}`
function setChildrenCollapsed(k, collapsed) {
  if (collapsed) collapsedChildren.add(k)
  else collapsedChildren.delete(k)
  // Sessions come and go; only the folds still worth honouring are worth storing.
  store.set(COLLAPSED_KEY, JSON.stringify([...collapsedChildren].slice(-200)))
}
// The header names the group and carries the fold. It is a sibling of the session
// row rather than part of it because that row is itself a button, and a button
// cannot hold another one.
function childToggleHtml(s, collapsed) {
  const all = s.delegations || []
  const running = all.filter(d => d.status === 'running').length
  const failed = all.filter(d => d.status === 'failed').length
  const counts = [`${all.length} sub-agent${all.length === 1 ? '' : 's'}`, running ? `${running} working` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ')
  return `<button class="session-children-toggle${collapsed ? ' is-collapsed' : ''}" data-fold-session="${esc(key(s))}" aria-expanded="${!collapsed}" aria-controls="${esc(childGroupId(key(s)))}"><span class="children-chevron" aria-hidden="true">›</span><span class="children-count"><i class="ico ico-pr" aria-hidden="true"></i> ${esc(counts)}</span></button>`
}
// An initiative that runs long enough accumulates delegations without bound; the
// row list stays a list, not a scrollbar of its own, by showing only the tail.
const CHILD_ROW_LIMIT = 20
const childRowsHtml = s => {
  const all = s.delegations || []
  if (!all.length) return ''
  // A fold never hides the one row the list reads as selected: clicking the header
  // hands the selection back to the session first, and a group still holding the
  // selected delegation by any other route draws open however it was left.
  const collapsed = collapsedChildren.has(key(s)) && !all.some(d => d.id === selectedChild)
  const group = `<div class="session-children" id="${esc(childGroupId(key(s)))}"${collapsed ? ' hidden' : ''}>${collapsed ? '' : childTailHtml(s)}</div>`
  return childToggleHtml(s, collapsed) + group
}
const childTailHtml = s => {
  const all = s.delegations || []
  const recent = all.length > CHILD_ROW_LIMIT ? all.slice(-CHILD_ROW_LIMIT) : all
  // The parent row has already handed its aria-pressed to session-ancestor, so a
  // selected delegation that aged out of the tail must still be drawn here, however
  // old it is, or nothing in the list reads as selected at all.
  const selectedOutside = selectedChild && !recent.some(d => d.id === selectedChild) ? all.find(d => d.id === selectedChild) : null
  const shown = selectedOutside ? [selectedOutside, ...recent] : recent
  const earlier = all.length - shown.length
  // The list is oldest-first, so what got cut is the oldest end of it: the marker
  // belongs ahead of the rows that survived, not trailing the newest one. It is a
  // plain, non-interactive node in the reading order — no role, no aria-hidden — so
  // it is announced once when it appears rather than looping as a live region or
  // vanishing from every screen reader that ignores an injected one.
  return (earlier ? `<div class="session-child-more">+${earlier} earlier</div>` : '') + shown.map(d => childRowHtml(s, d)).join('')
}

// ── Account usage ─────────────────────────────────────────────────────────────
// The plan windows belong to the account, not to a session: every Claude process on
// this machine draws on them, including the terminal sessions Fleet only watches. The
// bar says so, and it uses the same thresholds and colours as context pressure so
// "nearly full" reads the same way everywhere.
const WINDOW_WORD = { five_hour:'five-hour', seven_day:'weekly', seven_day_opus:'weekly Opus', seven_day_sonnet:'weekly Sonnet', seven_day_oauth_apps:'weekly apps' }
const BLOCK_REASON = {
  org_spend_cap_reached:'organisation spend cap reached', out_of_credits:'out of credits',
  overage_not_provisioned:'no overage configured', org_level_disabled:'overage off for this organisation',
  member_level_disabled:'overage off for this member', no_limits_configured:'no overage limits set',
  fetch_error:'usage lookup failed',
}
const clockAt = ms => new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
const untilReset = (ms, now) => {
  const left = ms - now
  if (left <= 0) return 'any moment'
  return left < 3600000 ? `${Math.max(1, Math.round(left / 60000))}m` : `${Math.floor(left / 3600000)}h ${Math.round(left % 3600000 / 60000)}m`
}
const blockReason = r => BLOCK_REASON[r] || (r ? String(r).replace(/_/g, ' ') : null)
const windowWord = name => WINDOW_WORD[name] || String(name || '').replace(/_/g, ' ')
function usageHtml(usage, now) {
  // Unknown is not zero. With nothing measured, and on an API key or a third-party
  // provider where plan limits do not apply at all, the cluster is simply absent.
  if (!usage || !usage.available || !usage.known) return ''
  const blocked = usage.blocked
  const blockedHtml = blocked ? `<span class="usage-blocked hot" title="A request was refused by this window. Every Claude session on this machine is affected until it resets.">⊘ Rate limited · ${esc(windowWord(blocked.rateLimitType))} window · resets ${clockAt(blocked.resetsAt)} (${untilReset(blocked.resetsAt, now)})${blockReason(blocked.reason) ? ` · ${esc(blockReason(blocked.reason))}` : ''}</span>` : ''
  const binding = usage.windows.find(w => w.name === usage.binding) || usage.windows[0]
  // A block with no window reading has no number to draw, and a made-up one is worse.
  if (!binding) return blockedHtml
  const cls = heat(binding.utilization)
  // Past 90% the countdown is the decision, so it replaces the reset clock. The gauge
  // itself never goes away: it is the one thing that reads at a glance in every state.
  const critical = binding.utilization >= 90
  const reset = binding.resetsAt ? (critical ? `${untilReset(binding.resetsAt, now)} left` : `resets ${clockAt(binding.resetsAt)}`) : ''
  const detail = [
    usage.subscription ? `Plan: ${usage.subscription}.` : '',
    'Account-wide, including the terminal sessions Fleet only watches.',
    usage.observedAt ? `Last read ${clockAt(usage.observedAt)}.` : '',
  ].filter(Boolean).join(' ')
  // One gauge, on whichever window is closest to stopping the fleet. The rest are bare
  // numbers: a second gauge would just be a second thing to look at.
  const others = usage.windows.filter(w => w !== binding)
    .map(w => `<span class="usage-other ${heat(w.utilization)}"><b>${esc(w.label)}</b> ${w.utilization}%</span>`).join('')
  const gauge = `<span class="usage-gauge ${cls}" role="meter" aria-label="${esc(windowWord(binding.name))} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${binding.utilization}"><i style="width:${binding.utilization}%"></i></span>`
  return `<span class="usage-window ${cls}${usage.stale ? ' is-stale' : ''}" title="${esc(detail)}"><b>${esc(binding.label)}</b>${gauge}<span class="usage-pct">${binding.utilization}%</span><small class="usage-reset${critical ? ' is-critical' : ''}">${reset}</small></span>${others}${blockedHtml}${usage.stale && usage.observedAt ? `<small class="usage-stale" title="Utilisation only updates while a Fleet agent is running.">as of ${clockAt(usage.observedAt)}</small>` : ''}`
}
function renderStatusbar(usage, sessions) {
  const now = Date.now()
  update('status-usage', usageHtml(usage, now))
  const managed = sessions.filter(s => s.managed && !s.archived)
  const waiting = managed.filter(s => s.managedStatus === 'approval').length
  const working = sessions.filter(s => !s.archived && isWorkingRow(s)).length
  update('status-fleet', [
    `<span>${working} working</span>`,
    waiting ? `<span class="warn">${waiting} needs you</span>` : '',
  ].filter(Boolean).join('<span class="status-sep" aria-hidden="true">·</span>'))
  // The same wall, said where it changes a decision: in the dialog that starts agents.
  const banner = $('launch-blocked')
  if (banner) {
    banner.hidden = !usage?.blocked
    if (usage?.blocked) banner.textContent = `Rate limited until ${clockAt(usage.blocked.resetsAt)} (${untilReset(usage.blocked.resetsAt, now)}). A new agent will not get past its first message until this window resets.`
  }
}

// ── The session row ─────────────────────────────────────────────────────────
// One row is four lines: what the agent is and how it is doing, what it was asked,
// where it is working, and the story of its latest turn. Each line is built by its
// own function, so changing the look of one does not mean reading the other three.

// Line one, after the status badge: the qualifiers that say this row is not an
// ordinary foreground session you started yourself.
function rowTags(s, spawnCounts) {
  const spawned = spawnCounts.get(s.pid)
  return [
    spawned ? `<span class="spawn-badge" title="Running ${spawned} background session(s)"><i class="ico ico-pr" aria-hidden="true"></i> ${spawned}</span>` : '',
    s.background ? `<span class="spawn-owner" title="Started by ${esc(s.spawnedByName || 'a program')}, not from a terminal">via ${esc(s.spawnedByName || 'a program')}</span>` : '',
    s.archived ? '<span class="archived-tag" title="Archived. Hidden from your fleet, still on disk and still resumable.">archived</span>' : '',
    s.engine === 'codex' ? '<span class="engine-tag" title="A Codex session">Codex</span>' : '',
  ].join('')
}
// A team session says which team is running it and how far through its tasks it is.
function initiativeTag(s) {
  if (s.kind === 'day') {
    const p = s.dayProgress
    return `<span class="initiative-tag day-tag">Day${p ? ` · ${p.done}/${p.total} done${p.waiting ? ` · ${p.waiting} waiting on you` : ''}${p.proposed ? ` · ${p.proposed} to triage` : ''}` : ''}</span>`
  }
  if (s.kind !== 'initiative') return ''
  const p = s.taskProgress
  const progress = p ? ` · ${p.verified}/${p.total} verified${p.blocked ? ` · ${p.blocked} need attention` : ''}` : ''
  return `<span class="initiative-tag">Initiative · ${esc(s.teamName || s.teamId || 'Team')}${progress}</span>`
}
// Where the work is happening.
function rowMeta(s) {
  const project = s.cwd?.split('/').filter(Boolean).pop() || 'No project'
  return `<span class="session-meta"><span>${esc(project)}</span><span class="branch"><i class="ico ico-pr" aria-hidden="true"></i> ${esc(s.branch || 'No branch')}</span>${s.links?.length ? `<span><i class="ico ico-arrow" aria-hidden="true"></i> ${s.links.length}</span>` : ''}</span>`
}
// The right-hand column: how full the context window is, and how long ago the
// agent last did anything.
function contextCell(s) {
  const p = percent(s)
  return `<span class="session-context ${heat(p)}">${p === null ? '—' : Math.round(p) + '%'}<span class="mini-bar"><i class="${heat(p)}" style="width:${p || 0}%"></i></span><small>${age(s.lastActivity)} ago</small></span>`
}
// ── Pixel avatars ─────────────────────────────────────────────────────────────
// A session's avatar is a dot matrix in its own colour: its initial drawn in bright
// pixels over a field of dimmer ones that brighten from left to right. While the agent
// works, the pixels twinkle. Each pixel's twinkle phase is taken from the clock, not
// from when the row was drawn, so the list re-rendering every couple of seconds never
// restarts the animation.
const GLYPHS = {
  A:'0111010001111111000110001', B:'1111010001111101000111110', C:'0111110000100001000001111', D:'1111010001100011000111110',
  E:'1111110000111101000011111', F:'1111110000111101000010000', G:'0111110000100111000101111', H:'1000110001111111000110001',
  I:'1111100100001000010011111', J:'0011100010000101001001100', K:'1001010100110001010010010', L:'1000010000100001000011111',
  M:'1000111011101011000110001', N:'1000111001101011001110001', O:'0111010001100011000101110', P:'1111010001111101000010000',
  Q:'0111010001101011001001101', R:'1111010001111101001010001', S:'0111110000011100000111110', T:'1111100100001000010000100',
  U:'1000110001100011000101110', V:'1000110001100010101000100', W:'1000110001101011101110001', X:'1000101010001000101010001',
  Y:'1000101010001000010000100', Z:'1111100010001000100011111', 0:'0111010011101011100101110', 1:'0010001100001000010001110',
  2:'1111000001011101000011111', 3:'1111000001001100000111110', 4:'1001010010111110001000010', 5:'1111110000111100000111110',
  6:'0111010000111101000101110', 7:'1111100001000100010000100', 8:'0111010001011101000101110', 9:'0111010001011110000101110',
}
const AVATAR_TONES = ['#a8d8bf', '#b9b2ff', '#e6c891', '#9fcbe8', '#eba9b8']
// A small deterministic generator, so a session's pattern is the same on every render.
function seeded(text) {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000 }
}
// The 7 cells span the whole 38px tile edge to edge with 1px gaps. 38 does not divide
// by 7, so cell edges are rounded to whole pixels (cells are 4 or 5 wide) and stay crisp.
// A fine 9×9 dot matrix filling the tile, each pixel on whole screen pixels so it stays
// crisp; the 5×5 letter sits in the middle.
const AVATAR_GRID = 9
const AVATAR_EDGES = Array.from({ length: AVATAR_GRID + 1 }, (_, i) => Math.round(i * 39 / AVATAR_GRID))
function pixelAvatar(seed, initial, tone, working) {
  const rand = seeded(seed), glyph = GLYPHS[initial] || null, now = Date.now() / 1000, cells = []
  for (let y = 0; y < AVATAR_GRID; y++) for (let x = 0; x < AVATAR_GRID; x++) {
    const gx = x - 2, gy = y - 2
    const inGlyph = !!glyph && gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && glyph[gy * 5 + gx] === '1'
    const r = rand()
    // Dim field, brighter towards the right; a few lit "stars"; the letter on top.
    const base = inGlyph ? 0.95 : Math.min(0.45, 0.05 + r * 0.11 + (x / (AVATAR_GRID - 1)) * 0.12 + (r > 0.95 ? 0.24 : 0)) + (working && !inGlyph ? 0.08 : 0)
    let motion = ''
    if (working) {
      const length = 1.4 + rand() * 1.8, phase = rand() * length
      // The field breathes and many pixels flare like stars, bright enough to read as
      // "working" from across the list; the letter pulses within a readable range.
      const high = inGlyph ? 0.72 : rand() > 0.6 ? 0.95 : Math.min(0.55, base * 2.4 + 0.1)
      motion = ` style="--o:${base.toFixed(2)};--hi:${high.toFixed(2)};animation-duration:${length.toFixed(2)}s;animation-delay:-${((now + phase) % length).toFixed(2)}s"`
    }
    const x0 = AVATAR_EDGES[x], y0 = AVATAR_EDGES[y]
    cells.push(`<rect x="${x0}" y="${y0}" width="${AVATAR_EDGES[x + 1] - 1 - x0}" height="${AVATAR_EDGES[y + 1] - 1 - y0}" rx=".6" opacity="${base.toFixed(2)}"${motion}/>`)
  }
  // Working, a band of light also sweeps across the pixels. Its phase comes from the
  // clock too, so the list redrawing does not restart it.
  const sweep = working ? `<defs><linearGradient id="sweep-${tone}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect class="avatar-sweep" x="-38" y="0" width="38" height="38" fill="url(#sweep-${tone})" style="animation-delay:-${(now % 2.8).toFixed(2)}s"/>` : ''
  return `<svg class="avatar-pixels" viewBox="0 0 38 38" shape-rendering="crispEdges" fill="${AVATAR_TONES[tone]}" aria-hidden="true">${cells.join('')}${sweep}</svg>`
}
// Draft contents survive modal dismissal until launch or explicit discard.
let draftOpen = false
function sessionRowHtml(s, spawnCounts) {
  // A row holding the selected sub-agent is an ancestor of the selection, not the
  // selection itself, so it gives up aria-pressed to the child row below it.
  const childSelectedHere = !!selectedChild && (s.delegations || []).some(d => d.id === selectedChild)
  const name = s.name || s.shortId || 'Unnamed session'
  const top = `<span class="session-top">${hasUnseen(s) ? '<span class="unseen" aria-label="New output"></span>' : ''}${status(s)}${name !== s.title ? `<span class="session-name">${esc(name)}</span>` : ''}${rowTags(s, spawnCounts)}</span>`
  const title = `<span class="session-title">${esc(s.title || s.lastPrompt || 'Untitled session')}</span>`
  const preview = s.latestResponse || s.lastPrompt || 'Ready for your next idea'
  const initial = (s.title || s.name || 'F').trim().slice(0, 1).toUpperCase()
  const tone = [...key(s)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5
  const working = isWorkingRow(s)
  const avatar = `<span class="agent-avatar avatar-${tone}${working ? ' is-working' : ''}" style="--tone:${AVATAR_TONES[tone]}${working ? `;animation-delay:-${((Date.now() / 1000) % 2.4).toFixed(2)}s` : ''}" aria-hidden="true">${pixelAvatar(key(s), initial, tone, working)}<i class="avatar-status ${s.managedStatus === 'approval' ? 'stale' : s.state}"></i></span>`
  const body = `<span class="session-title-row">${title}</span><span class="session-preview">${esc(preview)}</span>${top}${initiativeTag(s)}${rowMeta(s)}${turnRow(s)}`
  return `<button class="session${childSelectedHere ? ' session-ancestor' : ''}" draggable="true" data-session="${esc(key(s))}" aria-pressed="${selected === key(s) && !childSelectedHere}" aria-controls="detail" title="${hasUnseen(s) ? 'New output since you last opened this' : ''}">${avatar}<span class="session-summary">${body}</span>${contextCell(s)}</button>${childRowsHtml(s)}`
}
// The trigger names whichever combination is active instead of repeating every
// count Sessions' own header badge already shows.
// The one chevron every dropdown-shaped control uses, native <select> arrows included
// (see the `select` rule in styles.css) — inline so it inherits color via currentColor
// instead of guessing a font's ⌄ baseline.
const DROPDOWN_CHEVRON = '<svg class="filter-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const filterTriggerLabel = () => {
  const base = filter === 'all' ? 'All sessions' : filter === 'background' ? 'Background' : filter === 'archived' ? 'Archived' : LABELS[filter]
  return dateFilter === 'all' ? base : `${base} · ${DATE_LABELS[dateFilter]}`
}
const filterMenuHtml = (counts, foreground, background, archived, dateCounts) => `<button type="button" class="filter-trigger" id="filter-trigger" aria-haspopup="menu" aria-expanded="${filterMenuOpen}" aria-controls="filter-panel">${esc(filterTriggerLabel())}${DROPDOWN_CHEVRON}</button><div class="filter-panel" id="filter-panel" role="menu" aria-label="Filter sessions"${filterMenuOpen ? '' : ' hidden'}><div class="filter-group" role="group" aria-label="Status">${[
  ['all', 'All sessions', foreground],
  ...STATES.map(s => [s, LABELS[s], counts[s] || 0]),
  ...(background ? [['background', 'Background', background]] : []),
  ...(archived ? [['archived', 'Archived', archived]] : []),
].map(([s, label, n]) => `<button type="button" class="filter" data-filter="${s}" aria-pressed="${filter === s}">${label}<span>${n}</span></button>`).join('')}</div><div class="filter-group"><span class="filter-group-heading">Created</span>${['all', ...DATE_FILTERS].map(k => `<button type="button" class="filter" data-date-filter="${k}" aria-pressed="${dateFilter === k}">${DATE_LABELS[k]}<span>${dateCounts[k]}</span></button>`).join('')}</div></div>`
const emptyListHtml = total =>
  filter === 'background' ? 'No background sessions right now.'
  : total ? 'No sessions match your filters.<br>Try another search or select All sessions.'
  : 'Your fleet is quiet.<br>Start a Claude Code session and it will appear here automatically.'

function render() {
  if (!snapshot) return
  renderedAt = Date.now()
  const {sessions, total} = snapshot
  // Archived sessions are put away, not deleted: they leave every count and every
  // filter but their own, and the transcript behind them is untouched.
  const archived = sessions.filter(s => s.archived)
  const live = sessions.filter(s => !s.archived)
  // A Day is not one of your agents: it lives in the Today tab, never in these lists.
  const days = live.filter(s => s.kind === 'day')
  // An item's thread belongs to Today while its item is open; once settled it is an
  // ordinary past conversation and shows up here, resumable like any other.
  // A project's manager lives in the Projects tab, like a Day lives in Today.
  const agents = live.filter(s => s.kind !== 'day' && s.kind !== 'project' && !(s.kind === 'thread' && s.threadOpen))
  const background = agents.filter(s => s.background)
  // How many spawned sessions each visible session is running, for its row badge.
  const spawnCounts = new Map()
  for (const s of background) if (s.spawnedByPid) spawnCounts.set(s.spawnedByPid, (spawnCounts.get(s.spawnedByPid) || 0) + 1)
  const foreground = agents.filter(s => !s.background)
  const visibleCounts = { busy:0, idle:0, stale:0, dead:0 }
  for (const s of foreground) visibleCounts[s.state] = (visibleCounts[s.state] || 0) + 1
  // Restoring the last archived session should not strand you on an empty filter.
  if (filter === 'archived' && !archived.length) filter = 'all'
  const pool = filter === 'archived' ? archived : filter === 'background' ? background : foreground
  // Ordering comes from the server (approval, then busy, then most recent) and
  // finding a specific session is what the Ask modal is for.
  // The Today tab shows exactly one conversation, today's Day, or none before it starts.
  const today = window.FleetDay?.active() ? window.FleetDay.current(days, live) : window.FleetProjects?.active() ? window.FleetProjects.current(live) : undefined
  const shown = today !== undefined ? (today ? [today] : []) : pool.filter(s => (filter === 'all' || filter === 'background' || filter === 'archived' || s.state === filter) && matchesDate(s, dateFilter))

  if (!shown.some(s => key(s) === selected)) selected = shown[0] ? key(shown[0]) : null
  $('shown-count').textContent = shown.length
  renderStatusbar(snapshot.usage, live)
  // Date counts sit against the foreground pool, same base the status counts use,
  // so switching status tabs never makes these numbers jump for an unrelated reason.
  const dateCounts = { all: foreground.length, today: foreground.filter(s => matchesDate(s, 'today')).length, week: foreground.filter(s => matchesDate(s, 'week')).length }
  update('filters', filterMenuHtml(visibleCounts, foreground.length, background.length, archived.length, dateCounts))
  renderArchiveBar(live.filter(s => s.state === 'dead'), archived.length)
  update('session-list', (shown.length
    ? shown.map(s => sessionRowHtml(s, spawnCounts)).join('')
    : `<div class="empty">${emptyListHtml(total)}</div>`))
  const current = shown.find(s => key(s) === selected)
  if (current) markSeen(key(current), current.lastActivity)
  // A delegation belongs to whichever session is actually current; switching sessions,
  // or the owning session dropping out of the current filter, clears a stale child pick.
  const childId = selectedChild && current?.delegations?.some(d => d.id === selectedChild) ? selectedChild : null
  selectedChild = childId
  // A fresh fetch on every genuine transition, including back to a child left moments
  // ago: childDetailFor otherwise still names it "loaded" even after its cache was
  // cleared by the visit in between, and the view would be stuck on "Loading…".
  if (childId !== lastChildId) {
    lastChildId = childId
    if (childId) { childDetail = null; childDetailFor = null; childDetailError = null; loadChildDetail(current.managedId, childId) }
  }
  if (childId) {
    renderChildDetail(current, childId)
    window.FleetReview?.show(null)
    // A sub-agent is not addressable: clearing the control panel drops its composer
    // and conversation from the DOM entirely, not merely hiding them.
    window.FleetControl?.selectControl(null)
  } else {
    renderDetail(current)
    window.FleetControl?.selectControl(current)
  }
  syncDetails()
  window.FleetDay?.render(days)
  window.FleetProjects?.render(live)
  window.FleetProgress?.render()
  window.FleetWorktrees?.render()
}
// ── The archive ──────────────────────────────────────────────────────────────
// Putting a session away hides its row and nothing else: the transcript stays in
// ~/.claude, `claude --resume` still reaches it, and Ask still finds it. One age
// threshold serves both the one-off sweep and the standing rule, so the button and
// the checkbox can never disagree about what "old" means.
const DAY_MS = 86400000
const SWEEP_DAYS = [3, 7, 14, 30]
const archiveRule = () => (snapshot && snapshot.archiveRule) || { enabled: false, days: 14 }
const sweepTargets = () => {
  const cutoff = Date.now() - archiveRule().days * DAY_MS
  return (snapshot ? snapshot.sessions : []).filter(s => !s.archived && !s.managed && s.state === 'dead' && s.sessionId && s.lastActivity && s.lastActivity < cutoff)
}
// Boolean attributes are written the way the browser serialises them, so an
// unchanged bar compares equal and a refresh never closes an open dropdown.
function renderArchiveBar(offline, archivedCount) {
  const bar = $('archive-bar')
  if (!bar) return
  if (filter !== 'dead' && filter !== 'archived') { bar.hidden = true; return }
  bar.hidden = false
  if (filter === 'archived') return update('archive-bar', `<span class="archive-text">${archivedCount} session${archivedCount === 1 ? '' : 's'} put away. Each one still resumes in a terminal and still answers an Ask.</span><button class="button" id="archive-restore-all">Restore all</button>`)
  const rule = archiveRule()
  const stale = offline.filter(s => s.lastActivity && Date.now() - s.lastActivity > rule.days * DAY_MS).length
  // A stored threshold that is not one of the presets is still offered, so the
  // dropdown can never show a different number than the rule is actually using.
  const days = [...new Set([...SWEEP_DAYS, rule.days])].sort((a, b) => a - b)
  update('archive-bar', `<span class="archive-text">Archive offline sessions untouched for over</span><select id="archive-days" class="archive-days" aria-label="Age after which an offline session counts as old">${days.map(d => `<option value="${d}"${d === rule.days ? ' selected=""' : ''}>${d} days</option>`).join('')}</select>${stale ? `<button class="button" id="archive-sweep">Archive ${stale}</button>` : '<span class="archive-none">Nothing that old</span>'}<label class="archive-auto"><input type="checkbox" id="archive-rule"${rule.enabled ? ' checked=""' : ''}> Keep tidying automatically</label>`)
}
async function setArchived(ids, archived) {
  if (!ids.length) return
  try {
    await api('/api/archive', { ids, archived })
    toast(`${ids.length} session${ids.length === 1 ? '' : 's'} ${archived ? 'archived' : 'restored'}`)
    await tick()
  } catch (error) { toast(error.message || 'Could not update the archive.') }
}
document.addEventListener('change', async event => {
  const target = event.target
  if (target.id !== 'archive-days' && target.id !== 'archive-rule') return
  const rule = archiveRule()
  try {
    await api('/api/archive/rule', target.id === 'archive-days'
      ? { enabled: rule.enabled, days: Number(target.value) }
      : { enabled: target.checked, days: rule.days })
    await tick()
  } catch (error) { toast(error.message || 'Could not save the archive rule.') }
})
function renderDetail(s) {
  const UI = window.FleetUI
  window.FleetReview?.show(s)
  if (!s) { update('detail-content', UI.empty({ title: 'The full picture.', text: 'Select a session to inspect it.' })); return }
  const p = percent(s)
  const links = (s.links || []).filter(l => /^https:\/\/(github\.com|linear\.app)\//.test(l.url))
  const facts = [['Project',s.cwdShort],['Branch',s.branch],['Model',s.model?.replace('claude-','')],['Permissions',s.permissionMode || 'Default'],['Control',s.managed ? 'Fleet-managed' : s.alive ? 'Terminal · monitor only' : 'Saved · ready to continue'],['Session',s.sessionId]]
  const strip = [
    UI.stat('Context', p === null ? 'Not available' : `${UI.bar(p)}${Math.round(p)}% <small>${tokens(s.contextTokens)} / ${tokens(s.contextLimit)}</small>`, { tone: p === null ? 'quiet' : heat(p) || undefined }),
    UI.stat('Active', `${age(s.lastActivity)} <small>ago</small>`),
    UI.stat('Messages', esc(s.messages ?? 0)),
    s.model ? UI.stat('Model', esc(s.model.replace('claude-',''))) : '',
  ].join('')
  const actions = `${status(s)}${s.managed || !s.sessionId ? '' : `<button class="button ghost" id="toggle-archive">${s.archived ? 'Restore' : 'Archive'}</button>`}${s.resumeCmd && !s.managed ? '<button class="button ghost" id="copy-resume">Copy resume command</button>' : ''}`
  const body = [
    p >= 75 ? UI.callout(p >= 90 ? 'Context nearly full' : 'Context is getting full', p >= 90 ? 'Compaction may happen soon.' : '', { tone: 'needs' }) : '',
    s.managed ? '' : UI.section('Latest response', `<div class="response ${s.latestResponse ? '' : 'missing'}">${esc(s.latestResponse || 'No assistant response recorded yet.')}</div>`, { aside: s.latestResponseAt ? `${age(s.latestResponseAt)} ago` : '' }),
    s.lastPrompt && !s.managed ? UI.section('Latest request', `<div class="response">${esc(s.lastPrompt)}</div>`) : '',
    UI.section('Linked work', links.length ? `<div class="links">${links.map(l => `<a class="work-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${l.kind === 'pr' ? '<i class="ico ico-pr" aria-hidden="true"></i>' : '<i class="ico ico-ticket" aria-hidden="true"></i>'} ${esc(l.label)} <i class="ico ico-arrow" aria-hidden="true"></i></a>`).join('')}</div><p class="note">Recorded references, not live status.</p>` : '<p class="note">GitHub PR and Linear issue URLs appear here when mentioned in the conversation.</p>', { aside: 'From transcript' }),
    UI.section('Environment', `<dl class="facts">${facts.map(([label,value]) => `<dt>${label}</dt><dd>${esc(value ?? '—')}</dd>`).join('')}</dl>`),
    s.transcriptTruncated ? '<p class="note">Showing the most recent 6 MB of this transcript. Earlier responses and links may be absent.</p>' : '',
    s.archived ? '<p class="note archived-note">Archived. Hidden from your fleet, still on disk, still resumable and still searchable.</p>' : '',
  ].join('')
  update('detail-content', `${UI.pageHead({ title: esc(s.title || s.name || 'Untitled session'), actions, strip, cls: 'detail-head' })}<div class="page-body detail-body">${body}</div>`)
}
// A sub-agent's row: its mandate, its returned report and the steps it actually took.
// Read only — there is no composer here and nothing that could send it more input.
function renderChildDetail(s, delegationId) {
  const compact = s.delegations?.find(d => d.id === delegationId)
  if (!compact) return
  const full = childDetailFor === delegationId ? childDetail : null
  // The list poll and the session-detail fetch land independently; the list is the
  // one running every couple of seconds, so its status is never staler than the
  // detail fetch's, and the badge should never lag a row it sits right next to.
  const state = compact.status
  const cls = DELEGATION_BADGE[state] || ''
  const label = DELEGATION_LABEL[state] || state
  const steps = full?.steps || []
  const openedSteps=new Set([...document.querySelectorAll('[data-child-step][open]')].map(el=>el.dataset.childStep))
  const focusedStep=document.activeElement?.closest('[data-child-step]')?.dataset.childStep
  const usage=full?.usage
  const usageText=usage ? `${tokens(usage.input_tokens || 0)} input · ${tokens(usage.output_tokens || 0)} output · ${tokens(usage.cache_read_input_tokens || 0)} cache read · ${tokens(usage.cache_creation_input_tokens || 0)} cache write` : full?.runtimeUsage?.total_tokens != null ? `${tokens(full.runtimeUsage.total_tokens)} tokens reported` : 'Token usage not reported'
  const duration=full?.startedAt ? elapsed((full.finishedAt || Date.now())-full.startedAt) : 'Duration unavailable'

  // Selecting a child tears down the console, so an approval sitting on the owning
  // session would otherwise wait in total silence. A notice only: nothing here can
  // answer it, so it just points the operator back to the row that can.
  const approvalNotice = s.managedStatus === 'approval' ? `<p class="note child-approval-notice">${esc(s.name || s.title || 'This session')} needs your approval to continue. Select its row above to respond — this read-only view can’t.</p>` : ''
  const stepsHtml = steps.length ? `<ol class="child-steps">${steps.map(step => `<li class="child-step" data-status="${esc(step.status)}"><span class="child-step-tool">${esc(step.tool)}</span>${step.target ? `<span class="child-step-target">${esc(step.target)}</span>` : ''}<span class="child-step-state">${esc(STEP_LABEL[step.status] || step.status)}</span><span class="child-step-time">${step.ms != null ? elapsed(step.ms) : step.status === 'running' ? 'running…' : ''}</span>${step.input != null || step.result != null ? `<details class="child-step-detail" data-child-step="${esc(step.id)}" ${openedSteps.has(step.id) ? 'open':''}><summary>Input and output</summary><h4>Input</h4><pre>${esc(step.input == null ? 'Not recorded' : typeof step.input === 'string' ? step.input : JSON.stringify(step.input,null,2))}</pre><h4>Output${step.truncated ? ' · truncated':''}</h4><pre>${esc(step.result ?? 'No result reported yet.')}</pre></details>`:''}</li>`).join('')}</ol>` : `<p class="note">${full ? 'No tool steps recorded.' : 'Loading steps…'}</p>`
  update('detail-content', `${window.FleetUI.pageHead({ title: `<i class="ico ico-pr" aria-hidden="true"></i> ${esc(compact.role)}`, actions: `<span class="ui-pill">Sub-agent · read only</span><span class="badge ${cls}"><span class="dot"></span>${esc(label)}</span>`, strip: `${window.FleetUI.stat('Model', esc(formatModel(full?.model || compact.model)))}${window.FleetUI.stat('Duration', esc(duration))}${full?.attempt ? window.FleetUI.stat('Attempt', esc(full.attempt)) : ''}`, cls: 'detail-head' })}<div class="page-body detail-body">${approvalNotice}<p class="note">${esc(usageText)}.</p><section class="ui-section"><h4 class="ui-label">Mandate</h4><div class="response">${esc(full ? (full.prompt || 'No mandate recorded.') : 'Loading…')}</div></section><section class="ui-section"><h4 class="ui-label">Steps${full?.stepsTruncated ? '<span class="ui-label-aside">Showing the most recent 200</span>' : ''}</h4>${stepsHtml}</section><section class="ui-section"><h4 class="ui-label">Report to the manager</h4><div class="response ${full?.report ? '' : 'missing'}">${esc(full ? (full.report || 'Waiting for this agent’s report.') : 'Loading…')}</div></section>${childDetailError ? `<p class="note">${esc(childDetailError)}</p>` : ''}<p class="note">A sub-agent is not addressable on its own. This is a read-only report back to the manager.</p></div>`)
  if(focusedStep) document.querySelector(`[data-child-step="${CSS.escape(focusedStep)}"]>summary`)?.focus({preventScroll:true})
}
// The list payload only ever carries id/role/model/status for a delegation; its steps,
// mandate and report live on the session detail route, fetched independently of the
// manager's own control panel so viewing one never depends on that panel being mounted.
async function loadChildDetail(managedId, delegationId) {
  if (typeof api !== 'function') return
  const requestId = ++childRequest
  try {
    const data = await api(`/api/managed/${managedId}`)
    if (requestId !== childRequest || selectedChild !== delegationId) return
    childDetail = data.session?.taskBoard?.delegations?.find(d => d.id === delegationId) || null
    childDetailFor = delegationId
    childDetailError = null
  } catch (error) {
    if (requestId === childRequest && selectedChild === delegationId) childDetailError = error.message || 'Could not load this delegation.'
  } finally {
    if (requestId === childRequest && selectedChild === delegationId) render()
  }
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
    document.querySelectorAll('body > .topbar, body > main').forEach(el => { el.inert = true })
    document.querySelector(`[aria-controls="${id}"]`)?.setAttribute('aria-expanded', 'true')
  }
  const target = (focusSelector && backdrop.querySelector(focusSelector)) || backdrop.querySelector(FOCUSABLE)
  target?.focus()
  if (target && target.select) target.select()
}
function closeModal() {
  if (!openModalId) return
  const backdrop = $(openModalId)
  if (backdrop) {
    backdrop.querySelectorAll('input[type="password"]').forEach(input=>{input.value=''})
    backdrop.hidden = true
  }
  document.querySelector(`[aria-controls="${openModalId}"]`)?.setAttribute('aria-expanded', 'false')
  openModalId = null
  document.body.removeAttribute('data-modal')
  document.querySelectorAll('body > .topbar, body > main').forEach(el => { el.inert = false })
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
document.addEventListener('click', event => {
  if (!openModalId) return
  // The backdrop itself, or an explicit close button. Never a click inside the dialog.
  if (event.target === $(openModalId) || event.target.closest('[data-close-modal]')) closeModal()
})

// Reached from every error path, including ones that fire before the page has
// finished wiring itself up, so a missing toast element costs the message and
// nothing more.
function toast(message) {
  const box = $('toast')
  if (!box) return
  box.textContent = message
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.hidden = true }, 3000)
}
// Click-outside is the one thing a plain button pair can't give a popover for
// free, so it gets its own listener rather than folding into the delegated one
// below, which only ever looks at clicks that landed on a button.
document.addEventListener('click', event => {
  if (filterMenuOpen && !event.target.closest('.filter-menu')) { filterMenuOpen = false; render() }
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && filterMenuOpen) { filterMenuOpen = false; render(); $('filter-trigger')?.focus() }
})
document.addEventListener('click', async event => {
  const b = event.target.closest('button')
  if (!b) return
  if (b.id === 'filter-trigger') { filterMenuOpen = !filterMenuOpen; return render() }
  if (b.dataset.filter) { filter = b.dataset.filter; filterMenuOpen = false; render() }
  if (b.dataset.dateFilter) { dateFilter = b.dataset.dateFilter; filterMenuOpen = false; render() }
  if (b.dataset.foldSession) {
    const k = b.dataset.foldSession, collapsed = !collapsedChildren.has(k)
    setChildrenCollapsed(k, collapsed)
    // Folding the group away takes the selection back up to the session that owns it,
    // so the list never hides the one row reading as selected.
    if (collapsed && selectedChild && snapshot?.sessions.find(s => key(s) === k)?.delegations?.some(d => d.id === selectedChild)) {
      selected = k
      selectedChild = null
    }
    return render()
  }
  if (b.dataset.delegation) {
    selected = b.dataset.session; selectedChild = b.dataset.delegation; render()
    if (matchMedia('(max-width:720px)').matches) $('detail').scrollIntoView({behavior:'instant',block:'start'})
  } else if (b.dataset.session) {
    selected = b.dataset.session; selectedChild = null; render()
    if (matchMedia('(max-width:720px)').matches) $('detail').scrollIntoView({behavior:'instant',block:'start'})
  }
  if (b.id === 'archive-sweep') return setArchived(sweepTargets().map(s => s.sessionId), true)
  if (b.id === 'archive-restore-all') return setArchived(snapshot.sessions.filter(s => s.archived && s.sessionId).map(s => s.sessionId), false)
  if (b.id === 'toggle-archive') {
    const s = snapshot?.sessions.find(s => key(s) === selected)
    if (s?.sessionId) return setArchived([s.sessionId], !s.archived)
  }
  if (b.id === 'archive-sweep') return setArchived(sweepTargets().map(s => s.sessionId), true)
  if (b.id === 'archive-restore-all') return setArchived(snapshot.sessions.filter(s => s.archived && s.sessionId).map(s => s.sessionId), false)
  if (b.id === 'toggle-archive') {
    const s = snapshot?.sessions.find(s => key(s) === selected)
    if (s?.sessionId) return setArchived([s.sessionId], !s.archived)
  }
  if (b.id === 'copy-resume') {
    const s = snapshot?.sessions.find(s => key(s) === selected)
    if (!s?.resumeCmd) return
    try { await navigator.clipboard.writeText(s.resumeCmd); toast('Resume command copied') }
    catch { toast('Clipboard unavailable. The command is shown below.'); const code = document.createElement('pre'); code.className = 'response'; code.textContent = s.resumeCmd; $('detail').append(code) }
  }
})
const setBusy = busy => { if ($('refresh')) $('refresh').disabled = busy }
const setConnection = (text, state) => {
  if ($('connection')) $('connection').textContent = text
  if ($('connection-dot')) $('connection-dot').className = `dot ${state}`
}
const showError = message => {
  const box = $('error')
  if (!box) return
  box.hidden = !message
  if (message) box.textContent = message
}
async function tick() {
  if (pending) return
  // The poll runs on a timer and in the catch below, so it never assumes the
  // chrome it writes into is mounted.
  pending = true
  setBusy(true)
  try {
    // Only what changed comes back; an unchanged list is a 304 and costs nothing to draw.
    const { value: data, changed } = await window.FleetSync.get('/api/sessions', { paths: ['sessions'] })
    if (!Array.isArray(data.sessions) || !data.counts) { window.FleetSync.forget('/api/sessions'); throw new Error('Invalid response') }
    checkedAt = Date.now()
    if (changed || !snapshot) { snapshot = data; render() }
    // A selected delegation keeps polling its own steps and report at the same cadence
    // as everything else, independent of whether the manager's own panel is mounted.
    if (selectedChild) {
      const owner = data.sessions.find(s => s.delegations?.some(d => d.id === selectedChild))
      if (owner?.managedId) loadChildDetail(owner.managedId, selectedChild)
    }
    // Other panels (the ask results) re-read the snapshot to refresh "open now" state.
    if (changed) document.dispatchEvent(new CustomEvent('fleet-snapshot'))
    setConnection('Live connection', 'busy')
    if ($('updated')) $('updated').textContent = `Updated ${new Date(checkedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`
    showError(data.storageError)
  } catch {
    setConnection('Disconnected', 'stale')
    showError(snapshot ? 'Connection lost. Showing the last successful snapshot; retrying automatically.' : 'Unable to connect to the local server. Retrying automatically.')
    if (!snapshot) { update('session-list','<div class="empty">Waiting for the local server…</div>'); renderDetail(null) }
  } finally { pending = false; setBusy(false) }
}
// ── What the rest of the page may use ───────────────────────────────────────
// Published here, before the boot sequence below runs, and not as the value the
// wrapper returns: control.js, teams.js and ask.js destructure this the moment they
// load, so an element missing from the wiring that follows must not take the whole
// page down with it. State is handed out through functions rather than as live
// bindings, so a caller cannot take a copy of `snapshot` and read a stale one after
// the next poll.
// A pushed change asks for the list; a burst of them makes one fetch a second at most.
function requestTick() {
  if (tickQueued) return
  tickQueued = setTimeout(() => {
    tickQueued = null
    if (document.hidden) return // visibilitychange fetches on return
    tickAt = Date.now(); tick()
  }, Math.max(0, 1000 - (Date.now() - tickAt)))
}
window.Fleet = {
  // DOM and formatting helpers the other files share.
  $, esc, update, key, age, tokens, money, status, store,
  // The account's plan windows, rendered from a usage reading.
  usageHtml,
  // views.js calls this after a view switch: each view keeps its own divider.
  syncSplit: () => syncSplit(),
  // Current state.
  snapshot: () => snapshot,
  // Actions. Each one renders, so a caller never has to remember to.
  render,
  // Refetch the session list. control.js awaits this after an action that changed
  // the server's state, so the list reflects it without waiting for the next poll.
  tick,
  requestTick,
  setSnapshot(next) { snapshot = next; render() },
  setFilter(next) { filter = next; render() },
  select(sessionKey, delegationId = null) { selected = sessionKey; selectedChild = delegationId; render() },
  // The launch modal does not change the current session.
  draft: () => draftOpen,
  setDraft(open) { draftOpen = open },
  setChildrenCollapsed(sessionKey, collapsed) { setChildrenCollapsed(sessionKey, collapsed); render() },
  // What loadChildDetail's completion does: hand over the delegation the session
  // route returned, then redraw. Select the delegation first; a detail handed over
  // for one that is not selected has nowhere to be drawn.
  setChildDetail(delegationId, detail, error = null) {
    childDetail = detail
    childDetailFor = delegationId
    childDetailError = error
    render()
  },
  toast,
  // Modals.
  modalIsOpen, openModal, closeModal,
  // Layout, formerly window.FleetLayout.
  watchConversation, syncDetails,
  // Control-panel rendering, for tests and for the update poller.
  renderUpdate: (...args) => window.FleetControl.renderUpdate(...args),
}

// ── Boot ────────────────────────────────────────────────────────────────────
$('refresh')?.addEventListener('click',tick)
tick()
// The server pushes "the list changed" (control.js listens) and the page fetches then.
// This slow poll only covers a dropped event stream; reconnecting refetches anyway.
setInterval(() => { if (!document.hidden) tick() },30000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
// Ages ("2m ago") and running-turn timers are worked out from the clock when the list is
// drawn, so it is redrawn without fetching: every two seconds while something is
// working, every half minute otherwise.
setInterval(() => {
  if (document.hidden || !snapshot) return
  if (snapshot.sessions.some(isWorkingRow) || Date.now() - renderedAt > 30000) render()
}, 2000)

// Layout the operator controls: a draggable split between the session list and the
// inspector, and resizable session sections. Sizes are remembered per browser; a storage
// failure (private window, blocked site data) only costs the remembered size.
const LAYOUT = { split: 'fleet:minimal-split', today: 'fleet:today-split' }
const SPLIT_DEFAULT = 22, LIST_MIN = 240, DETAIL_MIN = 480
// Today is two working panels, not a list beside a console, so its divider has its own
// range and its own remembered position: dragging one never moves the other.
const TODAY_DEFAULT = 56, BOARD_MIN = 420, CONSOLE_MIN = 380
// Today and Projects are both a working pane beside a console, so they share a divider.
const todayView = () => ['today','projects'].includes(document.querySelector('.workspace')?.dataset.view)
const splitKey = () => todayView() ? LAYOUT.today : LAYOUT.split
const splitDefault = () => todayView() ? TODAY_DEFAULT : SPLIT_DEFAULT
const splitBounds = width => todayView()
  ? [BOARD_MIN / width * 100, (width - CONSOLE_MIN) / width * 100]
  : [LIST_MIN / width * 100, Math.min(width <= 1199 ? 300 : 380, width - DETAIL_MIN) / width * 100]

function applySplit(percent, { save = true } = {}) {
  const width = document.querySelector('.workspace')?.getBoundingClientRect().width || 0
  const value = Math.round(clampSplit(percent, width) * 10) / 10
  document.documentElement.style.setProperty(todayView() ? '--today-split' : '--split', `${value}%`)
  $('splitter')?.setAttribute('aria-valuenow', String(Math.round(value)))
  if (width > 720) {
    const [min, max] = splitBounds(width)
    $('splitter')?.setAttribute('aria-valuemin', String(Math.round(min)))
    $('splitter')?.setAttribute('aria-valuemax', String(Math.round(max)))
  }
  if (save) store.set(splitKey(), String(value))
}
// Clamp in pixels so neither pane can be squeezed past the point of being usable.
function clampSplit(percent, width) {
  if (width <= 720) return percent
  const [min, max] = splitBounds(width)
  return Math.min(Math.max(percent, min), max)
}
// Put the divider where this view last left it. Called on load and on every view switch.
function syncSplit() {
  const saved = Number(store.get(splitKey()))
  applySplit(Number.isFinite(saved) && saved > 0 ? saved : splitDefault(), { save: false })
}
function initSplitter() {
  const splitter = $('splitter'), workspace = document.querySelector('.workspace')
  if (!splitter || !workspace) return
  // The list view's position is applied too, so leaving Today never shows a stale one.
  const savedList = Number(store.get(LAYOUT.split))
  document.documentElement.style.setProperty('--split', `${Number.isFinite(savedList) && savedList > 0 ? savedList : SPLIT_DEFAULT}%`)
  syncSplit()

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
  splitter.addEventListener('dblclick', () => { store.clear(splitKey()); applySplit(splitDefault(), { save: false }) })
  splitter.addEventListener('keydown', event => {
    const step = { ArrowLeft: -2, ArrowRight: 2, Home: -100, End: 100 }[event.key]
    if (step === undefined) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      store.clear(splitKey())
      return applySplit(splitDefault(), { save: false })
    }
    event.preventDefault()
    const width = workspace.getBoundingClientRect().width
    const current = Number(splitter.getAttribute('aria-valuenow')) || splitDefault()
    applySplit(clampSplit(current + step, width), { save: true })
  })
  // A window resize can leave a stored split too narrow for one of the panes.
  addEventListener('resize', () => {
    const width = workspace.getBoundingClientRect().width
    const current = Number(splitter.getAttribute('aria-valuenow')) || splitDefault()
    const clamped = clampSplit(current, width)
    applySplit(clamped, { save: false })
  })
}

// Vertical sections share the same interaction as the session-list divider.
// Observe the container so saved sizes yield when the viewport or controls change.
let panelLayoutCleanup = () => {}
function watchConversation(element) {
  panelLayoutCleanup()
  if (!element) return
  const container = element.parentElement
  const disposers = []
  // grow: the size is a floor, not a fixed height, so the panel can still fit what is in
  // it (the composer with an image attached, or several lines).
  const addPanel = (panel, { key, label, min, initial, before = false, grow = false }) => {
    const divider = document.createElement('div')
    divider.className = 'panel-splitter'
    divider.tabIndex = 0
    divider.setAttribute('role', 'separator')
    divider.setAttribute('aria-orientation', 'horizontal')
    divider.setAttribute('aria-label', label)
    divider.setAttribute('aria-controls', panel.id)
    divider.title = 'Drag to resize · arrow keys to adjust · double-click to reset'
    before ? panel.before(divider) : panel.after(divider)
    const saved = Number(store.get(key))
    let preferred = Number.isFinite(saved) && saved >= min ? saved : initial
    let drag = null
    const height = () => panel.getBoundingClientRect().height
    const maximum = () => Math.max(min, Math.min(container.clientHeight * .45,
      height() + element.clientHeight - 120))
    const apply = () => {
      const mobile = matchMedia('(max-width:720px)').matches
      const collapsed = panel.tagName === 'DETAILS' && !panel.open
      divider.hidden = mobile || collapsed
      if (mobile || collapsed) { panel.style.removeProperty('height'); panel.style.removeProperty('min-height'); return }
      const max = Math.floor(maximum())
      const value = Math.round(Math.max(min, Math.min(preferred, max)))
      panel.style[grow ? 'minHeight' : 'height'] = `${value}px`
      divider.setAttribute('aria-valuemin', String(min))
      divider.setAttribute('aria-valuemax', String(max))
      divider.setAttribute('aria-valuenow', String(value))
      divider.setAttribute('aria-valuetext', `${value} pixels`)
    }
    const set = value => {
      preferred = Math.max(min, Math.min(value, maximum()))
      store.set(key, String(Math.round(preferred)))
      apply()
    }
    const reset = () => { preferred = initial; store.clear(key); apply() }
    const stop = () => {
      if (!drag) return
      const id = drag.id
      drag = null
      divider.removeAttribute('data-dragging')
      document.body.removeAttribute('data-panel-resizing')
      if (divider.hasPointerCapture?.(id)) divider.releasePointerCapture(id)
    }
    divider.addEventListener('pointerdown', event => {
      if (event.button) return
      event.preventDefault()
      divider.focus({ preventScroll: true })
      drag = { y: event.clientY, height: height(), id: event.pointerId }
      divider.setPointerCapture(event.pointerId)
      divider.setAttribute('data-dragging', '')
      document.body.setAttribute('data-panel-resizing', '')
    })
    divider.addEventListener('pointermove', event => {
      if (drag && event.pointerId === drag.id) set(drag.height + (event.clientY - drag.y) * (before ? -1 : 1))
    })
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(event, stop)
    divider.addEventListener('dblclick', reset)
    divider.addEventListener('keydown', event => {
      const delta = { ArrowUp: -10, ArrowDown: 10 }[event.key]
      if (delta !== undefined) { event.preventDefault(); set(height() + delta * (before ? -1 : 1)) }
      else if (['Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        if (event.key === 'Home') set(min)
        else if (event.key === 'End') set(maximum())
        else reset()
      }
    })
    panel.addEventListener('toggle', apply)
    const observer = new ResizeObserver(apply)
    observer.observe(container)
    addEventListener('resize', apply)
    const dispose = () => { stop(); observer.disconnect(); removeEventListener('resize', apply); panel.removeEventListener('toggle', apply); divider.remove() }
    disposers.push(dispose)
    apply()
    return dispose
  }
  const composer = $('composer')
  if (composer) addPanel(composer, { key: 'fleet:minimal-composer-height', label: 'Resize message composer', min: 110, initial: 130, before: true, grow: true })
  let board = null, disposeBoard = null
  const syncBoard = () => {
    const next = $('initiative-board')
    if (next === board) return
    disposeBoard?.()
    board = next
    if (board) {
      disposeBoard = addPanel(board, { key: 'fleet:overview-height', label: 'Resize team overview', min: 90, initial: 220 })
    }
  }
  const mutation = new MutationObserver(syncBoard)
  mutation.observe(container, { childList: true })
  syncBoard()
  panelLayoutCleanup = () => { mutation.disconnect(); disposers.forEach(dispose => dispose()) }
}
initSplitter()

// Wide screens show the inspector beside the conversation. Smaller screens start
// with it closed, unless the operator explicitly chose otherwise. Read-only sessions
// show their details in the main pane because they have no managed conversation.
const DETAILS_KEY = 'fleet:minimal-details-open'
function syncDetails() {
  const toggle = $('details-toggle'), content = $('detail-content'), hasConsole = !!$('composer')
  if (!toggle || !content) return
  // Today is two panels, the board and the console; the inspector has nothing to add.
  if (window.FleetDay?.active() || window.FleetProjects?.active() || window.FleetProgress?.active() || window.FleetWorktrees?.active()) { toggle.hidden = true; content.hidden = true; return }
  toggle.hidden = !hasConsole
  const preference = store.get(DETAILS_KEY)
  const open = !hasConsole || (preference === null ? matchMedia('(min-width:1200px)').matches : preference === '1')
  content.hidden = !open
  toggle.setAttribute('aria-expanded', String(open))
}
addEventListener('resize', syncDetails)
$('details-toggle')?.addEventListener('click', () => {
  const open = $('details-toggle').getAttribute('aria-expanded') !== 'true'
  store.set(DETAILS_KEY, open ? '1' : '0')
  syncDetails()
})
})()
