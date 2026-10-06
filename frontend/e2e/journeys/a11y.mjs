// Accessibility checks on the production build (A23, plan section 9): a keyboard-only
// journey, the phone width, 200% zoom, reduced motion, a dialog taller than the
// window, statuses in words, and accessible names. axe-core runs when it can be
// loaded (AXE_DIR or PLAYWRIGHT_DIR's node_modules); without it a targeted name check
// runs instead. Known, documented findings are reported as notes, not failures:
// see docs/plans/2026-10-06-react-migration-perf.md, "Accessibility findings".
import { assert, eventually, loadAxeSource, recordPosts } from './harness.mjs'

const active = page =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { tag: 'BODY' }
    return {
      tag: el.tagName,
      id: el.id,
      cls: el.className && typeof el.className === 'string' ? el.className : '',
      session: el.getAttribute('data-session'),
      delegation: el.getAttribute('data-delegation'),
      fold: el.getAttribute('data-fold-session'),
      role: el.getAttribute('role'),
      name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || '',
    }
  })

/** Press Tab (or Shift+Tab) until `match(active)` holds; fails past `max` presses or if focus falls to the body. */
async function tabTo(page, match, { max = 80, back = false, what = 'target' } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab')
    const now = await active(page)
    if (match(now)) return now
  }
  throw new Error(`Tab never reached ${what} in ${max} presses (last: ${JSON.stringify(await active(page))})`)
}

/** The focused element shows a focus indicator (outline or box-shadow). */
const focusVisible = page =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return false
    const style = getComputedStyle(el)
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0
    return outline || (style.boxShadow && style.boxShadow !== 'none')
  })

const noHorizontalScroll = page =>
  page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, ok: doc.scrollWidth <= doc.clientWidth + 1 }
  })

const inViewport = (page, selector) =>
  page.evaluate(sel => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : document.activeElement
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
  }, selector)

// axe rules about names and roles: a violation of these fails the check. Everything
// else (contrast inherited from the legacy palette, heading order, nested controls in
// legacy markup) is reported as a note, with the count.
const NAME_RULES = new Set([
  'button-name',
  'link-name',
  'label',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'aria-command-name',
  'aria-meter-name',
  'aria-progressbar-name',
  'select-name',
  'image-alt',
  'input-button-name',
  'landmark-unique',
  'aria-required-attr',
  'aria-valid-attr',
  'aria-valid-attr-value',
  'aria-roles',
  'aria-hidden-focus',
  'duplicate-id-aria',
])

async function axeCheck(page, label) {
  const source = loadAxeSource()
  if (!source) return targetedNames(page, label)
  await page.evaluate(source)
  const { violations } = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }))
  const blocking = violations.filter(v => v.impact === 'critical' || NAME_RULES.has(v.id))
  if (blocking.length) {
    throw new Error(
      `${label}: ${blocking.map(v => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`).join('\n  ')}`,
    )
  }
  return violations.map(v => `${label}: known ${v.id} (${v.impact}) x${v.nodes.length}`)
}

/** Without axe: every visible control has a name. */
async function targetedNames(page, label) {
  const nameless = await page.evaluate(() => {
    const visible = el => el.getClientRects().length > 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]')
    const nameOf = el => {
      const by = el.getAttribute('aria-labelledby')
      if (by) return by.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim()
      if (el.labels?.length) return [...el.labels].map(l => l.textContent).join(' ').trim()
      if (el.tagName === 'IMG') return el.getAttribute('alt') ?? null
      return (el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim()
    }
    return [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=combobox],[role=separator][tabindex],img')]
      .filter(visible)
      .filter(el => {
        const name = nameOf(el)
        return name === null || (name === '' && el.tagName !== 'IMG')
      })
      .map(el => el.outerHTML.slice(0, 120))
  })
  if (nameless.length) throw new Error(`${label}: controls without a name:\n  ${nameless.slice(0, 10).join('\n  ')}`)
  return [`${label}: axe-core not found, targeted name check only`]
}

/** Legacy 0.54.0 at 390px: the scrolling action row ends 4px past the edge (frontend/e2e/journeys/README.md). */
const LEGACY_PHONE_OVERFLOW = 4

const STATUS_WORDS = /Needs approval|Working|In terminal|Queued|Waiting|Ready|Error|Stopped|Stale|Offline|Idle|Done|Failed|Running|Interrupted/

export const A11Y = [
  {
    name: 'keyboard only: list, delegation detail, fold, splitter, combobox, modal close and focus return',
    pack: 'teams-heavy',
    async run({ page }) {
      const notes = []
      await page.locator('#session-list button.session').first().waitFor()
      // Start from the top of the document, as a keyboard user does.
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())

      // List selection: Tab to the team session and select it with Enter.
      await tabTo(page, a => a.session === 't-team' && !a.delegation && !a.fold, { what: 'the team row' })
      assert.ok(await focusVisible(page), 'focused row shows a focus ring')
      await page.keyboard.press('Enter')
      await eventually(async () => (await page.locator('button.session[data-session="t-team"]:not(.session-child)').getAttribute('aria-pressed')) === 'true', 'team row selected by Enter')

      // Fold and unfold the delegations with the keyboard.
      await tabTo(page, a => a.fold === 't-team', { what: 'the delegation fold' })
      const fold = page.locator('[data-fold-session="t-team"]')
      const expanded = await fold.getAttribute('aria-expanded')
      await page.keyboard.press('Enter')
      await eventually(async () => (await fold.getAttribute('aria-expanded')) !== expanded, 'fold toggled by Enter')
      if (expanded === 'false') notes.push('delegations started folded')
      if ((await fold.getAttribute('aria-expanded')) === 'false') await page.keyboard.press('Enter')
      await eventually(async () => (await fold.getAttribute('aria-expanded')) === 'true', 'unfolded')

      // Delegation detail: the first delegation row, selected by Space.
      const first = await tabTo(page, a => !!a.delegation, { what: 'a delegation row' })
      await page.keyboard.press(' ')
      await eventually(
        async () => (await page.locator(`button.session-child[data-delegation="${first.delegation}"]`).getAttribute('aria-pressed')) === 'true',
        'delegation selected by Space',
      )
      await eventually(async () => ((await page.locator('#detail').textContent()) || '').length > 20, 'delegation detail drawn')
      assert.equal((await active(page)).delegation, first.delegation, 'focus stays on the selected delegation')

      // Splitter: Arrow keys move it by 2, Home and End clamp to its bounds.
      await tabTo(page, a => a.id === 'splitter', { what: 'the splitter' })
      const splitter = page.locator('#splitter')
      const before = Number(await splitter.getAttribute('aria-valuenow'))
      await page.keyboard.press('ArrowRight')
      await eventually(async () => Number(await splitter.getAttribute('aria-valuenow')) === before + 2, 'splitter moved by ArrowRight')
      await page.keyboard.press('End')
      const max = Number(await splitter.getAttribute('aria-valuemax'))
      await eventually(async () => Number(await splitter.getAttribute('aria-valuenow')) === max, 'End clamps to the maximum')
      await page.keyboard.press('Enter')
      notes.push(`splitter ${before} -> ${before + 2} -> ${max} (max), Enter resets to ${await splitter.getAttribute('aria-valuenow')}`)

      // Modal: open New agent from its button with Enter, use a combobox, close with Escape.
      await page.locator('#new-session').focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'What are we working on?' })
      await dialog.waitFor()
      assert.ok(await dialog.evaluate(d => d.contains(document.activeElement)), 'focus moved into the dialog')
      await tabTo(page, a => a.name.startsWith('Approvals:'), { what: 'the Approvals combobox' })
      const trigger = dialog.getByRole('button', { name: /^Approvals:/ })
      const was = await trigger.getAttribute('aria-label')
      const listbox = page.getByRole('listbox', { name: 'Approvals' })
      // ArrowDown opens the menu on the current choice; Home or End moves off it.
      for (const key of ['Home', 'End']) {
        await page.keyboard.press('ArrowDown')
        await listbox.waitFor()
        await page.keyboard.press(key)
        await page.keyboard.press('Enter')
        await listbox.waitFor({ state: 'detached' })
        if ((await trigger.getAttribute('aria-label')) !== was) break
      }
      assert.notEqual(await trigger.getAttribute('aria-label'), was, 'the keyboard changed the choice')
      assert.equal((await active(page)).name, await trigger.getAttribute('aria-label'), 'focus back on the combobox')
      // Escape in an open menu closes only the menu.
      await page.keyboard.press('ArrowDown')
      await listbox.waitFor()
      await page.keyboard.press('Escape')
      await listbox.waitFor({ state: 'detached' })
      assert.equal(await dialog.count(), 1, 'Escape on a menu leaves the dialog open')
      // Tab is trapped: 40 presses never leave the dialog.
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        assert.ok(await dialog.evaluate(d => d.contains(document.activeElement)), `Tab ${i + 1} stayed inside the dialog`)
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal((await active(page)).id, 'new-session', 'focus returned to New agent')
      return notes
    },
  },
  {
    name: 'keyboard only: answer an approval',
    pack: 'fleet-mixed',
    async run({ page }) {
      const posts = recordPosts(page)
      await page.getByRole('heading', { name: 'Delete the remote branch' }).waitFor()
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await tabTo(page, a => a.name === 'Allow once', { max: 120, what: 'Allow once' })
      assert.ok(await focusVisible(page), 'Allow once shows a focus ring')
      await page.keyboard.press('Enter')
      await page.getByRole('heading', { name: 'Delete the remote branch' }).waitFor({ state: 'detached' })
      assert.equal(posts.filter(p => /\/approvals\//.test(p.path)).length, 1, 'one approval POST')
      // Focus does not fall to the body when the card it was on goes away.
      const now = await eventually(async () => {
        const a = await active(page)
        return a.tag !== 'BODY' && a
      }, 'focus kept after the approval')
      return [`after the approval, focus is on ${now.tag}${now.id ? `#${now.id}` : ''}`]
    },
  },
  {
    name: 'phone width 390px: no sideways scroll, controls reachable, native pickers',
    pack: 'fleet-mixed',
    open: { viewport: { width: 390, height: 844 }, contextOptions: { isMobile: true, hasTouch: true } },
    async run({ page }) {
      await page.locator('#session-list button.session').first().waitFor()
      // The top bar's action row scrolls sideways by design and pokes 4px past the edge,
      // exactly as legacy 0.54.0 does at 390px (measured, documented): allow that, no more.
      const wide = await noHorizontalScroll(page)
      assert.ok(wide.scrollWidth - wide.clientWidth <= LEGACY_PHONE_OVERFLOW, `Sessions overflows ${wide.scrollWidth - wide.clientWidth}px sideways`)
      for (const id of ['#new-session', '#open-settings']) {
        await page.locator(id).scrollIntoViewIfNeeded()
        assert.ok(await inViewport(page, id), `${id} can be brought into view`)
      }
      // Selecting a row reaches its conversation.
      await page.locator('button.session[data-session="m-claude-idle"]').tap()
      const log = page.getByRole('log', { name: 'Agent conversation' })
      await log.getByText('Fixed. The test waited on a timer').first().waitFor()
      await log.scrollIntoViewIfNeeded()
      // The launch dialog fits the width and uses the native picker on touch.
      await page.locator('#new-session').tap()
      const dialog = page.getByRole('dialog', { name: 'What are we working on?' })
      await dialog.waitFor()
      const box = await dialog.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 391, `dialog fits 390px (${JSON.stringify(box)})`)
      const native = dialog.locator('select').filter({ has: page.locator('option') })
      const count = await native.count()
      assert.ok(count >= 1, 'native selects present at touch width')
      // The Approvals picker: a native select a phone opens with its own wheel.
      const approvals = dialog.getByRole('combobox', { name: 'Approvals' })
      assert.ok(await approvals.isVisible(), 'the native select is the visible control at touch width')
      const values = await approvals.locator('option').evaluateAll(options => options.map(o => o.value))
      const current = await approvals.inputValue()
      const pick = values.find(v => v !== current)
      assert.ok(pick, `more than one approval mode offered: ${values.join(', ')}`)
      await approvals.selectOption(pick)
      assert.equal(await approvals.inputValue(), pick, 'a native choice applies')
      const launch = dialog.getByRole('button', { name: 'Launch agent' })
      await launch.scrollIntoViewIfNeeded()
      assert.ok(await inViewport(page, '#launch-submit, .modal button[type=submit]') || (await launch.isVisible()), 'Launch agent reachable')
      for (const view of ['Today', 'Projects', 'Progress', 'Worktrees']) {
        await page.keyboard.press('Escape').catch(() => {})
        await page.getByRole('navigation', { name: 'Fleet view' }).getByRole('button', { name: new RegExp(`^${view}`) }).tap()
        await page.waitForTimeout(400)
        const state = await noHorizontalScroll(page)
        assert.ok(state.scrollWidth - state.clientWidth <= LEGACY_PHONE_OVERFLOW, `${view} overflows ${state.scrollWidth - state.clientWidth}px sideways`)
      }
      return [`${count} native selects in the launch dialog; top bar overflow ${wide.scrollWidth - wide.clientWidth}px (legacy: 4px)`]
    },
  },
  {
    name: '200% zoom: 1440x900 at twice the size',
    pack: 'day-full',
    open: { view: 'today', viewport: { width: 720, height: 450 }, contextOptions: { deviceScaleFactor: 2 } },
    async run({ page }) {
      // Browser zoom to 200% on a 1440x900 window is a 720x450 CSS viewport at scale 2.
      await page.getByRole('heading', { name: /Waiting on you/ }).waitFor()
      const notes = []
      for (const view of ['Today', 'Sessions', 'Projects', 'Progress', 'Worktrees']) {
        await page.getByRole('navigation', { name: 'Fleet view' }).getByRole('button', { name: new RegExp(`^${view}`) }).click()
        await page.waitForTimeout(400)
        const state = await noHorizontalScroll(page)
        assert.ok(state.ok, `no horizontal scroll on ${view} at 200% (${state.scrollWidth} > ${state.clientWidth})`)
      }
      // A dialog at 200%: its close button and its last control are reachable.
      await page.locator('#open-settings').click()
      const dialog = page.getByRole('dialog', { name: 'How Fleet runs.' })
      await dialog.waitFor()
      assert.ok(await inViewport(page, '.modal-settings .modal-close'), 'close button visible at 200%')
      const last = dialog.getByRole('button', { name: 'Remove saved key' })
      await last.scrollIntoViewIfNeeded()
      assert.ok(await last.isVisible(), 'the last control scrolls into view')
      const fits = await dialog.evaluate(d => {
        const r = d.getBoundingClientRect()
        return r.height <= innerHeight + 1 && r.width <= innerWidth + 1
      })
      assert.ok(fits, 'the dialog fits the zoomed window and scrolls inside')
      notes.push('5 views and Settings checked at 720x450 CSS px, scale 2')
      return notes
    },
  },
  {
    name: 'reduced motion: no running animation or transition beyond a blink',
    pack: 'conversation-heavy',
    open: { contextOptions: { reducedMotion: 'reduce' } },
    async run({ page, browser, stack }) {
      await page.getByRole('log', { name: 'Agent conversation' }).waitFor()
      await page.waitForTimeout(800)
      const moving = page =>
        page.evaluate(() =>
          document
            .getAnimations()
            .filter(a => a.playState === 'running')
            .map(a => {
              const t = a.effect?.getComputedTiming()
              const target = a.effect?.target
              return {
                name: a.animationName || a.transitionProperty || a.constructor.name,
                duration: Number(t?.duration) || 0,
                iterations: t?.iterations,
                target: target ? `${target.tagName.toLowerCase()}.${String(target.className).split(' ')[0]}` : '',
              }
            })
            .filter(a => a.duration > 150 || a.iterations === Number.POSITIVE_INFINITY),
        )
      const reduced = await moving(page)
      // The same page without the preference, to show the check can see motion at all.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
      const normal = await context.newPage()
      await normal.goto(`${stack.base}/`)
      await normal.getByRole('log', { name: 'Agent conversation' }).waitFor()
      await normal.waitForTimeout(800)
      const full = await moving(normal)
      await context.close()
      assert.deepEqual(reduced, [], `animations still running with reduced motion: ${JSON.stringify(reduced)}`)
      return [`without the preference ${full.length} animations run (${[...new Set(full.map(a => a.target))].slice(0, 5).join(', ')}); with it, none`]
    },
  },
  {
    name: 'long dialog in a short window: scrolls inside, focus stays visible and trapped',
    pack: 'fleet-mixed',
    open: { viewport: { width: 1280, height: 420 } },
    async run({ page }) {
      await page.locator('#session-list button.session').first().waitFor()
      await page.locator('#open-settings').click()
      const dialog = page.getByRole('dialog', { name: 'How Fleet runs.' })
      await dialog.waitFor()
      const geometry = await dialog.evaluate(d => {
        const body = d.querySelector('.modal-body')
        const r = d.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: innerHeight, scrolls: !!body && body.scrollHeight > body.clientHeight }
      })
      assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height + 1, `dialog within the window ${JSON.stringify(geometry)}`)
      assert.ok(geometry.scrolls, 'the dialog body scrolls')
      const seen = new Set()
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        const now = await active(page)
        assert.ok(await dialog.evaluate(d => d.contains(document.activeElement)), 'focus stays in the dialog')
        assert.ok(await inViewport(page, null), `focused ${now.tag} "${now.name}" is scrolled into view`)
        seen.add(`${now.tag}:${now.name}`)
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal((await active(page)).id, 'open-settings', 'focus returned to Settings')
      return [`${seen.size} distinct stops, all visible while focused`]
    },
  },
  {
    name: 'statuses in words, not colour alone',
    pack: 'fleet-mixed',
    async run({ page }) {
      await page.locator('#session-list button.session').first().waitFor()
      const rows = await page.locator('#session-list button.session').evaluateAll(buttons =>
        buttons.map(b => ({ key: b.getAttribute('data-session'), badge: b.querySelector('.badge')?.textContent?.trim() || '', text: b.textContent || '' })),
      )
      const silent = rows.filter(r => !r.badge)
      assert.deepEqual(silent, [], 'every row has a status badge with text')
      const words = new Set(rows.map(r => r.badge))
      const unknown = [...words].filter(w => !/\w/.test(w))
      assert.deepEqual(unknown, [], 'badges are words')
      assert.ok(rows.every(r => STATUS_WORDS.test(r.badge)), `badges use status words: ${[...words].join(', ')}`)
      // The status bar and connection state are text too.
      const status = await page.locator('#statusbar').textContent()
      assert.match(status, /\d+ working/)
      assert.match(status, /\d+ needs? you/)
      assert.match(await page.locator('#connection').textContent(), /Live connection|Connecting|Disconnected|Reconnecting/)
      // Meters carry their value for assistive technology.
      const meters = await page.getByRole('meter').evaluateAll(ms => ms.map(m => ({ name: m.getAttribute('aria-label'), now: m.getAttribute('aria-valuenow') })))
      assert.ok(meters.every(m => m.name && m.now !== null), `meters named with values: ${JSON.stringify(meters)}`)
      return [`badges: ${[...words].join(', ')}`]
    },
  },
  ...[
    ['fleet-mixed', 'sessions', null, 'Sessions'],
    ['conversation-heavy', 'sessions', null, 'Conversation'],
    ['teams-heavy', 'sessions', async page => page.locator('button.session[data-session="t-team"]').first().click(), 'Team overview'],
    ['day-full', 'today', null, 'Today'],
    ['projects-collision', 'projects', null, 'Projects'],
    ['day-full', 'progress', null, 'Progress'],
    ['fleet-mixed', 'worktrees', null, 'Worktrees'],
    ['fleet-mixed', 'sessions', async page => page.locator('#new-session').click(), 'New agent dialog'],
    ['fleet-mixed', 'sessions', async page => page.locator('#open-settings').click(), 'Settings dialog'],
    ['fleet-mixed', 'sessions', async page => page.keyboard.press('Meta+k'), 'Search dialog'],
    ['fleet-mixed', 'sessions', async page => page.locator('#open-connections, button:has-text("Connections")').first().click(), 'Connections dialog'],
  ].map(([pack, view, step, label]) => ({
    name: `accessible names and roles (axe): ${label}`,
    pack,
    open: { view },
    async run({ page }) {
      await page.waitForSelector('#session-list button.session, .workspace[data-view]:not([data-view="sessions"]) h2', { timeout: 10000 })
      await page.waitForTimeout(800)
      if (step) {
        await step(page)
        await page.waitForTimeout(800)
      }
      return axeCheck(page, label)
    },
  })),
]
