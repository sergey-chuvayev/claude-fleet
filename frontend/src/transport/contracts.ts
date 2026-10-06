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

// ── The control panel: fields of a managed detail, and its side routes ──────
// A managed detail is a loose clone of the server's session (plan section 6). The
// console reads these fields from it; each one falls back on its own when it has an
// unexpected shape, so one odd field costs that one control, not the conversation.

export const approvalSchema = z.looseObject({
  id: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  at: z.number().nullable().optional(),
  reason: nullableString.optional(),
  description: nullableString.optional(),
  /** Inside an initiative, the role that asked. */
  role: nullableString.optional(),
})
export type Approval = z.infer<typeof approvalSchema>

/** AskUserQuestion's input: answers are keyed by the question text in the request. */
export const askQuestionSchema = z.looseObject({
  question: z.string().min(1),
  header: nullableString.optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: nullableString.optional() })).optional(),
})
export type AskQuestion = z.infer<typeof askQuestionSchema>

export const queuedMessageSchema = z.looseObject({
  id: z.string().optional(),
  message: nullableString.optional(),
  attachments: z.array(z.unknown()).optional(),
  references: z.array(z.unknown()).optional(),
})
export type QueuedMessage = z.infer<typeof queuedMessageSchema>

/** Another program (a terminal) holding this managed session; messages wait for it. */
export const holderSchema = z.looseObject({
  pid: z.number().nullable().optional(),
  name: nullableString.optional(),
  entrypoint: nullableString.optional(),
  state: nullableString.optional(),
  startedAt: z.number().nullable().optional(),
})
export type Holder = z.infer<typeof holderSchema>

export const modelRoutingSchema = z.looseObject({
  model: z.string(),
  description: nullableString.optional(),
  signals: z.looseObject({ complexity: z.unknown().optional(), probability: z.number().optional() }).nullable().optional(),
})
export type ModelRouting = z.infer<typeof modelRoutingSchema>

export const teamRoleSchema = z.looseObject({
  model: nullableString.optional(),
  description: nullableString.optional(),
})
export const teamSnapshotSchema = z.looseObject({
  manager: z.string(),
  roles: z.record(z.string(), teamRoleSchema),
  workflow: z
    .looseObject({ mode: z.string().optional(), reviewers: z.array(z.string()).optional(), maxAttempts: z.number().optional() })
    .nullable()
    .optional(),
})
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>

export const boardTaskSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  owner: z.string().optional(),
  status: z.string(),
  attempt: z.number().optional(),
  criteria: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  blocker: nullableString.optional(),
  snapshot: z.looseObject({ commit: z.string() }).nullable().optional(),
  reviewErrors: z.number().optional(),
  evidence: nullableString.optional(),
})
export type BoardTask = z.infer<typeof boardTaskSchema>

export const boardDelegationSchema = z.looseObject({
  id: z.string().min(1),
  taskId: nullableString.optional(),
  role: z.string(),
  status: z.string(),
  model: nullableString.optional(),
  activity: nullableString.optional(),
  prompt: nullableString.optional(),
  report: nullableString.optional(),
})
export type BoardDelegation = z.infer<typeof boardDelegationSchema>

export const taskBoardSchema = z.looseObject({
  tasks: z.array(boardTaskSchema),
  delegations: z.array(boardDelegationSchema),
})
export type TaskBoard = z.infer<typeof taskBoardSchema>

const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

const controlFieldsSchema = z.object({
  kind: lenient(z.string()),
  name: lenient(nullableString),
  aiTitle: lenient(nullableString),
  renamed: lenient(z.boolean()),
  cwd: lenient(nullableString),
  projectId: lenient(nullableString),
  approvalMode: lenient(approvalModeSchema),
  selectedModel: lenient(nullableString),
  modelRouting: lenient(modelRoutingSchema.nullable()),
  contextTokens: lenient(z.number().nullable()),
  contextLimit: lenient(z.number().nullable()),
  currentTool: lenient(nullableString),
  approvals: lenient(z.array(approvalSchema)),
  queue: lenient(z.array(queuedMessageSchema)),
  openElsewhere: lenient(holderSchema.nullable()),
  teamName: lenient(nullableString),
  teamSnapshot: lenient(teamSnapshotSchema.nullable()),
  taskBoard: lenient(taskBoardSchema.nullable()),
  limits: lenient(z.looseObject({ maxAttempts: z.number().optional() }).nullable()),
})
export type ControlFields = z.infer<typeof controlFieldsSchema>

const controlFieldsSeen = new WeakMap<object, ControlFields>()

/** The control panel's view of a managed session. Never throws; computed once per session object. */
export function readControlFields(session: ManagedDetail['session']): ControlFields {
  const seen = controlFieldsSeen.get(session)
  if (seen) return seen
  const fields = controlFieldsSchema.parse(session)
  controlFieldsSeen.set(session, fields)
  return fields
}

/** The `{session}` answer of a managed mutation (message, stop, mode, model, approval, name, project). */
export function parseSessionAnswer(raw: unknown): ManagedDetail | null {
  try {
    return parseManagedDetail(raw)
  } catch {
    return null
  }
}

// ── /api/managed/:id/commands, /api/models ─────────────────────────────────

export const commandSchema = z.looseObject({
  name: z.string().min(1),
  kind: z.string().optional(),
  scope: z.string().optional(),
  description: nullableString.optional(),
  hint: nullableString.optional(),
})
export type Command = z.infer<typeof commandSchema>

export function parseCommands(raw: unknown): readonly Command[] {
  const result = z.looseObject({ commands: z.array(z.unknown()) }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/managed/:id/commands', issues(result.error))
  // One malformed entry is skipped, not fatal: the picker only inserts text.
  return result.data.commands.flatMap(entry => {
    const parsed = commandSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

export const modelOptionSchema = z.looseObject({
  value: z.string(),
  displayName: nullableString.optional(),
  description: nullableString.optional(),
})
export type ModelOption = z.infer<typeof modelOptionSchema>

export function parseModels(raw: unknown): { models: ModelOption[] } {
  const result = z.looseObject({ models: z.array(modelOptionSchema).min(1) }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/models', issues(result.error))
  return result.data
}

// ── /api/projects, /api/progress, /api/worktrees ───────────────────────────
// Plain JSON routes (no ETag, no packed arrays). Loose about fields the client does
// not read, defaulted where the server may omit a field (a project just created or
// archived has no progress or members yet).

export const DELIVERABLE_STATES = ['todo', 'doing', 'review', 'done'] as const
export type DeliverableState = (typeof DELIVERABLE_STATES)[number]

const deliverableSchema = z.looseObject({
  /** Stable and persisted since B04: scope is project plus deliverable, never title or index. */
  id: z.string().min(1),
  title: z.string(),
  state: z.string(),
  note: z.string().default(''),
  brief: z.string().default(''),
  links: z.array(z.string()).default([]),
})
export type Deliverable = z.infer<typeof deliverableSchema>

const projectSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  deadline: nullableString.optional(),
  archived: z.boolean().default(false),
  repos: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  brief: z.string().default(''),
  deliverables: z.array(deliverableSchema).default([]),
  sections: z.array(z.looseObject({ heading: z.string(), body: z.string().default('') })).default([]),
  log: z.array(z.looseObject({ at: z.number(), text: z.string() })).default([]),
  file: z.string().default(''),
  updatedAt: z.number().optional(),
  /** Only on the answer to a create: false when the manager could not start. */
  setup: z.looseObject({ started: z.boolean(), error: z.string().optional() }).optional(),
  progress: z.looseObject({ total: z.number(), done: z.number(), doing: z.number().optional() }).default({ total: 0, done: 0 }),
  sessions: z.number().default(0),
  onToday: z.record(z.string(), z.looseObject({ itemId: z.string(), status: z.string() })).default({}),
  managerId: nullableString.default(null),
})
export type Project = z.infer<typeof projectSchema>

export function parseProjects(raw: unknown): Project[] {
  const result = z.looseObject({ projects: z.array(projectSchema) }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/projects', issues(result.error))
  return result.data.projects
}

/** The answer to a create or an archive: one project. */
export function parseProject(raw: unknown): Project {
  const result = z.looseObject({ project: projectSchema }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/projects', issues(result.error))
  return result.data.project
}

const progressSchema = z.looseObject({
  since: z.number(),
  days: z.number(),
  staleDays: z.number(),
  shipped: z.looseObject({
    items: z.array(z.looseObject({ id: z.string(), title: z.string(), date: z.string(), prs: z.array(z.string()).default([]) })),
    count: z.number(),
    prs: z.number(),
  }),
  stalled: z.looseObject({
    items: z.array(z.looseObject({ id: z.string(), title: z.string(), kind: z.string(), status: z.string(), lastMoved: z.number() })),
    count: z.number(),
  }),
  ran: z.looseObject({
    count: z.number(),
    outcomes: z.record(z.string(), z.number()),
    sessions: z.array(z.looseObject({ id: z.string(), name: z.string(), outcome: z.string(), at: z.number(), teamName: nullableString.optional() })),
  }),
})
export type ProgressReport = z.infer<typeof progressSchema>

export function parseProgress(raw: unknown): ProgressReport {
  const result = progressSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/progress', issues(result.error))
  return result.data
}

const checkoutSchema = z.looseObject({
  path: z.string().min(1),
  pathShort: z.string(),
  repo: z.looseObject({ name: z.string(), root: z.string() }),
  branch: nullableString,
  tip: nullableString.optional(),
  trunk: nullableString.optional(),
  isMain: z.boolean(),
  merged: z.boolean(),
  mergedBy: nullableString.optional(),
  empty: z.boolean().optional(),
  dirty: z.number(),
  unpushed: z.number(),
  locked: z.boolean().optional(),
  running: z.boolean().optional(),
  pr: z.looseObject({ number: z.number(), url: z.string().optional(), state: z.string() }).nullable().optional(),
  clearable: z.boolean(),
  blockers: z.array(z.looseObject({ text: z.string() })).default([]),
  sessions: z
    .array(z.looseObject({ name: nullableString.optional(), engine: z.string().optional(), alive: z.boolean().optional(), cwd: z.string() }))
    .default([]),
})
export type Checkout = z.infer<typeof checkoutSchema>

const worktreesSchema = z.looseObject({
  generatedAt: z.number().optional(),
  checkouts: z.array(checkoutSchema),
  outside: z.number().default(0),
})
export type WorktreeReport = z.infer<typeof worktreesSchema>

export function parseWorktrees(raw: unknown): WorktreeReport {
  const result = worktreesSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/worktrees', issues(result.error))
  return result.data
}

// ── /api/search ─────────────────────────────────────────────────────────────

const searchHitSchema = z.looseObject({
  sessionId: z.string().min(1),
  title: nullableString.optional(),
  cwd: nullableString.optional(),
  project: nullableString.optional(),
  firstAt: z.number().nullable().optional(),
  lastAt: z.number().nullable().optional(),
  matches: z.number().optional(),
  snippets: z
    .array(z.looseObject({ role: z.string(), text: z.string(), at: z.number().nullable().optional() }))
    .optional(),
})
export type SearchHit = z.infer<typeof searchHitSchema>

const searchMatchSchema = z.looseObject({
  sessionId: z.string().min(1),
  relevance: z.string().optional(),
  context: nullableString.optional(),
  quote: nullableString.optional(),
})
export type SearchMatch = z.infer<typeof searchMatchSchema>

export const searchJobSchema = z.looseObject({
  id: z.string().min(1),
  question: z.string(),
  model: z.string().optional(),
  status: z.enum(['thinking', 'done', 'error', 'stopped']),
  hits: z.array(searchHitSchema),
  sessions: z.number().optional(),
  passages: z.number().optional(),
  searchMs: z.number().optional(),
  ai: z.looseObject({ answer: z.string(), matches: z.array(searchMatchSchema) }).nullable().optional(),
  error: nullableString.optional(),
  aiMs: z.number().nullable().optional(),
})
export type SearchJob = z.infer<typeof searchJobSchema>

/** `{key: value}` answers: validate the value under `key` and hand it back. */
const envelope = <T extends z.ZodType>(route: string, key: string, schema: T) => {
  const wrapper = z.looseObject({ [key]: schema })
  return (raw: unknown): z.infer<T> => {
    const result = wrapper.safeParse(raw)
    if (!result.success) throw new ContractError(route, issues(result.error))
    return (result.data as Record<string, z.infer<T>>)[key] as z.infer<T>
  }
}

/** `{job}` from POST /api/search and GET /api/search/:id. */
export const parseSearchJob = envelope('/api/search', 'job', searchJobSchema)

// ── /api/connections ────────────────────────────────────────────────────────

export const connectionStatusSchema = z.enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>

// A plain object, not a loose one: unknown keys are dropped here, so a server row
// that carried a command line, environment or headers can never reach the page.
const connectionServerSchema = z.object({
  name: z.string().min(1),
  status: z.string(),
  scope: z.string().optional(),
  internal: z.boolean().optional(),
  tools: z.array(z.string()).default([]),
  canToggle: z.boolean().optional(),
  canAuthenticate: z.boolean().optional(),
  error: nullableString.optional(),
})
export type ConnectionServer = z.infer<typeof connectionServerSchema>

const connectionResultSchema = z.object({
  cwd: z.string(),
  source: z.enum(['session', 'project']),
  connectionId: z.string().optional(),
  checkedAt: z.number(),
  servers: z.array(connectionServerSchema),
  auth: z
    .object({
      name: z.string().optional(),
      url: nullableString.optional(),
      opened: z.boolean().optional(),
      needsAction: z.boolean().optional(),
    })
    .nullable()
    .optional(),
})
export type ConnectionResult = z.infer<typeof connectionResultSchema>

export const parseConnections = envelope('/api/connections', 'connections', connectionResultSchema)

// ── /api/queue, /api/service, /api/settings/*, /api/update ──────────────────

export const parseQueueResponse = envelope('/api/queue', 'queue', queueStateSchema)

const gatewaySchema = z.object({
  configured: z.boolean(),
  source: z.enum(['saved', 'environment']).nullable().optional(),
})
export type GatewayStatus = z.infer<typeof gatewaySchema>

const gatewayResponseSchema = z.looseObject({
  gateway: gatewaySchema,
  test: z.looseObject({ message: nullableString.optional(), ok: z.boolean().optional() }).nullable().optional(),
})
export interface GatewayResponse {
  readonly gateway: GatewayStatus
  readonly testMessage: string | null
}
export function parseGatewayResponse(raw: unknown): GatewayResponse {
  const result = gatewayResponseSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/settings/gateway', issues(result.error))
  return { gateway: result.data.gateway, testMessage: result.data.test?.message ?? null }
}

const serviceSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  loaded: z.boolean().optional(),
  managed: z.boolean().optional(),
})
export type ServiceStatus = z.infer<typeof serviceSchema>
export const parseService = envelope('/api/service', 'service', serviceSchema)
export function parseServiceChange(raw: unknown): { service: ServiceStatus; restarting: boolean } {
  const result = z.looseObject({ service: serviceSchema, restarting: z.boolean().optional() }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/service', issues(result.error))
  return { service: result.data.service, restarting: result.data.restarting === true }
}

export function parseApprovalModeResponse(raw: unknown): ApprovalMode {
  const result = z.looseObject({ defaultApprovalMode: approvalModeSchema }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/settings/approval-mode', issues(result.error))
  return result.data.defaultApprovalMode
}

const updateSchema = z.looseObject({
  name: z.string().optional(),
  current: z.string().optional(),
  latest: nullableString.optional(),
  available: z.boolean(),
  canInstall: z.boolean(),
  channel: nullableString.optional(),
  checkedAt: z.number().nullable().optional(),
  state: z.string().optional(),
  error: nullableString.optional(),
  installed: nullableString.optional(),
  restarting: z.boolean().optional(),
})
export type UpdateStatus = z.infer<typeof updateSchema>
export const parseUpdate = envelope('/api/update', 'update', updateSchema)
