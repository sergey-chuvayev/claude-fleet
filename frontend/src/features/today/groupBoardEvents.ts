// The Day's console, told in its own terms (public/day.js `messages`). An automatic
// run is a marker, not a message from the operator; back-to-back board calls are one
// "Board" block that says what changed, instead of six identical mcp__fleet__day rows.
// Pure and derived: nothing here is persisted, and a group's id is stable across
// refreshes (`<first call id>~board`), so the conversation keeps its block.
import type { Message } from '../../transport/contracts'
import { AUTO_RUN } from './day'

const BOARD_TOOL = 'mcp__fleet__day'
const BOARD_VERB: Readonly<Record<string, string>> = {
  add: 'added',
  update: 'updated',
  ask: 'asked',
  list: 'read the board',
  inspect: 'looked up',
  cursor: 'moved cursors',
  teams: 'listed teams',
  capacity: 'noted free time',
}
const COUNTED = new Set(['add', 'update', 'ask'])

const field = (input: Message['input'], key: string): string => {
  const value = input?.[key]
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function summarize(id: string, calls: readonly Message[]): Message {
  const first = calls[0] as Message
  const counts = new Map<string, number>()
  for (const call of calls) {
    const action = field(call.input, 'action') || 'call'
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }
  const status = calls.some(c => c.status === 'running') ? 'running' : calls.some(c => c.status === 'error') ? 'error' : 'done'
  const ms = calls.every(c => c.ms != null) ? calls.reduce((n, c) => n + (c.ms ?? 0), 0) : null
  const target = [...counts.entries()].map(([a, n]) => (COUNTED.has(a) ? `${BOARD_VERB[a]} ${n}` : (BOARD_VERB[a] ?? a))).join(' · ')
  const lines = calls.map(c => {
    const action = field(c.input, 'action')
    const what = field(c.input, 'title') || field(c.input, 'question') || field(c.input, 'note') || field(c.input, 'source')
    const failed = c.status === 'error'
    const verb = BOARD_VERB[action] ?? (action || 'call')
    return {
      text: `${verb}${what ? `: ${what.slice(0, 140)}` : ''}${failed && c.result ? ` (failed: ${String(c.result).slice(0, 160)})` : ''}`,
      error: failed,
    }
  })
  return { id, role: 'tool', tool: BOARD_TOOL, label: 'Board', approval: 'auto', at: first.at ?? null, status, ms, target, lines }
}

/** The stored messages of a Day or item thread, as its console shows them. */
export function groupBoardEvents(list: readonly Message[]): Message[] {
  const out: Message[] = []
  let calls: Message[] | null = null
  let slot = -1
  const close = () => {
    if (calls) out[slot] = summarize(`${(calls[0] as Message).id}~board`, calls)
    calls = null
  }
  for (const m of list) {
    const auto = m.role === 'user' && !!m.runPrompt && (m.background === true || (m.text ? !!AUTO_RUN[m.text] : false))
    if (auto) {
      close()
      out.push({ id: m.id, role: 'event', text: (m.text && AUTO_RUN[m.text]) || m.text || '', at: m.at ?? null })
      continue
    }
    if (m.role === 'tool' && m.tool === BOARD_TOOL) {
      if (!calls) {
        calls = []
        slot = out.length
        out.push(m)
      }
      calls.push(m)
      continue
    }
    close()
    out.push(m)
  }
  close()
  return out
}
