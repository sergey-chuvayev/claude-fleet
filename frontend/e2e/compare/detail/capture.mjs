// Side-by-side screenshots of the React session console (header, conversation,
// approvals, composer, team overview) against the legacy baseline
// (frontend/e2e/baseline/screens): legacy on the left, the React build (Vite dev, same
// fixture pack, clock and motion settings) on the right.
//
//   PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/compare/detail/capture.mjs
//
// The session is chosen by clicking its row when the list draws one with
// data-session; otherwise the list's own fallback (the first row) applies, which is
// the same session in each of these packs.
//
// Output: <viewport>/<shot>.png next to this file.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const fixtures = path.join(repo, 'frontend/src/test/fixtures/capture.js')
const baseline = path.join(repo, 'frontend/e2e/baseline/screens')
const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)
const VIEWPORTS = { '1440x900': [1440, 900], '390x844': [390, 844] }
const DEV_PORT = Number(process.env.FLEET_DEV_PORT || 5197)
// name: [pack, managed id of the session shown]
const SHOTS = {
  conversation: ['conversation-heavy', 'c-heavy'],
  'sessions-approval': ['fleet-mixed', 'm-claude-approval'],
  'team-overview': ['teams-heavy', 't-team'],
}
const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}'

function loadPlaywright() {
  for (const root of [process.env.PLAYWRIGHT_DIR, here, process.cwd()].filter(Boolean)) {
    try { return createRequire(path.join(root, 'noop.js'))('playwright') } catch {}
  }
  throw new Error('Playwright is not installed; set PLAYWRIGHT_DIR to a directory that has it.')
}

function start(command, args, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const match = ready.exec(buffer)
      if (match) resolve({ match, stop: () => new Promise(done => { child.once('exit', done); child.kill('SIGTERM') }) })
    })
    child.on('exit', code => reject(new Error(`${command} ${args.join(' ')} exited (${code})`)))
  })
}

async function main() {
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch()
  try {
    const byPack = new Map()
    for (const [name, [pack]] of Object.entries(SHOTS)) byPack.set(pack, [...(byPack.get(pack) ?? []), name])
    for (const [pack, names] of byPack) {
      const fixture = await start(process.execPath, [fixtures, '--serve', pack], {}, /FIXTURE_SERVER (\S+)/)
      const fleetPort = new URL(fixture.match[1]).port
      const vite = await start('npx', ['vite', '--config', 'frontend/vite.config.mts'], { FLEET_PORT: fleetPort, FLEET_DEV_PORT: String(DEV_PORT) }, /Local:/)
      try {
        for (const name of names) {
          const [, id] = SHOTS[name]
          for (const [label, [width, height]] of Object.entries(VIEWPORTS)) {
            const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-GB', timezoneId: 'UTC' })
            const page = await context.newPage()
            const errors = []
            page.on('pageerror', error => errors.push(error.message))
            await page.clock.install({ time: T0 })
            await page.clock.setFixedTime(T0)
            await page.addInitScript(() => { try { localStorage.setItem('fleet:view', 'sessions') } catch {} })
            await page.goto(`http://127.0.0.1:${DEV_PORT}/`)
            await page.addStyleTag({ content: FREEZE })
            await page.click(`[data-session="${id}"]`, { timeout: 3000 }).catch(() => {})
            await page.waitForSelector('#composer', { timeout: 20000 })
            await page.waitForTimeout(2000)
            const react = await page.screenshot()
            await context.close()
            if (errors.length) console.error(`${name} ${label}: ${errors.join('; ')}`)

            const legacy = fs.readFileSync(path.join(baseline, label, `${name}.png`))
            const sheet = await browser.newPage({ viewport: { width: width * 2 + 24, height: height + 40 } })
            const img = buf => `data:image/png;base64,${buf.toString('base64')}`
            await sheet.setContent(`<body style="margin:0;background:#000;font:12px sans-serif;color:#aaa;display:flex;gap:24px">
              <figure style="margin:0"><figcaption style="height:40px;line-height:40px">legacy 0.54.0 · ${name} · ${label}</figcaption><img src="${img(legacy)}"></figure>
              <figure style="margin:0"><figcaption style="height:40px;line-height:40px">React · ${name} · ${label}</figcaption><img src="${img(react)}"></figure></body>`)
            const file = path.join(here, label, `${name}.png`)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            await sheet.screenshot({ path: file, fullPage: true })
            await sheet.close()
            console.log(path.relative(repo, file))
          }
        }
      } finally {
        await vite.stop()
        await fixture.stop()
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
