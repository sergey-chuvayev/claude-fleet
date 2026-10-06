// The question above its answer (public/blocks.js pinQuestions). As the conversation
// scrolls, the last message the operator sent that is now above the fold stays pinned
// at the top, compact, until the next one takes its place; clicking it scrolls back to
// where it was asked. One pin per conversation, laid over its top edge; the messages
// themselves never move.
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '../../transport/contracts'

interface Shown {
  readonly id: string
  readonly words: string
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function QuestionPin({ log, messages }: { log: RefObject<HTMLElement | null>; messages: readonly Message[] }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const [entered, setEntered] = useState(false)
  const current = useRef<string | null>(null)
  const latest = useRef(messages)
  latest.current = messages

  const update = useCallback(() => {
    const element = log.current
    if (!element) return
    const top = element.getBoundingClientRect().top
    let above: HTMLElement | null = null
    for (const block of element.querySelectorAll<HTMLElement>('.block[data-role="user"]')) {
      if (block.getBoundingClientRect().bottom < top + 4) above = block
      else break
    }
    const id = above?.dataset.block ?? null
    if (id === current.current) return
    current.current = id
    if (!id) {
      setShown(null)
      setEntered(false)
      return
    }
    const words = (latest.current.find(m => m.id === id)?.text ?? '').replace(/\s+/g, ' ').trim()
    setShown({ id, words: words || 'Your message' })
    // Replay the entrance for each new question, not only the first.
    setEntered(false)
  }, [log])

  // The entrance: one frame without the class, then with it.
  useEffect(() => {
    if (!shown || entered) return
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [shown, entered])

  useEffect(() => {
    const element = log.current
    if (!element) return
    let frame = 0
    let pending = false
    const schedule = () => {
      if (pending) return
      pending = true
      frame = requestAnimationFrame(() => {
        pending = false
        update()
      })
    }
    element.addEventListener('scroll', schedule, { passive: true })
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    resize?.observe(element)
    return () => {
      element.removeEventListener('scroll', schedule)
      resize?.disconnect()
      if (pending) cancelAnimationFrame(frame)
    }
  }, [log, update])

  // New or changed messages can move what is above the fold.
  useEffect(() => {
    update()
  }, [messages, update])

  const back = () => {
    const element = log.current
    const id = current.current
    if (!element || !id) return
    const block = [...element.querySelectorAll<HTMLElement>('[data-block]')].find(b => b.dataset.block === id)
    if (!block) return
    const top = element.scrollTop + block.getBoundingClientRect().top - element.getBoundingClientRect().top - 8
    if (typeof element.scrollTo === 'function') element.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' })
    else element.scrollTop = top
  }

  const summary = shown?.words.slice(0, 200) ?? ''
  return (
    <div className={shown && entered ? 'question-pin is-shown' : 'question-pin'}>
      <button
        type="button"
        className="question-pin-bubble"
        tabIndex={-1}
        title={shown ? `Back to: ${summary}` : undefined}
        aria-label={shown ? `Back to your message: ${summary}` : undefined}
        aria-hidden={shown ? undefined : true}
        onClick={back}
      >
        <span className="question-pin-label">YOU</span>
        <span className="question-pin-text">{shown?.words ?? ''}</span>
      </button>
    </div>
  )
}
