'use strict'
// teams-heavy: a normal team initiative and an owner-review initiative, 25 delegations
// including the oldest, 200 steps on one delegation, and failed, interrupted, completed
// and running handoffs. Plus the team catalog and editor routes.

const path = require('node:path')

const steps = (prefix, n, at) => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}-step-${i}`, tool: ['Read', 'Grep', 'Edit', 'Bash'][i % 4], target: `src/file-${i % 17}.ts`, status: 'done',
  input: { file_path: `src/file-${i % 17}.ts` }, result: `step ${i} ok`, ms: 20 + i, truncated: i % 50 === 0, at: at + i * 1000,
}))

exports.prepare = async ctx => {
  const { MIN, uid } = ctx
  const repo = ctx.git('delivery-repo', { branch: 'feat/delivery' })
  const ownerRepo = ctx.git('owner-repo', { branch: 'feat/owner' })
  const bugfix = ctx.manager.teams.get('bugfix')
  const ownerReview = ctx.manager.teams.get('owner-review')
  const t0 = ctx.now() - 5 * 60 * MIN

  // A normal team: 6 tasks, 25 delegations.
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: uid(0x7a, i + 1), title: `Task ${i + 1}: ${['Add the endpoint', 'Wire the form', 'Migrate the schema', 'Write the docs', 'Harden validation', 'Ship the flag'][i]}`,
    owner: 'developer', criteria: ['It works', 'It is tested'], dependencies: i > 0 && i < 3 ? [uid(0x7a, i)] : [],
    status: ['verified', 'verified', 'review', 'changes_requested', 'blocked', 'pending'][i], attempt: i < 5 ? 1 + (i % 2) : 0,
    reviews: i < 2 ? { qa: { verdict: 'PASS', delegationId: uid(0xd1, 2 * i + 2), attempt: 1 } } : i === 3 ? { qa: { verdict: 'FAIL', delegationId: uid(0xd1, 8), attempt: 1 } } : {},
    blocker: i === 4 ? 'Delegation failed. Read the report before retrying.' : null, createdAt: t0 + i * MIN,
  }))
  const delegations = []
  for (let i = 1; i <= 25; i++) {
    const status = i === 25 ? 'running' : i === 24 ? 'interrupted' : i === 23 ? 'failed' : 'completed'
    const task = tasks[(i - 1) % 6]
    delegations.push({
      id: uid(0xd1, i), taskId: task.id, role: i % 2 ? 'developer' : 'qa', attempt: 1 + Math.floor(i / 13), status,
      startedAt: t0 + i * 3 * MIN, finishedAt: status === 'running' ? null : t0 + i * 3 * MIN + 2 * MIN,
      prompt: `Fleet task: ${task.id}\n\nDo the work for ${task.title}. Mandate ${i}.`,
      report: status === 'running' ? null : i % 2 ? `Implemented ${task.title}.` : `PASS: verified ${task.title} with tests and a manual check.`,
      output: status === 'running' ? 'Working on it...' : '',
      activity: status === 'running' ? 'Edit src/form.ts' : null, tokens: 1000 * i,
      steps: i === 1 ? steps('d1', 200, t0) : i === 25 ? steps('d25', 8, t0 + 90 * MIN).map((x, j) => (j === 7 ? { ...x, status: 'running', result: null, ms: null } : x)) : steps(`d${i}`, 3, t0 + i * MIN),
    })
  }
  ctx.managed('t-team', {
    name: 'Ship the checkout flow', cwd: repo, kind: 'initiative', teamId: 'bugfix', teamName: bugfix.name, teamSnapshot: structuredClone(bugfix),
    status: 'running', sessionId: uid(0x5e, 30), limits: { maxAttempts: 3 },
    taskBoard: { tasks, delegations }, updatedAt: ctx.now() - 3000,
    messages: [ctx.message('tt-u', 'user', 'Ship the checkout flow with the bugfix team', t0), ctx.message('tt-a', 'assistant', 'I split this into six tasks and started the first delegations.', t0 + MIN)],
    worktree: { path: repo, branch: 'feat/delivery', base: 'main', root: repo },
  })

  // Owner + review: one durable request task, reviewer delegations only.
  const ownerReviewModule = require(path.join(__dirname, '../../../../../owner-review.js'))
  const snapshot = ownerReviewModule.snapshot({ cwd: ownerRepo })
  const orTask = { id: uid(0x7b, 1), title: 'Implement the request', owner: 'owner', criteria: ['Behavior matches the request', 'Tests pass'], dependencies: [], status: 'verified', attempt: 2, reviews: { reviewer: { verdict: 'PASS', delegationId: uid(0xd2, 2), attempt: 2 } }, blocker: null, createdAt: t0, snapshot, evidence: 'npm test: 120 passed; manual check of the checkout path done.' }
  ctx.managed('t-owner', {
    name: 'Owner + review: refund path', cwd: ownerRepo, kind: 'initiative', teamId: 'owner-review', teamName: ownerReview.name, teamSnapshot: structuredClone(ownerReview),
    status: 'idle', sessionId: uid(0x5e, 31), reviewBaseCommit: snapshot.commit, ownerRequest: 'Fix the refund path.', limits: null,
    taskBoard: { tasks: [orTask], delegations: [
      { id: uid(0xd2, 1), taskId: orTask.id, role: 'reviewer', attempt: 1, status: 'completed', startedAt: t0, finishedAt: t0 + 4 * MIN, prompt: 'Review the refund change.', report: 'FAIL: the refund total ignores shipping. Add a test and fix it.', snapshot, steps: steps('o1', 5, t0) },
      { id: uid(0xd2, 2), taskId: orTask.id, role: 'reviewer', attempt: 2, status: 'completed', startedAt: t0 + 30 * MIN, finishedAt: t0 + 34 * MIN, prompt: 'Review the repaired refund change.', report: 'PASS: shipping is now included, covered by refund.test.ts, suite green.', snapshot, steps: steps('o2', 4, t0 + 30 * MIN) },
    ] },
    messages: [ctx.message('to-u', 'user', 'Fix the refund path', t0), ctx.message('to-a', 'assistant', 'Fixed and verified by the reviewer.', t0 + 40 * MIN)], updatedAt: ctx.now() - 20 * MIN,
  })
  ctx.save()
}

exports.capture = async ctx => {
  await ctx.getCommon()
  await ctx.getSessions()
  await ctx.getDetails({ histories: 0 })
  for (const id of ['bugfix', 'delivery', 'quick', 'owner-review']) await ctx.get(`team-${id}`, `/api/teams/${id}`)
  const custom = {
    id: 'docs-team', name: 'Docs team', description: 'Writes and reviews docs.', manager: 'lead',
    roles: {
      lead: { description: 'Plans the docs', prompt: 'Plan the docs work.', model: 'sonnet', maxTurns: 20, effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Bash'] },
      writer: { description: 'Writes the docs', prompt: 'Write the docs.', model: 'sonnet', maxTurns: 30, effort: 'medium', tools: ['Read', 'Write', 'Edit'] },
      checker: { description: 'Checks the docs', prompt: 'Check the docs.', model: 'haiku', maxTurns: 15, effort: 'low', tools: ['Read', 'Grep'] },
    },
    workflow: { mode: 'team', reviewers: ['checker'], maxAttempts: 2 },
  }
  await ctx.post('post-team-save', '/api/teams', custom)
  await ctx.get('get-teams-after-save', '/api/teams')
  await ctx.post('post-team-update', '/api/teams', { ...custom, description: 'Writes and reviews docs, now with a changelog.' })
  await ctx.post('post-team-builtin', '/api/teams', { ...custom, id: 'bugfix' }, { note: 'built-in teams are read-only' })
  await ctx.post('post-team-too-few-roles', '/api/teams', { ...custom, id: 'tiny', roles: { lead: custom.roles.lead } })
  await ctx.post('post-team-owner-review', '/api/teams', {
    id: 'my-owner-review', name: 'My owner and review', description: 'One owner, one reviewer.', manager: 'owner',
    roles: { owner: { ...custom.roles.writer, tools: ['Read', 'Write', 'Edit', 'Bash'] }, reviewer: custom.roles.checker },
    workflow: { mode: 'owner-review', reviewers: ['reviewer'], maxAttempts: 3 },
  })
  await ctx.post('post-limits', '/api/managed/t-owner/limits', { maxAttempts: 4 })
  await ctx.post('post-limits-invalid', '/api/managed/t-owner/limits', { maxAttempts: 40 })
  await ctx.post('post-limits-wrong-session', '/api/managed/t-team/limits', { maxAttempts: 2 }, { note: 'active manager run' })
  await ctx.post('post-managed-team-launch', '/api/managed', { requestId: 'team-launch-1', cwd: ctx.dirs.repos + '/delivery-repo', prompt: 'Start a team initiative', teamId: 'quick' })
  await ctx.settle()
  await ctx.post('post-managed-team-unknown', '/api/managed', { requestId: 'team-launch-2', cwd: ctx.dirs.repos + '/delivery-repo', prompt: 'x', teamId: 'nope' })
}
