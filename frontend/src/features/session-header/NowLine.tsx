// The line under the conversation: the step that is running and for how long, or
// thinking, writing, waiting for you, in the avatars' pixel style. Its clock ticks on
// its own (the shared clock), so the conversation above never re-renders for it.
import { useNow } from '../../components/clock'
import { PixelRun } from '../../components/PixelRun'
import { type NowState, shortElapsed } from './status'

function NowTime({ since }: { since: number }) {
  const now = useNow(1000)
  return <span className="now-time">{shortElapsed(now - since)}</span>
}

export function NowLine({ now }: { now: NowState | null }) {
  if (!now) return <div id="now-line" className="now-line" role="status" hidden />
  return (
    <div id="now-line" className="now-line" role="status" data-tone={now.tone}>
      <PixelRun label={now.text} />
      <span className="now-text">{now.text}</span>
      {now.since ? <NowTime since={now.since} /> : null}
    </div>
  )
}
