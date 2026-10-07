// What the caret is in: a `/command` at the start of a line, or an `@` session
// reference after a space. Pure, ported from public/control.js; the picker only ever
// inserts text or a reference chip, it never sends or runs anything.
import type { Command, SessionSummary } from '../../transport/contracts'

export interface Caret {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

/** The command being typed, or null when the caret is not in a slash word. */
export function slashQuery(input: Caret): string | null {
  if (input.selectionStart !== input.selectionEnd) return null
  const before = input.value.slice(0, input.selectionStart)
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const match = /^\/([\w:-]*)$/.exec(line)
  return match ? (match[1] ?? '') : null
}

/** The reference being typed after `@`, or null. */
export function mentionQuery(input: Caret): string | null {
  if (input.selectionStart !== input.selectionEnd) return null
  const match = /(?:^|\s)@([^@\n]*)$/.exec(input.value.slice(0, input.selectionStart))
  return match ? (match[1] ?? '') : null
}

/** Commands containing the query, prefix matches first, at most 40. */
export function matchCommands(catalog: readonly Command[], query: string): Command[] {
  const needle = query.toLowerCase()
  return catalog
    .filter(entry => entry.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)))
    .slice(0, 40)
}

/** Replace the slash word on the caret's line with `/name `; returns the new value and caret. */
export function insertCommand(input: Caret, name: string): { value: string; caret: number } {
  const before = input.value.slice(0, input.selectionStart)
  const start = before.lastIndexOf('\n') + 1
  const insertion = `/${name} `
  return { value: input.value.slice(0, start) + insertion + input.value.slice(input.selectionStart), caret: start + insertion.length }
}

/** Remove the `@query` being typed (it becomes a chip, not text). */
export function removeMention(input: Caret): { value: string; caret: number } {
  const start = input.value.slice(0, input.selectionStart).lastIndexOf('@')
  if (start < 0) return { value: input.value, caret: input.selectionStart }
  return { value: input.value.slice(0, start) + input.value.slice(input.selectionStart), caret: start }
}

// ── References ──────────────────────────────────────────────────────────────

/** Up to four sessions per message, as the server allows. */
export const MAX_REFERENCES = 4

const STATE_LABELS: Readonly<Record<string, string>> = { busy: 'Working', idle: 'Waiting', stale: 'Stale', dead: 'Offline' }

type Row = SessionSummary & { readonly lastPrompt?: unknown; readonly background?: unknown }

/** The id a reference names: the managed id, else the transcript id. */
export const referenceIdOf = (row: Pick<SessionSummary, 'managedId' | 'sessionId'>): string | null =>
  row.managedId || row.sessionId || null

export const referenceTitle = (row: Row): string =>
  row.title || row.name || (typeof row.lastPrompt === 'string' && row.lastPrompt) || row.shortId || 'Untitled session'

export const referenceState = (row: Row): string => row.managedStatus || STATE_LABELS[row.state] || ''

/**
 * Sessions this conversation may reference: not itself (by managed id or by its own
 * transcript), not background observers, and only rows with an id the server resolves.
 */
export function referenceCandidates(
  rows: readonly SessionSummary[],
  self: { readonly managedId: string; readonly transcriptId: string | null },
): Row[] {
  return (rows as readonly Row[]).filter(
    row =>
      !!referenceIdOf(row) &&
      row.managedId !== self.managedId &&
      !(self.transcriptId && row.sessionId === self.transcriptId) &&
      !row.background,
  )
}

/** Candidates matching the query by title, directory or last prompt, at most 30. */
export function matchReferences(candidates: readonly Row[], attached: ReadonlySet<string>, query: string): Row[] {
  const needle = query.toLowerCase()
  return candidates
    .filter(row => {
      const id = referenceIdOf(row)
      if (!id || attached.has(id)) return false
      const prompt = typeof row.lastPrompt === 'string' ? row.lastPrompt : ''
      return `${referenceTitle(row)} ${row.cwd ?? ''} ${prompt}`.toLowerCase().includes(needle)
    })
    .slice(0, 30)
}
