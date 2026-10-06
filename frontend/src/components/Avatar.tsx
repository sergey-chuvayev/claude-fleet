// Pixel avatars, ported exactly from public/app.js (GLYPHS, seeded, pixelAvatar). A
// session's avatar is a 9x9 dot matrix in one of five tones: its initial in bright
// pixels over a field of dimmer ones that brighten from left to right. While the
// agent works the pixels twinkle and a band of light sweeps across. Each animation's
// phase is taken from the clock when the avatar starts working, not from when it was
// drawn, so a redraw never restarts it. Same seed, same pattern, on every render.
import { type CSSProperties, memo, useMemo } from 'react'

const GLYPHS: Readonly<Record<string, string>> = {
  A: '0111010001111111000110001', B: '1111010001111101000111110', C: '0111110000100001000001111', D: '1111010001100011000111110',
  E: '1111110000111101000011111', F: '1111110000111101000010000', G: '0111110000100111000101111', H: '1000110001111111000110001',
  I: '1111100100001000010011111', J: '0011100010000101001001100', K: '1001010100110001010010010', L: '1000010000100001000011111',
  M: '1000111011101011000110001', N: '1000111001101011001110001', O: '0111010001100011000101110', P: '1111010001111101000010000',
  Q: '0111010001101011001001101', R: '1111010001111101001010001', S: '0111110000011100000111110', T: '1111100100001000010000100',
  U: '1000110001100011000101110', V: '1000110001100010101000100', W: '1000110001101011101110001', X: '1000101010001000101010001',
  Y: '1000101010001000010000100', Z: '1111100010001000100011111', 0: '0111010011101011100101110', 1: '0010001100001000010001110',
  2: '1111000001011101000011111', 3: '1111000001001100000111110', 4: '1001010010111110001000010', 5: '1111110000111100000111110',
  6: '0111010000111101000101110', 7: '1111100001000100010000100', 8: '0111010001011101000101110', 9: '0111010001011110000101110',
}

export const AVATAR_TONES = ['#a8d8bf', '#b9b2ff', '#e6c891', '#9fcbe8', '#eba9b8'] as const

/** A small deterministic generator (FNV-1a seed, xorshift), as legacy. */
export function seeded(text: string): () => number {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 10000) / 10000
  }
}

/** The tone index for a legacy session key: its character codes summed, mod 5. */
export const avatarTone = (legacyKey: string): number => [...legacyKey].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5

/** The letter drawn: the first character of the title (or name), upper case; F for Fleet. */
export const avatarInitial = (title: string | null | undefined): string => (title || 'F').trim().slice(0, 1).toUpperCase()

const AVATAR_GRID = 9
const AVATAR_EDGES = Array.from({ length: AVATAR_GRID + 1 }, (_, i) => Math.round((i * 39) / AVATAR_GRID))

export interface AvatarCell {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Resting opacity, two decimals, as legacy printed it. */
  readonly opacity: string
  /** Working only: the twinkle's range and clock-derived phase. */
  readonly motion: { readonly o: string; readonly hi: string; readonly duration: string; readonly delay: string } | null
}

/** The 81 cells of an avatar. `nowSeconds` fixes the animation phases. */
export function avatarCells(seed: string, initial: string, working: boolean, nowSeconds: number): AvatarCell[] {
  const rand = seeded(seed)
  const glyph = GLYPHS[initial] || null
  const cells: AvatarCell[] = []
  for (let y = 0; y < AVATAR_GRID; y++)
    for (let x = 0; x < AVATAR_GRID; x++) {
      const gx = x - 2
      const gy = y - 2
      const inGlyph = !!glyph && gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && glyph[gy * 5 + gx] === '1'
      const r = rand()
      // Dim field, brighter towards the right; a few lit "stars"; the letter on top.
      const base = inGlyph
        ? 0.95
        : Math.min(0.45, 0.05 + r * 0.11 + (x / (AVATAR_GRID - 1)) * 0.12 + (r > 0.95 ? 0.24 : 0)) + (working && !inGlyph ? 0.08 : 0)
      let motion: AvatarCell['motion'] = null
      if (working) {
        const length = 1.4 + rand() * 1.8
        const phase = rand() * length
        const high = inGlyph ? 0.72 : rand() > 0.6 ? 0.95 : Math.min(0.55, base * 2.4 + 0.1)
        motion = {
          o: base.toFixed(2),
          hi: high.toFixed(2),
          duration: `${length.toFixed(2)}s`,
          delay: `-${((nowSeconds + phase) % length).toFixed(2)}s`,
        }
      }
      const x0 = AVATAR_EDGES[x]!
      const y0 = AVATAR_EDGES[y]!
      cells.push({ x: x0, y: y0, width: AVATAR_EDGES[x + 1]! - 1 - x0, height: AVATAR_EDGES[y + 1]! - 1 - y0, opacity: base.toFixed(2), motion })
    }
  return cells
}

export interface AvatarProps {
  /** The legacy session key (managedId, else sessionId, else session:<pid>): seed and tone. */
  readonly seed: string
  /** The title or name the initial is taken from. */
  readonly title?: string | null
  readonly working?: boolean
  /** The status dot's class: busy, idle, stale (needs approval) or dead. */
  readonly status?: string
}

export const Avatar = memo(function Avatar({ seed, title, working = false, status }: AvatarProps) {
  const tone = avatarTone(seed)
  const initial = avatarInitial(title)
  const color = AVATAR_TONES[tone]!
  // The phases come from the moment it started working and then stay put.
  const drawn = useMemo(() => {
    const now = Date.now() / 1000
    return { cells: avatarCells(seed, initial, working, now), glow: `-${(now % 2.4).toFixed(2)}s`, sweep: `-${(now % 2.8).toFixed(2)}s` }
  }, [seed, initial, working])
  const style = { '--tone': color, ...(working ? { animationDelay: drawn.glow } : {}) } as CSSProperties
  return (
    <span className={`agent-avatar avatar-${tone}${working ? ' is-working' : ''}`} style={style} aria-hidden="true">
      <svg className="avatar-pixels" viewBox="0 0 38 38" shapeRendering="crispEdges" fill={color} aria-hidden="true">
        {drawn.cells.map((cell, i) => (
          <rect
            key={i}
            x={cell.x}
            y={cell.y}
            width={cell.width}
            height={cell.height}
            rx=".6"
            opacity={cell.opacity}
            style={
              cell.motion
                ? ({
                    '--o': cell.motion.o,
                    '--hi': cell.motion.hi,
                    animationDuration: cell.motion.duration,
                    animationDelay: cell.motion.delay,
                  } as CSSProperties)
                : undefined
            }
          />
        ))}
        {working ? (
          <>
            <defs>
              <linearGradient id={`sweep-${tone}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset=".5" stopColor="#fff" stopOpacity=".5" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <rect className="avatar-sweep" x="-38" y="0" width="38" height="38" fill={`url(#sweep-${tone})`} style={{ animationDelay: drawn.sweep }} />
          </>
        ) : null}
      </svg>
      <i className={`avatar-status${status ? ` ${status}` : ''}`} />
    </span>
  )
})
