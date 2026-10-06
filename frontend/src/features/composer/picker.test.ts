// The caret rules behind the `/` and `@` pickers, and reference candidates.
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../transport/contracts'
import { insertCommand, matchCommands, matchReferences, mentionQuery, referenceCandidates, removeMention, slashQuery } from './picker'

const at = (value: string, caret = value.length) => ({ value, selectionStart: caret, selectionEnd: caret })

describe('slashQuery', () => {
  it('finds a slash word at the start of the caret’s line only', () => {
    expect(slashQuery(at('/rev'))).toBe('rev')
    expect(slashQuery(at('first line\n/de'))).toBe('de')
    expect(slashQuery(at('/'))).toBe('')
    expect(slashQuery(at('a /rev'))).toBeNull()
    expect(slashQuery(at('/rev now'))).toBeNull()
    expect(slashQuery({ value: '/rev', selectionStart: 0, selectionEnd: 4 })).toBeNull()
  })
})

describe('mentionQuery', () => {
  it('finds `@` at the start or after a space', () => {
    expect(mentionQuery(at('@chk'))).toBe('chk')
    expect(mentionQuery(at('see @fix flaky'))).toBe('fix flaky')
    expect(mentionQuery(at('mail@example'))).toBeNull()
    expect(mentionQuery(at('one\n@'))).toBe('')
  })
})

describe('insertion', () => {
  it('replaces the slash word with the command and a space', () => {
    expect(insertCommand(at('intro\n/re tail', 9), 'review')).toEqual({ value: 'intro\n/review  tail', caret: 14 })
  })
  it('removes the `@query` that became a chip', () => {
    expect(removeMention(at('compare @check'))).toEqual({ value: 'compare ', caret: 8 })
  })
})

describe('matchCommands', () => {
  it('prefers a prefix match and keeps catalog order otherwise', () => {
    const catalog = [{ name: 'code-review' }, { name: 'review' }, { name: 'reviewer' }]
    expect(matchCommands(catalog, 'rev').map(c => c.name)).toEqual(['review', 'reviewer', 'code-review'])
  })
})

describe('referenceCandidates', () => {
  const rows = [
    { managedId: 'self', sessionId: 't-self', state: 'idle' },
    { sessionId: 't-self', state: 'idle', name: 'its own transcript' },
    { managedId: 'other', sessionId: 't-other', state: 'busy', title: 'Other' },
    { sessionId: 't-bg', state: 'idle', background: true },
    { pid: 4, state: 'busy' },
    { sessionId: 't-ext', state: 'dead', name: 'terminal', cwd: '/repo/web' },
  ] as unknown as SessionSummary[]

  it('excludes itself by managed id and by transcript, background rows and rows without an id', () => {
    const list = referenceCandidates(rows, { managedId: 'self', transcriptId: 't-self' })
    expect(list.map(r => r.managedId || r.sessionId)).toEqual(['other', 't-ext'])
  })

  it('matches title, directory and prompt, without what is already attached', () => {
    const list = referenceCandidates(rows, { managedId: 'self', transcriptId: 't-self' })
    expect(matchReferences(list, new Set(), 'web').map(r => r.sessionId)).toEqual(['t-ext'])
    expect(matchReferences(list, new Set(['other']), '').map(r => r.sessionId)).toEqual(['t-ext'])
  })
})
