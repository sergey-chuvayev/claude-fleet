// A06 (F09): a streaming reply grows and new messages append while the operator reads,
// copies, collapses and selects. Node identity, open disclosures, selection and the
// read anchor must hold; the tail follower follows; the operator above the tail does
// not move; unsafe Markdown cannot run or pass for Fleet's controls.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import heavyFile from '../../test/fixtures/conversation-heavy/managed/c-heavy.json'
import codexFile from '../../test/fixtures/conversation-heavy/managed/c-codex.json'
import errorFile from '../../test/fixtures/conversation-heavy/managed/c-error.json'
import grownFile from '../../test/fixtures/conversation-heavy/managed-c-heavy-grown-packed.json'
import historyFile from '../../test/fixtures/conversation-heavy/history/undefined-000000c1-0000-4000-8000-000000000001.json'
import sessionsFile from '../../test/fixtures/conversation-heavy/get-sessions.json'
import type { Message } from '../../transport/contracts'
import { Conversation, conversationTarget } from './Conversation'
import { type DetailBody, type Layout, bodyOf, fakeFleet, installLayout, mountWith, nextFrame, renderCounter } from './testing'

const HEAVY = 'managed:c-heavy'
const STREAM = 'h-a-stream'
// The grown fixture's streaming text: the same message id, more words.
const grownText = (grownFile.response.body.session.messages.at(-1) as { text: string }).text

const heavy = () => bodyOf<DetailBody>(heavyFile)
function withMessages(detail: DetailBody, messages: Message[], status = detail.session.status): DetailBody {
  return { ...detail, session: { ...detail.session, status, messages } }
}
function grown(detail: DetailBody, extra: Message[] = []): DetailBody {
  const messages = detail.session.messages.map(m => (m.id === STREAM ? { ...m, text: grownText } : m))
  return withMessages(detail, [...messages, ...extra])
}
const block = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-block="${id}"]`)
  if (!found) throw new Error(`no block ${id}`)
  return found
}
const blockIds = () => [...document.querySelectorAll<HTMLElement>('[data-block]')].map(b => b.dataset.block)

let fleet: ReturnType<typeof fakeFleet>
let geometry: Layout
beforeEach(() => {
  fleet = fakeFleet()
  fleet.managed('c-heavy', heavy())
  geometry = installLayout()
})
afterEach(() => {
  geometry.uninstall()
})

async function open(sessionKey = HEAVY, probe?: (id: string) => void) {
  const mounted = mountWith(fleet, <Conversation sessionKey={sessionKey} />, probe)
  await screen.findAllByRole('article')
  return mounted
}
const refresh = async (client: ReturnType<typeof mountWith>['client'], id = 'c-heavy') => {
  await act(async () => {
    await client.store.refresh(client.resources.managed(id))
  })
}

describe('Conversation (A06)', () => {
  it('opens at the tail and follows it while the reply grows and messages append', async () => {
    const { client } = await open()
    expect(geometry.scrollTop).toBe(geometry.bottom())
    expect(geometry.bottom()).toBeGreaterThan(0)

    geometry.setHeight(STREAM, 400)
    fleet.managed('c-heavy', grown(heavy(), [{ id: 'new-tool', role: 'tool', tool: 'Bash', status: 'running', input: { command: 'npm test' }, at: 1 }]))
    await refresh(client)
    expect(blockIds().at(-1)).toBe('new-tool')
    expect(geometry.scrollTop).toBe(geometry.bottom())
  })

  it('keeps node identity of the streaming block and of every unchanged block', async () => {
    const { client } = await open()
    const streaming = block(STREAM)
    const earlier = block('h-t-0-b')
    expect(streaming.textContent).toContain('writing')
    fleet.managed('c-heavy', grown(heavy()))
    await refresh(client)
    expect(block(STREAM)).toBe(streaming)
    expect(block('h-t-0-b')).toBe(earlier)
    expect(streaming.textContent).toContain('a regression test covers the slow path')
    // The packed answer carried every unchanged message as {h} alone.
    expect(fleet.requests.filter(url => url === '/api/managed/c-heavy')).toHaveLength(2)
  })

  it('holds the read anchor when the operator is above the tail, through growth, appends and the window moving', async () => {
    const { client } = await open()
    geometry.userScroll(4000)
    await act(nextFrame)
    const anchor = geometry.firstVisible()
    if (!anchor) throw new Error('nothing visible')
    const before = geometry.topOf(anchor)
    const scrolled = geometry.scrollTop

    // The reply grows below, a message appends, and the oldest message leaves the top.
    geometry.setHeight(STREAM, 900)
    const next = grown(heavy(), [{ id: 'new-user', role: 'user', text: 'More', at: 2 }])
    next.session.messages.shift()
    fleet.managed('c-heavy', next)
    await refresh(client)

    expect(geometry.topOf(anchor)).toBe(before)
    expect(geometry.scrollTop).toBe(scrolled - 100)
    expect(geometry.scrollTop).toBeLessThan(geometry.bottom())
  })

  it('keeps collapse, open disclosures and a text selection across unrelated updates', async () => {
    const { client } = await open()
    // A completed Bash call starts collapsed; open it.
    const bash = block('h-t-0-b')
    expect(bash.classList.contains('collapsed')).toBe(true)
    fireEvent.click(bash.querySelector('[data-collapse]') as HTMLElement)
    expect(bash.classList.contains('collapsed')).toBe(false)
    // An assistant reply: collapse it.
    const reply = block('h-a-0')
    fireEvent.click(reply.querySelector('[data-collapse]') as HTMLElement)
    expect(reply.classList.contains('collapsed')).toBe(true)
    // A delegation's mandate starts closed; open it.
    const task = block('h-t-3-b')
    const mandate = task.querySelector('details[data-delegation="mandate"]') as HTMLDetailsElement
    mandate.open = true
    fireEvent(mandate, new Event('toggle'))
    await waitFor(() => expect(mandate.textContent).toContain('Review the checkout change for races.'))
    // Select words in an earlier user message.
    const words = block('h-u-0').querySelector('.block-prose p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(words, 0)
    range.setEnd(words, 8)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)

    fleet.managed('c-heavy', grown(heavy()))
    await refresh(client)

    expect(block('h-t-0-b')).toBe(bash)
    expect(bash.classList.contains('collapsed')).toBe(false)
    expect(reply.classList.contains('collapsed')).toBe(true)
    expect(mandate.open).toBe(true)
    expect(mandate.isConnected).toBe(true)
    const selection = document.getSelection()
    expect(selection?.anchorNode).toBe(words)
    expect(words.isConnected).toBe(true)
    expect(selection?.toString()).toBe('Question')
  })

  it('copies a block and tells the operator', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const notices: string[] = []
    mountWith(fleet, <Conversation sessionKey={HEAVY} onNotice={text => notices.push(text)} />)
    await screen.findAllByRole('article')
    fireEvent.click(block('h-t-0-b').querySelector('[data-copy]') as HTMLElement)
    await waitFor(() => expect(notices).toEqual(['Block copied']))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^Bash · npm test -- checkout\nnpm test -- checkout\n\nline 1:/))
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('restores each session’s reading position when switching back', async () => {
    fleet.managed('c-error', bodyOf(errorFile))
    const { rerender } = await open()
    geometry.userScroll(3000)
    await act(nextFrame)
    const anchor = geometry.firstVisible()
    if (!anchor) throw new Error('nothing visible')
    const offset = geometry.topOf(anchor)

    rerender(<Conversation sessionKey="managed:c-error" />)
    await screen.findByText('Run the full suite')
    expect(geometry.scrollTop).toBe(geometry.bottom())
    rerender(<Conversation sessionKey={HEAVY} />)
    await screen.findAllByRole('article')
    expect(geometry.topOf(anchor)).toBe(offset)
    expect(geometry.scrollTop).toBeLessThan(geometry.bottom())
  })

  it('renders unsafe Markdown inert, without form controls or borrowed chrome', async () => {
    const hostile = [
      'Hello <script>window.__pwned = 1</script>',
      '<img src=x onerror="window.__pwned = 2">',
      '<form action="/api/managed"><input name="prompt" value="rm -rf"><button>Send</button></form>',
      '<select><option>Allow once</option></select><textarea>type here</textarea>',
      '<span class="block-button question-pin-bubble" role="button" tabindex="0" style="position:fixed">Deny</span>',
      '<a href="javascript:window.__pwned=3">click</a> <a href="https://example.com">ok</a>',
      '<label for="message-input">x</label><progress value="1"></progress>',
    ].join('\n\n')
    fleet.managed(
      'c-heavy',
      withMessages(heavy(), [
        { id: 'evil', role: 'assistant', text: hostile, at: 1 },
        { id: 'evil-tool', role: 'tool', tool: 'Bash', status: 'error', input: { command: '<img src=x onerror="window.__pwned=4">' }, result: '<script>window.__pwned=5</script>', at: 2 },
      ], 'idle'),
    )
    await open()
    const prose = block('evil').querySelector('.block-prose') as HTMLElement
    expect(prose.querySelector('script, form, input, button, select, option, textarea, label, progress, iframe')).toBeNull()
    expect(prose.querySelector('[class], [style], [role], [tabindex], [onerror]')).toBeNull()
    expect(prose.querySelector('a[href^="javascript"]')).toBeNull()
    expect(prose.querySelector('a[href="https://example.com"]')?.getAttribute('rel')).toBe('noreferrer noopener')
    // Only Fleet's own two actions are buttons in the block.
    expect(block('evil').querySelectorAll('button')).toHaveLength(2)
    // Tool input and output are text, never markup.
    const tool = block('evil-tool')
    expect(tool.querySelector('img, script')).toBeNull()
    expect(tool.textContent).toContain('<img src=x onerror="window.__pwned=4">')
    expect(tool.textContent).toContain('<script>window.__pwned=5</script>')
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined()
  })
})

describe('Conversation rendering and memoization', () => {
  it('re-renders only the streaming block when the reply grows', async () => {
    const counter = renderCounter()
    const { client } = await open(HEAVY, counter.probe)
    counter.reset()
    fleet.managed('c-heavy', grown(heavy()))
    await refresh(client)
    expect([...counter.counts.entries()]).toEqual([[STREAM, 1]])
  })

  it('does not re-render any block on unrelated store updates or a 304', async () => {
    const counter = renderCounter()
    const { client } = await open(HEAVY, counter.probe)
    counter.reset()
    await act(async () => {
      client.store.set(client.resources.sessions, bodyOf(sessionsFile))
      await client.store.refresh(client.resources.control)
    })
    await refresh(client) // nothing changed: 304
    expect(counter.total()).toBe(0)
  })

  it('stops showing the reply as streaming when the session settles, touching only that block', async () => {
    const counter = renderCounter()
    const { client } = await open(HEAVY, counter.probe)
    counter.reset()
    fleet.managed('c-heavy', withMessages(heavy(), heavy().session.messages, 'idle'))
    await refresh(client)
    expect([...counter.counts.keys()]).toEqual([STREAM])
    expect(block(STREAM).textContent).not.toContain('writing')
  })

  it('shows at most the most recent 200 messages', async () => {
    const many: Message[] = Array.from({ length: 250 }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Message ${i}`, at: i }))
    fleet.managed('c-heavy', withMessages(heavy(), many, 'idle'))
    await open()
    const ids = blockIds()
    expect(ids).toHaveLength(200)
    expect(ids[0]).toBe('m-50')
    expect(ids.at(-1)).toBe('m-249')
  })

  it('renders the whole heavy fixture, one article per message, in order', async () => {
    await open()
    expect(blockIds()).toEqual(heavy().session.messages.map(m => m.id))
    expect(screen.getByRole('log', { name: 'Agent conversation' })).toBeTruthy()
  })

  it('labels a Codex session’s replies CODEX', async () => {
    fleet.managed('c-codex', bodyOf(codexFile))
    await open('managed:c-codex')
    expect(block('x-a').querySelector('.block-tool')?.textContent).toBe('CODEX')
    expect(block('x-u').querySelector('.block-tool')?.textContent).toBe('YOU')
  })

  it('explains a missing session and an empty one', async () => {
    mountWith(fleet, <Conversation sessionKey="managed:gone" />)
    expect(await screen.findByText('Session not found.')).toBeTruthy()
  })

  it('invites the first instruction in an empty session', async () => {
    fleet.managed('c-heavy', withMessages(heavy(), [], 'idle'))
    mountWith(fleet, <Conversation sessionKey={HEAVY} />)
    expect(await screen.findByText('Send your first instruction below.')).toBeTruthy()
  })
})

describe('External conversation', () => {
  const ID = '000000c1-0000-4000-8000-000000000001'
  const history = () => bodyOf<{ messages: Message[]; truncated: boolean; alive: boolean }>(historyFile)

  it('reads the transcript under its engine-qualified key and renders it', async () => {
    fleet.history(ID, history())
    const { client } = await open(`claude:${ID}`)
    expect(screen.getByRole('log', { name: 'Conversation from the terminal' })).toBeTruthy()
    expect(blockIds()).toEqual(['u0', 'a1', 'u2', 'a3', 'tu-1'])
    expect(block('a1').querySelector('.block-tool')?.textContent).toBe('CLAUDE')
    expect(client.store.get(client.resources.history('claude', ID)).data?.alive).toBe(true)
  })

  it('says when earlier messages are only in the transcript', async () => {
    fleet.history(ID, { ...history(), truncated: true })
    await open(`claude:${ID}`)
    expect(screen.getByText('Earlier messages are in the transcript; this shows the most recent part.')).toBeTruthy()
  })

  it('reads the transcript again only when the session moves in the list', async () => {
    fleet.history(ID, history())
    const snapshot = bodyOf<{ sessions: Array<Record<string, unknown>> }>(sessionsFile)
    fleet.sessions.set(snapshot)
    const { client } = await open(`claude:${ID}`)
    await act(async () => {
      await client.store.refresh(client.resources.sessions)
    })
    const reads = () => fleet.requests.filter(url => url.startsWith('/api/sessions/history')).length
    expect(reads()).toBe(1)
    // The list refreshes with nothing new for this session: no read.
    const others = { ...snapshot, total: snapshot.sessions.length }
    fleet.sessions.set(others)
    await act(async () => {
      await client.store.refresh(client.resources.sessions)
    })
    expect(reads()).toBe(1)
    // The session moved: one read.
    const moved = {
      ...snapshot,
      sessions: snapshot.sessions.map(s => (s.sessionId === ID ? { ...s, lastActivity: Number(s.lastActivity) + 1000 } : s)),
    }
    fleet.history(ID, { ...history(), messages: [...history().messages, { id: 'a9', role: 'assistant', text: 'Done.', at: 9 }] })
    fleet.sessions.set(moved)
    await act(async () => {
      await client.store.refresh(client.resources.sessions)
    })
    await waitFor(() => expect(reads()).toBe(2))
    await screen.findByText('Done.')
  })

  it('explains a transcript that cannot be read', async () => {
    mountWith(fleet, <Conversation sessionKey="codex:00000000-0000-4000-8000-000000000000" />)
    expect(await screen.findByText('No transcript for that session.')).toBeTruthy()
  })
})

describe('conversationTarget', () => {
  it('reads managed and engine-qualified external keys, and nothing else', () => {
    expect(conversationTarget('managed:c-1')).toEqual({ kind: 'managed', id: 'c-1' })
    expect(conversationTarget('codex:abc')).toEqual({ kind: 'external', engine: 'codex', id: 'abc' })
    expect(conversationTarget('claude:abc')).toEqual({ kind: 'external', engine: 'claude', id: 'abc' })
    expect(conversationTarget('pid:42')).toBeNull()
    expect(conversationTarget('managed:')).toBeNull()
  })
})
