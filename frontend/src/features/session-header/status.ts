// What the console says about a session's state, ported from public/control.js. Pure.
import type { Holder, Message } from '../../transport/contracts'
import { clockAt } from '../../domain/format'
import { isWorking, toolLabel } from '../conversation/format'

export const MANAGED_LABELS: Readonly<Record<string, string>> = {
  starting: 'Starting Claude…',
  running: 'Working on your task',
  approval: 'Your input is needed',
  stopping: 'Stopping the agent…',
  stopped: 'Stopped · ready to continue',
  error: 'Turn failed',
  idle: 'Ready for your next message',
  queued: 'Queued · waiting for a free slot',
}

/** What Fleet's approval setting means for Codex, which cannot ask before each command. */
export const CODEX_SANDBOX: Readonly<Record<string, string>> = {
  ask: 'Codex reads the project but changes nothing.',
  auto: 'Codex edits inside the project, without network access. It does not ask before each command.',
  all: 'Codex edits inside the project and can use the network. It does not ask before each command.',
}

export const APPROVAL_MODES = [
  { value: 'auto', label: 'Auto approvals', description: 'Asks only for destructive or networked shell commands' },
  { value: 'ask', label: 'Ask every time', description: 'Every tool waits for you' },
  { value: 'all', label: 'Approve everything', description: 'Nothing waits, destructive commands included' },
] as const

export const MODE_TOASTS: Readonly<Record<string, string>> = {
  ask: 'Every tool will ask',
  all: 'Approving everything, including destructive commands',
  auto: 'Auto approvals on',
}

/** The kinds of managed session, and what each one may do. */
export const renameable = (kind: string | undefined): boolean => ['agent', 'initiative'].includes(kind || 'agent')
/** Day, item thread and project manager are held to an outward gate rather than an approval mode. */
export const gated = (kind: string | undefined): boolean => kind === 'day' || kind === 'thread' || kind === 'project'

export function titleOf(s: { kind?: string | undefined; name?: string | null | undefined; aiTitle?: string | null | undefined; renamed?: boolean | undefined }): string {
  const name = s.name ?? ''
  if (s.kind === 'day') return 'Day agent'
  if (s.kind === 'thread') return `About: ${name}`
  if (s.kind === 'project') return `Project manager · ${name}`
  // A name you chose outranks Claude's own title.
  return (s.renamed ? name : s.aiTitle || name) || 'Conversation'
}

/** The header's state line: the tool in use, or the lifecycle label, plus the queue. */
export function stateText(s: { status: string; kind?: string | undefined; currentTool?: string | null | undefined; queueLength: number; holder: Holder | null | undefined }): string {
  if (s.holder) return s.holder.state === 'busy' ? 'Working in a terminal' : 'Open in a terminal'
  const tool = s.currentTool ? toolLabel(s.currentTool) : null
  const base =
    tool && s.status === 'running' ? (s.kind === 'day' && tool === 'Board' ? 'Updating the board…' : `Using ${tool}`) : (MANAGED_LABELS[s.status] ?? s.status)
  return `${base}${s.queueLength ? ` · ${s.queueLength} queued` : ''}`
}

/** Why messages wait, while another program holds the session. */
export function heldText(holder: Holder | null | undefined): string {
  if (!holder) return ''
  const where = holder.entrypoint === 'cli' ? 'in a terminal' : 'in another program'
  const name = holder.name ? ` · ${holder.name}` : ''
  const since = holder.startedAt ? ` · since ${clockAt(holder.startedAt)}` : ''
  return `Open ${where}${name}${since}. Messages wait here and send once it is closed there.`
}

/** Context use as a share of the limit, or null when unknown. */
export function contextShare(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used === null || used === undefined) return null
  return Math.min(100, Math.round((used / (limit || 200000)) * 100))
}

export interface NowState {
  readonly text: string
  readonly since: number | null
  readonly tone: '' | 'needs'
}

/** The line under the conversation: what is happening this second, or null. */
export function managedNow(status: string, messages: readonly Message[], held: boolean): NowState | null {
  if (held || !isWorking(status)) return null
  if (status === 'approval') return { text: 'Waiting for your approval', since: null, tone: 'needs' }
  if (status === 'starting') return { text: 'Starting Claude', since: null, tone: '' }
  if (status === 'stopping') return { text: 'Stopping', since: null, tone: '' }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'tool' || m.status !== 'running') continue
    const delegate = m.tool === 'Agent' || m.tool === 'Task'
    const subagent = typeof m.input?.subagent_type === 'string' ? m.input.subagent_type : 'a sub-agent'
    const what = delegate ? `Delegating to ${subagent}` : `Running ${toolLabel(m.tool)}`
    return { text: `${what}${m.target ? ` · ${m.target}` : ''}`, since: m.at ?? null, tone: '' }
  }
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') return { text: 'Writing a reply', since: last.at ?? null, tone: '' }
  return { text: 'Thinking', since: last?.at ?? null, tone: '' }
}

/** The now-line's clock: 7s, 4m 03s, 1h 07m. */
export function shortElapsed(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  if (t < 60) return `${t}s`
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`
  return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`
}
