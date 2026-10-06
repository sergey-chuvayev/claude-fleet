// Boundary validation for conversation routes (appended to transport/contracts.ts).
import { describe, expect, it } from 'vitest'
import heavyFile from '../../test/fixtures/conversation-heavy/managed/c-heavy.json'
import historyFile from '../../test/fixtures/conversation-heavy/history/undefined-000000c1-0000-4000-8000-000000000001.json'
import teamFile from '../../test/fixtures/teams-heavy/managed/t-team.json'
import { parseHistory, parseManagedDetail } from '../../transport/contracts'
import { ContractError } from '../../transport/errors'

const clone = <T>(value: T): T => structuredClone(value)

describe('parseManagedDetail', () => {
  it('accepts the heavy and team fixtures and keeps fields it does not read', () => {
    const detail = parseManagedDetail(clone(heavyFile.response.body))
    expect(detail.session.messages).toHaveLength(164)
    expect(detail.session.approvals).toHaveLength(2)
    expect((detail.session as Record<string, unknown>).queue).toBeTruthy()
    expect(parseManagedDetail(clone(teamFile.response.body)).session.kind).toBe('initiative')
  })

  it('returns the very message objects it was given', () => {
    const raw = clone(heavyFile.response.body)
    const detail = parseManagedDetail(raw)
    detail.session.messages.forEach((message, i) => expect(message).toBe(raw.session.messages[i]))
    // A second parse of the same rows skips them and still hands them back.
    const again = parseManagedDetail({ ...raw, session: { ...raw.session } })
    expect(again.session.messages[0]).toBe(raw.session.messages[0])
  })

  it('keeps a record kind it does not know', () => {
    const raw = clone(heavyFile.response.body)
    raw.session.messages.push({ id: 'sys', role: 'system', text: 'hello', at: 1 } as never)
    expect(parseManagedDetail(raw).session.messages.at(-1)?.role).toBe('system')
  })

  it('names the message that broke the contract', () => {
    const raw = clone(heavyFile.response.body)
    raw.session.messages.splice(3, 0, { role: 'user', text: 'no id' } as never)
    expect(() => parseManagedDetail(raw)).toThrow(/session\.messages\[3\]/)
    expect(() => parseManagedDetail({ session: { id: 'x', messages: [] } })).toThrow(ContractError)
    expect(() => parseManagedDetail(null)).toThrow(ContractError)
  })
})

describe('parseHistory', () => {
  it('accepts an external transcript and returns its rows by reference', () => {
    const raw = clone(historyFile.response.body)
    const history = parseHistory(raw)
    expect(history.alive).toBe(true)
    expect(history.truncated).toBe(false)
    history.messages.forEach((message, i) => expect(message).toBe(raw.messages[i]))
  })

  it('rejects a transcript without messages', () => {
    expect(() => parseHistory({ truncated: false })).toThrow(ContractError)
  })
})
