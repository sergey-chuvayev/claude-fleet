'use strict'
// day-full: a Day board of 200 items spanning every status, source and mode, open
// approve/choose/info/launch needs, a carried item with a previous thread, an active
// thread, scout history, calendar capacity and project links. Yesterday's Day exists too.

const SOURCES = ['slack', 'linear', 'granola', 'github', 'calendar', 'me']
const PRIORITIES = ['must', 'should', 'could']
const MODES = ['me', 'draft', 'agent', 'ask']
const STATUSES = ['proposed', 'today', 'in_progress', 'waiting_on_you', 'done', 'later', 'dropped']

exports.prepare = async ctx => {
  const { MIN, HOUR, DAY, uid } = ctx
  const day = ctx.modules.day
  const repo = ctx.git('day-repo', { branch: 'main' })
  const project = ctx.manager.projects.create({ name: 'Checkout revamp' })
  ctx.manager.projects.define(project.id, { brief: 'Make checkout fast and boring.', deadline: '2026-10-20', deliverables: [{ title: 'Faster totals', brief: 'Cache the totals.', links: ['https://linear.app/team/issue/TECH-110/totals'] }, 'Refund flow'] })
  const p = ctx.manager.projects.get(project.id)

  // Yesterday's Day: carried from.
  const yesterday = new Date(ctx.now() - DAY).toISOString().slice(0, 10)
  const old = ctx.managed('day-yesterday', { name: `Day ${yesterday}`, kind: 'day', cwd: repo, status: 'idle', sessionId: uid(0x5e, 40), createdAt: ctx.now() - DAY, updatedAt: ctx.now() - 14 * HOUR, messages: [ctx.message('dy-u', 'user', 'Start my day', ctx.now() - DAY), ctx.message('dy-a', 'assistant', 'Day started. Three items today.', ctx.now() - DAY + MIN)] })
  old.dayBoard = { date: yesterday, items: [], cursors: { slack: 'c-100' } }
  const carried = day.act(old, { action: 'add', title: 'Reply to Thomas about the migration', source: 'slack', links: ['https://example.slack.com/archives/C1/p1'], priority: 'must', mode: 'draft', context: 'Thomas asked if the migration can ship Friday.' }, 'operator').item
  day.act(old, { action: 'add', title: 'Review the pricing PR', source: 'github', links: ['https://github.com/example-org/web-app/pull/77'], priority: 'should', mode: 'agent' }, 'operator')
  const settled = day.act(old, { action: 'add', title: 'Send the weekly update', source: 'me', priority: 'could', mode: 'me' }, 'operator').item
  settled.status = 'done'
  carried.thread = { sessionId: 'thr-old', at: ctx.now() - 20 * HOUR, summary: 'Agreed to ship Friday if QA signs off.' }

  // Today's Day.
  const board = day.carryOver(old.dayBoard, new Date(ctx.now()).toISOString().slice(0, 10))
  const s = ctx.managed('day-today', { name: `Day ${new Date(ctx.now()).toISOString().slice(0, 10)}`, kind: 'day', cwd: repo, status: 'idle', sessionId: uid(0x5e, 41), createdAt: ctx.now() - 2 * HOUR, updatedAt: ctx.now() - 4 * MIN, dayChecks: { lastAt: ctx.now() - 20 * MIN, everyMin: 30, hours: [8, 19] }, messages: [ctx.message('dt-u', 'user', 'Start my day', ctx.now() - 2 * HOUR), ctx.message('dt-a', 'assistant', 'Here is your day. Five things need you.', ctx.now() - 2 * HOUR + MIN)] })
  s.dayBoard = { date: new Date(ctx.now()).toISOString().slice(0, 10), items: board.items, cursors: { slack: 'c-200', github: 'g-9', linear: 'l-4' } }
  day.act(s, { action: 'capacity', freeMinutes: 190 })
  const items = s.dayBoard.items
  // Plenty of items across every status, source and mode.
  const target = 199 - items.length
  for (let i = 0; i < target; i++) {
    const { item } = day.act(s, { action: 'add', title: `Item ${String(i + 1).padStart(3, '0')}: ${['Reply to', 'Review', 'Prepare', 'Triage', 'Follow up on'][i % 5]} ${['the pricing change', 'a customer thread', 'the release notes', 'a flaky build', 'the roadmap draft'][(i * 3) % 5]}`, source: SOURCES[i % SOURCES.length], priority: PRIORITIES[i % 3], mode: MODES[(i + 1) % 4], estimateMin: [15, 30, 45, 60, undefined][i % 5], context: i % 9 === 0 ? `Context for item ${i}.\n\n## Why\nIt blocks the release.\n\n- step one\n- step two\n\n${'More detail. '.repeat(40)}` : i % 3 === 0 ? `Short context ${i}.` : undefined, links: i % 4 === 0 ? [`https://github.com/example-org/web-app/pull/${100 + i}`] : i % 4 === 1 ? [`https://linear.app/team/issue/TECH-${200 + i}/thing`] : [] }, 'agent')
    item.status = STATUSES[i % STATUSES.length]
    if (i % 6 === 0) item.log.push({ at: ctx.now() - (i + 1) * MIN, text: `Scout noted: item ${i} changed.` })
  }
  // Needs: one of each kind on the first items.
  const open = [...s.dayBoard.items.filter(i => !['done', 'dropped'].includes(i.status))]
  const [a, b, c, d, e] = open.slice(0, 5)
  day.act(s, { action: 'ask', itemId: a.id, kind: 'approve', question: 'Send this Slack reply to Thomas?', draft: 'Hi Thomas, yes, Friday works if QA signs off by Thursday. I will confirm tomorrow morning.' })
  day.act(s, { action: 'ask', itemId: b.id, kind: 'choose', question: 'Which environment should the check run on?', options: ['staging', 'production', 'both'] })
  day.act(s, { action: 'ask', itemId: c.id, kind: 'info', question: 'What is the ticket number for the pricing change?' })
  day.act(s, { action: 'ask', itemId: d.id, kind: 'launch', question: 'Start an agent for the totals cache?', draft: 'Implement the totals cache described in TECH-110. Add tests.', cwd: repo, teamId: 'quick', name: 'Totals cache' })
  day.act(s, { action: 'ask', itemId: e.id, kind: 'choose', question: 'The agent finished and opened a pull request: Cached totals, tests green.', options: ['Done', 'Needs more work'] })
  s.dayBoard.items.find(i => i.id === e.id).needs.at(-1).report = 'm-launched'
  // Project link and a plan on Today.
  const planned = s.dayBoard.items[0]
  planned.projectId = p.id
  planned.deliverableId = p.deliverables[0].id
  // A launched agent and an active thread.
  const launched = ctx.managed('m-launched', { name: 'Totals cache', cwd: repo, parentDayId: s.id, sessionId: uid(0x5e, 42), messages: [ctx.message('ml-u', 'user', 'Implement the totals cache', ctx.now() - HOUR), ctx.message('ml-a', 'assistant', 'Done. Opened https://github.com/example-org/web-app/pull/120.', ctx.now() - 50 * MIN)], updatedAt: ctx.now() - 50 * MIN })
  d.launched = [launched.id]
  const thread = ctx.managed('thr-today', { name: 'Reply to Thomas', kind: 'thread', parentDayId: s.id, itemId: a.id, cwd: repo, sessionId: uid(0x5e, 43), messages: [ctx.message('th-u', 'user', 'What did Thomas ask exactly?', ctx.now() - 10 * MIN), ctx.message('th-a', 'assistant', 'He asked whether the migration can ship on Friday.', ctx.now() - 9 * MIN)], updatedAt: ctx.now() - 9 * MIN })
  a.thread = { sessionId: thread.id, at: ctx.now() - 10 * MIN }
  a.previousThread = a.previousThread || { summary: 'Agreed to ship Friday if QA signs off.', at: ctx.now() - 20 * HOUR, sessionId: 'thr-old' }
  // Scout history: subagent runs by role.
  s.subagents = ['calendar', 'slack', 'github', 'linear', 'granola'].flatMap((role, r) => [0, 1].map(k => ({
    id: `scout-${role}-${k}`, itemId: null, role: `${role}-scout`, description: `Scan ${role}`, prompt: `Scan ${role} for new work since the last cursor.`, status: 'completed',
    startedAt: ctx.now() - (k + 1) * HOUR - r * MIN, finishedAt: ctx.now() - (k + 1) * HOUR - r * MIN + 90000, output: '', report: `${role}: ${r + k} new items found.`, steps: [{ id: `ss-${role}-${k}`, tool: 'mcp__scan', target: role, status: 'done', input: {}, result: 'ok', ms: 900, truncated: false }],
  })))
  ctx.save()
  ctx.fixtureItems = { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, plain: s.dayBoard.items.find(i => i.status === 'proposed' && !i.needs.length).id, needA: a.needs[0].id, needB: b.needs[0].id, needC: c.needs[0].id, needD: d.needs[0].id, needE: e.needs[0].id, project: p.id, deliverable: p.deliverables[0].id }
}

exports.capture = async ctx => {
  const f = ctx.fixtureItems
  await ctx.getCommon()
  await ctx.getSessions()
  await ctx.getDetails({ histories: 0 })
  const day = '/api/managed/day-today/day'
  await ctx.post('post-day-add', day, { op: 'add', item: { title: 'Call the accountant', source: 'me', priority: 'must', mode: 'me', context: 'About the quarter close.', links: ['https://example.com/ledger'], estimateMin: 30 } })
  await ctx.post('post-day-add-limit', day, { op: 'add', item: { title: 'One too many', source: 'me' } }, { note: 'the board holds 200 items' })
  await ctx.post('post-day-add-invalid', day, { op: 'add', item: { title: '', source: 'me' } })
  await ctx.post('post-day-add-bad-source', day, { op: 'add', item: { title: 'x', source: 'carrier-pigeon' } })
  await ctx.post('post-day-triage', day, { op: 'triage', itemId: f.plain, status: 'today', priority: 'must', mode: 'agent' })
  await ctx.post('post-day-triage-project', day, { op: 'triage', itemId: f.plain, projectId: f.project })
  await ctx.post('post-day-triage-missing-item', day, { op: 'triage', itemId: 'nope', status: 'today' })
  await ctx.post('post-day-triage-unknown-project', day, { op: 'triage', itemId: f.plain, projectId: 'no-such-project' })
  await ctx.post('post-day-answer-reply', day, { op: 'answer', itemId: f.a, needId: f.needA, answer: 'Not yet, ask Thomas first.', decision: 'reply' }, { note: 'reply never approves the outward draft' })
  await ctx.post('post-day-answer-info', day, { op: 'answer', itemId: f.c, needId: f.needC, answer: 'TECH-4410', decision: 'info' })
  await ctx.post('post-day-answer-choose', day, { op: 'answer', itemId: f.b, needId: f.needB, answer: 'staging', decision: 'choose' })
  await ctx.post('post-day-answer-choose-invalid', day, { op: 'answer', itemId: f.b, needId: f.needB, answer: 'staging', decision: 'choose' }, { note: 'already answered' })
  await ctx.post('post-day-answer-report-done', day, { op: 'answer', itemId: f.e, needId: f.needE, answer: 'Done', decision: 'choose' }, { note: 'Done on an agent report closes the item' })
  await ctx.post('post-day-answer-missing-need', day, { op: 'answer', itemId: f.a, needId: 'nope', answer: 'approve' })
  await ctx.post('post-day-answer-launch-edited', day, { op: 'answer', itemId: f.d, needId: f.needD, answer: 'Implement the totals cache; keep the change small.', decision: 'edit', cwd: ctx.dirs.repos + '/day-repo', teamId: 'quick' }, { note: 'launch approved with an edited brief and chosen team' })
  await ctx.settle()
  await ctx.post('post-day-sweep', day, { op: 'sweep' })
  await ctx.post('post-day-thread-existing', day, { op: 'thread', itemId: f.a, message: 'Summarise his last message.', requestId: 'day-thread-1' })
  await ctx.post('post-day-thread-new', day, { op: 'thread', itemId: f.plain, message: 'What is this about?', requestId: 'day-thread-2' })
  await ctx.post('post-day-thread-no-request-id', day, { op: 'thread', itemId: f.plain, message: 'again' })
  await ctx.post('post-day-unknown-op', day, { op: 'explode' })
  await ctx.post('post-day-create-duplicate', '/api/managed', { requestId: 'day-create-1', kind: 'day', cwd: ctx.dirs.repos, prompt: '' }, { note: 'one Day per local date' })
  await ctx.post('post-projects-today', `/api/projects/${f.project}/today`, { deliverableId: f.deliverable })
  await ctx.post('post-projects-today-again', `/api/projects/${f.project}/today`, { deliverableId: f.deliverable }, { note: 'duplicate retry returns the existing item' })
  const second = ctx.manager.projects.get(f.project).deliverables[1].id
  await ctx.post('post-projects-today-new', `/api/projects/${f.project}/today`, { deliverableId: second }, { note: 'the board already holds 200 items, so this surfaces as a plain 500; projects-collision captures the success path' })
  await ctx.post('post-projects-today-unknown', `/api/projects/${f.project}/today`, { deliverableId: 'nope' })
  await ctx.settle()
  await ctx.get('get-day-after', '/api/managed/day-today')
  await ctx.get('get-progress-after', '/api/progress?days=7')
}
