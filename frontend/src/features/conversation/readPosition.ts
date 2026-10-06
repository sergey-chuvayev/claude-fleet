// Where the operator is reading. At (or within 60px of) the bottom the log follows the
// tail as messages append and grow. Above it, the log keeps an anchor, the first
// visible block and its offset from the top, and holds that block still through
// appends, a growing reply, images loading and the 200-message window dropping its
// oldest entries. Each session's position is remembered, so switching back restores it.
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

export interface Anchor {
  readonly messageId: string
  /** Pixels from the top of the log's viewport to the top of the block. */
  readonly offset: number
}
export type ReadPosition = { readonly tail: true } | { readonly tail: false; readonly anchor: Anchor | null; readonly scrollTop: number }

/** Matches the legacy console: within this many pixels of the bottom counts as following. */
export const NEAR_BOTTOM = 60
const REMEMBERED = 50

export type PositionMemory = Map<string, ReadPosition>

const memories = new WeakMap<object, PositionMemory>()
/** One memory per owner (the FleetClient), so separate apps and tests never share positions. */
export function positionMemory(owner: object): PositionMemory {
  let memory = memories.get(owner)
  if (!memory) {
    memory = new Map()
    memories.set(owner, memory)
  }
  return memory
}

function remember(memory: PositionMemory, key: string, position: ReadPosition): void {
  memory.delete(key)
  memory.set(key, position)
  if (memory.size > REMEMBERED) memory.delete(memory.keys().next().value as string)
}

const blocks = (log: HTMLElement): HTMLElement[] => [...log.querySelectorAll<HTMLElement>('[data-block]')]

/** Read the current position from the DOM. */
export function measure(log: HTMLElement): ReadPosition {
  if (log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM) return { tail: true }
  const top = log.getBoundingClientRect().top
  for (const block of blocks(log)) {
    const box = block.getBoundingClientRect()
    if (box.bottom > top) {
      return { tail: false, anchor: { messageId: block.dataset.block ?? '', offset: box.top - top }, scrollTop: log.scrollTop }
    }
  }
  return { tail: false, anchor: null, scrollTop: log.scrollTop }
}

/** Put the log back at a position. */
export function restore(log: HTMLElement, position: ReadPosition): void {
  if (position.tail) {
    const bottom = log.scrollHeight - log.clientHeight
    if (Math.abs(log.scrollTop - bottom) >= 1) log.scrollTop = log.scrollHeight
    return
  }
  const anchor = position.anchor
  const block = anchor ? blocks(log).find(b => b.dataset.block === anchor.messageId) : undefined
  if (anchor && block) {
    const drift = block.getBoundingClientRect().top - log.getBoundingClientRect().top - anchor.offset
    if (Math.abs(drift) >= 1) log.scrollTop += drift
  } else if (Math.abs(log.scrollTop - position.scrollTop) >= 1) {
    // The anchor left the window; hold the scroll offset rather than jump.
    log.scrollTop = position.scrollTop
  }
}

/**
 * Keep `log` at the operator's reading position. `version` changes whenever the
 * rendered content may have changed (the message array); `content` is the element
 * whose size changes with it (images, disclosures).
 */
export function useReadPosition(
  log: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  key: string,
  memory: PositionMemory,
  version: unknown,
): void {
  const position = useRef<ReadPosition>(memory.get(key) ?? { tail: true })
  const frame = useRef(0)
  const record = useRef(() => {})
  record.current = () => {
    const element = log.current
    if (!element) return
    position.current = measure(element)
    remember(memory, key, position.current)
  }
  // A scroll still waiting for its frame is the latest word on where the operator is.
  const settle = () => {
    if (!frame.current) return
    cancelAnimationFrame(frame.current)
    frame.current = 0
    record.current()
  }

  // Record where the operator scrolled to, once per frame.
  useEffect(() => {
    const element = log.current
    if (!element) return
    const onScroll = () => {
      if (frame.current) return
      frame.current = -1
      const id = requestAnimationFrame(() => {
        frame.current = 0
        record.current()
      })
      // A frame that already ran (a synchronous scheduler) has cleared the marker.
      if (frame.current === -1) frame.current = id
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      if (element.isConnected) settle()
      else if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [log])

  // After every content commit, before paint: follow the tail or hold the anchor.
  // `version` is the trigger; it is not read.
  useLayoutEffect(() => {
    const element = log.current
    if (!element) return
    settle()
    restore(element, position.current)
  }, [log, version])

  // Size changes that are not commits: an image arriving, a viewport resize.
  useEffect(() => {
    const element = log.current
    if (!element || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => restore(element, position.current))
    observer.observe(element)
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [log, content])
}
