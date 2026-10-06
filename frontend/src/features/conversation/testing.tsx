// Test support for the conversation: a fake Fleet answering from the fixture packs
// with the server's real sync protocol, a mount helper, and a small layout engine,
// because jsdom has no layout and the read position is all about pixels.
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import controlFixture from '../../test/fixtures/control.json'
import { jsonResponse, strip, syncRoute } from '../../test/fakes'
import { FleetClient } from '../../transport/client'
import type { FetchLike } from '../../transport/conditional'
import type { Message } from '../../transport/contracts'
import { FleetClientProvider } from '../../transport/hooks'
import { RenderProbe } from './probe'

interface FixtureFile {
  readonly response: { readonly body: unknown }
}
/** A fixture's body without the protocol's `h` markers: what the server holds. */
export const bodyOf = <T,>(file: FixtureFile): T => strip(file.response.body) as T

export interface DetailBody {
  session: { id: string; status: string; engine?: string; messages: Message[]; [key: string]: unknown }
}

/** A fake Fleet server for conversations: managed details, histories and the list. */
export function fakeFleet() {
  const managed = new Map<string, ReturnType<typeof syncRoute>>()
  const histories = new Map<string, ReturnType<typeof syncRoute>>()
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set({ sessions: [], counts: { busy: 0, idle: 0, stale: 0, dead: 0 }, total: 0 })
  const requests: string[] = []
  const fetch: FetchLike = async (url, init) => {
    requests.push(url)
    if (url === '/api/control') return jsonResponse(controlFixture)
    if (url === '/api/sessions') return sessions.fetch(url, init)
    const detail = /^\/api\/managed\/([\w-]+)$/.exec(url)
    if (detail?.[1]) {
      const route = managed.get(detail[1])
      return route ? route.fetch(url, init) : jsonResponse({ error: 'Session not found.', code: 'NOT_FOUND' }, 404)
    }
    const history = /^\/api\/sessions\/history\?sessionId=([\w-]+)$/.exec(url)
    if (history?.[1]) {
      const route = histories.get(history[1])
      return route ? route.fetch(url, init) : jsonResponse({ error: 'No transcript for that session.', code: 'NOT_FOUND' }, 404)
    }
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }
  return {
    fetch,
    requests,
    sessions,
    /** Set (or replace) what /api/managed/:id answers. */
    managed(id: string, value: unknown) {
      let route = managed.get(id)
      if (!route) {
        route = syncRoute(['session.messages', 'session.subagents'])
        managed.set(id, route)
      }
      route.set(value)
      return route
    },
    history(id: string, value: unknown) {
      let route = histories.get(id)
      if (!route) {
        route = syncRoute(['messages'])
        histories.set(id, route)
      }
      route.set(value)
      return route
    },
  }
}

/** Mount a conversation against a fake Fleet. The client is not started: no stream, no timers. */
export function mountWith(fleet: ReturnType<typeof fakeFleet>, ui: ReactElement, probe?: (id: string) => void) {
  const client = new FleetClient({ fetch: fleet.fetch, eventSource: null, visibility: null })
  const wrap = (node: ReactElement) => (
    <FleetClientProvider client={client}>
      <RenderProbe.Provider value={probe ?? null}>{node}</RenderProbe.Provider>
    </FleetClientProvider>
  )
  const view = render(wrap(ui))
  return { client, ...view, rerender: (node: ReactElement) => view.rerender(wrap(node)) }
}

/** Counts renders per message id. */
export function renderCounter() {
  const counts = new Map<string, number>()
  return {
    probe: (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1),
    counts,
    reset: () => counts.clear(),
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
  }
}

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

/**
 * A layout engine for conversation logs, installed on the prototypes so a log that
 * React mounts later (a session switch) is laid out too. Every block is
 * `heights.get(id) ?? 100` pixels tall, stacked in DOM order; a log's viewport is
 * `viewport` pixels at the top of the window; scrollTop is clamped like a browser's.
 * Only `userScroll` fires a scroll event, as a person would. Call `uninstall` after.
 */
export function installLayout({ viewport = 300 }: { viewport?: number } = {}) {
  const heights = new Map<string, number>()
  const tops = new WeakMap<Element, number>()
  const isLog = (el: Element) => el.classList.contains('conversation')
  const blocksOf = (log: Element) => [...log.querySelectorAll<HTMLElement>('[data-block]')]
  const heightOf = (block: HTMLElement) => heights.get(block.dataset.block ?? '') ?? 100
  const total = (log: Element) => blocksOf(log).reduce((sum, block) => sum + heightOf(block), 0)
  const max = (log: Element) => Math.max(0, total(log) - viewport)
  const offsetOf = (log: Element, target: HTMLElement) => {
    let y = 0
    for (const block of blocksOf(log)) {
      if (block === target) return y
      y += heightOf(block)
    }
    return y
  }
  const saved = (['scrollTop', 'scrollHeight', 'clientHeight'] as const).map(name => {
    let owner: object | null = Element.prototype
    while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner)
    return { name, owner: owner ?? Element.prototype, descriptor: owner ? Object.getOwnPropertyDescriptor(owner, name) : undefined }
  })
  const original = (name: string) => saved.find(s => s.name === name)?.descriptor
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? (tops.get(this) ?? 0) : (original('scrollTop')?.get?.call(this) ?? 0)
    },
    set(this: Element, value: number) {
      if (isLog(this)) tops.set(this, Math.min(max(this), Math.max(0, value)))
      else original('scrollTop')?.set?.call(this, value)
    },
  })
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? Math.max(viewport, total(this)) : (original('scrollHeight')?.get?.call(this) ?? 0)
    },
  })
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return isLog(this) ? viewport : (original('clientHeight')?.get?.call(this) ?? 0)
    },
  })
  const realRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isLog(this)) return rect(0, viewport)
    const log = this instanceof HTMLElement && this.dataset.block ? this.closest('.conversation') : null
    if (log && this instanceof HTMLElement) return rect(offsetOf(log, this) - (tops.get(log) ?? 0), heightOf(this))
    return realRect.call(this)
  }
  const current = () => {
    const log = document.querySelector('.conversation')
    if (!log) throw new Error('no conversation log')
    return log as HTMLElement
  }
  return {
    uninstall() {
      for (const { name, owner, descriptor } of saved) {
        if (descriptor) Object.defineProperty(owner, name, descriptor)
        if (owner !== Element.prototype) Reflect.deleteProperty(Element.prototype, name)
      }
      Element.prototype.getBoundingClientRect = realRect
    },
    get scrollTop() {
      return tops.get(current()) ?? 0
    },
    bottom: () => max(current()),
    setHeight: (id: string, px: number) => heights.set(id, px),
    /** Where a block's top is, relative to the top of the log's viewport. */
    topOf: (id: string) => {
      const log = current()
      const block = blocksOf(log).find(b => b.dataset.block === id)
      if (!block) throw new Error(`no block ${id}`)
      return offsetOf(log, block) - (tops.get(log) ?? 0)
    },
    /** The first block at least partly in view. */
    firstVisible: () => {
      const log = current()
      const top = tops.get(log) ?? 0
      return blocksOf(log).find(b => offsetOf(log, b) + heightOf(b) - top > 0)?.dataset.block ?? null
    },
    userScroll(to: number) {
      const log = current()
      log.scrollTop = to
      log.dispatchEvent(new Event('scroll'))
    },
  }
}
export type Layout = ReturnType<typeof installLayout>

/** Let a requestAnimationFrame callback run. */
export const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
