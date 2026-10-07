// Side-by-side screenshots of the React New agent dialog against the legacy one, for a
// person to compare by eye. Both are drawn live on this machine (same fonts), from the
// fleet-mixed fixture pack: the legacy page from a pre-cutover checkout's fixture server
// (LEGACY_ROOT, see ../../legacy.mjs; public/ is gone since the cutover), the React build
// through Vite proxied to this checkout's. Same clock, motion and locale as the baseline.
//
//   LEGACY_ROOT=/tmp/fleet-legacy PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/compare/launch/capture.mjs
//
// Output: <viewport>/<shot>.png next to this file (legacy left, React right).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyCapture, requireLegacyRoot } from '../../legacy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')
const fixtures = path.join(repo, 'frontend/src/test/fixtures/capture.js')
const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)
const VIEWPORTS = { '1440x900': [1440, 900], '390x844': [390, 844] }
const DEV_PORT = Number(process.env.FLEET_DEV_PORT || 5213)

const open = async page => {
  await page.click('#new-session')
  await page.waitForSelector('#launch-backdrop:not([hidden]) #launch-prompt')
}
const SHOTS = {
  'launch-modal': open,
  'launch-team': async page => {
    await open(page)
    await page.selectOption('#launch-team', 'quick')
    await page.fill('#launch-prompt', 'Make the upload retry on a dropped connection.')
  },
  'launch-codex': async page => {
    await open(page)
    await page.selectOption('#launch-engine', 'codex')
  },
  'team-editor': async page => {
    await open(page)
    await page.click('#customize-team')
    await page.waitForSelector('#team-editor:not([hidden]) input')
  },
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

async function shoot(browser, url, [width, height], step) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-GB', timezoneId: 'UTC' })
  const page = await context.newPage()
  await page.clock.install({ time: T0 })
  await page.clock.setFixedTime(T0)
  await page.addInitScript(() => { try { localStorage.setItem('fleet:view', 'sessions') } catch {} })
  await page.goto(url)
  await page.addStyleTag({ content: FREEZE })
  await page.waitForSelector('#app-version:not(:empty)', { state: 'attached', timeout: 20000 })
  await page.waitForTimeout(1500)
  await step(page)
  await page.waitForTimeout(700)
  const shot = await page.screenshot()
  await context.close()
  return shot
}

async function main() {
  const legacyFixtures = legacyCapture(requireLegacyRoot())
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch()
  // The legacy page comes from a pre-cutover checkout's fixture server (../../legacy.mjs).
  // Both fixture servers use one fixed directory per pack, so they run one after the other.
  const legacyShots = new Map()
  const old = await start(process.execPath, [legacyFixtures, '--serve', 'fleet-mixed'], {}, /FIXTURE_SERVER (\S+)/)
  try {
    for (const [label, size] of Object.entries(VIEWPORTS)) {
      for (const [name, step] of Object.entries(SHOTS)) legacyShots.set(`${label}/${name}`, await shoot(browser, old.match[1], size, step))
    }
  } finally {
    await old.stop()
  }
  const fixture = await start(process.execPath, [fixtures, '--serve', 'fleet-mixed'], {}, /FIXTURE_SERVER (\S+)/)
  const fleetPort = new URL(fixture.match[1]).port
  const vite = await start('npx', ['vite', '--config', 'frontend/vite.config.mts'], { FLEET_PORT: fleetPort, FLEET_DEV_PORT: String(DEV_PORT) }, /Local:/)
  try {
    for (const [label, size] of Object.entries(VIEWPORTS)) {
      for (const [name, step] of Object.entries(SHOTS)) {
        const legacy = legacyShots.get(`${label}/${name}`)
        const react = await shoot(browser, `http://127.0.0.1:${DEV_PORT}/`, size, step)
        const [width, height] = size
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
    await browser.close()
    await vite.stop()
    await fixture.stop()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
