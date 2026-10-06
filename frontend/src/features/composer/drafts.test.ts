// The draft store's rules (A07): edits bump the revision and the request id, a send
// snapshots both, and only an accepted answer for that revision clears the draft.
import { describe, expect, it } from 'vitest'
import { DraftStore } from './drafts'

const store = () => {
  let n = 0
  return new DraftStore(() => `req-${++n}`)
}

describe('DraftStore', () => {
  it('starts empty, and each edit is a new revision with a new request id', () => {
    const drafts = store()
    expect(drafts.get('managed:a').text).toBe('')
    const one = drafts.edit('managed:a', { text: 'h' })
    const two = drafts.edit('managed:a', { text: 'hi' })
    expect([one.revision, one.requestId]).toEqual([1, 'req-1'])
    expect([two.revision, two.requestId]).toEqual([2, 'req-2'])
    expect(drafts.get('managed:b').text).toBe('')
  })

  it('an accepted send clears the draft it sent', () => {
    const drafts = store()
    drafts.edit('managed:a', { text: 'go', references: [{ id: 'x', title: 'X', state: '' }] })
    const snap = drafts.begin('managed:a')!
    expect(drafts.begin('managed:a')).toBeNull()
    drafts.accepted('managed:a', snap)
    expect(drafts.get('managed:a')).toMatchObject({ text: '', references: [], images: [], sending: null, error: null })
  })

  it('an edit while the send is out survives the answer', () => {
    const drafts = store()
    drafts.edit('managed:a', { text: 'go' })
    const snap = drafts.begin('managed:a')!
    drafts.edit('managed:a', { text: 'go on' })
    drafts.accepted('managed:a', snap)
    expect(drafts.get('managed:a')).toMatchObject({ text: 'go on', sending: null })
  })

  it('a failure keeps the draft and the request id for a deliberate retry', () => {
    const drafts = store()
    drafts.edit('managed:a', { text: 'go' })
    const snap = drafts.begin('managed:a')!
    drafts.failed('managed:a', snap, 'All agents are busy.')
    expect(drafts.get('managed:a')).toMatchObject({ text: 'go', error: 'All agents are busy.', sending: null })
    const retry = drafts.begin('managed:a')!
    expect(retry.requestId).toBe(snap.requestId)
    expect(drafts.get('managed:a').error).toBeNull()
  })

  it('an answer for another send (or another key) changes nothing', () => {
    const drafts = store()
    drafts.edit('managed:a', { text: 'a' })
    drafts.edit('managed:b', { text: 'b' })
    const a = drafts.begin('managed:a')!
    drafts.accepted('managed:b', a)
    expect(drafts.get('managed:b').text).toBe('b')
    drafts.failed('managed:a', { ...a, requestId: 'other' }, 'nope')
    expect(drafts.get('managed:a').sending).toBe(a)
  })

  it('an image-only draft that was never edited still gets a request id', () => {
    const drafts = store()
    expect(drafts.begin('managed:a')?.requestId).toBe('req-1')
  })

  it('notifies only the listeners of the key that changed', () => {
    const drafts = store()
    const seen: string[] = []
    drafts.subscribe('managed:a', () => seen.push('a'))
    drafts.subscribe('managed:b', () => seen.push('b'))
    drafts.edit('managed:a', { text: 'x' })
    expect(seen).toEqual(['a'])
  })
})
