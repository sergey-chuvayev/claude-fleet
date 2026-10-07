// Shared support for the journeys, the accessibility checks and the performance runs:
// loading Playwright (and axe-core) from outside the repo, one browser page per test
// against a fixture stack, and a few assertions Playwright's library build lacks.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStack } from './serve.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The fixture clock (capture.js T0): the browser's Date starts here so "today" is the fixture's day. */
export const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)

function requireFrom(name) {
  const roots = [process.env.PLAYWRIGHT_DIR, here, process.cwd()].filter(Boolean)
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'noop.js'))(name)
    } catch {}
  }
  return null
}

export function loadPlaywright() {
  const playwright = requireFrom('playwright')
  if (!playwright) {
    throw new Error(
      'Playwright is not installed. Set PLAYWRIGHT_DIR to a directory that has it (`npm i playwright && npx playwright install chromium-headless-shell` there).',
    )
  }
  return playwright
}

/** axe-core's browser bundle, from AXE_DIR or PLAYWRIGHT_DIR's node_modules. Null when absent. */
export function loadAxeSource() {
  const roots = [process.env.AXE_DIR, process.env.PLAYWRIGHT_DIR, here, process.cwd()].filter(Boolean)
  for (const root of roots) {
    try {
      const file = createRequire(path.join(root, 'noop.js')).resolve('axe-core/axe.min.js')
      return fs.readFileSync(file, 'utf8')
    } catch {}
  }
  return null
}

/**
 * A page on a fresh context against `stack`, with the fixture clock (flowing, not frozen:
 * timers and polling run), en-GB/UTC, and every page error and failed API answer
 * recorded on `page.problems`.
 */
export async function openPage(browser, stack, { view = 'sessions', storage = {}, viewport = { width: 1440, height: 900 }, contextOptions = {} } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'UTC',
    ...contextOptions,
  })
  const page = await context.newPage()
  page.problems = []
  page.on('pageerror', error => page.problems.push(`page error: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) page.problems.push(`console: ${message.text()}`)
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api/') && response.status() >= 500) page.problems.push(`${response.status()} ${url.pathname}`)
  })
  await page.clock.install({ time: T0 })
  await page.addInitScript(
    ({ view, storage }) => {
      try {
        if (sessionStorage.getItem('e2e:seeded')) return
        sessionStorage.setItem('e2e:seeded', '1')
        localStorage.setItem('fleet:view', view)
        for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value)
      } catch {}
    },
    { view, storage },
  )
  await page.goto(`${stack.base}/`)
  return page
}

/** Wait for `predicate` (sync or async) to hold, polling. Throws with `message` on timeout. */
export async function eventually(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`Timed out: ${message}${last instanceof Error ? ` (${last.message})` : ''}`)
}

/** Record every POST the page sends (path and parsed body), for "exactly one request" checks. */
export function recordPosts(page) {
  const posts = []
  page.on('request', request => {
    if (request.method() !== 'POST') return
    let body = null
    try {
      body = request.postDataJSON()
    } catch {}
    posts.push({ path: new URL(request.url()).pathname, body })
  })
  return posts
}

export { assert }

/** One stack per pack, shared by consecutive tests of the same pack. */
export class Stacks {
  current = null
  pack = null
  async get(pack) {
    if (this.pack === pack && this.current) return this.current
    await this.stop()
    this.current = await startStack(pack)
    this.pack = pack
    return this.current
  }
  /** A fresh server for tests that change state other tests read. */
  async fresh(pack) {
    await this.stop()
    return this.get(pack)
  }
  async stop() {
    if (this.current) await this.current.stop()
    this.current = null
    this.pack = null
  }
}
