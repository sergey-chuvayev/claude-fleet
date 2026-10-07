// A07 (F10, F11), a hard gate: compose with IME, commands, a reference chip and images,
// switch sessions while a request is pending, and nothing crosses sessions: each draft
// is its own, a late answer clears only the revision it sent, and inserting a command
// or a reference never sends by itself.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ManagedId } from '../../domain/ids'
import errorFile from '../../test/fixtures/conversation-heavy/managed/c-error.json'
import codexFile from '../../test/fixtures/conversation-heavy/managed/c-codex.json'
import sessionsFile from '../../test/fixtures/conversation-heavy/get-sessions.json'
import { deferred, jsonResponse, strip } from '../../test/fakes'
import { SessionDetail } from '../inspector/SessionDetail'
import { type ConsoleFleet, choose, consoleFleet, detailOf, mountConsole, postsTo } from '../session-header/testing'
import { draftStoreFor } from './drafts'

const managed = (id: string) => ({ kind: 'managed', managedId: id as ManagedId }) as const
const box = () => screen.getByRole('combobox', { name: 'Message this agent' }) as HTMLTextAreaElement
const toast = () => document.getElementById('toast')?.textContent ?? ''

let fleet: ConsoleFleet
beforeEach(() => {
  fleet = consoleFleet()
  fleet.update('c-error', detailOf(errorFile))
  fleet.update('c-codex', detailOf(codexFile))
  fleet.sessions.set(strip(sessionsFile.response.body))
})

describe('Composer drafts across sessions (A07)', () => {
  it('keeps each session’s words to itself when switching', async () => {
    const user = userEvent.setup()
    const mounted = mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), 'for the failed run')
    await choose(mounted, managed('c-codex'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Codex: add retries' })).toBeTruthy())
    expect(box().value).toBe('')
    await user.type(box(), 'for codex')
    await choose(mounted, managed('c-error'))
    await waitFor(() => expect(box().value).toBe('for the failed run'))
    await choose(mounted, managed('c-codex'))
    await waitFor(() => expect(box().value).toBe('for codex'))
    expect(fleet.posts).toEqual([])
  })

  it('a late answer after switching clears only the session it was for', async () => {
    const user = userEvent.setup()
    const answer = deferred<Response>()
    fleet.onPost = () => answer.promise
    const mounted = mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), 'retry it{Enter}')
    expect(postsTo(fleet, '/messages')).toHaveLength(1)
    // The send is out: the button is disabled and the words are still there.
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true)
    await choose(mounted, managed('c-codex'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Codex: add retries' })).toBeTruthy())
    await user.type(box(), 'codex words')
    await act(async () => answer.resolve(jsonResponse(fleet.held('c-error'))))
    expect(box().value).toBe('codex words')
    const drafts = draftStoreFor(mounted.client)
    expect(drafts.get('managed:c-error').text).toBe('')
    expect(drafts.get('managed:c-error').sending).toBeNull()
    expect(drafts.get('managed:c-codex').text).toBe('codex words')
  })

  it('words typed while the send was out survive its answer', async () => {
    const user = userEvent.setup()
    const answer = deferred<Response>()
    fleet.onPost = () => answer.promise
    const mounted = mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), 'first{Enter}')
    await user.type(box(), ' and more')
    await act(async () => answer.resolve(jsonResponse(fleet.held('c-error'))))
    expect(box().value).toBe('first and more')
    expect(draftStoreFor(mounted.client).get('managed:c-error').sending).toBeNull()
    expect(postsTo(fleet, '/messages').map(p => p.body.message)).toEqual(['first'])
  })

  it('a failed send keeps the draft and its request id, and says why; the deliberate retry reuses the id', async () => {
    const user = userEvent.setup()
    let calls = 0
    fleet.onPost = (_post, self) => (++calls === 1 ? jsonResponse({ error: 'All agents are busy.', code: 'CAPACITY' }, 409) : jsonResponse(self.held('c-error')))
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), 'try again{Enter}')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'All agents are busy.')
    expect(box().value).toBe('try again')
    await user.click(screen.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(box().value).toBe(''))
    const [first, second] = postsTo(fleet, '/messages')
    expect(first?.body.requestId).toBeTruthy()
    expect(second?.body.requestId).toBe(first?.body.requestId)
  })

  it('Shift+Enter is a new line and an Enter that ends IME composition sends nothing', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), 'line one{Shift>}{Enter}{/Shift}line two')
    expect(box().value).toBe('line one\nline two')
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(fleet.posts).toEqual([])
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(postsTo(fleet, '/messages')).toHaveLength(1))
    expect(postsTo(fleet, '/messages')[0]?.body.message).toBe('line one\nline two')
  })

  it('an empty draft sends nothing', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), '   {Enter}')
    expect(fleet.posts).toEqual([])
  })
})

describe('Slash commands (A07)', () => {
  it('offers the session’s commands on `/`, and Enter inserts one without sending', async () => {
    fleet.commands = [
      { name: 'review', kind: 'command', scope: 'project', description: 'Review the diff', hint: '[file]' },
      { name: 'deploy-check', kind: 'skill', scope: 'user', description: 'Check a deploy' },
    ]
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), '/re')
    const list = await screen.findByRole('listbox', { name: 'Commands and skills' })
    await waitFor(() => expect(within(list).getAllByRole('option').map(o => o.querySelector('.slash-name')?.textContent)).toEqual(['/review']))
    expect(box().getAttribute('aria-activedescendant')).toBe('slash-0')
    await user.keyboard('{Enter}')
    expect(box().value).toBe('/review ')
    expect(fleet.posts).toEqual([])
    expect(screen.queryByRole('listbox', { name: 'Commands and skills' })).toBeNull()
    expect(fleet.requests.filter(r => r.endsWith('/commands'))).toHaveLength(1)
  })

  it('arrows move the pick, Tab inserts, Escape closes', async () => {
    fleet.commands = [
      { name: 'deploy', kind: 'command', scope: 'project', description: '' },
      { name: 'debug', kind: 'skill', scope: 'plugin', description: '' },
    ]
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), '/de')
    await screen.findByRole('listbox', { name: 'Commands and skills' })
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Tab}')
    expect(box().value).toBe('/debug ')
    await user.type(box(), '{Enter}')
    await waitFor(() => expect(postsTo(fleet, '/messages')).toHaveLength(1))
    // Typing `/` again opens it; Escape closes it with the text untouched.
    await user.type(box(), '/d')
    await screen.findByRole('listbox', { name: 'Commands and skills' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Commands and skills' })).toBeNull()
    expect(box().value).toBe('/d')
  })
})

describe('Session references (A07, F11)', () => {
  it('`@` lists other sessions but never this one; a pick becomes a chip and is sent as an id', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), 'compare with @')
    const list = await screen.findByRole('listbox', { name: 'Reference a session' })
    const names = within(list)
      .getAllByRole('option')
      .map(o => o.querySelector('.slash-name')?.textContent)
    expect(names).toContain('✳ Fix flaky checkout test')
    expect(names).toContain('✳ checkout-refactor')
    expect(names).not.toContain('✳ Run that failed')
    await user.type(box(), 'checkout-ref')
    await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Reference a session' })).getAllByRole('option')).toHaveLength(1))
    await user.keyboard('{Enter}')
    expect(box().value).toBe('compare with ')
    const tray = screen.getByLabelText('Referenced sessions')
    expect(within(tray).getByRole('button', { name: /^✳ checkout-refactor/ })).toBeTruthy()
    expect(fleet.posts).toEqual([])
    await user.type(box(), '{Enter}')
    await waitFor(() => expect(postsTo(fleet, '/messages')).toHaveLength(1))
    expect(postsTo(fleet, '/messages')[0]?.body).toMatchObject({ message: 'compare with', references: ['000000c1-0000-4000-8000-000000000001'] })
    await waitFor(() => expect(screen.getByLabelText('Referenced sessions').hidden).toBe(true))
  })

  it('a chip can be removed, and opening it selects that session', async () => {
    const user = userEvent.setup()
    const mounted = mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.type(await screen.findByRole('combobox', { name: 'Message this agent' }), '@Fix flaky')
    await screen.findByRole('listbox', { name: 'Reference a session' })
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Remove reference to Fix flaky checkout test' }))
    expect(screen.getByLabelText('Referenced sessions').hidden).toBe(true)
    await user.type(box(), '@Fix flaky')
    await screen.findByRole('listbox', { name: 'Reference a session' })
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: /^✳ Fix flaky checkout test/ }))
    await waitFor(() => expect(mounted.store.getState().selection.sessions).toEqual({ kind: 'managed', managedId: 'c-heavy' }))
  })
})

const png = (name = 'shot.png', size = 1024) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const paste = (files: File[]) =>
  fireEvent.paste(box(), { clipboardData: { items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })) } })

describe('Images (A08, F11)', () => {
  it('a pasted image shows a thumbnail, can be removed, and an image-only message sends', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await screen.findByRole('combobox', { name: 'Message this agent' })
    paste([png('one.png'), png('two.png')])
    await waitFor(() => expect(screen.getAllByRole('img', { name: /\.png$/ })).toHaveLength(2))
    expect(document.getElementById('composer-hint')?.textContent).toBe('2 images attached · Enter to send')
    await user.click(screen.getByRole('button', { name: 'Remove one.png' }))
    expect(screen.getAllByRole('img', { name: /\.png$/ }).map(i => i.getAttribute('alt'))).toEqual(['two.png'])
    await user.type(box(), '{Enter}')
    await waitFor(() => expect(postsTo(fleet, '/messages')).toHaveLength(1))
    const body = postsTo(fleet, '/messages')[0]!.body
    expect(body.message).toBe('')
    expect(body.images).toEqual([{ mediaType: 'image/png', data: expect.any(String) }])
    await waitFor(() => expect(screen.queryAllByRole('img', { name: /\.png$/ })).toEqual([]))
  })

  it('refuses a seventh image, an oversized one and a non-image before anything is sent', async () => {
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await screen.findByRole('combobox', { name: 'Message this agent' })
    paste([png('big.png', 8 * 1024 * 1024 + 1)])
    await waitFor(() => expect(toast()).toBe('big.png is over 8 MB.'))
    paste([new File(['x'], 'pic.bmp', { type: 'image/bmp' })])
    await waitFor(() => expect(toast()).toBe('Only PNG, JPEG, GIF and WebP images can be attached.'))
    paste(Array.from({ length: 7 }, (_, i) => png(`p${i}.png`)))
    await waitFor(() => expect(toast()).toBe('Up to 6 images per message.'))
    expect(screen.getAllByRole('img', { name: /\.png$/ })).toHaveLength(6)
    expect(fleet.posts).toEqual([])
  })

  it('a dropped image joins the draft; a text paste is left to the browser', async () => {
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await screen.findByRole('combobox', { name: 'Message this agent' })
    const form = document.getElementById('composer')!
    fireEvent.dragOver(form, { dataTransfer: { types: ['Files'] } })
    expect(form.className).toContain('is-dropping')
    fireEvent.drop(form, { dataTransfer: { types: ['Files'], files: [png('drop.png')] } })
    await waitFor(() => expect(screen.getByRole('img', { name: 'drop.png' })).toBeTruthy())
    expect(form.className).not.toContain('is-dropping')
    const event = fireEvent.paste(box(), { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } })
    expect(event).toBe(true)
  })

  it('a GIF refused by a Codex agent keeps the draft and says why', async () => {
    fleet.onPost = () => jsonResponse({ error: 'Codex agents take PNG, JPEG and WebP images. Convert the GIF first.', code: 'UNSUPPORTED_ENGINE' }, 400)
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-codex'))
    await screen.findByRole('combobox', { name: 'Message this agent' })
    paste([new File([new Uint8Array(10)], 'loop.gif', { type: 'image/gif' })])
    await waitFor(() => expect(screen.getByRole('img', { name: 'loop.gif' })).toBeTruthy())
    await user.type(box(), 'see this{Enter}')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Codex agents take PNG, JPEG and WebP images. Convert the GIF first.')
    expect(box().value).toBe('see this')
    expect(screen.getByRole('img', { name: 'loop.gif' })).toBeTruthy()
  })
})
