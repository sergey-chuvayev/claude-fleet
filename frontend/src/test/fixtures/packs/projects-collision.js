'use strict'
// projects-collision: two projects with equal deliverable titles, same-project
// punctuation, Unicode and 60-character-prefix collisions, archived projects with the
// active cap reached, a Markdown file edited by hand, and arbitrary sections that must
// survive. Also the project routes: create, archive, deliverable, ask, comment, today.

const fs = require('node:fs')

exports.prepare = async ctx => {
  const { MIN, HOUR, uid } = ctx
  const store = ctx.manager.projects
  const repo = ctx.git('projects-repo', { branch: 'main' })
  const alpha = store.create({ name: 'Alpha launch' })
  const beta = store.create({ name: 'Beta launch' })
  const long = 'Rewrite the whole checkout so that totals, taxes and shipping agree everywhere'
  store.define(alpha.id, {
    brief: 'Ship the Alpha launch.', deadline: '2026-10-18', repos: [repo], links: ['https://github.com/example-org/web-app/pull/41'],
    deliverables: [
      { title: 'Ship it', brief: 'Cut the release.\nDone when: tagged and deployed.', links: ['https://linear.app/team/issue/TECH-301/ship'] },
      'Fix login!', 'Fix login?', 'Fix  login', 'Café menu', 'Cafe menu',
      `${long}: part one`, `${long}: part two`,
    ],
  })
  store.define(beta.id, { brief: 'Ship the Beta launch.', deadline: '2026-11-02', deliverables: ['Ship it', 'Write the docs'] })
  store.section(alpha.id, 'Sources', '- Notion: Alpha plan\n- Slack: #alpha')
  store.section(alpha.id, 'Decisions', '- 2026-10-02 Ship on Friday.')
  store.section(alpha.id, 'Risks', 'Vendor delay on the payments sandbox.')
  const first = store.get(alpha.id)
  store.deliverable(alpha.id, first.deliverables[0].id, { state: 'doing', note: 'PR #41 rebasing' })
  store.deliverable(alpha.id, first.deliverables[1].id, { state: 'done' })
  store.note(alpha.id, 'Agreed scope with Franco.')
  // A hand edit: a renamed title keeps its id, a new line gets one on first read, a
  // section is added, and the Log is touched.
  const file = store.get(alpha.id).file
  let text = fs.readFileSync(file, 'utf8')
  text = text.replace('- [ ] Café menu', '- [ ] Café menu (renamed by hand)')
  text = text.replace(/(## Deliverables\n\n)/, '$1- [ ] Hand-added deliverable\n')
  text += '\n## Hand notes\n\nWritten in an editor, not through Fleet.\n'
  fs.writeFileSync(file, text)
  ctx.writeText('markdown/alpha-launch.md', fs.readFileSync(file, 'utf8'))
  // Archived projects, then enough active ones to sit at the cap of 30.
  for (const name of ['Old research', 'Retired migration']) store.archive(store.create({ name }).id, true)
  let n = 0
  while (store.active() < 30) store.create({ name: `Filler ${String(++n).padStart(2, '0')}` })
  // A Day, so a deliverable can be planned on Today.
  ctx.managed('day-today', { name: 'Day 2026-10-06', kind: 'day', cwd: repo, sessionId: uid(0x5e, 50), dayChecks: { lastAt: ctx.now() - 20 * MIN, everyMin: 30, hours: [8, 19] }, createdAt: ctx.now() - 2 * HOUR })
  ctx.manager.sessions.get('day-today').dayBoard = { date: '2026-10-06', items: [], cursors: {} }
  ctx.save()
  ctx.fixtureProjects = { alpha: alpha.id, beta: beta.id }
}

exports.capture = async ctx => {
  const { alpha, beta } = ctx.fixtureProjects
  await ctx.getCommon()
  const store = ctx.manager.projects
  const a = store.get(alpha)
  ctx.writeText('markdown/alpha-launch-after-read.md', fs.readFileSync(a.file, 'utf8'))
  await ctx.get('get-projects-active-at-cap', '/api/projects')
  // The cap: 30 active. Archived projects do not count; restoring at the cap is refused.
  await ctx.post('post-project-create-at-cap', '/api/projects', { name: 'One too many' })
  await ctx.post('post-project-archive', `/api/projects/${store.list().find(p => p.name === 'Filler 01').id}/archive`, { archived: true })
  await ctx.post('post-project-create-after-archive', '/api/projects', { name: 'Fresh start', note: 'Plan the Q4 launch.', requestId: 'proj-create-1' })
  await ctx.settle()
  const restoreId = store.list({ archived: true }).find(p => p.name === 'Old research').id
  await ctx.post('post-project-restore-at-cap', `/api/projects/${restoreId}/archive`, { archived: false }, { note: 'restoring needs a free slot; the project stays archived' })
  await ctx.get('get-projects-archived-at-cap', '/api/projects?archived=1')
  // Setup that cannot start (every agent busy) keeps the project and says so (B01).
  await ctx.post('post-project-archive-2', `/api/projects/${store.list().find(p => p.name === 'Filler 02').id}/archive`, { archived: true })
  for (let i = 0; i < 8; i++) ctx.manager.runs.set(`busy-${i}`, { controller: new AbortController() })
  await ctx.post('post-project-create-agents-busy', '/api/projects', { name: 'Created while busy' }, { note: 'no free agent: the project is kept, setup.started is false, no storage error' })
  await ctx.get('get-control-after-busy-create', '/api/control')
  await ctx.post('post-project-ask-busy', `/api/projects/${beta}/ask`, { message: 'Set this up' }, { note: 'capacity 409' })
  ctx.manager.runs.clear()
  await ctx.post('post-project-ask', `/api/projects/${beta}/ask`, { message: 'What is the status of Beta?', requestId: 'proj-ask-1' })
  await ctx.settle()
  await ctx.post('post-project-ask-empty', `/api/projects/${beta}/ask`, { message: '' })
  await ctx.post('post-project-missing', '/api/projects/nope/archive', {})
  // Deliverables with equal titles are different tasks, by project and id.
  const ad = store.get(alpha).deliverables, bd = store.get(beta).deliverables
  const ship = ad.find(d => d.title === 'Ship it')
  ctx.write('collision-ids', { alpha: ad.map(d => ({ id: d.id, title: d.title })), beta: bd.map(d => ({ id: d.id, title: d.title })) })
  await ctx.post('post-deliverable-state', `/api/projects/${alpha}/deliverable`, { deliverableId: ad[2].id, state: 'review', note: 'waiting on QA' })
  await ctx.post('post-deliverable-invalid-state', `/api/projects/${alpha}/deliverable`, { deliverableId: ad[2].id, state: 'finished' })
  await ctx.post('post-deliverable-missing', `/api/projects/${alpha}/deliverable`, { deliverableId: 'nope', state: 'done' })
  await ctx.post('post-today-alpha-ship', `/api/projects/${alpha}/today`, { deliverableId: ship.id })
  await ctx.post('post-today-beta-ship', `/api/projects/${beta}/today`, { deliverableId: bd[0].id }, { note: 'same title, other project: a separate item' })
  await ctx.post('post-today-alpha-ship-again', `/api/projects/${alpha}/today`, { deliverableId: ship.id }, { note: 'retry returns the existing item' })
  await ctx.post('post-comment', `/api/projects/${alpha}/comment`, { deliverableId: ad[0].id, message: 'Please add the rollback plan to the brief.', requestId: 'proj-comment-1' })
  await ctx.settle()
  await ctx.post('post-comment-empty', `/api/projects/${alpha}/comment`, { deliverableId: ad[0].id, message: '' })
  await ctx.post('post-comment-unknown-deliverable', `/api/projects/${alpha}/comment`, { deliverableId: 'nope', message: 'hello' })
  await ctx.get('get-projects-final', '/api/projects')
  await ctx.get('get-day-final', '/api/managed/day-today')
  ctx.writeText('markdown/alpha-launch-final.md', fs.readFileSync(store.get(alpha).file, 'utf8'))
  await ctx.getSessions()
}
