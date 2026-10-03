'use strict'
// A conversation started in a terminal, read back from its Claude transcript as the
// entries Fleet's console draws: your messages, Claude's replies, and each tool call
// with its target, input and result. It is what lets a terminal session open in the
// same view as one Fleet started, and what a session Fleet takes over starts with.
const fs = require('node:fs')
const { toolTarget } = require('./fleet')

const MAX_TAIL_BYTES = 6 * 1024 * 1024
const MAX_TOOL_INPUT = 2000
const MAX_TOOL_RESULT = 6000
const MAX_TEXT = 24000
// Results the console never shows; the input says what happened.
const QUIET_RESULT = new Set(['TodoWrite', 'Write', 'Edit', 'NotebookEdit'])

function clampInput(input) {
  if (input === null || typeof input !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value.length > MAX_TOOL_INPUT ? value.slice(0, MAX_TOOL_INPUT) + '\n… truncated' : value
    else if (value === null || ['number', 'boolean'].includes(typeof value)) out[key] = value
    else { const json = JSON.stringify(value) ?? ''; out[key] = json.length > MAX_TOOL_INPUT ? json.slice(0, MAX_TOOL_INPUT) + '… truncated' : value }
  }
  return out
}
function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : '').filter(Boolean).join('\n')
  return ''
}

// The tail of a transcript, whole lines only. Long sessions keep their last 6 MB, the
// same window the session list reads.
function readTail(file) {
  const size = fs.statSync(file).size
  if (size <= MAX_TAIL_BYTES) return { text: fs.readFileSync(file, 'utf8'), truncated: false }
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(MAX_TAIL_BYTES)
    fs.readSync(fd, buf, 0, MAX_TAIL_BYTES, size - MAX_TAIL_BYTES)
    const text = buf.toString('utf8')
    return { text: text.slice(text.indexOf('\n') + 1), truncated: true }
  } finally { fs.closeSync(fd) }
}

// What a person typed, without the scaffolding Claude Code wraps around it: system
// reminders, and slash commands recorded as tags (shown as the command itself).
function userText(raw) {
  const text = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  if (/<local-command-(stdout|stderr|caveat)>/.test(text)) return ''
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
    return `${command[1].trim()}${args ? ` ${args}` : ''}`
  }
  return text.trim()
}

// alive: the session is still running in its terminal, so a tool call without a result
// yet is in progress rather than cut off.
function history(file, { alive = false, limit = 200 } = {}) {
  const { text, truncated } = readTail(file)
  const messages = []
  const tools = new Map()
  let assistant = null
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.isSidechain || d.isMeta || d.isCompactSummary) continue
    if (d.type !== 'user' && d.type !== 'assistant') continue
    const at = Date.parse(d.timestamp) || 0
    const content = d.message?.content
    if (d.type === 'user') {
      assistant = null
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
      const words = blocks.filter(b => b.type === 'text').map(b => userText(b.text)).filter(Boolean).join('\n\n')
      const images = blocks.filter(b => b.type === 'image').length
      if (words || images) messages.push({ id: d.uuid || `u${messages.length}`, role: 'user', text: (words + (images ? `${words ? '\n\n' : ''}[${images} image${images === 1 ? '' : 's'}]` : '')).slice(0, MAX_TEXT), at })
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue
        const entry = tools.get(block.tool_use_id)
        if (!entry) continue
        const result = resultText(block.content)
        entry.status = block.is_error ? 'error' : 'done'
        entry.ms = at && entry.at ? Math.max(0, at - entry.at) : null
        entry.truncated = result.length > MAX_TOOL_RESULT
        entry.result = block.is_error || !QUIET_RESULT.has(entry.tool) ? result.slice(0, MAX_TOOL_RESULT) : null
      }
      continue
    }
    // Claude Code writes one record per content block; blocks of one reply share its id.
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'text' && block.text?.trim()) {
        if (!assistant || assistant.messageId !== d.message?.id) {
          assistant = { id: d.uuid || `a${messages.length}`, role: 'assistant', text: '', at, messageId: d.message?.id }
          messages.push(assistant)
        }
        assistant.text = (assistant.text ? `${assistant.text}\n\n` : '') + block.text
        assistant.text = assistant.text.slice(-MAX_TEXT)
      } else if (block.type === 'tool_use' && block.id && !tools.has(block.id)) {
        assistant = null
        const entry = { id: block.id, role: 'tool', tool: block.name || 'Tool', at, status: 'running', input: clampInput(block.input), target: toolTarget(block.name, block.input), text: '', result: null, ms: null, approval: 'auto' }
        tools.set(block.id, entry)
        messages.push(entry)
      }
    }
  }
  if (!alive) for (const entry of tools.values()) if (entry.status === 'running') entry.status = 'interrupted'
  for (const m of messages) delete m.messageId
  return { messages: messages.slice(-limit), truncated: truncated || messages.length > limit }
}

module.exports = { history, clampInput, resultText, userText, MAX_TOOL_INPUT, MAX_TOOL_RESULT, QUIET_RESULT }
