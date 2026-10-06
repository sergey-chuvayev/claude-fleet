#!/usr/bin/env node
// Visual baseline of the legacy UI (work package 1). Serves the legacy public/ app
// against the fixture server and screenshots each view, the launch modal and a
// conversation at four viewports into ./screens/<viewport>/<name>.png.
//
//   LEGACY_ROOT=/tmp/fleet-legacy node frontend/e2e/baseline/capture.mjs [name ...]
//
// public/ is gone since the cutover, so the fixture server runs from LEGACY_ROOT, a
// checkout from before it (see ../legacy.mjs); without one this exits with how to make one.
//
// Needs Playwright with a Chromium. If `playwright` is not installed in the repo yet,
// point PLAYWRIGHT_DIR at a directory that has it (`npm i playwright` there):
//   PLAYWRIGHT_DIR=/some/dir node frontend/e2e/baseline/capture.mjs
//
// The data is the fixture packs (see frontend/src/test/fixtures/README.md). The browser's
// Date is fixed to the fixture clock, animations are off, and the viewport is fixed.
// Fonts are the machine's own; regenerate on the same OS before comparing two sets.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyCapture, requireLegacyRoot } from '../legacy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = legacyCapture(requireLegacyRoot())
const out = path.join(here, 'screens')
const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)

const VIEWPORTS = { '1440x900': [1440, 900], '1280x800': [1280, 800], '900x900': [900, 900], '390x844': [390, 844] }

// name: [pack, view, optional step run after load]
const SHOTS = {
  'sessions': ['fleet-mixed', 'sessions'],
  'sessions-approval': ['fleet-mixed', 'sessions', async page => { await page.click('.session[data-session="m-claude-approval"]') }],
  'launch-modal': ['fleet-mixed', 'sessions', async page => { await page.click('#new-session'); await page.waitForSelector('#launch-backdrop:not([hidden])') }],
  'conversation': ['conversation-heavy', 'sessions', async page => { await page.click('.session[data-session="c-heavy"]'); await page.waitForSelector('#conversation .block') }],
  'team-overview': ['teams-heavy', 'sessions', async page => { await page.click('.session[data-session="t-team"]'); await page.waitForSelector('#conversation .block, .team-overview, #detail-content') }],
  'today': ['day-full', 'today'],
  'projects': ['projects-collision', 'projects', null, async base => ({ 'fleet:project': (await (await fetch(`${base}/api/projects`)).json()).projects.find(p => p.name === 'Alpha launch').id })],
  'progress': ['day-full', 'progress'],
  'worktrees': ['fleet-mixed', 'worktrees'],
}

async function loadPlaywright() {
  const roots = [process.env.PLAYWRIGHT_DIR, here, process.cwd()].filter(Boolean)
  for (const root of roots) {
    try { return createRequire(path.join(root, 'noop.js'))('playwright') } catch {}
  }
  throw new Error('Playwright is not installed. Run `npm i playwright && npx playwright install chromium-headless-shell`, or set PLAYWRIGHT_DIR to a directory that has it.')
}

function serve(pack) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtures, '--serve', pack], { stdio: ['ignore', 'pipe', 'inherit'] })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const match = /FIXTURE_SERVER (\S+)/.exec(buffer)
      if (match) resolve({ base: match[1], stop: () => new Promise(done => { child.once('exit', done); child.kill('SIGTERM') }) })
    })
    child.on('exit', code => reject(new Error(`fixture server for ${pack} exited (${code})`)))
  })
}

const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`

async function main() {
  const { chromium } = await loadPlaywright()
  const wanted = process.argv.slice(2)
  const names = wanted.length ? wanted : Object.keys(SHOTS)
  for (const name of names) if (!SHOTS[name]) throw new Error(`Unknown shot ${name}. Shots: ${Object.keys(SHOTS).join(', ')}`)
  const byPack = new Map()
  for (const name of names) byPack.set(SHOTS[name][0], [...(byPack.get(SHOTS[name][0]) || []), name])

  const browser = await chromium.launch()
  const written = []
  try {
    for (const [pack, shots] of byPack) {
      const server = await serve(pack)
      try {
        for (const [label, [width, height]] of Object.entries(VIEWPORTS)) {
          for (const name of shots) {
            const [, view, step, storage] = SHOTS[name]
            const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-GB', timezoneId: 'UTC' })
            const page = await context.newPage()
            await page.clock.install({ time: T0 })
            await page.clock.setFixedTime(T0)
            const extra = storage ? await storage(server.base) : {}
            await page.addInitScript(({ view, extra }) => {
              try { localStorage.setItem('fleet:view', view); for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v) } catch {}
            }, { view, extra })
            await page.goto(server.base + '/')
            await page.addStyleTag({ content: FREEZE })
            await page.waitForSelector('#session-list .session, #today-pane:not([hidden]), #projects-pane:not([hidden]), #progress-pane:not([hidden]), #worktrees-pane:not([hidden])', { state: 'attached', timeout: 15000 })
            await page.waitForTimeout(1200)
            if (step) await step(page)
            await page.waitForTimeout(500)
            const file = path.join(out, label, `${name}.png`)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            await page.screenshot({ path: file })
            written.push(path.relative(here, file))
            await context.close()
          }
        }
      } finally { await server.stop() }
    }
  } finally { await browser.close() }
  if (!wanted.length) fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ clock: new Date(T0).toISOString(), viewports: Object.keys(VIEWPORTS), shots: Object.fromEntries(Object.entries(SHOTS).map(([k, v]) => [k, { pack: v[0], view: v[1] }])), files: written.sort() }, null, 2) + '\n')
  console.log(`${written.length} screenshots in ${path.relative(process.cwd(), out)}`)
}

main().catch(error => { console.error(error.message); process.exit(1) })
