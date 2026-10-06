// What the console says about a session: titles, the state line, the now-line.
import { describe, expect, it } from 'vitest'
import type { Message } from '../../transport/contracts'
import { contextShare, heldText, managedNow, shortElapsed, stateText, titleOf } from './status'

describe('titleOf', () => {
  it('a chosen name outranks Claude’s title; Day, thread and project manager have their own', () => {
    expect(titleOf({ name: 'Fix it', aiTitle: 'Claude title' })).toBe('Claude title')
    expect(titleOf({ name: 'Fix it', aiTitle: 'Claude title', renamed: true })).toBe('Fix it')
    expect(titleOf({ kind: 'day', name: 'x' })).toBe('Day agent')
    expect(titleOf({ kind: 'thread', name: 'Ship it' })).toBe('About: Ship it')
    expect(titleOf({ kind: 'project', name: 'Checkout' })).toBe('Project manager · Checkout')
  })
})

describe('stateText', () => {
  it('names the tool in use, the queue, and a holder', () => {
    expect(stateText({ status: 'running', currentTool: 'Bash', queueLength: 0, holder: null })).toBe('Using Bash')
    expect(stateText({ status: 'running', kind: 'day', currentTool: 'mcp__fleet__day', queueLength: 0, holder: null })).toBe('Updating the board…')
    expect(stateText({ status: 'idle', queueLength: 2, holder: null })).toBe('Ready for your next message · 2 queued')
    expect(stateText({ status: 'idle', queueLength: 1, holder: { state: 'busy' } })).toBe('Working in a terminal')
  })
})

describe('heldText', () => {
  it('says where the session is open and that messages wait', () => {
    expect(heldText({ entrypoint: 'cli', name: 'held' })).toBe('Open in a terminal · held. Messages wait here and send once it is closed there.')
    expect(heldText({ entrypoint: 'sdk-ts' })).toBe('Open in another program. Messages wait here and send once it is closed there.')
    expect(heldText(null)).toBe('')
  })
})

describe('contextShare', () => {
  it('is unknown without a count and capped at 100', () => {
    expect(contextShare(null, 200000)).toBeNull()
    expect(contextShare(168000, 200000)).toBe(84)
    expect(contextShare(500000, null)).toBe(100)
  })
})

describe('managedNow', () => {
  const msg = (m: Partial<Message>): Message => ({ id: 'x', role: 'assistant', ...m }) as Message
  it('follows the lifecycle, then the running tool, then the reply', () => {
    expect(managedNow('idle', [], false)).toBeNull()
    expect(managedNow('running', [], true)).toBeNull()
    expect(managedNow('approval', [], false)).toEqual({ text: 'Waiting for your approval', since: null, tone: 'needs' })
    expect(managedNow('running', [msg({ role: 'tool', tool: 'Bash', status: 'running', target: 'npm test', at: 5 })], false)).toEqual({
      text: 'Running Bash · npm test',
      since: 5,
      tone: '',
    })
    expect(managedNow('running', [msg({ role: 'tool', tool: 'Task', status: 'running', input: { subagent_type: 'qa' }, at: 6 })], false)?.text).toBe('Delegating to qa')
    expect(managedNow('running', [msg({ at: 7 })], false)).toEqual({ text: 'Writing a reply', since: 7, tone: '' })
    expect(managedNow('running', [msg({ role: 'user', at: 8 })], false)).toEqual({ text: 'Thinking', since: 8, tone: '' })
  })
})

describe('shortElapsed', () => {
  it('pads minutes and seconds the way the now-line always has', () => {
    expect(shortElapsed(0)).toBe('0s')
    expect(shortElapsed(243_000)).toBe('4m 03s')
    expect(shortElapsed(4_020_000)).toBe('1h 07m')
  })
})
