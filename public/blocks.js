'use strict'
// An isolated scope, matching teams.js. This file borrows nothing from the others.
window.FleetBlocks = (() => {
// Warp-style conversation blocks. Every message, tool call and result is its own
// block with a sticky header, a copy action and collapse. Rendering is incremental:
// a block is only rebuilt when its content signature changes, so a streaming turn
// does not re-highlight the whole log on every poll.

const LIBS = () => window.FleetLibs || null
const ICONS = {
  Bash: '⚡', BashOutput: '⚡', Read: '▤', Write: '✎', Edit: '✎', NotebookEdit: '✎',
  Grep: '⌕', Glob: '⌕', WebSearch: '⌕', WebFetch: '↓', Task: '✳', Agent: '✳', Skill: '◆',
  TodoWrite: '☑', AskUserQuestion: '?', ExitPlanMode: '▸',
}
const EXTENSIONS = {
  js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', tsx:'typescript',
  kt:'kotlin', kts:'kotlin', java:'java', py:'python', rs:'rust', go:'go', swift:'swift',
  json:'json', yml:'yaml', yaml:'yaml', sql:'sql', css:'css', scss:'css', html:'xml', xml:'xml', svg:'xml',
  md:'markdown', sh:'bash', bash:'bash', zsh:'bash', diff:'diff', patch:'diff', toml:'plaintext',
}
// Mirrors toolTarget() in managed.js: the input key already shown in the block header.
const TARGET_KEYS = {
  Bash: 'command', BashOutput: 'bash_id', Task: 'description', Agent: 'description', WebSearch: 'query',
  WebFetch: 'url', Grep: 'pattern', Glob: 'pattern', Skill: 'skill',
}
// The runtime names this tool `Agent`; `Task` is the older name for the same call and still
// appears in transcripts recorded before the rename. Both carry {subagent_type, description,
// prompt}, so both render as a delegation.
const isDelegation = name => name === 'Agent' || name === 'Task'
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const languageFor = file => EXTENSIONS[String(file || '').split('.').pop().toLowerCase()] || null
const duration = ms => ms == null ? null : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`
const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// hljs escapes its own output, so its HTML is safe to inject directly.
function highlight(code, language) {
  const libs = LIBS()
  if (!libs) return escapeHtml(code)
  try {
    if (language && libs.hljs.getLanguage(language)) return libs.hljs.highlight(code, { language, ignoreIllegals: true }).value
    return libs.hljs.highlightAuto(code).value
  } catch { return escapeHtml(code) }
}
function codeHtml(code, language, extraClass = '') {
  const text = String(code ?? '').replace(/\s+$/, '')
  if (!text) return ''
  return `<pre class="block-code ${extraClass}"><code class="hljs">${highlight(text, language)}</code></pre>`
}

// Markdown for prose blocks: parse, sanitise, then highlight fenced code in place.
function proseHtml(text, { skipHighlight = false } = {}) {
  const libs = LIBS()
  const source = String(text ?? '')
  if (!libs) return `<pre class="block-plain">${escapeHtml(source)}</pre>`
  let html
  try { html = libs.marked.parse(source) } catch { return `<pre class="block-plain">${escapeHtml(source)}</pre>` }
  const clean = libs.DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  })
  const holder = document.createElement('div')
  holder.className = 'block-prose'
  holder.innerHTML = clean
  for (const link of holder.querySelectorAll('a[href]')) { link.target = '_blank'; link.rel = 'noreferrer noopener' }
  if (!skipHighlight) for (const code of holder.querySelectorAll('pre > code')) {
    const declared = [...code.classList].map(c => c.match(/^language-(.+)$/)?.[1]).find(Boolean)
    code.innerHTML = highlight(code.textContent, declared)
    code.classList.add('hljs')
    code.parentElement.classList.add('block-code')
  }
  return holder.outerHTML
}

// What a tool block shows in its body, per tool. Falls back to its JSON input.
function toolBody(message) {
  // A grouped block (the Day's board calls) brings its own plain-language lines.
  if (Array.isArray(message.lines)) return `<ul class="block-lines">${message.lines.map(l => `<li class="${l.error ? 'is-error' : ''}">${escapeHtml(l.text)}</li>`).join('')}</ul>`
  const input = message.input || {}
  const name = message.tool
  if (name === 'Bash' || name === 'BashOutput') return codeHtml(input.command || input.bash_id || '', 'bash', 'is-command')
  if (name === 'Edit' || name === 'NotebookEdit') {
    const before = String(input.old_string ?? input.old_source ?? '')
    const after = String(input.new_string ?? input.new_source ?? '')
    if (!before && !after) return codeHtml(JSON.stringify(input, null, 2), 'json')
    const lines = []
    if (before) for (const line of before.split('\n')) lines.push(`- ${line}`)
    if (after) for (const line of after.split('\n')) lines.push(`+ ${line}`)
    return codeHtml(lines.join('\n'), 'diff')
  }
  if (name === 'Write') return codeHtml(input.content || '', languageFor(input.file_path))
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    if (!todos.length) return ''
    const mark = t => t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'
    return `<ul class="block-todos">${todos.map(t => `<li class="todo-${escapeHtml(t.status)}"><span aria-hidden="true">${mark(t)}</span>${escapeHtml(t.content || t.activeForm || '')}</li>`).join('')}</ul>`
  }
  if (isDelegation(name)) return `<details class="delegation-mandate" data-delegation="mandate"><summary>Mandate</summary>${proseHtml(input.prompt || input.description || 'No mandate recorded.')}</details>`
  if (name === 'Skill') return codeHtml(input.prompt || input.args || input.description || '', 'plaintext')
  if (name === 'AskUserQuestion') return ''
  // The header already shows the main argument, so repeating it as JSON is noise.
  const shown = TARGET_KEYS[name] || 'file_path'
  const rest = Object.fromEntries(Object.entries(input).filter(([k, value]) => k !== shown && k !== 'path' && value !== '' && value != null))
  return Object.keys(rest).length ? codeHtml(JSON.stringify(rest, null, 2), 'json') : ''
}
function resultHtml(message) {
  if (isDelegation(message.tool)) {
    const report = String(message.result || '')
    if (!report) return `<p class="block-note">${message.status === 'running' ? 'Awaiting report…' : message.status === 'error' ? 'Delegation failed without a report.' : 'No report returned.'}</p>`
    const long = report.length > 1200 || report.split('\n').length > 16
    return `<details class="delegation-report" data-delegation="report"${long ? '' : ' open'}><summary>Returned report${long ? ' · long' : ''}</summary>${proseHtml(report)}${message.truncated ? '<p class="block-note">Report truncated by Fleet.</p>' : ''}</details>`
  }
  if (!message.result) return ''
  const language = message.tool === 'Read' ? languageFor(message.input?.file_path) : message.status === 'error' ? 'plaintext' : null
  const note = message.truncated ? '<p class="block-note">Output truncated by Fleet.</p>' : ''
  return `<div class="block-result ${message.status === 'error' ? 'is-error' : ''}">${codeHtml(message.result, language)}${note}</div>`
}
const actionsHtml = '<span class="block-actions"><button type="button" class="block-button" data-copy title="Copy block">⧉</button><button type="button" class="block-button" data-collapse title="Collapse block" aria-expanded="true">⌄</button></span>'

// A tool's name as a person would say it. MCP names carry their server and an
// underscore-joined action ("mcp__claude_ai_Slack__slack_search_public"); Fleet's own
// Day board tool is just "Board".
const SERVER_NAMES = { fleet: 'Fleet', 'linear-server': 'Linear', granola: 'Granola', github: 'GitHub' }
// Built-in tools whose own names describe the mechanism rather than what happened.
const PLAIN_NAMES = { ToolSearch: 'Loading tools' }
function toolLabel(name) {
  if (PLAIN_NAMES[name]) return PLAIN_NAMES[name]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(name || ''))
  if (!mcp) return String(name || 'Tool')
  if (mcp[1] === 'fleet' && mcp[2] === 'day') return 'Board'
  const server = SERVER_NAMES[mcp[1]] || mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')
  const action = mcp[2].replace(new RegExp(`^${server.toLowerCase()}_`), '').replace(/_/g, ' ')
  return `${server} · ${action}`
}
function blockHtml(message, { streaming = false, agent = 'CLAUDE' } = {}) {
  // A run that started on its own (an intake, a check, picking up answers): a marker
  // in the timeline, not a message the operator typed.
  if (message.role === 'event') return `<div class="block-event"><span>${escapeHtml(message.text)}</span><span class="block-meta">${clock(message.at)}</span></div>`
  if (message.role === 'tool') {
    const icon = ICONS[message.tool] || '▸'
    const meta = [duration(message.ms), clock(message.at)].filter(Boolean).join(' · ')
    const state = message.status === 'error' ? 'is-failed' : message.status === 'running' ? 'is-running' : message.status === 'interrupted' ? 'is-interrupted' : 'is-done'
    const stateLabel = state === 'is-done' ? isDelegation(message.tool) ? 'done' : '' : state.slice(3)
    const target = message.target ? `<span class="block-target" title="${escapeHtml(message.target)}">${escapeHtml(message.target)}</span>` : ''
    const auto = message.approval === 'auto' ? '<span class="block-auto" title="Fleet approved this automatically">auto</span>' : ''
    // A step that is running right now wears the pixel mark instead of its icon.
    const lead = state === 'is-running' && window.FleetUI ? `<span class="block-icon is-live">${window.FleetUI.running('Running now')}</span>` : `<span class="block-icon" aria-hidden="true">${icon}</span>`
    return `<div class="block-head">${lead}<span class="block-tool" title="${escapeHtml(message.tool)}">${isDelegation(message.tool) ? `Delegation · ${escapeHtml(message.input?.subagent_type || 'subagent')}` : escapeHtml(message.label || toolLabel(message.tool))}</span>${target}<span class="block-meta">${escapeHtml(meta)}</span>${auto}<span class="block-state ${state}">${stateLabel}</span>${actionsHtml}</div><div class="block-body">${toolBody(message)}${resultHtml(message)}</div>`
  }
  const who = message.role === 'user' ? 'YOU' : agent
  const icon = message.role === 'user' ? '›' : '✳'
  const live = streaming ? `<span class="block-state is-running is-live">${window.FleetUI ? window.FleetUI.running('Writing now') : ''}writing</span>` : ''
  const attachments = Array.isArray(message.attachments) && message.attachments.length
    ? `<div class="block-attachments">${message.attachments.map(a => `<a href="/api/attachments/${escapeHtml(a.id)}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(a.mediaType)} · ${Math.round((a.bytes || 0) / 1024)} KB"><img src="/api/attachments/${escapeHtml(a.id)}" alt="Attached image" loading="lazy"></a>`).join('')}</div>`
    : ''
  const references = (message.references || []).map(r => `<details class="block-reference"><summary>✳ ${escapeHtml(r.title)} <span>· session snapshot</span></summary><p>${escapeHtml(r.project)} · ${escapeHtml(r.state)}</p><pre>${escapeHtml(r.context)}</pre></details>`).join('')
  const body = message.text ? proseHtml(message.text, { skipHighlight: streaming }) : ''
  return `<div class="block-head"><span class="block-icon" aria-hidden="true">${icon}</span><span class="block-tool">${who}</span><span class="block-meta">${clock(message.at)}</span>${live}${actionsHtml}</div><div class="block-body">${references}${attachments}${body}</div>`
}

// Signature drives the incremental update: an identical signature means an identical block.
const signature = (message, streaming) => [
  message.role, message.tool || '', message.label || '', message.target || '', message.status || '', message.ms ?? '', message.approval || '', streaming ? 'S' : '',
  (message.text || '').length, (message.result || '').length, (message.attachments || []).length, (message.references || []).length,
  message.role === 'tool' ? JSON.stringify(message.input || {}).length : 0,
  (message.text || '').slice(-80), (message.result || '').slice(-80), (message.lines || []).length,
].join('~|~')

function copyText(message) {
  if (message.role !== 'tool') return message.text || ''
  const parts = [`${message.tool}${message.target ? ` · ${message.target}` : ''}`]
  if (message.tool === 'Bash' && message.input?.command) parts.push(message.input.command)
  else parts.push(JSON.stringify(message.input || {}, null, 2))
  if (message.result) parts.push('', message.result)
  return parts.join('\n')
}

// `agent` names who replies: CLAUDE, or CODEX for a Codex session.
function renderBlocks(container, messages, { streamingId = null, onCopy = () => {}, agent = 'CLAUDE' } = {}) {
  const seen = new Set()
  let previous = null
  for (const message of messages) {
    const streaming = message.id === streamingId
    const sig = signature(message, streaming)
    seen.add(message.id)
    let element = container.querySelector(`[data-block="${CSS.escape(message.id)}"]`)
    if (!element) {
      element = document.createElement('article')
      element.className = 'block'
      element.dataset.block = message.id
      // Completed tool activity starts compact; errors and live work remain visible.
      if (message.role === 'tool' && !isDelegation(message.tool) && message.status !== 'running' && message.status !== 'error') element.classList.add('collapsed')
    }
    if (element.dataset.sig !== sig) {
      element.dataset.sig = sig
      element.dataset.role = message.role
      element.dataset.tool = message.tool || ''
      element.dataset.status = message.status || ''
      const disclosures = new Map([...element.querySelectorAll('[data-delegation]')].map(el => [el.dataset.delegation, el.open]))
      element.innerHTML = blockHtml(message, { streaming, agent })
      for (const el of element.querySelectorAll('[data-delegation]')) if (disclosures.has(el.dataset.delegation)) el.open = disclosures.get(el.dataset.delegation)
      element.querySelector('[data-collapse]')?.addEventListener('click', event => {
        const collapsed = element.classList.toggle('collapsed')
        event.currentTarget.setAttribute('aria-expanded', String(!collapsed))
      })
      element.querySelector('[data-copy]')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(copyText(message)).then(() => onCopy('Block copied'), () => onCopy('Copying needs clipboard permission'))
      })
      if (element.classList.contains('collapsed')) element.querySelector('[data-collapse]')?.setAttribute('aria-expanded', 'false')
    }
    // Keep DOM order aligned with message order without rebuilding untouched blocks.
    const shouldFollow = previous ? previous.nextElementSibling : container.firstElementChild
    if (shouldFollow !== element) container.insertBefore(element, shouldFollow)
    previous = element
  }
  for (const element of [...container.children]) if (!seen.has(element.dataset?.block)) element.remove()
}

// The question above its answer. As the conversation scrolls, the last message the
// operator sent that is now above the fold stays pinned at the top, compact, until the
// next one takes its place; clicking it scrolls back to where it was asked. One pin per
// conversation, laid over its top edge; the messages themselves never move.
function pinQuestions(log) {
  if (!log || log.dataset.questionPin) return
  log.dataset.questionPin = '1'
  const pin = document.createElement('div')
  pin.className = 'question-pin'
  pin.innerHTML = '<button type="button" class="question-pin-bubble" tabindex="-1"><span class="question-pin-label">YOU</span><span class="question-pin-text"></span></button>'
  log.before(pin)
  const bubble = pin.firstElementChild, text = bubble.lastElementChild
  let shown = null, frame = 0
  const observers = []
  const update = () => {
    frame = 0
    if (!log.isConnected) { for (const o of observers) o.disconnect(); pin.remove(); return }
    const box = log.getBoundingClientRect()
    let current = null
    for (const el of log.querySelectorAll('.block[data-role="user"]')) {
      if (el.getBoundingClientRect().bottom < box.top + 4) current = el
      else break
    }
    if (current === shown) return
    shown = current
    if (current) {
      const words = (current.querySelector('.block-body')?.innerText || '').replace(/\s+/g, ' ').trim()
      text.textContent = words || 'Your message'
      bubble.title = `Back to: ${words.slice(0, 200)}`
      bubble.setAttribute('aria-label', `Back to your message: ${words.slice(0, 200)}`)
      // Replay the entrance for each new question, not only the first.
      pin.classList.remove('is-shown'); void pin.offsetWidth; pin.classList.add('is-shown')
    } else pin.classList.remove('is-shown')
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
  log.addEventListener('scroll', schedule, { passive: true })
  const resize = new ResizeObserver(schedule); resize.observe(log); observers.push(resize)
  const content = new MutationObserver(schedule); content.observe(log, { childList: true }); observers.push(content)
  bubble.addEventListener('click', () => {
    if (!shown) return
    const box = log.getBoundingClientRect()
    log.scrollTo({ top: log.scrollTop + shown.getBoundingClientRect().top - box.top - 8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  })
  schedule()
}
return { renderBlocks, proseHtml, codeHtml, highlight, toolLabel, pinQuestions }
})()
