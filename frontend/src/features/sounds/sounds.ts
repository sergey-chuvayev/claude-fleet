// Small sounds for the moments worth looking up for: an agent finished its turn,
// something waits on you (an approval, a question on Today), an agent reported back on
// Today. Synthesized here, a few soft sine notes each, so there is nothing to download.
// On by default; Settings turns them off for this browser (`fleet.sounds`).
//
// Ported from public/sounds.js. The player is a class with injectable audio, storage
// and clock so tests need no real AudioContext; `sounds` is the one the app uses.

export const SOUNDS_KEY = 'fleet.sounds'

export type SoundName = 'done' | 'ask' | 'report'

/** Notes in Hz with their start offset in seconds. */
export const TUNES: Readonly<Record<SoundName, ReadonlyArray<readonly [number, number]>>> = {
  done: [
    [659.25, 0],
    [987.77, 0.11],
  ],
  ask: [
    [880, 0],
    [880, 0.16],
  ],
  report: [
    [783.99, 0],
    [987.77, 0.09],
    [1174.66, 0.18],
  ],
}

/** One sound at a time: a second within this window is dropped unless forced. */
export const MIN_GAP_MS = 1200

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The slice of AudioContext the player uses. */
export interface AudioLike {
  readonly state: string
  readonly currentTime: number
  readonly destination: unknown
  resume(): Promise<void>
  createOscillator(): {
    type: string
    frequency: { value: number }
    connect(node: unknown): unknown
    start(at: number): void
    stop(at: number): void
  }
  createGain(): {
    gain: {
      setValueAtTime(value: number, at: number): void
      linearRampToValueAtTime(value: number, at: number): void
      exponentialRampToValueAtTime(value: number, at: number): void
    }
    connect(node: unknown): unknown
  }
}

export interface SoundPlayerOptions {
  readonly storage?: (() => StorageLike | null) | undefined
  readonly createAudio?: (() => AudioLike | null) | undefined
  readonly now?: (() => number) | undefined
}

const browserStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const browserAudio = (): AudioLike | null => {
  const Ctor =
    (globalThis as { AudioContext?: new () => AudioLike }).AudioContext ??
    (globalThis as { webkitAudioContext?: new () => AudioLike }).webkitAudioContext
  return Ctor ? new Ctor() : null
}

export class SoundPlayer {
  private audio: AudioLike | null = null
  private lastAt = 0
  private readonly storage: () => StorageLike | null
  private readonly createAudio: () => AudioLike | null
  private readonly now: () => number

  constructor(options: SoundPlayerOptions = {}) {
    this.storage = options.storage ?? browserStorage
    this.createAudio = options.createAudio ?? browserAudio
    this.now = options.now ?? Date.now
  }

  enabled = (): boolean => {
    try {
      return this.storage()?.getItem(SOUNDS_KEY) !== '0'
    } catch {
      return true
    }
  }

  setEnabled = (on: boolean): void => {
    try {
      this.storage()?.setItem(SOUNDS_KEY, on ? '1' : '0')
    } catch {
      // Private window or full storage: the choice lasts until the page closes at most.
    }
  }

  /** Browsers only let a page make sound after the person has interacted with it. */
  unlock = (): void => {
    this.context()
  }

  private context(): AudioLike | null {
    if (!this.audio) {
      try {
        this.audio = this.createAudio()
      } catch {
        this.audio = null
      }
      if (!this.audio) return null
    }
    if (this.audio.state === 'suspended') this.audio.resume().catch(() => {})
    return this.audio
  }

  private note(audio: AudioLike, freq: number, at: number, length = 0.32): void {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.07, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(at)
    osc.stop(at + length + 0.02)
  }

  /** Play a tune. Returns whether anything sounded (off, too soon, or still locked: false). */
  play = (name: SoundName, { force = false }: { force?: boolean } = {}): boolean => {
    if (!force && !this.enabled()) return false
    const tune = TUNES[name]
    const now = this.now()
    if (!tune || (!force && now - this.lastAt < MIN_GAP_MS)) return false
    const audio = this.context()
    if (!audio || audio.state !== 'running') return false
    this.lastAt = now
    const start = audio.currentTime + 0.01
    for (const [freq, offset] of tune) this.note(audio, freq, start + offset)
    return true
  }
}

/** The player the app uses. */
export const sounds = new SoundPlayer()
export const playSound = sounds.play

// ── What the session list says changed ──────────────────────────────────────

const ACTIVE = new Set(['starting', 'running', 'stopping'])
const COORDINATORS = new Set(['day', 'project', 'thread'])

/** What the sound check remembers about one managed session. */
export interface SoundSeen {
  readonly status: string | undefined
  readonly kind: string
  readonly waiting: number
}

interface Row {
  readonly managed?: boolean | undefined
  readonly managedId?: string | undefined
  readonly managedStatus?: string | undefined
  readonly kind?: unknown
  readonly dayProgress?: unknown
}

export function seenOf(rows: readonly Row[]): Map<string, SoundSeen> {
  const out = new Map<string, SoundSeen>()
  for (const row of rows) {
    if (!row.managed || !row.managedId) continue
    const progress = row.dayProgress as { waiting?: number } | null | undefined
    out.set(row.managedId, { status: row.managedStatus, kind: typeof row.kind === 'string' ? row.kind : 'agent', waiting: progress?.waiting || 0 })
  }
  return out
}

/**
 * The one sound a list update deserves, if any. The first update only sets the
 * baseline (null `before`). "ask" outranks "done": several events in one update play
 * only the first, ordered by importance. Coordinators (Day, project, thread) going
 * idle are silent; "report" is not decided here, the report-back flow plays it.
 */
export function soundFor(before: ReadonlyMap<string, SoundSeen> | null, after: ReadonlyMap<string, SoundSeen>): SoundName | null {
  if (!before) return null
  let asks = false
  let finished = false
  for (const [id, cur] of after) {
    const was = before.get(id)
    if (!was) continue
    if (cur.status === 'approval' && was.status !== 'approval') asks = true
    if (cur.kind === 'day' && cur.waiting > was.waiting) asks = true
    if (!COORDINATORS.has(cur.kind) && was.status && ACTIVE.has(was.status) && cur.status === 'idle') finished = true
  }
  return asks ? 'ask' : finished ? 'done' : null
}
