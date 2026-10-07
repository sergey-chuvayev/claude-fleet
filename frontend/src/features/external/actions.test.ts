// What continuing an outside conversation means, per engine and liveness (A05).
import { describe, expect, it } from 'vitest'
import { type ExternalRow, continueBody, continueMode } from './actions'

const row = (patch: Partial<ExternalRow>): ExternalRow => ({
  engine: 'claude',
  transcriptId: 't-1',
  cwd: '/repo',
  alive: false,
  busy: false,
  title: 'From the terminal',
  ...patch,
})

describe('continueMode', () => {
  it('forks live Claude, resumes offline Claude and Codex, refuses live Codex', () => {
    expect(continueMode(row({ alive: true }))).toBe('fork')
    expect(continueMode(row({}))).toBe('resume')
    expect(continueMode(row({ engine: 'codex' }))).toBe('resume')
    expect(continueMode(row({ engine: 'codex', alive: true }))).toBe('refused')
    expect(continueMode(row({ transcriptId: null }))).toBe('unavailable')
    expect(continueMode(row({ cwd: null }))).toBe('unavailable')
  })
})

describe('continueBody', () => {
  it('names the transcript to resume and the engine; a live Claude copy forks', () => {
    expect(continueBody(row({ alive: true }), 'go', 'r1')).toEqual({ cwd: '/repo', name: 'From the terminal', prompt: 'go', requestId: 'r1', resumeSessionId: 't-1', fork: true })
    expect(continueBody(row({}), 'go', 'r1')).toEqual({ cwd: '/repo', name: 'From the terminal', prompt: 'go', requestId: 'r1', resumeSessionId: 't-1' })
    expect(continueBody(row({ engine: 'codex' }), 'go', 'r1')).toMatchObject({ engine: 'codex', resumeSessionId: 't-1' })
    expect(continueBody(row({ engine: 'codex' }), 'go', 'r1')).not.toHaveProperty('fork')
  })
})
