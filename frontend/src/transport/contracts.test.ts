import { describe, expect, it } from 'vitest'
import controlFixture from '../test/fixtures/control.json'
import sessionsFixture from '../test/fixtures/sessions.json'
import { parseControl, parseSessionSnapshot } from './contracts'
import { ContractError } from './errors'

const clone = <T>(value: T): T => structuredClone(value)

describe('boundary validation', () => {
  it('accepts the control fixture and keeps fields it does not know yet', () => {
    const control = parseControl({ ...clone(controlFixture), futureFlag: true })
    expect(control.token).toBe(controlFixture.token)
    expect(control.futureFlag).toBe(true)
  })

  it('rejects a control answer without a token or with a wrong type', () => {
    const { token: _token, ...noToken } = clone(controlFixture)
    expect(() => parseControl(noToken)).toThrow(ContractError)
    expect(() => parseControl({ ...clone(controlFixture), defaultApprovalMode: 'sometimes' })).toThrow(ContractError)
    expect(() => parseControl(null)).toThrow(ContractError)
  })

  it('returns the very row objects it was given', () => {
    const raw = clone(sessionsFixture)
    const snapshot = parseSessionSnapshot(raw)
    expect(snapshot.sessions).toHaveLength(raw.sessions.length)
    snapshot.sessions.forEach((row, i) => expect(row).toBe(raw.sessions[i]))
  })

  it('names the row that broke the contract', () => {
    const raw = clone(sessionsFixture)
    const broken = { ...raw, sessions: [...raw.sessions, { title: 'no identity', state: 'idle' }] }
    expect(() => parseSessionSnapshot(broken)).toThrow(/sessions\[5\]/)
    const badState = { ...raw, sessions: [{ ...raw.sessions[0], state: 'sleeping' }] }
    expect(() => parseSessionSnapshot(badState)).toThrow(ContractError)
  })

  it('rejects a snapshot without counts', () => {
    const { counts: _counts, ...rest } = clone(sessionsFixture)
    expect(() => parseSessionSnapshot(rest)).toThrow(ContractError)
  })
})
