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

// ── Session rows, as the list and the inspector read them ──────────────────
// The snapshot schema above checks only what identity needs. The list and the
// inspector read many more fields; each is checked here on its own and falls back to
// "absent" when it does not have the expected shape, so one odd field costs that
// field, not the row. Read through `sessionRowOf`, which validates a row object once
// and caches the result by identity, so an unchanged row costs nothing per render.

const optionalText = z.string().nullable().optional().catch(null)
const optionalNumber = z.number().nullable().optional().catch(null)
const optionalBoolean = z.boolean().nullable().optional().catch(null)
/** Timestamps arrive as epoch milliseconds or ISO strings. */
const optionalTime = z.union([z.number(), z.string()]).nullable().optional().catch(null)

const sessionLinkSchema = z.looseObject({ url: z.string(), kind: z.string().optional(), label: z.string().optional() })
export type SessionLink = z.infer<typeof sessionLinkSchema>

const turnStepSchema = z.looseObject({
  /** Tool name. */
  t: z.string(),
  /** Family of work: inspect, change, run, delegate, ask, other. */
  k: z.string().optional(),
  ok: z.boolean().optional(),
  target: z.string().nullable().optional(),
})
const turnNowSchema = z.looseObject({ t: z.string(), target: z.string().nullable().optional(), at: z.number().nullable().optional() })
const turnSchema = z.looseObject({
  steps: z.array(turnStepSchema).catch([]),
  turnStartedAt: z.number().nullable().optional().catch(null),
  current: turnNowSchema.nullable().optional().catch(null),
  last: turnNowSchema.nullable().optional().catch(null),
})
export type TurnSummary = z.infer<typeof turnSchema>

const delegationSummarySchema = z.looseObject({
  id: z.string().min(1),
  role: z.string().catch('agent'),
  model: z.string().nullable().optional().catch(null),
  status: z.string().catch('running'),
})
export type DelegationSummary = z.infer<typeof delegationSummarySchema>

const sessionRowFieldsSchema = z.object({
  managedStatus: z.string().optional().catch(undefined),
  queuePosition: optionalNumber,
  lastPrompt: optionalText,
  latestResponse: optionalText,
  latestResponseAt: optionalTime,
  startedAt: optionalTime,
  branch: optionalText,
  model: optionalText,
  contextTokens: optionalNumber,
  contextLimit: optionalNumber,
  permissionMode: optionalText,
  messages: optionalNumber,
  resumeCmd: optionalText,
  transcriptTruncated: optionalBoolean,
  background: optionalBoolean,
  spawnedByPid: optionalNumber,
  spawnedByName: optionalText,
  kind: optionalText,
  teamId: optionalText,
  teamName: optionalText,
  threadOpen: optionalBoolean,
  links: z.array(sessionLinkSchema).nullable().optional().catch(null),
  turn: turnSchema.nullable().optional().catch(null),
  openElsewhere: z
    .looseObject({ entrypoint: z.string().nullable().optional(), name: z.string().nullable().optional(), state: z.string().nullable().optional() })
    .nullable()
    .optional()
    .catch(null),
  taskProgress: z
    .looseObject({ verified: z.number(), total: z.number(), blocked: z.number().optional() })
    .nullable()
    .optional()
    .catch(null),
  dayProgress: z
    .looseObject({ done: z.number(), total: z.number(), waiting: z.number().optional(), proposed: z.number().optional() })
    .nullable()
    .optional()
    .catch(null),
  delegations: z.array(delegationSummarySchema).nullable().optional().catch(null),
})
export type SessionRowFields = z.infer<typeof sessionRowFieldsSchema>
/** A row with the fields the list and inspector read, typed. */
export type SessionRow = SessionSummary & SessionRowFields

const rowCache = new WeakMap<object, SessionRow>()

/** The typed view of a validated snapshot row; the same object for the same row. */
export function sessionRowOf(summary: SessionSummary): SessionRow {
  const cached = rowCache.get(summary)
  if (cached) return cached
  const fields = sessionRowFieldsSchema.parse(summary)
  const row: SessionRow = { ...summary, ...fields }
  rowCache.set(summary, row)
  return row
}

// ── A delegation's full record, from /api/managed/:id (taskBoard.delegations) ──

const delegationStepSchema = z.looseObject({
  id: z.string().min(1),
  tool: z.string().catch('Tool'),
  target: z.string().nullable().optional().catch(null),
  status: z.string().catch('done'),
  input: z.unknown().optional(),
  result: z.string().nullable().optional().catch(null),
  ms: z.number().nullable().optional().catch(null),
  truncated: z.boolean().optional().catch(false),
})
export type DelegationStep = z.infer<typeof delegationStepSchema>

const tokenUsageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
})

const delegationRecordSchema = z.looseObject({
  id: z.string().min(1),
  role: z.string().optional().catch(undefined),
  model: z.string().nullable().optional().catch(null),
  status: z.string().optional().catch(undefined),
  attempt: z.number().nullable().optional().catch(null),
  startedAt: z.number().nullable().optional().catch(null),
  finishedAt: z.number().nullable().optional().catch(null),
  prompt: z.string().nullable().optional().catch(null),
  report: z.string().nullable().optional().catch(null),
  usage: tokenUsageSchema.nullable().optional().catch(null),
  runtimeUsage: z.looseObject({ total_tokens: z.number().nullable().optional() }).nullable().optional().catch(null),
  steps: z.array(delegationStepSchema).optional().catch([]),
  stepsTruncated: z.boolean().optional().catch(false),
})
export type DelegationRecord = z.infer<typeof delegationRecordSchema>

/**
 * One delegation out of a managed detail's task board, or null when the board does not
 * list it. A malformed record is a ContractError, not a silent blank.
 */
export function delegationOf(detail: ManagedDetail, delegationId: string): DelegationRecord | null {
  const board = (detail.session as Record<string, unknown>).taskBoard
  const list = typeof board === 'object' && board !== null ? (board as Record<string, unknown>).delegations : undefined
  if (!Array.isArray(list)) return null
  const raw: unknown = list.find(item => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === delegationId)
  if (raw === undefined) return null
  const result = delegationRecordSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/managed/:id', `taskBoard.delegations: ${issues(result.error)}`)
  return result.data
}

// ── /api/pr-status ──────────────────────────────────────────────────────────

const prStatusSchema = z.union([
  z.looseObject({
    ok: z.literal(true),
    url: z.string().optional(),
    state: z.string(),
    draft: z.boolean().optional(),
    number: z.number().nullable().optional(),
    ci: z.looseObject({ result: z.enum(['pass', 'fail', 'pending', 'none']), failing: z.array(z.string()).catch([]) }),
  }),
  z.looseObject({ ok: z.literal(false), url: z.string().optional(), reason: z.string().optional() }),
])
export type PrStatus = z.infer<typeof prStatusSchema>

export function parsePrStatus(raw: unknown): PrStatus {
  const result = z.looseObject({ status: prStatusSchema }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/pr-status', issues(result.error))
  return result.data.status
}

// ── /api/archive and /api/archive/rule ─────────────────────────────────────

const archiveResultSchema = z.looseObject({ changed: z.number(), archived: z.number().optional() })
export type ArchiveResult = z.infer<typeof archiveResultSchema>

export function parseArchiveResult(raw: unknown): ArchiveResult {
  const result = archiveResultSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/archive', issues(result.error))
  return result.data
}

const archiveRuleSchema = z.object({ enabled: z.boolean(), days: z.number() })
export type ArchiveRule = z.infer<typeof archiveRuleSchema>

export function parseArchiveRuleResult(raw: unknown): ArchiveRule {
  const result = z.looseObject({ rule: archiveRuleSchema }).safeParse(raw)
  if (!result.success) throw new ContractError('/api/archive/rule', issues(result.error))
  return result.data.rule
}

// ── /api/models, /api/teams, POST /api/managed (the launch dialog) ──────────

const modelOptionSchema = z.looseObject({
  value: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
})
export type ModelOption = z.infer<typeof modelOptionSchema>
// An empty list is a broken answer, not "no models": the caller keeps its fallback.
const modelsSchema = z.looseObject({ models: z.array(modelOptionSchema).min(1) })

export function parseModels(raw: unknown): ModelOption[] {
  const result = modelsSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/models', issues(result.error))
  return result.data.models
}

export const teamModeSchema = z.enum(['team', 'owner-review'])
export type TeamMode = z.infer<typeof teamModeSchema>

const teamSummarySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  manager: z.string().optional(),
  mode: teamModeSchema.optional(),
  custom: z.boolean().optional(),
  roles: z.array(z.looseObject({ name: z.string(), description: z.string().optional(), model: nullableString.optional() })),
})
export type TeamSummary = z.infer<typeof teamSummarySchema>
const teamCatalogSchema = z.looseObject({ teams: z.array(teamSummarySchema), tools: z.array(z.string()) })
export type TeamCatalog = z.infer<typeof teamCatalogSchema>

export function parseTeamCatalog(raw: unknown): TeamCatalog {
  const result = teamCatalogSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/teams', issues(result.error))
  return result.data
}

const teamRoleSchema = z.looseObject({
  description: z.string(),
  prompt: z.string(),
  model: nullableString.optional(),
  maxTurns: z.number().optional(),
  effort: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
})
export type TeamRole = z.infer<typeof teamRoleSchema>
const teamDefinitionSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  manager: z.string(),
  roles: z.record(z.string(), teamRoleSchema),
  workflow: z
    .looseObject({ mode: teamModeSchema.optional(), reviewers: z.array(z.string()), maxAttempts: z.number().optional() })
    .optional(),
})
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>
const teamAnswerSchema = z.looseObject({ team: teamDefinitionSchema })

/** GET /api/teams/:id and POST /api/teams both answer `{team}`. */
export function parseTeamAnswer(raw: unknown): TeamDefinition {
  const result = teamAnswerSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/teams/:id', issues(result.error))
  return result.data.team
}

const launchedSchema = z.looseObject({
  session: z.looseObject({ ...managedSessionShape, messages: z.array(z.unknown()).optional() }),
})
export type LaunchedSession = z.infer<typeof launchedSchema>['session']

/** POST /api/managed: the created (or, for a repeated request id, the existing) session. */
export function parseLaunched(raw: unknown): LaunchedSession {
  const result = launchedSchema.safeParse(raw)
  if (!result.success) throw new ContractError('/api/managed', issues(result.error))
  return result.data.session
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

const dayTokenUsageSchema = z.looseObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheCreation: z.number() })
export type DayTokenUsage = z.infer<typeof dayTokenUsageSchema>

/** What the Today feature reads from a Day's (or an item thread's) managed detail. */
const dayDetailSchema = z.looseObject({
  dayBoard: dayBoardSchema.nullable().optional(),
  dayChecks: dayChecksSchema.nullable().optional(),
  subagents: z.array(daySubagentSchema).optional(),
  tokenUsage: dayTokenUsageSchema.nullable().optional(),
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

