// The launch draft reducer: seeding never overwrites, request ids follow the draft,
// and the store outlives any component.
import { describe, expect, it } from 'vitest'
import { LaunchStore, initialLaunchState, launchReducer } from './launchState'

describe('launch draft', () => {
  it('seeds only the fields that have no value yet', () => {
    let state = launchReducer(initialLaunchState(), { type: 'seed', cwd: '/repo', approvalMode: 'ask' })
    expect(state.fields).toMatchObject({ cwd: '/repo', approvalMode: 'ask' })
    state = launchReducer(state, { type: 'seed', cwd: '/elsewhere', approvalMode: 'all' })
    expect(state.fields).toMatchObject({ cwd: '/repo', approvalMode: 'ask' })
    // An emptied directory is the operator's choice, not a gap to fill.
    state = launchReducer(state, { type: 'edit', field: 'cwd', value: '' })
    expect(launchReducer(state, { type: 'seed', cwd: '/repo' }).fields.cwd).toBe('')
  })

  it('keeps the request id through a failure and drops it on any edit', () => {
    let state = launchReducer(initialLaunchState(), { type: 'edit', field: 'prompt', value: 'Task' })
    state = launchReducer(state, { type: 'submit', requestId: 'r1' })
    expect(launchReducer(state, { type: 'edit', field: 'prompt', value: 'Changed' })).toBe(state)
    state = launchReducer(state, { type: 'failed', error: { message: 'Busy', code: 'CAPACITY' } })
    expect(state).toMatchObject({ requestId: 'r1', submitting: false, error: { code: 'CAPACITY' } })
    expect(launchReducer(state, { type: 'edit', field: 'model', value: 'opus' }).requestId).toBeNull()
    expect(launchReducer(state, { type: 'edit', field: 'prompt', value: 'Task' })).toBe(state)
  })

  it('refuses values outside the choices', () => {
    const state = initialLaunchState()
    expect(launchReducer(state, { type: 'edit', field: 'engine', value: 'gemini' })).toBe(state)
    expect(launchReducer(state, { type: 'edit', field: 'approvalMode', value: 'sometimes' })).toBe(state)
  })

  it('starts over after a launch or a discard, and ignores a stale team-editor answer', () => {
    const store = new LaunchStore()
    store.dispatch({ type: 'edit', field: 'prompt', value: 'Task' })
    const token = store.nextToken()
    store.dispatch({ type: 'editor-loading', token })
    store.dispatch({ type: 'discard' })
    expect(store.getState()).toEqual(initialLaunchState())
    store.dispatch({ type: 'editor-failed', token })
    expect(store.getState().editor).toEqual({ status: 'closed' })
  })
})
