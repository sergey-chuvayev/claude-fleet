// Runtime checks at the HTTP boundary. Nothing from the wire becomes a typed value
// without passing one of these. Schemas are deliberately loose about fields this
// client does not read yet (extra keys are kept, not stripped) and strict about the
// fields it does, so a server change that would break the UI fails here, loudly,
// instead of somewhere in a component.
//
// Covered now: /api/control and the /api/sessions snapshot. Later packages add the
// rest next to these, one exported parser per route.
import { z } from 'zod'
import { ContractError } from './errors'

const nullableString = z.string().nullable()

export const approvalModeSchema = z.enum(['ask', 'auto', 'all'])
export type ApprovalMode = z.infer<typeof approvalModeSchema>

export const queueStateSchema = z.object({
  enabled: z.boolean(),
  limit: z.number(),
  paused: z.boolean(),
  running: z.number(),
  waiting: z.number(),
})
export type QueueState = z.infer<typeof queueStateSchema>

// ── /api/control ────────────────────────────────────────────────────────────

export const controlSchema = z.looseObject({
  token: z.string().min(1),
  version: z.string(),
  codex: z.looseObject({ available: z.boolean(), model: nullableString.optional() }),
  supportsSessionReferences: z.boolean().optional(),
  defaultCwd: nullableString.optional(),
  maxConcurrent: z.number().optional(),
  defaultApprovalMode: approvalModeSchema.optional(),
  queue: queueStateSchema.optional(),
  storageError: nullableString.optional(),
  searchDays: z.number().optional(),
  theme: z.looseObject({ name: nullableString.optional(), source: nullableString.optional() }).optional(),
  // Added by work package 2 (#103). Optional so an older running server still boots
  // the page; the shell can then explain that a restart is needed.
  apiVersion: z.number().optional(),
  instanceId: z.string().optional(),
  buildId: z.string().optional(),
  capabilities: z
    .looseObject({
      engines: z.record(z.string(), z.boolean()).optional(),
      structuredErrors: z.boolean().optional(),
    })
    .catchall(z.unknown())
    .optional(),
})
export type ControlResponse = z.infer<typeof controlSchema>
/** Control as the rest of the app sees it: the POST token stays inside the transport. */
const controlInfoSchema = controlSchema.omit({ token: true })
export type ControlInfo = z.infer<typeof controlInfoSchema>

// ── /api/sessions ───────────────────────────────────────────────────────────

export const engineSchema = z.enum(['claude', 'codex'])
export type Engine = z.infer<typeof engineSchema>
export const sessionStateSchema = z.enum(['busy', 'idle', 'stale', 'dead'])
export type SessionState = z.infer<typeof sessionStateSchema>

export const sessionSummarySchema = z
  .looseObject({
    /** Fleet's managed id; present for managed sessions from creation, never replaced. */
    managedId: z.string().min(1).optional(),
    /** Runtime transcript id; null for a managed session that has not started yet. */
    sessionId: nullableString.optional(),
    pid: z.number().nullable().optional(),
    /** Absent on external Claude rows: absence means Claude. */
    engine: engineSchema.optional(),
    name: nullableString.optional(),
    title: nullableString.optional(),
    shortId: nullableString.optional(),
    state: sessionStateSchema,
    managed: z.boolean().optional(),
    managedStatus: z.string().optional(),
    alive: z.boolean().optional(),
    archived: z.boolean().optional(),
    cwd: nullableString.optional(),
    cwdShort: nullableString.optional(),
    lastActivity: z.number().nullable().optional(),
    /** Content fingerprint added by the sync protocol: a change marker, never a key. */
    h: z.string().optional(),
  })
  .refine(s => !!s.managedId || !!s.sessionId || typeof s.pid === 'number', {
    message: 'a session needs a managedId, a sessionId or a pid',
  })
export type SessionSummary = z.infer<typeof sessionSummarySchema>

const snapshotShellSchema = z.looseObject({
  sessions: z.array(z.unknown()),
  counts: z.object({ busy: z.number(), idle: z.number(), stale: z.number(), dead: z.number() }),
  total: z.number(),
  archived: z.number().optional(),
  archiveRule: z.object({ enabled: z.boolean(), days: z.number() }).optional(),
  queue: queueStateSchema.optional(),
  storageError: nullableString.optional(),
  usage: z.unknown().optional(),
  generatedAt: z.number().optional(),
})
// Type only: the shell with its rows typed. Parsing goes row by row (below).
const sessionSnapshotSchema = snapshotShellSchema.extend({ sessions: z.array(sessionSummarySchema) })
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>

// ── Parsers ─────────────────────────────────────────────────────────────────

const issues = (error: z.ZodError): string => z.prettifyError(error).replace(/\s+/g, ' ').trim()

export function parseControl(raw: unknown): ControlResponse {
  const result = controlSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/control', issues(result.error))
  return result.data
}

// Items that already passed validation. Reconstruction hands back the same object for
// an unchanged row, so a steady list re-validates only the rows that changed.
const validRows = new WeakSet<object>()

const isSessionSummary = (value: unknown): value is SessionSummary => {
  if (typeof value === 'object' && value !== null && validRows.has(value)) return true
  if (!sessionSummarySchema.safeParse(value).success) return false
  if (typeof value === 'object' && value !== null) validRows.add(value)
  return true
}

/**
 * Validate a reconstructed snapshot. Rows are checked one by one and returned as the
 * very objects that came in, so reference identity from reconstruction survives.
 */
export function parseSessionSnapshot(raw: unknown): SessionSnapshot {
  const shell = snapshotShellSchema.safeParse(raw)
  if (!shell.success) throw new ContractError('/api/sessions', issues(shell.error))
  const sessions: SessionSummary[] = []
  shell.data.sessions.forEach((row, index) => {
    if (!isSessionSummary(row)) {
      const detail = sessionSummarySchema.safeParse(row)
      throw new ContractError('/api/sessions', `sessions[${index}]: ${detail.success ? 'invalid' : issues(detail.error)}`)
    }
    sessions.push(row)
  })
  return { ...shell.data, sessions }
}

// ── /api/managed/:id and /api/sessions/history ─────────────────────────────
// A conversation is a list of records. The roles the UI knows are user, assistant,
// tool and event; any other role is kept and shown as a plain system record instead of
// failing the whole conversation.

const attachmentSchema = z.looseObject({
  id: z.string().min(1),
  mediaType: z.string().optional(),
  bytes: z.number().optional(),
})
export type Attachment = z.infer<typeof attachmentSchema>

const messageReferenceSchema = z.looseObject({
  id: z.string().optional(),
  sessionId: nullableString.optional(),
  title: nullableString.optional(),
  project: nullableString.optional(),
  state: nullableString.optional(),
  context: nullableString.optional(),
  capturedAt: z.number().optional(),
})
export type MessageReference = z.infer<typeof messageReferenceSchema>

export const messageSchema = z.looseObject({
  /** Stable for the life of the record, also while a streaming reply grows. */
  id: z.string().min(1),
  role: z.string().min(1),
  at: z.number().nullable().optional(),
  text: nullableString.optional(),
  tool: nullableString.optional(),
  /** A derived view model's own heading (the Day's grouped board calls). */
  label: z.string().optional(),
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  target: nullableString.optional(),
  status: nullableString.optional(),
  result: nullableString.optional(),
  ms: z.number().nullable().optional(),
  truncated: z.boolean().optional(),
  approval: nullableString.optional(),
  attachments: z.array(attachmentSchema).optional(),
  references: z.array(messageReferenceSchema).optional(),
  lines: z.array(z.looseObject({ text: z.string(), error: z.boolean().optional() })).optional(),
  h: z.string().optional(),
})
export type Message = z.infer<typeof messageSchema>

const subagentSchema = z.looseObject({ id: z.string().min(1) })
export type Subagent = z.infer<typeof subagentSchema>

const managedSessionShape = {
  /** Fleet's managed id. */
  id: z.string().min(1),
  /** Runtime transcript id, null until the runtime assigns one. */
  sessionId: nullableString.optional(),
  engine: engineSchema.optional(),
  kind: z.string().optional(),
  name: nullableString.optional(),
  status: z.string(),
  error: nullableString.optional(),
  approvals: z.array(z.unknown()).optional(),
}
const managedDetailShellSchema = z.looseObject({
  session: z.looseObject({
    ...managedSessionShape,
    messages: z.array(z.unknown()),
    subagents: z.array(z.unknown()).optional(),
  }),
})
// Type only: the shell with its rows typed. Parsing goes row by row (below).
const managedDetailSchema = z.looseObject({
  session: z.looseObject({
    ...managedSessionShape,
    messages: z.array(messageSchema),
    subagents: z.array(subagentSchema).optional(),
  }),
})
export type ManagedDetail = z.infer<typeof managedDetailSchema>

const historyShellSchema = z.looseObject({
  messages: z.array(z.unknown()),
  truncated: z.boolean().optional(),
  alive: z.boolean().optional(),
})
const historySchema = historyShellSchema.extend({ messages: z.array(messageSchema) })
export type History = z.infer<typeof historySchema>

const validMessages = new WeakSet<object>()
const validSubagents = new WeakSet<object>()

// Each row is checked once and handed back as the very object that came in, so an
// unchanged message keeps its identity through reconstruction and React skips it.
function validRowsOf<T>(route: string, path: string, list: readonly unknown[], schema: z.ZodType<T>, seen: WeakSet<object>): T[] {
  return list.map((row, index) => {
    if (typeof row === 'object' && row !== null && seen.has(row)) return row as T
    const result = schema.safeParse(row)
    if (!result.success) throw new ContractError(route, `${path}[${index}]: ${issues(result.error)}`)
    if (typeof row === 'object' && row !== null) seen.add(row)
    return row as T
  })
}

export function parseManagedDetail(raw: unknown): ManagedDetail {
  const route = '/api/managed/:id'
  const shell = managedDetailShellSchema.safeParse(raw)
  if (!shell.success) throw new ContractError(route, issues(shell.error))
  const { messages, subagents, ...session } = shell.data.session
  return {
    ...shell.data,
    session: {
      ...session,
      messages: validRowsOf(route, 'session.messages', messages, messageSchema, validMessages),
      ...(subagents ? { subagents: validRowsOf(route, 'session.subagents', subagents, subagentSchema, validSubagents) } : {}),
    },
  }
}

export function parseHistory(raw: unknown): History {
  const route = '/api/sessions/history'
  const shell = historyShellSchema.safeParse(raw)
  if (!shell.success) throw new ContractError(route, issues(shell.error))
  return { ...shell.data, messages: validRowsOf(route, 'messages', shell.data.messages, messageSchema, validMessages) }
}

// ── The Day (/api/managed/:id for kind 'day', and /api/managed/:id/day) ────
// The board travels inside the Day's managed detail. The fields the Today feature
// reads are checked here; anything else on an item or a need is kept as it came.

export const dayPrioritySchema = z.enum(['must', 'should', 'could'])
export type DayPriority = z.infer<typeof dayPrioritySchema>
export const dayModeSchema = z.enum(['me', 'draft', 'agent', 'ask'])
export type DayMode = z.infer<typeof dayModeSchema>
export const dayStatusSchema = z.enum(['proposed', 'today', 'in_progress', 'waiting_on_you', 'done', 'later', 'dropped'])
export type DayStatus = z.infer<typeof dayStatusSchema>

const dayNeedSchema = z.looseObject({
  id: z.string().min(1),
  /** approve, choose, info or launch; a kind this client does not know is answered in words. */
  kind: z.string(),
  question: z.string(),
  at: z.number().optional(),
  options: z.array(z.string()).optional(),
  /** The exact text an approval sends, or the brief a launch starts from. */
  draft: z.string().optional(),
  launch: z
    .looseObject({ cwd: nullableString.optional(), teamId: nullableString.optional(), name: nullableString.optional() })
    .optional(),
  answer: z.string().optional(),
  decision: z.string().optional(),
  answeredAt: z.number().optional(),
  /** Set on the question an agent launched from the item asks when it reports back. */
  report: z.string().optional(),
})
export type DayNeed = z.infer<typeof dayNeedSchema>

const dayThreadSchema = z.looseObject({
  sessionId: z.string().min(1),
  at: z.number().optional(),
  summary: nullableString.optional(),
  closed: z.boolean().optional(),
})

const dayItemSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  source: z.string(),
  priority: dayPrioritySchema,
  status: dayStatusSchema,
  mode: dayModeSchema,
  estimateMin: z.number().nullable().optional(),
  links: z.array(z.string()),
  context: nullableString.optional(),
  needs: z.array(dayNeedSchema),
  log: z.array(z.looseObject({ at: z.number(), text: z.string() })),
  createdAt: z.number(),
  by: z.string().optional(),
  carriedFrom: nullableString.optional(),
  projectId: nullableString.optional(),
  deliverableId: nullableString.optional(),
  launched: z.array(z.string()).optional(),
  thread: dayThreadSchema.nullable().optional(),
  previousThread: dayThreadSchema.extend({ summary: z.string() }).nullable().optional(),
})
export type DayItem = z.infer<typeof dayItemSchema>

export const dayBoardSchema = z.looseObject({
  date: z.string(),
  items: z.array(dayItemSchema),
  cursors: z.record(z.string(), z.unknown()).optional(),
  capacity: z.looseObject({ freeMinutes: z.number().nullable().optional(), at: z.number().optional() }).nullable().optional(),
  focus: z.looseObject({ itemId: nullableString.optional(), at: z.number() }).nullable().optional(),
})
export type DayBoard = z.infer<typeof dayBoardSchema>

const dayChecksSchema = z.looseObject({
  lastAt: z.number().nullable().optional(),
  everyMin: z.number(),
  hours: z.tuple([z.number(), z.number()]).optional(),
})
export type DayChecks = z.infer<typeof dayChecksSchema>

const dayStepSchema = z.looseObject({
  id: z.string().min(1),
  tool: z.string(),
  target: nullableString.optional(),
  status: z.string(),
  input: z.unknown().optional(),
  result: nullableString.optional(),
  ms: z.number().nullable().optional(),
  truncated: z.boolean().optional(),
})

/** One of the Day's subagents: a scout, or a worker on an item. */
const daySubagentSchema = z.looseObject({
  id: z.string().min(1),
  role: z.string(),
  status: z.string(),
  itemId: nullableString.optional(),
  description: nullableString.optional(),
  prompt: nullableString.optional(),
  model: nullableString.optional(),
  startedAt: z.number().nullable().optional(),
  finishedAt: z.number().nullable().optional(),
  output: nullableString.optional(),
  report: nullableString.optional(),
  steps: z.array(dayStepSchema).optional(),
})
export type DaySubagent = z.infer<typeof daySubagentSchema>

const tokenUsageSchema = z.looseObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheCreation: z.number() })
export type TokenUsage = z.infer<typeof tokenUsageSchema>

/** What the Today feature reads from a Day's (or an item thread's) managed detail. */
const dayDetailSchema = z.looseObject({
  dayBoard: dayBoardSchema.nullable().optional(),
  dayChecks: dayChecksSchema.nullable().optional(),
  subagents: z.array(daySubagentSchema).optional(),
  tokenUsage: tokenUsageSchema.nullable().optional(),
  contextTokens: z.number().nullable().optional(),
  contextLimit: z.number().nullable().optional(),
  currentTool: nullableString.optional(),
  queue: z.array(z.unknown()).optional(),
})
export type DayDetail = z.infer<typeof dayDetailSchema>

const dayDetails = new WeakMap<object, DayDetail>()

/**
 * The Day's own fields of a managed detail, validated once per detail object (the
 * store hands back the same object until the session changes).
 */
export function parseDayDetail(session: ManagedDetail['session']): DayDetail {
  const held = dayDetails.get(session)
  if (held) return held
  const result = dayDetailSchema.safeParse(session)
  if (!result.success) throw new ContractError('/api/managed/:id (Day)', issues(result.error))
  dayDetails.set(session, result.data)
  return result.data
}

/** The browser-facing Day actions (plan section 5); not the agent tool's protocol. */
export type DayAction =
  | {
      readonly op: 'add'
      readonly item: {
        readonly title: string
        readonly source: 'me'
        readonly context?: string
        readonly links?: readonly string[]
        readonly priority?: DayPriority
        readonly mode?: DayMode
        readonly estimateMin?: number
        readonly projectId?: string
      }
    }
  | {
      readonly op: 'triage'
      readonly itemId: string
      readonly status?: 'today' | 'later' | 'dropped' | 'proposed' | 'done'
      readonly priority?: DayPriority
      readonly mode?: DayMode
      readonly projectId?: string | null
    }
  | {
      readonly op: 'answer'
      readonly itemId: string
      readonly needId: string
      readonly answer: string
      readonly decision?: 'reply' | 'approve' | 'reject' | 'edit' | 'choose' | 'info'
      readonly cwd?: string
      readonly teamId?: string
    }
  | { readonly op: 'sweep' }
  | { readonly op: 'thread'; readonly itemId: string; readonly message: string; readonly requestId: string }

const dayActionResponseSchema = z.looseObject({ result: z.unknown(), session: z.looseObject({ id: z.string().min(1) }) })

/** `{result, session}` from /api/managed/:id/day; `session` is the Day's whole detail. */
export function parseDayActionResponse(raw: unknown): { result: unknown; detail: ManagedDetail } {
  const shell = dayActionResponseSchema.safeParse(raw)
  if (!shell.success) throw new ContractError('/api/managed/:id/day', issues(shell.error))
  return { result: shell.data.result, detail: parseManagedDetail({ session: shell.data.session }) }
}

const threadResultSchema = z.looseObject({ threadId: z.string().min(1) })

/** The thread op's result: the item thread's managed id. */
export function parseDayThreadResult(raw: unknown): string {
  const result = threadResultSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/managed/:id/day (thread)', issues(result.error))
  return result.data.threadId
}

// ── /api/teams and /api/projects, as far as the Day board reads them ───────

const teamListSchema = z.looseObject({ teams: z.array(z.looseObject({ id: z.string().min(1), name: z.string() })) })
export type TeamList = z.infer<typeof teamListSchema>

export function parseTeamList(raw: unknown): TeamList {
  const result = teamListSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/teams', issues(result.error))
  return result.data
}

const projectListSchema = z.looseObject({
  projects: z.array(z.looseObject({ id: z.string().min(1), name: z.string(), archived: z.boolean().optional() })),
})
export type ProjectList = z.infer<typeof projectListSchema>

export function parseProjectList(raw: unknown): ProjectList {
  const result = projectListSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/projects', issues(result.error))
  return result.data
}
