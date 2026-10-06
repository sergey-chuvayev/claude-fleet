// The launch model picker (legacy model-picker.test.js): a failed model fetch leaves
// the standard choices usable and caches nothing empty; every opening retries; a
// choice made while the request is in flight survives its answer.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../app/AppShell'
import { deferred, jsonResponse } from '../../test/fakes'
import { type Harness, makeHarness, renderWith } from '../../test/shell'
import { STANDARD_MODELS, modelOptions } from './models'
import { isGet, launchFleet } from './testing'

let harness: Harness | null = null
afterEach(() => {
  harness?.client.stop()
  harness = null
})

function boot(fleet = launchFleet()) {
  harness = makeHarness(fleet.fetch)
  harness.client.start()
  renderWith(harness, <AppShell />)
  return fleet
}

const model = () => document.getElementById('launch-model') as HTMLSelectElement
const values = () => [...model().options].map(o => o.value)
const status = () => document.getElementById('launch-model-status')!
const open = async () => {
  fireEvent.keyDown(document, { key: 'n', ctrlKey: true })
  await screen.findByRole('dialog')
}
const close = () => fireEvent.keyDown(document.getElementById('launch-prompt')!, { key: 'Escape' })

describe('launch model picker', () => {
  it('keeps the standard choices when the list fails, says so, and retries on the next opening', async () => {
    const fleet = launchFleet()
    fleet.once(isGet('/api/models'), () => jsonResponse({ error: 'Model catalog unavailable.', code: 'UNAVAILABLE' }, 503))
    boot(fleet)
    await open()
    await waitFor(() => expect(status().textContent).toBe('Could not refresh models. The choices above still work; reopen New agent to retry.'))
    expect(values()).toEqual(STANDARD_MODELS.map(m => m.value))
    fireEvent.change(model(), { target: { value: 'haiku' } })
    expect(model().value).toBe('haiku')

    close()
    await open()
    await waitFor(() => expect(status().hidden).toBe(true))
    expect(fleet.gets('/api/models')).toHaveLength(2)
    // The runtime's list, with its descriptions; the choice made earlier holds.
    expect(values()).toEqual(['', 'opus', 'sonnet', 'haiku', 'auto-jev'])
    expect(model().value).toBe('haiku')
  })

  it('never caches an empty list as the catalog', async () => {
    const fleet = launchFleet()
    fleet.once(isGet('/api/models'), () => jsonResponse({ models: [] }))
    boot(fleet)
    await open()
    await waitFor(() => expect(status().textContent).toMatch(/^Could not refresh models/))
    expect(values()).toEqual(STANDARD_MODELS.map(m => m.value))
  })

  it('keeps a choice made while the refresh is in flight', async () => {
    const fleet = launchFleet()
    const slow = deferred<Response>()
    fleet.once(isGet('/api/models'), () => slow.promise)
    boot(fleet)
    await open()
    expect(status().textContent).toBe('Refreshing available models…')
    fireEvent.change(model(), { target: { value: 'opus' } })
    await act(async () =>
      slow.resolve(
        jsonResponse({
          models: [
            { value: '', displayName: 'Fleet default' },
            { value: 'claude-opus-5-5', displayName: 'Opus 5.5' },
          ],
        }),
      ),
    )
    await waitFor(() => expect(values()).toContain('claude-opus-5-5'))
    // The list no longer has "opus", so it stays as its own option rather than resetting.
    expect(model().value).toBe('opus')
    expect(values()).toEqual(['', 'claude-opus-5-5', 'opus'])
  })

  it('names a value the list lacks after itself', () => {
    expect(modelOptions(STANDARD_MODELS, 'claude-haiku-4')).toContainEqual({ value: 'claude-haiku-4', label: 'claude-haiku-4' })
    expect(modelOptions([{ value: 'x', displayName: 'X', description: 'An X' }], 'x')).toEqual([
      { value: 'x', label: 'X', description: 'An X' },
    ])
  })
})
