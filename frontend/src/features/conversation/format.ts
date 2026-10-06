// Pure helpers for conversation blocks, ported from public/blocks.js. No React here.
import type { Message } from '../../transport/contracts'

export const ICONS: Readonly<Record<string, string>> = {
  Bash: '⚡',
  BashOutput: '⚡',
  Read: '▤',
  Write: '✎',
  Edit: '✎',
  NotebookEdit: '✎',
  Grep: '⌕',
  Glob: '⌕',
  WebSearch: '⌕',
  WebFetch: '↓',
  Task: '✳',
  Agent: '✳',
  Skill: '◆',
  TodoWrite: '☑',
  AskUserQuestion: '?',
  ExitPlanMode: '▸',
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  py: 'python',
  rs: 'rust',
  go: 'go',
  swift: 'swift',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  diff: 'diff',
  patch: 'diff',
  toml: 'plaintext',
}

/** Mirrors toolTarget() in managed.js: the input key already shown in the block header. */
export const TARGET_KEYS: Readonly<Record<string, string>> = {
  Bash: 'command',
  BashOutput: 'bash_id',
  Task: 'description',
  Agent: 'description',
  WebSearch: 'query',
  WebFetch: 'url',
  Grep: 'pattern',
  Glob: 'pattern',
  Skill: 'skill',
}

/**
 * The runtime names this tool `Agent`; `Task` is the older name for the same call and
 * still appears in transcripts recorded before the rename. Both carry
 * {subagent_type, description, prompt}, so both render as a delegation.
 */
export const isDelegation = (name: string | null | undefined): boolean => name === 'Agent' || name === 'Task'

export const languageFor = (file: unknown): string | null =>
  EXTENSIONS[String(file ?? '').split('.').pop()?.toLowerCase() ?? ''] ?? null

export function duration(ms: number | null | undefined): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

export const clock = (at: number | null | undefined): string =>
  at == null ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** A plain string from a tool input value, whatever the runtime put there. */
export const text = (value: unknown): string =>
  value == null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)

// A tool's name as a person would say it. MCP names carry their server and an
// underscore-joined action ("mcp__claude_ai_Slack__slack_search_public"); Fleet's own
// Day board tool is just "Board".
const SERVER_NAMES: Readonly<Record<string, string>> = { fleet: 'Fleet', 'linear-server': 'Linear', granola: 'Granola', github: 'GitHub' }
/** Built-in tools whose own names describe the mechanism rather than what happened. */
const PLAIN_NAMES: Readonly<Record<string, string>> = { ToolSearch: 'Loading tools' }
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function toolLabel(name: string | null | undefined): string {
  const plain = name ? PLAIN_NAMES[name] : undefined
  if (plain) return plain
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''))
  if (!mcp?.[1] || !mcp[2]) return String(name || 'Tool')
  if (mcp[1] === 'fleet' && mcp[2] === 'day') return 'Board'
  const server = SERVER_NAMES[mcp[1]] ?? mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')
  const action = mcp[2].replace(new RegExp(`^${escapeRegExp(server.toLowerCase())}_`), '').replace(/_/g, ' ')
  return `${server} · ${action}`
}

export type ToolState = 'is-done' | 'is-failed' | 'is-running' | 'is-interrupted'
export const toolState = (status: string | null | undefined): ToolState =>
  status === 'error' ? 'is-failed' : status === 'running' ? 'is-running' : status === 'interrupted' ? 'is-interrupted' : 'is-done'

/** Completed tool activity starts compact; errors, live work and delegations stay open. */
export const startsCollapsed = (message: Message): boolean =>
  message.role === 'tool' && !isDelegation(message.tool) && message.status !== 'running' && message.status !== 'error'

/** What the copy action puts on the clipboard. */
export function copyText(message: Message): string {
  if (message.role !== 'tool') return message.text ?? ''
  const parts = [`${message.tool ?? ''}${message.target ? ` · ${message.target}` : ''}`]
  const command = message.input?.command
  if (message.tool === 'Bash' && command) parts.push(text(command))
  else parts.push(JSON.stringify(message.input ?? {}, null, 2))
  if (message.result) parts.push('', message.result)
  return parts.join('\n')
}

/** The working states in which the last assistant message is still being written. */
export const isWorking = (status: string | null | undefined): boolean =>
  status === 'starting' || status === 'running' || status === 'approval' || status === 'stopping'

/** Who replies: CLAUDE, or CODEX for a Codex session. */
export const agentLabel = (engine: string | null | undefined): string => (engine === 'codex' ? 'CODEX' : 'CLAUDE')

/** The legacy page renders at most this many messages; the server keeps the same bound. */
export const MESSAGE_WINDOW = 200
