// Plays the tones for what changed in the session list (agent finished, needs you).
// Renders nothing. Mounted once by the shell (app/background.tsx), so it runs on every
// view. The first snapshot only sets the baseline, and the audio unlocks on the first
// pointer interaction.
import { useEffect, useRef } from 'react'
import { useFleetClient, useResource } from '../../transport/hooks'
import { type SoundPlayer, type SoundSeen, seenOf, soundFor, sounds } from './sounds'

export function SoundController({ player = sounds }: { player?: SoundPlayer }) {
  const client = useFleetClient()
  const snapshot = useResource(client.resources.sessions).data
  const seen = useRef<Map<string, SoundSeen> | null>(null)

  useEffect(() => {
    const unlock = () => player.unlock()
    document.addEventListener('pointerdown', unlock, { once: true, capture: true })
    return () => document.removeEventListener('pointerdown', unlock, { capture: true })
  }, [player])

  useEffect(() => {
    if (!snapshot) return
    const now = seenOf(snapshot.sessions)
    const name = soundFor(seen.current, now)
    seen.current = now
    if (name) player.play(name)
  }, [snapshot, player])

  return null
}
