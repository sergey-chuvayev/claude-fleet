#!/usr/bin/env node
// Runs the production-build journeys and accessibility checks in Chromium. No npm
// script and no test framework: one Node process, Playwright's library build, and
// a fresh fixture server per test.
//
//   npm run build:frontend
//   PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/run.mjs [suite|test ...]
//
// Suites: `journeys` (default together with `a11y`), `a11y`. Any other argument is a
// substring of a test name. `--headed` shows the browser. Exit code 1 when a test fails.
// See README.md in this directory.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { A11Y } from './a11y.mjs'
import { Stacks, loadPlaywright, openPage } from './harness.mjs'
import { JOURNEYS } from './journeys.mjs'

const SUITES = { journeys: JOURNEYS, a11y: A11Y }

async function main() {
  const args = process.argv.slice(2)
  const headed = args.includes('--headed')
  const words = args.filter(a => !a.startsWith('--'))
  const suites = words.filter(w => SUITES[w])
  const filters = words.filter(w => !SUITES[w])
  const chosen = (suites.length ? suites : Object.keys(SUITES)).flatMap(suite =>
    SUITES[suite].map(test => ({ ...test, suite })),
  )
  const tests = filters.length ? chosen.filter(t => filters.some(f => t.name.includes(f))) : chosen
  if (!tests.length) throw new Error(`No test matches ${words.join(' ')}.`)

  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({ headless: !headed })
  const stacks = new Stacks()
  const results = []
  const started = Date.now()
  try {
    for (const test of tests) {
      const t0 = Date.now()
      const label = `${test.suite} › ${test.name}`
      let page = null
      try {
        // Every test gets its own server: journeys write state the next one would read.
        const stack = await stacks.fresh(test.pack)
        page = await openPage(browser, stack, test.open ?? {})
        const notes = (await test.run({ page, stack, browser })) || []
        // A test passes only without uncaught page errors or 5xx answers along the way.
        if (page.problems.length) throw new Error(`unexpected problems:\n    ${page.problems.join('\n    ')}`)
        results.push({ label, ok: true, ms: Date.now() - t0, notes })
        console.log(`  ok    ${label} (${Date.now() - t0} ms)`)
        for (const note of notes) console.log(`        ${note}`)
      } catch (error) {
        results.push({ label, ok: false, ms: Date.now() - t0, error })
        console.log(`  FAIL  ${label} (${Date.now() - t0} ms)\n        ${String(error?.stack || error).split('\n').join('\n        ')}`)
        if (page && process.env.E2E_SCREENSHOTS) {
          const file = path.join(process.env.E2E_SCREENSHOTS, `${test.name.replace(/\W+/g, '-')}.png`)
          await page.screenshot({ path: file, fullPage: false }).catch(() => {})
          console.log(`        screenshot: ${file}`)
        }
      } finally {
        await page?.context().close().catch(() => {})
      }
    }
  } finally {
    await stacks.stop()
    await browser.close()
  }
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`)
  process.exit(failed.length ? 1 : 0)
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error)
    process.exit(1)
  })
}
