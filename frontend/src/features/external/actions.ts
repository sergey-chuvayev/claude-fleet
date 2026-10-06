// What Fleet can do with a conversation that was started outside it (F08), by engine
// and by whether its program is still running. Pure, from public/control.js.
//
//   offline Claude   continue here: Fleet takes the transcript over (resume)
//   live Claude      continue a copy here: a fork, the terminal keeps the original
//   offline Codex    continue here: Fleet takes the Codex thread over (resume)
//   live Codex       refused: Codex has no copy to continue, only the idle thread
import type { Engine } from '../../transport/contracts'

export interface ExternalRow {
  readonly engine: Engine
  readonly transcriptId: string | null
  readonly cwd: string | null
  readonly alive: boolean
  readonly busy: boolean
  readonly title: string
}

export type ContinueMode = 'resume' | 'fork' | 'refused' | 'unavailable'

export function continueMode(row: ExternalRow): ContinueMode {
  if (!row.transcriptId || !row.cwd) return 'unavailable'
  if (row.engine === 'codex') return row.alive ? 'refused' : 'resume'
  return row.alive ? 'fork' : 'resume'
}

/** The launch body that continues this conversation in Fleet. */
export function continueBody(row: ExternalRow, prompt: string, requestId: string): Record<string, unknown> {
  return {
    cwd: row.cwd,
    name: row.title,
    prompt,
    requestId,
    resumeSessionId: row.transcriptId,
    ...(row.engine === 'codex' ? { engine: 'codex' } : continueMode(row) === 'fork' ? { fork: true } : {}),
  }
}

export function stateText(row: ExternalRow): string {
  if (row.engine === 'codex') return row.busy ? 'Codex is working on it' : 'From Codex · stopped'
  if (row.alive) return row.busy ? 'Working in a terminal' : 'Open in a terminal'
  return 'From a terminal · stopped'
}

export function hintText(row: ExternalRow): string {
  switch (continueMode(row)) {
    case 'unavailable':
      return 'This session has no saved conversation to continue.'
    case 'refused':
      return 'Codex is still working on this in its own window. Continue it here once it finishes.'
    case 'fork':
      return 'Sends to a copy in Fleet. The terminal keeps the original.'
    case 'resume':
      return row.engine === 'codex' ? 'Your message continues this Codex conversation in Fleet.' : 'Your message continues this conversation in Fleet.'
  }
}

export const buttonText = (row: ExternalRow): string => (continueMode(row) === 'fork' ? 'Continue a copy here' : 'Continue here')
export const placeholderText = (row: ExternalRow): string => (row.alive ? 'Continue a copy of this conversation…' : 'Continue this conversation…')
export const successText = (row: ExternalRow): string =>
  continueMode(row) === 'fork' ? 'Continuing a copy in Fleet. The terminal keeps the original.' : 'Continuing in Fleet'
