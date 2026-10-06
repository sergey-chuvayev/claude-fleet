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
  // Planned by work package 2 (section 7); optional until the server sends them.
  apiVersion: z.number().optional(),
  instanceId: z.string().optional(),
  buildId: z.string().optional(),
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
