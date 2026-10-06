// A23 regression, found by the keyboard-only journey on the production build: after
// "Allow once" from the keyboard the card left with the focused button and focus fell
// to the page. It goes to the next card waiting, then to the composer.
import { waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ManagedId } from '../../domain/ids'
import heavyFile from '../../test/fixtures/conversation-heavy/managed/c-heavy.json'
import { jsonResponse } from '../../test/fakes'
import type { DetailBody } from '../conversation/testing'
import { SessionDetail } from '../inspector/SessionDetail'
import { type ConsoleFleet, consoleFleet, detailOf, mountConsole } from '../session-header/testing'

const managed = (id: string) => ({ kind: 'managed', managedId: id as ManagedId }) as const
const withSession = (detail: DetailBody, patch: Record<string, unknown>): DetailBody => ({ ...detail, session: { ...detail.session, ...patch } })
const card = (id: string) => document.querySelector<HTMLFormElement>(`form[data-approval="${id}"]`)

let fleet: ConsoleFleet
beforeEach(() => {
  fleet = consoleFleet()
  fleet.update('c-heavy', detailOf(heavyFile))
  // The server drops the decided approval and answers with the session.
  fleet.onPost = (post, self) => {
    const id = post.path.split('/').at(-1)
    const approvals = (self.held('c-heavy')!.session.approvals as Array<{ id: string }>).filter(a => a.id !== id)
    const next = withSession(self.held('c-heavy')!, { approvals })
    self.update('c-heavy', next)
    return jsonResponse(next)
  }
})

describe('Approvals focus after a decision', () => {
  it('moves to the next card, then to the composer, never to the body', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-current')).toBeTruthy())
    within(card('ap-current')!).getByRole('button', { name: 'Allow once' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(card('ap-current')).toBeNull())
    await waitFor(() => expect(card('ap-ask')?.contains(document.activeElement)).toBe(true))

    within(card('ap-ask')!).getByRole('button', { name: 'Skip question' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(card('ap-ask')).toBeNull())
    await waitFor(() => expect(document.activeElement?.id).toBe('message-input'))
  })
})
