// The production-build journeys (plan section 11, layer four; work package 5). Each
// runs the real handlers end to end: dist/ in Chromium, the real createApp behind it
// with fake runtimes. A journey asserts what the person sees and what reached the
// server (exactly one POST, the right body), never source text.
import { assert, eventually, recordPosts } from './harness.mjs'

/** A 1x1 PNG, the smallest image the server accepts. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

const row = (page, id) => page.locator(`#session-list button.session[data-session="${id}"]`)
const conversation = page => page.getByRole('log', { name: 'Agent conversation' })
const pressed = async locator => (await locator.getAttribute('aria-pressed')) === 'true'
const only = (posts, pattern) => posts.filter(p => pattern.test(p.path))
/** Finite animations (a dialog opening) finished; endless ones (spinners, avatars) ignored. */
const animationsDone = page =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(a => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map(a => a.finished.catch(() => {})),
    ),
  )

export const JOURNEYS = [
  {
    name: 'session select, conversation and approval allow',
    pack: 'fleet-mixed',
    async run({ page }) {
      const posts = recordPosts(page)
      // The first row (a pending approval) is selected on load.
      await row(page, 'm-claude-approval').waitFor()
      assert.ok(await pressed(row(page, 'm-claude-approval')), 'the approval row starts selected')

      // Another session: its conversation replaces the first one.
      await row(page, 'm-claude-idle').click()
      await eventually(() => pressed(row(page, 'm-claude-idle')), 'idle row selected')
      await conversation(page).getByText('Fixed. The test waited on a timer; now it awaits the event.').first().waitFor()
      assert.equal(await page.getByText('Delete the remote branch').count(), 0, 'the other session approval is gone')

      // Back to the approval and allow it once.
      await row(page, 'm-claude-approval').click()
      const card = page.getByRole('heading', { name: 'Delete the remote branch' })
      await card.waitFor()
      await page.getByRole('button', { name: 'Allow once' }).click()
      await card.waitFor({ state: 'detached' })
      const approvals = only(posts, /^\/api\/managed\/m-claude-approval\/approvals\//)
      assert.equal(approvals.length, 1, 'one approval POST')
      assert.equal(approvals[0].body.decision ?? approvals[0].body.behavior ?? 'allow', 'allow')
      // The row no longer says it needs you.
      await eventually(async () => !(await row(page, 'm-claude-approval').textContent()).includes('Needs approval'), 'row status updated')
      return [`approval POST ${approvals[0].path} ${JSON.stringify(approvals[0].body)}`]
    },
  },
  {
    name: 'launch from Today: New agent and a Launch need',
    pack: 'day-full',
    open: { view: 'today' },
    async run({ page }) {
      const posts = recordPosts(page)
      await page.getByRole('heading', { name: 'Waiting on you 5' }).waitFor()

      // New agent while viewing Today: one POST, the modal closes, selection moves to Sessions.
      await page.locator('#new-session').click()
      const dialog = page.getByRole('dialog', { name: 'What are we working on?' })
      await dialog.waitFor()
      await dialog.getByRole('textbox', { name: 'What are we working on?' }).fill('E2E: tidy the release notes')
      await dialog.getByRole('button', { name: 'Launch agent' }).click()
      await dialog.waitFor({ state: 'detached' })
      const creates = only(posts, /^\/api\/managed$/)
      assert.equal(creates.length, 1, 'one create POST')
      assert.equal(creates[0].body.prompt ?? creates[0].body.message, 'E2E: tidy the release notes')
      assert.ok(creates[0].body.requestId, 'the create carries a requestId')
      await eventually(() => pressed(page.getByRole('navigation', { name: 'Fleet view' }).getByRole('button', { name: 'Sessions' })), 'view moved to Sessions')
      const selected = page.locator('#session-list button.session[aria-pressed="true"]')
      await eventually(async () => (await selected.textContent())?.includes('E2E: tidy the release notes'), 'the new session is selected')

      // The Launch need on the board starts one child session from the approved brief.
      await page.getByRole('navigation', { name: 'Fleet view' }).getByRole('button', { name: /^Today/ }).click()
      const card = page.locator('article').filter({ hasText: 'Item 002: Review a flaky build' }).filter({ has: page.getByRole('button', { name: 'Launch' }) })
      await card.waitFor()
      // An edited brief is what the server must receive, word for word.
      const brief = `${await card.getByRole('textbox', { name: 'Brief the new session starts from' }).inputValue()} Keep the diff small.`
      await card.getByRole('textbox', { name: 'Brief the new session starts from' }).fill(brief)
      await card.getByRole('button', { name: 'Launch', exact: true }).click()
      await eventually(async () => only(posts, /\/day$/).length === 1, 'one Day action POST')
      const day = only(posts, /\/day$/)[0]
      assert.ok(JSON.stringify(day.body).includes(JSON.stringify(brief).slice(1, -1)), `the brief as approved: ${JSON.stringify(day.body)}`)
      await eventually(async () => (await card.getByRole('button', { name: 'Launch', exact: true }).count()) === 0, 'the launch need settled')
      return [`create ${JSON.stringify(creates[0].body).slice(0, 120)}`, `day action ${JSON.stringify(day.body).slice(0, 160)}`]
    },
  },
  {
    name: 'composer send with an image',
    pack: 'fleet-mixed',
    async run({ page }) {
      const posts = recordPosts(page)
      await row(page, 'm-claude-idle').click()
      const box = page.getByRole('combobox', { name: 'Message this agent' })
      await box.waitFor()
      // Drop a PNG onto the composer, the way a file from Finder arrives.
      await page.evaluate(base64 => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
        const file = new File([bytes], 'dot.png', { type: 'image/png' })
        const data = new DataTransfer()
        data.items.add(file)
        const form = document.querySelector('#message-form') || document.querySelector('textarea')?.closest('form')
        form.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
        form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
      }, PNG_BASE64)
      await page.locator('#attach-tray figure').first().waitFor()
      await box.fill('What is in this picture?')
      await box.press('Enter')
      await eventually(() => only(posts, /\/messages$/).length === 1, 'one message POST')
      const sent = only(posts, /\/messages$/)[0]
      assert.match(sent.path, /^\/api\/managed\/m-claude-idle\/messages$/)
      assert.equal(sent.body.text ?? sent.body.message, 'What is in this picture?')
      assert.equal(sent.body.images?.length, 1, 'one image on the wire')
      assert.ok(sent.body.requestId, 'the message carries a requestId')
      // The draft clears and the fake runtime answers to an image prompt (not stdin text).
      await eventually(async () => (await box.inputValue()) === '', 'composer cleared')
      await eventually(async () => (await page.locator('#attach-tray figure').count()) === 0, 'tray cleared')
      await conversation(page).getByText('What is in this picture?').first().waitFor()
      await conversation(page).getByText('Fixture reply to: (images)').first().waitFor({ timeout: 10000 })
      assert.equal(only(posts, /\/messages$/).length, 1, 'still exactly one POST')
      return [`message POST images=${sent.body.images.length} keys=${Object.keys(sent.body).join(',')}`]
    },
  },
  {
    name: 'Today triage and answering a need',
    pack: 'day-full',
    open: { view: 'today' },
    async run({ page }) {
      const posts = recordPosts(page)
      await page.getByRole('heading', { name: /^To triage 28/ }).waitFor()

      // Triage: take one item onto today.
      const triage = page.locator('article').filter({ hasText: 'Item 022: Review a flaky build' })
      await triage.getByRole('button', { name: 'Today', exact: true }).click()
      await eventually(() => only(posts, /\/day$/).length === 1, 'one triage POST')
      await page.getByRole('heading', { name: /^To triage 27/ }).waitFor()

      // Answer an info need: the exact text goes to the server, the card leaves Waiting on you.
      const need = page.locator('article').filter({ hasText: 'Item 001: Reply to the pricing change' })
      await need.getByRole('textbox', { name: /^Answer:/ }).fill('TECH-999')
      await need.getByRole('button', { name: 'Answer', exact: true }).click()
      await eventually(() => only(posts, /\/day$/).length === 2, 'one answer POST')
      const answer = only(posts, /\/day$/)[1]
      assert.ok(JSON.stringify(answer.body).includes('TECH-999'), 'the answer text reached the server')
      await page.getByRole('heading', { name: 'Waiting on you 4' }).waitFor()
      return [`triage ${JSON.stringify(only(posts, /\/day$/)[0].body)}`, `answer ${JSON.stringify(answer.body)}`]
    },
  },
  {
    name: 'project create and plan on Today',
    pack: 'day-full',
    open: { view: 'projects' },
    async run({ page }) {
      const posts = recordPosts(page)
      await page.getByRole('heading', { name: 'Checkout revamp', level: 2 }).waitFor()

      await page.getByRole('button', { name: 'New project' }).click()
      await page.getByRole('textbox', { name: 'Project title' }).fill('E2E launch plan')
      await page.getByRole('button', { name: 'Create and set up' }).click()
      await page.getByRole('heading', { name: 'E2E launch plan', level: 2 }).waitFor()
      assert.equal(only(posts, /^\/api\/projects$/).length, 1, 'one create POST')

      // Back to the project with deliverables; plan one on Today.
      await page.getByRole('button', { name: /^Switch project:/ }).click()
      await page.getByRole('option', { name: /Checkout revamp/ }).click()
      await page.getByRole('heading', { name: 'Checkout revamp', level: 2 }).waitFor()
      const deliverable = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Today', exact: true }) }).first()
      const title = (await deliverable.locator('strong').first().textContent()).trim()
      await deliverable.getByRole('button', { name: 'Today', exact: true }).click()
      await eventually(() => only(posts, /^\/api\/projects\/[\w-]+\/today$/).length === 1, 'one plan POST')

      await page.getByRole('navigation', { name: 'Fleet view' }).getByRole('button', { name: /^Today/ }).click()
      await page.getByRole('region', { name: 'Day board' }).getByText(title).first().waitFor()
      return [`planned "${title}"`]
    },
  },
  {
    name: 'search, Open in Fleet',
    pack: 'fleet-mixed',
    async run({ page }) {
      await row(page, 'm-claude-approval').waitFor()
      await page.keyboard.press('Meta+k')
      const dialog = page.getByRole('dialog', { name: 'Find the thread.' })
      await dialog.waitFor()
      await dialog.getByRole('textbox', { name: 'Search all sessions' }).fill('fixture')
      await dialog.getByRole('textbox', { name: 'Search all sessions' }).press('Enter')
      const open = dialog.getByRole('button', { name: 'Open in Fleet' }).first()
      await open.waitFor({ timeout: 10000 })
      const target = await open.getAttribute('data-open-session')
      await open.click()
      await dialog.waitFor({ state: 'detached' })
      const selected = page.locator('button.session[aria-pressed="true"]')
      await eventually(async () => (await selected.count()) === 1, 'one selected row')
      const key = await selected.getAttribute('data-session')
      assert.ok(target?.endsWith(key) || key === target || target?.includes(key), `Open in Fleet selected ${key} for ${target}`)
      await eventually(() => pressed(page.getByRole('navigation', { name: 'Fleet view' }).getByRole('button', { name: 'Sessions' })), 'on Sessions')
      return [`opened ${target}`]
    },
  },
  {
    name: 'settings queue limit',
    pack: 'fleet-mixed',
    async run({ page }) {
      const posts = recordPosts(page)
      await row(page, 'm-claude-approval').waitFor()
      await page.locator('#open-settings').click()
      const dialog = page.getByRole('dialog', { name: 'How Fleet runs.' })
      await dialog.waitFor()
      await dialog.getByText('0/8 running · 0 waiting').waitFor()
      const limit = dialog.getByRole('button', { name: 'Concurrent agents: 8' })
      // Let the opening animation finish: a click mid-animation makes Playwright scroll
      // the body, and the scroll (rightly) closes the menu it just opened.
      await animationsDone(page)
      await limit.click()
      await page.getByRole('option', { name: '4', exact: true }).click()
      await eventually(() => only(posts, /^\/api\/queue$/).length === 1, 'one queue POST')
      assert.equal(only(posts, /^\/api\/queue$/)[0].body.limit, 4)
      await dialog.getByRole('button', { name: 'Concurrent agents: 4' }).waitFor()
      await dialog.getByText(/\/4 running/).waitFor()

      // Closed and reopened, the dialog reads the server's value, not a local echo.
      // The Select was disabled while it saved, so focus fell to <body>: Escape still closes
      // the dialog and focus returns to its opener.
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-settings', 'focus returned to Settings')
      await page.reload()
      await row(page, 'm-claude-approval').waitFor()
      await page.locator('#open-settings').click()
      await page.getByRole('dialog', { name: 'How Fleet runs.' }).getByRole('button', { name: 'Concurrent agents: 4' }).waitFor()
      return [`queue POST ${JSON.stringify(only(posts, /^\/api\/queue$/)[0].body)}`]
    },
  },
]
