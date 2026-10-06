// A33 (sounds): what changes in the session list makes at most one tone, none on the
// first snapshot, none when off, and the player honours the legacy rules.
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Providers, makeHarness } from '../../test/shell'
import { jsonResponse } from '../../test/fakes'
import { SoundController } from './SoundController'
import { type AudioLike, MIN_GAP_MS, SOUNDS_KEY, SoundPlayer, TUNES, seenOf, soundFor } from './sounds'

const row = (managedId: string, status: string, extra: Record<string, unknown> = {}) => ({
  managed: true,
  managedId,
  managedStatus: status,
  kind: 'agent',
  ...extra,
})

function fakeAudio(state = 'running') {
  const started: Array<{ freq: number; at: number }> = []
  const audio: AudioLike = {
    state,
    currentTime: 10,
    destination: {},
    resume: async () => {},
    createOscillator: () => {
      const osc = {
        type: '',
        frequency: { value: 0 },
        connect: () => ({}),
        start: (at: number) => void started.push({ freq: osc.frequency.value, at }),
        stop: () => {},
      }
      return osc
    },
    createGain: () => ({
      gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => ({}),
    }),
  }
  return { audio, started }
}

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map }
}

describe('soundFor', () => {
  const seen = (...rows: ReturnType<typeof row>[]) => seenOf(rows)

  it('is silent on the first snapshot, which only sets the baseline', () => {
    expect(soundFor(null, seen(row('a', 'approval')))).toBeNull()
  })
  it('done when a managed agent goes from active to idle', () => {
    for (const before of ['starting', 'running', 'stopping'])
      expect(soundFor(seen(row('a', before)), seen(row('a', 'idle')))).toBe('done')
    expect(soundFor(seen(row('a', 'idle')), seen(row('a', 'idle')))).toBeNull()
    expect(soundFor(seen(row('a', 'error')), seen(row('a', 'idle')))).toBeNull()
  })
  it('ask when a session reaches approval, or a Day waiting count grows', () => {
    expect(soundFor(seen(row('a', 'running')), seen(row('a', 'approval')))).toBe('ask')
    expect(soundFor(seen(row('a', 'approval')), seen(row('a', 'approval')))).toBeNull()
    const day = (waiting: number) => row('d', 'idle', { kind: 'day', dayProgress: { waiting } })
    expect(soundFor(seen(day(1)), seen(day(2)))).toBe('ask')
    expect(soundFor(seen(day(2)), seen(day(1)))).toBeNull()
  })
  it('plays only the most important sound when several events share an update', () => {
    expect(soundFor(seen(row('a', 'running'), row('b', 'running')), seen(row('a', 'idle'), row('b', 'approval')))).toBe('ask')
  })
  it('keeps Day, project and thread coordinators silent when they go idle', () => {
    for (const kind of ['day', 'project', 'thread'])
      expect(soundFor(seen(row('c', 'running', { kind })), seen(row('c', 'idle', { kind })))).toBeNull()
  })
  it('ignores sessions it has not seen before and unmanaged rows', () => {
    expect(soundFor(seen(row('a', 'running')), seen(row('a', 'running'), row('new', 'approval')))).toBeNull()
    expect(seenOf([{ managed: false, managedId: undefined }]).size).toBe(0)
  })
})

describe('SoundPlayer', () => {
  it('plays each tune note by note, on by default', () => {
    const { audio, started } = fakeAudio()
    const player = new SoundPlayer({ storage: () => memory(), createAudio: () => audio, now: () => 5000 })
    expect(player.enabled()).toBe(true)
    expect(player.play('report')).toBe(true)
    expect(started.map(n => n.freq)).toEqual(TUNES.report.map(([f]) => f))
    expect(started.map(n => +(n.at - started[0]!.at).toFixed(2))).toEqual([0, 0.09, 0.18])
  })

  it('is silent when turned off, unless a sample is forced', () => {
    const storage = memory({ [SOUNDS_KEY]: '0' })
    const { audio, started } = fakeAudio()
    const player = new SoundPlayer({ storage: () => storage, createAudio: () => audio, now: () => 5000 })
    expect(player.enabled()).toBe(false)
    expect(player.play('done')).toBe(false)
    expect(started).toHaveLength(0)
    expect(player.play('done', { force: true })).toBe(true)
    player.setEnabled(true)
    expect(storage.map.get(SOUNDS_KEY)).toBe('1')
    expect(player.enabled()).toBe(true)
  })

  it('lets only one sound through per 1.2 seconds, and none before the browser allows audio', () => {
    let t = 100_000
    const { audio, started } = fakeAudio()
    const player = new SoundPlayer({ storage: () => memory(), createAudio: () => audio, now: () => t })
    expect(player.play('done')).toBe(true)
    t += MIN_GAP_MS - 1
    expect(player.play('ask')).toBe(false)
    t += 2
    expect(player.play('ask')).toBe(true)
    expect(started).toHaveLength(4)

    const locked = fakeAudio('suspended')
    const quiet = new SoundPlayer({ storage: () => memory(), createAudio: () => locked.audio })
    expect(quiet.play('done')).toBe(false)
    expect(locked.started).toHaveLength(0)
  })

  it('survives blocked storage and missing audio', () => {
    const player = new SoundPlayer({
      storage: () => {
        throw new Error('blocked')
      },
      createAudio: () => null,
    })
    expect(player.enabled()).toBe(true)
    expect(() => player.setEnabled(false)).not.toThrow()
    expect(player.play('done')).toBe(false)
  })
})

describe('SoundController', () => {
  async function mountWith(snapshots: unknown[], player: SoundPlayer) {
    let n = 0
    const fetch = async (url: string) => {
      if (url === '/api/control') return jsonResponse((await import('../../test/fixtures/fleet-mixed/get-control.json')).default.response.body)
      const body = snapshots[Math.min(n++, snapshots.length - 1)]
      return jsonResponse(body)
    }
    const harness = makeHarness(fetch as never)
    const view = render(
      <Providers harness={harness}>
        <SoundController player={player} />
      </Providers>,
    )
    return { harness, ...view }
  }
  const snap = (...rows: unknown[]) => ({ sessions: rows, counts: { busy: 0, idle: 0, stale: 0, dead: 0 }, total: rows.length })

  it('plays one tone per update, never for the first snapshot', async () => {
    const play = vi.fn(() => true)
    const player = { play, unlock: vi.fn() } as unknown as SoundPlayer
    const { harness } = await mountWith(
      [
        snap({ ...row('a', 'running'), state: 'busy' }),
        snap({ ...row('a', 'idle'), state: 'idle' }),
        snap({ ...row('a', 'approval'), state: 'idle' }),
      ],
      player,
    )
    await vi.waitFor(() => expect(harness.client.store.get(harness.client.resources.sessions).data).toBeTruthy())
    expect(play).not.toHaveBeenCalled()
    await harness.client.store.refresh(harness.client.resources.sessions)
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith('done'))
    await harness.client.store.refresh(harness.client.resources.sessions)
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith('ask'))
    expect(play).toHaveBeenCalledTimes(2)
    harness.client.stop()
  })

  it('unlocks audio on the first pointer press', async () => {
    const unlock = vi.fn()
    const player = { play: vi.fn(), unlock } as unknown as SoundPlayer
    await mountWith([snap()], player)
    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new Event('pointerdown'))
    expect(unlock).toHaveBeenCalledTimes(1)
  })
})
