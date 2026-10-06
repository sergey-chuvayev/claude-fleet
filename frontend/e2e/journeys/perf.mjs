#!/usr/bin/env node
// Performance gates (plan section 11, "Proposed performance gates"): the legacy page
// (public/, served by the fixture server itself, 0.54.0 semantics) against the React
// production build (dist/), on the same fixture, viewport, browser and machine.
//
//   npm run build:frontend
//   PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/perf.mjs [--out file.json] [--runs 3]
//
// Per implementation: 1 cold start (a new browser, empty cache) and N warm runs (same
// context, reloaded), median reported. Each warm run measures:
//   startup      navigation to a usable selected conversation (its streaming message
//                drawn and the composer present), in-page performance.now()
//   interaction  p95 of Event Timing durations (input to next paint) for 30 keystrokes
//                in the composer and 8 session switches, while a synthetic stream runs;
//                input loss and focus loss checked
//   long tasks   >50 ms on the main thread in 8 s of steady streaming, no input
//   requests     GETs, 304 share and bytes, streaming and settled
//   idle         8 s settled: main-thread task time per second and animation frames
//   heap         after 100 selection + modal cycles, GC'd, against the post-warm-up heap
//
// The synthetic stream: this front answers /api/events and GET /api/managed/c-heavy
// itself, growing the streaming message by 24 characters every 100 ms and announcing
// each change as the real server does (`sessions` event, ETag and packed messages
// through the server's own sync.js). Everything else goes to the fixture server.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { loadPlaywright } from './harness.mjs'
import { DIST, REPO, SECURITY_HEADERS, startFixture, startStatic } from './serve.mjs'

const sync = createRequire(import.meta.url)(path.join(REPO, 'sync.js'))
const PACK = 'conversation-heavy'
const STREAM_ID = 'c-heavy'
const OTHER_ID = 'c-error'
const VIEWPORT = { width: 1440, height: 900 }
const TICK_MS = 100
const WORDS = ' then the totals were checked against the cart, the tax rule was applied once, and the shipping estimate matched.'.split(' ')

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A stream of changes to one conversation, answered by the front, not the fixture server. */
function syntheticStream(fixtureBase, log) {
  const clients = new Set()
  let pristine = null
  let detail = null
  let timer = null
  let tick = 0
  const strip = value => JSON.parse(JSON.stringify(value, (key, v) => (key === 'h' ? undefined : v)))
  return {
    async init() {
      const answer = await fetch(`${fixtureBase}/api/managed/${STREAM_ID}`)
      pristine = strip(await answer.json())
      this.reset()
    },
    reset() {
      detail = structuredClone(pristine)
      tick = 0
    },
    intercept(req, res) {
      const pathname = (req.url || '').split('?')[0]
      if (pathname === '/api/events') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': connected\n\n')
        clients.add(res)
        res.on('close', () => clients.delete(res))
        return true
      }
      if (req.method === 'GET' && pathname === `/api/managed/${STREAM_ID}` && detail) {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
        const entry = { method: 'GET', path: pathname, status: 0, at: Date.now(), bytes: 0 }
        const end = res.end.bind(res)
        res.end = (body, ...rest) => {
          entry.status = res.statusCode
          entry.bytes = body ? Buffer.byteLength(body) : 0
          log(entry)
          return end(body, ...rest)
        }
        sync.respond(req, res, detail, { paths: ['session.messages', 'session.subagents'] })
        return true
      }
      return false
    },
    start() {
      if (timer) return
      timer = setInterval(() => {
        tick++
        const messages = detail.session.messages
        const last = messages[messages.length - 1]
        const words = WORDS.slice(0, 4).join(' ')
        WORDS.push(...WORDS.splice(0, 4))
        messages[messages.length - 1] = { ...last, text: `${last.text} ${words}` }
        detail = { ...detail, session: { ...detail.session, messages: [...messages], updatedAt: detail.session.updatedAt + 1 } }
        for (const client of clients) {
          client.write(`event: sessions\ndata: ${JSON.stringify([STREAM_ID])}\n\n`)
          if (tick % 10 === 0) client.write('event: list\ndata: {}\n\n')
        }
      }, TICK_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    close() {
      this.stop()
      for (const client of clients) client.end()
    },
    get ticks() {
      return tick
    },
  }
}

// Installed before any page script: long tasks, Event Timing, animation frames and the
// moment the selected conversation is usable.
const PROBE = () => {
  const perf = { long: [], events: [], frames: 0, ready: null }
  window.__perf = perf
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) perf.long.push({ start: e.startTime, duration: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch {}
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) if (e.interactionId) perf.events.push({ name: e.name, id: e.interactionId, duration: e.duration, start: e.startTime })
    }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  } catch {}
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => {
    perf.frames++
    return raf(cb)
  }
  const usable = () =>
    !!document.querySelector('#message-input') &&
    [...document.querySelectorAll('#conversation, .conversation')].some(el => (el.textContent || '').includes('Summary so far'))
  const watch = new MutationObserver(() => {
    if (perf.ready === null && usable()) {
      perf.ready = performance.now()
      watch.disconnect()
    }
  })
  document.addEventListener('DOMContentLoaded', () => watch.observe(document.body, { childList: true, subtree: true, characterData: true }))
}

async function newContext(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-GB', timezoneId: 'UTC' })
  await context.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('perf:seeded')) {
        sessionStorage.setItem('perf:seeded', '1')
        localStorage.setItem('fleet:view', 'sessions')
      }
    } catch {}
  })
  await context.addInitScript(PROBE)
  return context
}

async function startup(page, url) {
  if (url) await page.goto(url)
  else await page.reload()
  await page.waitForFunction(() => window.__perf?.ready !== null, null, { timeout: 30000 })
  return page.evaluate(() => window.__perf.ready)
}

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(m => [m.name, m.value]))
}

async function warmRun(page, front, stream, log) {
  const out = {}
  stream.stop()
  stream.reset()
  out.startupMs = await startup(page)
  await sleep(1500)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')

  // Settled: no stream. Requests, CPU and frames over 8 s.
  let mark = log.length
  let m0 = await cdpMetrics(cdp)
  let f0 = await page.evaluate(() => window.__perf.frames)
  await sleep(8000)
  let m1 = await cdpMetrics(cdp)
  let f1 = await page.evaluate(() => window.__perf.frames)
  const settled = log.slice(mark).filter(e => e.method === 'GET' && e.path.startsWith('/api/'))
  out.idle = {
    taskMsPerSec: round(((m1.TaskDuration - m0.TaskDuration) * 1000) / 8),
    scriptMsPerSec: round(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / 8),
    framesPerSec: round((f1 - f0) / 8),
    gets: settled.length,
    notModified: settled.filter(e => e.status === 304).length,
    bytes: settled.reduce((a, e) => a + e.bytes, 0),
    byPath: Object.entries(settled.reduce((a, e) => ({ ...a, [e.path]: (a[e.path] || 0) + 1 }), {})).map(([k, v]) => `${k} x${v}`),
  }

  // Steady streaming, no input: long tasks and requests over 8 s.
  stream.start()
  await sleep(1500)
  mark = log.length
  const longBefore = await page.evaluate(() => window.__perf.long.length)
  const ticks0 = stream.ticks
  m0 = await cdpMetrics(cdp)
  f0 = await page.evaluate(() => window.__perf.frames)
  await sleep(8000)
  m1 = await cdpMetrics(cdp)
  f1 = await page.evaluate(() => window.__perf.frames)
  const long = (await page.evaluate(() => window.__perf.long)).slice(longBefore)
  const streaming = log.slice(mark).filter(e => e.method === 'GET' && e.path.startsWith('/api/'))
  const detailGets = streaming.filter(e => e.path === `/api/managed/${STREAM_ID}`)
  out.streaming = {
    events: stream.ticks - ticks0,
    longTasks: long.length,
    longTaskMaxMs: round(Math.max(0, ...long.map(l => l.duration))),
    longTaskTotalMs: round(long.reduce((a, l) => a + l.duration, 0)),
    taskMsPerSec: round(((m1.TaskDuration - m0.TaskDuration) * 1000) / 8),
    framesPerSec: round((f1 - f0) / 8),
    detailGets: detailGets.length,
    detailBytesPerGet: detailGets.length ? Math.round(detailGets.reduce((a, e) => a + e.bytes, 0) / detailGets.length) : 0,
    detail304: detailGets.filter(e => e.status === 304).length,
    gets: streaming.length,
    byPath: Object.entries(streaming.reduce((a, e) => ({ ...a, [e.path]: (a[e.path] || 0) + 1 }), {})).map(([k, v]) => `${k} x${v}`),
  }

  // Interactions while streaming: keystrokes in the composer, then session switches.
  const eventsBefore = await page.evaluate(() => window.__perf.events.length)
  const box = page.locator('#message-input')
  await box.click()
  const text = 'the quick brown fox jumps over'
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(60)
  }
  const typed = await box.inputValue()
  const focusKept = await page.evaluate(() => document.activeElement?.id === 'message-input')
  let switches = 0
  for (let i = 0; i < 8; i++) {
    await page.locator(`#session-list .session[data-session="${i % 2 ? STREAM_ID : OTHER_ID}"], .session[data-session="${i % 2 ? STREAM_ID : OTHER_ID}"]`).first().click()
    switches++
    await sleep(350)
  }
  await sleep(300)
  const events = (await page.evaluate(() => window.__perf.events)).slice(eventsBefore)
  const byInteraction = new Map()
  const kindOf = new Map()
  for (const e of events) {
    byInteraction.set(e.id, Math.max(byInteraction.get(e.id) || 0, e.duration))
    if (!kindOf.has(e.id) || e.name.startsWith('key')) kindOf.set(e.id, e.name.startsWith('key') ? 'key' : 'click')
  }
  const ofKind = (kind, expectedCount) => {
    const list = [...byInteraction].filter(([id]) => kindOf.get(id) === kind).map(([, d]) => d)
    while (list.length < expectedCount) list.push(16)
    return { p95Ms: percentile(list, 95), maxMs: Math.max(...list) }
  }
  const expected = text.length + switches
  // Event Timing reports only interactions of 16 ms or more; the rest count as 16.
  const durations = [...byInteraction.values()]
  while (durations.length < expected) durations.push(16)
  out.interaction = {
    interactions: expected,
    reported: byInteraction.size,
    p95Ms: percentile(durations, 95),
    maxMs: Math.max(...durations),
    keys: ofKind('key', text.length),
    switches: ofKind('click', switches),
    inputLost: typed.endsWith(text) ? 0 : text.length - typed.length,
    focusKept,
  }
  stream.stop()
  await box.fill('')

  // Heap after 100 selection and modal cycles.
  await sleep(500)
  const cycle = async () => {
    await page.locator(`.session[data-session="${OTHER_ID}"]`).first().click()
    await page.locator(`.session[data-session="${STREAM_ID}"]`).first().click()
    await page.locator('#new-session').click()
    // Locators, not waitForSelector: an ElementHandle would keep each closed dialog alive.
    // Legacy keeps its dialogs in the page, hidden; the role query sees only the open one.
    const dialog = page.getByRole('dialog', { name: 'What are we working on?' })
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  }
  for (let i = 0; i < 10; i++) await cycle()
  await cdp.send('HeapProfiler.enable')
  const gc = async () => {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage')
    await sleep(300)
    return cdpMetrics(cdp)
  }
  const h0 = await gc()
  for (let i = 0; i < 100; i++) await cycle()
  const h1 = await gc()
  out.heap = {
    baseMB: round(h0.JSHeapUsedSize / 1048576, 2),
    afterMB: round(h1.JSHeapUsedSize / 1048576, 2),
    growthPct: round(((h1.JSHeapUsedSize - h0.JSHeapUsedSize) / h0.JSHeapUsedSize) * 100),
    nodes: [h0.Nodes, h1.Nodes],
    listeners: [h0.JSEventListeners, h1.JSEventListeners],
  }
  await cdp.detach()
  return out
}

function bundle() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, '.vite', 'manifest.json'), 'utf8'))
  const entry = Object.values(manifest).find(c => c.isEntry)
  const seen = new Set()
  const walk = key => {
    if (seen.has(key)) return
    seen.add(key)
    for (const i of manifest[key]?.imports ?? []) walk(i)
  }
  walk(Object.keys(manifest).find(k => manifest[k] === entry))
  const files = [...seen].map(k => manifest[k].file)
  const css = [...seen].flatMap(k => manifest[k].css ?? [])
  const size = list => {
    let raw = 0
    let gzip = 0
    for (const file of list) {
      const data = fs.readFileSync(path.join(DIST, file))
      raw += data.length
      gzip += zlib.gzipSync(data, { level: 9 }).length
    }
    return { raw, gzip }
  }
  const all = fs.readdirSync(path.join(DIST, 'assets')).filter(f => f.endsWith('.js'))
  const lazy = size(all.map(f => `assets/${f}`).filter(f => !files.includes(f)))
  const legacyHtml = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8')
  const legacyScripts = [...legacyHtml.matchAll(/<script src="\/([^"]+)"/g)].map(m => path.join('..', 'public', m[1]))
  const legacyJs = (() => {
    let raw = 0
    let gzip = 0
    for (const file of legacyScripts) {
      const data = fs.readFileSync(path.join(DIST, file))
      raw += data.length
      gzip += zlib.gzipSync(data, { level: 9 }).length
    }
    return { raw, gzip, files: legacyScripts.length }
  })()
  return { initialJs: { files, ...size(files) }, initialCss: size(css), lazyJs: lazy, legacyJs }
}

function machine(browserVersion) {
  const git = (...a) => {
    try {
      return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  let manifestHash = null
  try {
    manifestHash = createHash('sha256').update(fs.readFileSync(path.join(DIST, '.vite', 'manifest.json'))).digest('hex').slice(0, 12)
  } catch {}
  let osVersion = `${os.type()} ${os.release()}`
  try {
    osVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
  } catch {}
  return {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    os: osVersion,
    node: process.version,
    chromium: browserVersion,
    commit: git('rev-parse', '--short', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    buildId: manifestHash ? `${JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version}+${manifestHash}` : null,
    at: new Date().toISOString(),
  }
}

async function measure(chromium, impl, runs) {
  const log = []
  const fixture = await startFixture(PACK)
  const stream = syntheticStream(fixture.base, entry => log.push(entry))
  await stream.init()
  const front = await startStatic({ fleetBase: fixture.base, legacy: impl === 'legacy', intercept: (req, res) => stream.intercept(req, res), log: entry => log.push(entry) })
  try {
    // Cold: a new browser, nothing cached.
    const coldBrowser = await chromium.launch()
    const coldContext = await newContext(coldBrowser)
    const coldPage = await coldContext.newPage()
    const coldMark = log.length
    const cold = await startup(coldPage, `${front.base}/`)
    const coldRequests = log.slice(coldMark).filter(e => e.method === 'GET').length
    await coldBrowser.close()

    const browser = await chromium.launch()
    const context = await newContext(browser)
    const page = await context.newPage()
    await startup(page, `${front.base}/`)
    const results = []
    for (let i = 0; i < runs; i++) {
      process.stderr.write(`  ${impl} warm run ${i + 1}/${runs}\n`)
      results.push(await warmRun(page, front, stream, log))
    }
    // Idle again with reduced motion: what is left once the CSS animations stop.
    const calm = []
    for (let i = 0; i < runs; i++) {
      const quiet = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' })
      await quiet.addInitScript(PROBE)
      const still = await quiet.newPage()
      await startup(still, `${front.base}/`)
      await sleep(1500)
      const cdp = await quiet.newCDPSession(still)
      await cdp.send('Performance.enable')
      const a = await cdpMetrics(cdp)
      const fa = await still.evaluate(() => window.__perf.frames)
      await sleep(6000)
      const b = await cdpMetrics(cdp)
      const fb = await still.evaluate(() => window.__perf.frames)
      calm.push({ taskMsPerSec: round(((b.TaskDuration - a.TaskDuration) * 1000) / 6), scriptMsPerSec: round(((b.ScriptDuration - a.ScriptDuration) * 1000) / 6), framesPerSec: round((fb - fa) / 6) })
      await quiet.close()
    }
    const version = browser.version()
    await browser.close()
    return { cold: { startupMs: round(cold), requests: coldRequests }, runs: results, calm, version }
  } finally {
    stream.close()
    await front.stop()
    await fixture.stop()
  }
}

function summarize(data) {
  const pick = (runs, f) => round(median(runs.map(f)))
  return {
    coldStartupMs: data.cold.startupMs,
    warmStartupMs: pick(data.runs, r => r.startupMs),
    interactionP95Ms: pick(data.runs, r => r.interaction.p95Ms),
    interactionMaxMs: pick(data.runs, r => r.interaction.maxMs),
    keystrokeP95Ms: pick(data.runs, r => r.interaction.keys.p95Ms),
    sessionSwitchP95Ms: pick(data.runs, r => r.interaction.switches.p95Ms),
    inputLost: Math.max(...data.runs.map(r => r.interaction.inputLost)),
    focusKept: data.runs.every(r => r.interaction.focusKept),
    longTasksStreaming: pick(data.runs, r => r.streaming.longTasks),
    longTaskMaxMs: pick(data.runs, r => r.streaming.longTaskMaxMs),
    streamingTaskMsPerSec: pick(data.runs, r => r.streaming.taskMsPerSec),
    streamingEvents: pick(data.runs, r => r.streaming.events),
    streamingDetailGets: pick(data.runs, r => r.streaming.detailGets),
    streamingDetailBytesPerGet: pick(data.runs, r => r.streaming.detailBytesPerGet),
    idleGets: pick(data.runs, r => r.idle.gets),
    idle304: pick(data.runs, r => r.idle.notModified),
    idleTaskMsPerSec: pick(data.runs, r => r.idle.taskMsPerSec),
    idleFramesPerSec: pick(data.runs, r => r.idle.framesPerSec),
    idleScriptMsPerSec: pick(data.runs, r => r.idle.scriptMsPerSec),
    idleReducedMotionTaskMsPerSec: round(median(data.calm.map(c => c.taskMsPerSec))),
    idleReducedMotionScriptMsPerSec: round(median(data.calm.map(c => c.scriptMsPerSec))),
    heapBaseMB: pick(data.runs, r => r.heap.baseMB),
    heapGrowthPct: pick(data.runs, r => r.heap.growthPct),
    listenersAfter: pick(data.runs, r => r.heap.listeners[1] - r.heap.listeners[0]),
    nodesAfter: pick(data.runs, r => r.heap.nodes[1] - r.heap.nodes[0]),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const runs = Number(args[args.indexOf('--runs') + 1]) || 3
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
  const only = args.filter(a => a === 'legacy' || a === 'react')
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Run `npm run build:frontend` first.')
  const { chromium } = loadPlaywright()
  const report = { machine: null, bundle: bundle(), legacy: null, react: null }
  for (const impl of only.length ? only : ['legacy', 'react']) {
    process.stderr.write(`${impl}:\n`)
    const data = await measure(chromium, impl, runs)
    report.machine ??= machine(data.version)
    report[impl] = { summary: summarize(data), ...data }
  }
  const json = JSON.stringify(report, null, 2)
  if (out) fs.writeFileSync(out, `${json}\n`)
  console.log(JSON.stringify({ machine: report.machine, bundle: report.bundle, legacy: report.legacy?.summary, react: report.react?.summary }, null, 2))
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error)
    process.exit(1)
  })
}
