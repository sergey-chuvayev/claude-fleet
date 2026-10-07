// Each block type against the conversation-heavy and teams-heavy fixtures.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import heavyFile from '../../test/fixtures/conversation-heavy/managed/c-heavy.json'
import afterImageFile from '../../test/fixtures/conversation-heavy/managed-c-error-after-image.json'
import teamFile from '../../test/fixtures/teams-heavy/managed/t-team.json'
import ownerFile from '../../test/fixtures/teams-heavy/managed/t-owner.json'
import type { Message } from '../../transport/contracts'
import { MessageBlock } from './MessageBlock'
import { MessageList } from './MessageList'
import { type DetailBody, bodyOf } from './testing'

const heavy = bodyOf<DetailBody>(heavyFile).session.messages
const byId = (messages: readonly Message[], id: string): Message => {
  const found = messages.find(m => m.id === id)
  if (!found) throw new Error(`fixture has no message ${id}`)
  return found
}
const show = (message: Message, { streaming = false, agent = 'CLAUDE' } = {}) =>
  render(<MessageBlock message={message} streaming={streaming} agent={agent} />).container.querySelector('article') as HTMLElement
const expand = (article: HTMLElement) => fireEvent.click(article.querySelector('[data-collapse]') as HTMLElement)

describe('user and assistant blocks', () => {
  it('shows the operator as YOU with time, attachments through the private route and reference chips', () => {
    const article = show(byId(heavy, 'h-u-last'))
    expect(article.dataset.role).toBe('user')
    expect(article.querySelector('.block-tool')?.textContent).toBe('YOU')
    expect(article.querySelector('.block-meta')?.textContent).toMatch(/\d{2}.\d{2}.\d{2}/)
    const link = article.querySelector('.block-attachments a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/api/attachments/00000a77-0000-4000-8000-000000000001.png')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')
    expect(link.querySelector('img')?.getAttribute('alt')).toBe('Attached image')
    expect(link.title).toBe('image/png · 0 KB')
    const reference = article.querySelector('details.block-reference') as HTMLDetailsElement
    expect(reference.querySelector('summary')?.textContent).toBe('✳ checkout-refactor · session snapshot')
    expect(reference.open).toBe(false)
  })

  it('refuses an attachment id the server would not have generated', () => {
    const article = show({ id: 'u', role: 'user', text: 'x', attachments: [{ id: '../../etc/passwd', mediaType: 'image/png', bytes: 1 }] })
    expect(article.querySelector('img')).toBeNull()
    expect(article.textContent).toContain('Attachment unavailable')
  })

  it('renders an assistant reply as Markdown under the engine label', () => {
    const article = show(byId(heavy, 'h-a-0'), { agent: 'CODEX' })
    expect(article.querySelector('.block-tool')?.textContent).toBe('CODEX')
    expect(article.querySelector('.block-prose ol li')?.textContent).toBe('Read the failing test')
    expect(article.querySelector('.block-prose blockquote')?.textContent).toContain('the timer is the suspect')
    expect(article.classList.contains('collapsed')).toBe(false)
  })

  it('highlights fenced code in a final reply, and leaves it plain while streaming', () => {
    const reply: Message = { id: 'a', role: 'assistant', text: 'Fix:\n\n```ts\nconst wait = (): Promise<void> => once("settled")\n```' }
    const final = show(reply)
    expect(final.querySelector('pre.block-code code.hljs .hljs-keyword')).toBeTruthy()
    const live = show({ ...reply, id: 'b' }, { streaming: true })
    expect(live.querySelector('.hljs-keyword')).toBeNull()
    expect(live.querySelector('pre code')?.textContent).toContain('const wait')
    expect(live.querySelector('.block-state.is-running')?.textContent).toBe('writing')
    expect(live.querySelector('.pixel-run')?.getAttribute('aria-label')).toBe('Writing now')
  })

  it('shows an unknown record kind as escaped plain text', () => {
    const article = show({ id: 's', role: 'system', text: '<b>Compacted</b>' })
    expect(article.querySelector('.block-tool')?.textContent).toBe('SYSTEM')
    expect(article.querySelector('pre.block-plain')?.textContent).toBe('<b>Compacted</b>')
    expect(article.querySelector('b')).toBeNull()
  })

  it('marks a run that started on its own as an event in the timeline', () => {
    const article = show(byId(heavy, 'h-e-1'))
    expect(article.dataset.role).toBe('event')
    expect(article.querySelector('.block-event span')?.textContent).toBe('Context was compacted to keep the conversation going.')
    expect(article.querySelector('button')).toBeNull()
  })

  it('renders the image and reference follow-ups recorded after an error', () => {
    const messages = bodyOf<DetailBody>(afterImageFile).session.messages
    const { container } = render(<MessageList messages={messages} streamingId={null} agent="CLAUDE" />)
    const blocks = container.querySelectorAll('article')
    expect(blocks).toHaveLength(messages.length)
    expect(container.querySelector('[data-block="e-t"]')?.classList.contains('collapsed')).toBe(false)
    expect(container.querySelectorAll('.block-attachments img')).toHaveLength(1)
    expect(container.querySelectorAll('details.block-reference')).toHaveLength(1)
  })
})

describe('tool blocks', () => {
  it('starts a finished Bash call collapsed and shows command and output when expanded', () => {
    const article = show(byId(heavy, 'h-t-0-b'))
    expect(article.classList.contains('collapsed')).toBe(true)
    expect(article.querySelector('.block-body')).toBeNull()
    expect(article.querySelector('.block-tool')?.textContent).toBe('Bash')
    expect(article.querySelector('.block-target')?.textContent).toBe('npm test -- checkout')
    // The operator approved this one; only automatic approvals carry the chip.
    expect(article.querySelector('.block-auto')).toBeNull()
    expect(article.querySelector('[data-collapse]')?.getAttribute('aria-expanded')).toBe('false')
    expect(article.querySelector('.block-meta')?.textContent).toMatch(/^8\.2s · /)
    expand(article)
    expect(article.querySelector('[data-collapse]')?.getAttribute('aria-expanded')).toBe('true')
    expect(article.querySelector('pre.block-code.is-command')?.textContent).toBe('npm test -- checkout')
    expect(article.querySelector('.block-result pre')?.textContent).toContain('line 1: ')
  })

  it('shows a Read result highlighted for its file type', () => {
    const article = show(byId(heavy, 'h-t-0-a'))
    expand(article)
    expect(article.querySelector('.block-tool')?.textContent).toBe('Read')
    expect(article.querySelector('.block-auto')?.textContent).toBe('auto')
    expect(article.querySelector('.block-result .hljs-keyword')).toBeTruthy()
    // file_path is the header's target, so there is no input panel.
    expect(article.querySelectorAll('pre')).toHaveLength(1)
  })

  it('shows an Edit as a diff', () => {
    const article = show(byId(heavy, 'h-t-1-b'))
    expand(article)
    const diff = article.querySelector('pre.block-code') as HTMLElement
    expect(diff.querySelector('.hljs-deletion')?.textContent).toBe('- const wait = () => sleep(500)')
    expect(diff.querySelector('.hljs-addition')?.textContent).toBe('+ const wait = () => events.once("settled")')
  })

  it('shows a TodoWrite as a checklist', () => {
    const article = show(byId(heavy, 'h-t-2-b'))
    expand(article)
    const items = [...article.querySelectorAll('.block-todos li')]
    expect(items.map(li => li.className)).toEqual(['todo-completed', 'todo-in_progress', 'todo-pending'])
    expect(items.map(li => li.textContent)).toEqual(['☑Reproduce the flake', '▸Fix the wait', '☐Add a regression test'])
  })

  it('keeps a failed call open and says it failed', () => {
    const failed = heavy.find(m => m.status === 'error') as Message
    const article = show(failed)
    expect(article.classList.contains('collapsed')).toBe(false)
    expect(article.dataset.status).toBe('error')
    expect(article.querySelector('.block-state')?.textContent).toBe('failed')
    expect(article.querySelector('.block-result.is-error')).toBeTruthy()
  })

  it('wears the pixel mark while running and says Fleet truncated the output', () => {
    const article = show({ id: 't', role: 'tool', tool: 'Grep', status: 'running', input: { pattern: 'retry', path: 'src' }, target: 'retry', result: 'a\nb', truncated: true, ms: null })
    expect(article.querySelector('.block-icon.is-live .pixel-run')?.getAttribute('aria-label')).toBe('Running now')
    expect(article.querySelector('.block-state')?.textContent).toBe('running')
    expect(article.textContent).toContain('Output truncated by Fleet.')
    // pattern and path are already in the header: no JSON panel.
    expect(article.querySelectorAll('pre')).toHaveLength(1)
  })

  it('names MCP tools the way a person would and shows their other arguments as JSON', () => {
    const article = show({ id: 't', role: 'tool', tool: 'mcp__claude_ai_Slack__slack_search_public', status: 'running', input: { query: 'release', limit: 5 } })
    expect(article.querySelector('.block-tool')?.textContent).toBe('Slack · search public')
    expect(JSON.parse(article.querySelector('pre')?.textContent ?? '{}')).toEqual({ query: 'release', limit: 5 })
  })

  it('renders grouped board lines from a derived view model', () => {
    const article = show({ id: 'g', role: 'tool', tool: 'mcp__fleet__day', label: 'Board', status: 'running', lines: [{ text: 'Added "Ship it"' }, { text: 'Could not move', error: true }] })
    expect([...article.querySelectorAll('.block-lines li')].map(li => [li.textContent, li.className])).toEqual([
      ['Added "Ship it"', ''],
      ['Could not move', 'is-error'],
    ])
  })
})

// The teams-heavy pack: delegation runs as the conversation shows them, built from the
// pack's own 25 delegations (completed, failed, interrupted, running).
interface Delegation {
  id: string
  role: string
  status: string
  prompt: string
  report: string
  startedAt: number
  finishedAt: number | null
  steps: Array<{ id: string; tool: string; target: string; status: string; input: Record<string, unknown>; result: string; ms: number; truncated: boolean; at: number }>
}
const team = bodyOf<DetailBody & { session: { taskBoard: { delegations: Delegation[] } } }>(teamFile).session
const STATUS: Record<string, string> = { completed: 'done', failed: 'error', interrupted: 'interrupted', running: 'running' }
const asAgentCall = (d: Delegation): Message => ({
  id: d.id,
  role: 'tool',
  tool: 'Agent',
  status: STATUS[d.status] ?? d.status,
  input: { subagent_type: d.role, description: `Delegation ${d.id}`, prompt: d.prompt },
  target: `Delegation ${d.id}`,
  result: d.status === 'completed' ? d.report : '',
  at: d.startedAt,
  ms: d.finishedAt ? d.finishedAt - d.startedAt : null,
})

describe('delegation blocks (teams-heavy)', () => {
  it('renders the team and owner-review conversations', () => {
    for (const file of [teamFile, ownerFile]) {
      const messages = bodyOf<DetailBody>(file).session.messages
      const { container, unmount } = render(<MessageList messages={messages} streamingId={null} agent="CLAUDE" />)
      expect([...container.querySelectorAll('article')].map(a => a.dataset.block)).toEqual(messages.map(m => m.id))
      unmount()
    }
  })

  it('shows each delegation open, with a closed mandate and the report or what became of it', () => {
    const calls = team.taskBoard.delegations.map(asAgentCall)
    const { container } = render(<MessageList messages={calls} streamingId={null} agent="CLAUDE" />)
    expect(container.querySelectorAll('article')).toHaveLength(25)
    for (const delegation of team.taskBoard.delegations) {
      const article = container.querySelector(`[data-block="${delegation.id}"]`) as HTMLElement
      expect(article.classList.contains('collapsed')).toBe(false)
      expect(article.querySelector('.block-tool')?.textContent).toBe(`Delegation · ${delegation.role}`)
      const mandate = article.querySelector('details[data-delegation="mandate"]') as HTMLDetailsElement
      expect(mandate.open).toBe(false)
      const report = article.querySelector('details[data-delegation="report"]') as HTMLDetailsElement | null
      const note = article.querySelector('.block-note')?.textContent
      if (delegation.status === 'completed') {
        expect(report?.open).toBe(true)
        expect(report?.textContent).toContain(delegation.report)
        expect(article.querySelector('.block-state')?.textContent).toBe('done')
      } else if (delegation.status === 'running') expect(note).toBe('Awaiting report…')
      else if (delegation.status === 'failed') expect(note).toBe('Delegation failed without a report.')
      else expect(note).toBe('No report returned.')
    }
  })

  it('folds a long report and keeps the operator’s choice when the report grows', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n')
    const call: Message = { id: 'd', role: 'tool', tool: 'Task', status: 'done', input: { subagent_type: 'qa', prompt: 'Check it' }, result: long, truncated: true }
    const { container, rerender } = render(<MessageBlock message={call} streaming={false} agent="CLAUDE" />)
    const report = container.querySelector('details[data-delegation="report"]') as HTMLDetailsElement
    expect(report.open).toBe(false)
    expect(report.querySelector('summary')?.textContent).toBe('Returned report · long')
    report.open = true
    fireEvent(report, new Event('toggle'))
    rerender(<MessageBlock message={{ ...call, result: `${long}\nLine 20` }} streaming={false} agent="CLAUDE" />)
    expect(container.querySelector('details[data-delegation="report"]')).toBe(report)
    expect(report.open).toBe(true)
    expect(report.textContent).toContain('Line 20')
    expect(report.textContent).toContain('Report truncated by Fleet.')
  })

  it('renders the 200 steps of the largest delegation as tool blocks, truncation noted', () => {
    const steps = [...team.taskBoard.delegations].sort((a, b) => b.steps.length - a.steps.length)[0]?.steps ?? []
    expect(steps).toHaveLength(200)
    const messages: Message[] = steps.map(step => ({ ...step, role: 'tool' }))
    const { container } = render(<MessageList messages={messages} streamingId={null} agent="CLAUDE" />)
    expect(container.querySelectorAll('article')).toHaveLength(200)
    const first = container.querySelector('article') as HTMLElement
    fireEvent.click(first.querySelector('[data-collapse]') as HTMLElement)
    expect(first.textContent).toContain('Output truncated by Fleet.')
  })
})

describe('copy', () => {
  it('copies a tool block as its name, target, input and result', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } })
    show(byId(heavy, 'h-t-1-b'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy block' }))
    await screen.findByRole('button', { name: 'Copied' })
    expect(copied[0]).toMatch(/^Edit · src\/checkout.ts\n\{\n {2}"file_path"/)
    expect(copied[0]).toMatch(/\n\nThe file has been updated\.$/)
    Reflect.deleteProperty(navigator, 'clipboard')
  })
})
