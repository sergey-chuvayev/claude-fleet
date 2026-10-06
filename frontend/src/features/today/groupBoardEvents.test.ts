// Port of day-ui.test.js: tools named as a person would say them, and the Day console
// folding back-to-back board calls into one readable block.
import { describe, expect, it } from 'vitest'
import type { Message } from '../../transport/contracts'
import { toolLabel } from '../conversation'
import { groupBoardEvents } from './groupBoardEvents'

describe('toolLabel', () => {
  it('names tools the way a person would say them', () => {
    expect(toolLabel('mcp__fleet__day')).toBe('Board')
    expect(toolLabel('mcp__claude_ai_Slack__slack_search_public_and_private')).toBe('Slack · search public and private')
    expect(toolLabel('mcp__linear-server__get_issue')).toBe('Linear · get issue')
    expect(toolLabel('mcp__granola__list_meetings')).toBe('Granola · list meetings')
    expect(toolLabel('Bash')).toBe('Bash')
    expect(toolLabel('ToolSearch')).toBe('Loading tools')
  })
})

describe('groupBoardEvents', () => {
  const tool = (id: string, input: Record<string, unknown>, status = 'done', ms: number | null = 100): Message => ({
    id,
    role: 'tool',
    tool: 'mcp__fleet__day',
    input,
    status,
    ms,
    at: 1,
  })
  const list: Message[] = [
    { id: 'u1', role: 'user', text: 'Sweep', runPrompt: 'Scheduled sweep…', background: true, at: 1 },
    tool('t1', { action: 'list' }),
    tool('t2', { action: 'add', title: 'Reply to Marc' }),
    tool('t3', { action: 'add', title: 'Review #2224' }),
    { ...tool('t4', { action: 'ask', question: 'Send this?' }, 'error'), result: 'Too many questions' },
    { id: 'a1', role: 'assistant', text: 'Two new items.', at: 2 },
    tool('t5', { action: 'update', note: 'Logged context' }, 'running', null),
    { id: 'u2', role: 'user', text: 'What is left?', at: 3 },
  ]

  it('marks automatic runs and folds back-to-back board calls into one block', () => {
    const out = groupBoardEvents(list)
    expect(out.map(m => m.role)).toEqual(['event', 'tool', 'assistant', 'tool', 'user'])
    expect(out[0]?.text).toBe('Auto check')
    const board = out[1]
    expect(board?.label).toBe('Board')
    expect(board?.target).toBe('read the board · added 2 · asked 1')
    expect(board?.status).toBe('error')
    expect(board?.ms).toBe(400)
    expect(board?.lines?.map(l => l.text.split(':')[0])).toEqual(['read the board', 'added', 'added', 'asked'])
    expect(board?.lines?.[3]?.error).toBe(true)
    expect(board?.lines?.[3]?.text).toBe('asked: Send this? (failed: Too many questions)')
    expect(out[3]?.status).toBe('running')
    expect(out[3]?.ms).toBeNull()
    expect(out[4]?.text).toBe('What is left?')
  })

  it('keeps a group id stable as the group grows', () => {
    expect(groupBoardEvents(list)[1]?.id).toBe('t1~board')
    expect(groupBoardEvents(list)[3]?.id).toBe('t5~board')
    expect(groupBoardEvents(list.slice(0, 3))[1]?.id).toBe('t1~board')
  })

  it('names known automatic runs, and leaves an operator message with a run prompt alone unless it is background', () => {
    const out = groupBoardEvents([
      { id: 'm', role: 'user', text: 'Start my day', runPrompt: 'intake', at: 1 },
      { id: 'p', role: 'user', text: 'Pick up answers', runPrompt: 'answers', at: 2 },
      { id: 'x', role: 'user', text: 'Plain question', at: 3 },
    ])
    expect(out.map(m => [m.role, m.text])).toEqual([
      ['event', 'Morning intake'],
      ['event', 'Picked up your answers'],
      ['user', 'Plain question'],
    ])
  })
})
