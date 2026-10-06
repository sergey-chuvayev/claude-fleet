'use strict'
// fleet-mixed: managed Claude and Codex, live and offline external sessions, a background
// observer, an archived row, a fork-pending copy, an externally held session, and every
// status the list can show. Also the HTTP guards, SSE, and the representative POSTs.

exports.prepare = async ctx => {
  const { MIN, HOUR, DAY, uid } = ctx
  const web = ctx.git('web-app', { branch: 'feat/checkout' })
  const api = ctx.git('api-service', { branch: 'main', commits: 2 })
  const docs = ctx.git('docs-site', { branch: 'docs/refresh' })

  // Linked worktrees for the Worktrees tab: one merged and clean (safe to clear), one with work in flight.
  const merged = ctx.worktree(web, 'web-app-merged', { merged: true })
  const wip = ctx.worktree(web, 'web-app-wip', { dirty: true })

  // External Claude sessions (real transcript and registry files in the temp ~/.claude).
  ctx.claudeExternal({ id: uid(0xc1, 1), cwd: web, name: 'checkout-refactor', alive: true, busy: true, ageMin: 1, prompt: 'Refactor checkout, see https://linear.app/team/issue/TECH-101/checkout', reply: 'Working on https://github.com/example-org/web-app/pull/41 now.' })
  ctx.claudeExternal({ id: uid(0xc1, 2), cwd: api, name: 'api-review', alive: true, ageMin: 12, reply: 'Review done. Two comments left on the PR.' })
  ctx.claudeExternal({ id: uid(0xc1, 3), cwd: docs, alive: false, ageMin: 3 * 60, prompt: 'Update the docs index', reply: 'Docs index updated.' })
  ctx.claudeExternal({ id: uid(0xc1, 4), cwd: web, name: 'stale-session', alive: true, ageMin: 4 * 24 * 60, prompt: 'Old idea', reply: 'Parked.' })
  ctx.claudeExternal({ id: uid(0xc1, 5), cwd: api, alive: false, ageMin: 9 * 24 * 60, prompt: 'Ancient task', reply: 'Finished long ago.' })
  ctx.claudeExternal({ id: uid(0xc1, 6), cwd: web, name: 'observer', alive: true, entrypoint: 'sdk-ts', ageMin: 2, prompt: 'Observe', reply: 'Observed.' })
  ctx.claudeExternal({ id: uid(0xc1, 7), cwd: docs, alive: false, ageMin: 26 * HOUR / MIN, prompt: 'Will be archived', reply: 'Archived row fixture.' })
  // Held elsewhere: a live terminal session a managed row continues.
  ctx.claudeExternal({ id: uid(0xc1, 9), cwd: merged, name: 'finished-branch', alive: false, ageMin: 6 * 60, prompt: 'Ship the merged branch', reply: 'Merged and done.' })
  ctx.claudeExternal({ id: uid(0xc1, 10), cwd: wip, name: 'branch-in-flight', alive: false, ageMin: 50, prompt: 'Work in flight', reply: 'Not merged yet.' })
  ctx.claudeExternal({ id: uid(0xc1, 8), cwd: api, name: 'held-in-terminal', alive: true, busy: true, ageMin: 1, prompt: 'Held', reply: 'Still in the terminal.' })

  // External Codex sessions.
  ctx.codexExternal({ id: uid(0xc0, 1), cwd: web, title: 'Codex: fix flaky test', live: true, ageMin: 1 })
  ctx.codexExternal({ id: uid(0xc0, 2), cwd: docs, title: 'Codex: rewrite README', live: false, ageMin: 90 })

  // Managed rows, one per status.
  const msgs = (id, prompt, reply) => [ctx.message(`${id}-u`, 'user', prompt, ctx.now() - 20 * MIN), ctx.message(`${id}-a`, 'assistant', reply, ctx.now() - 19 * MIN)]
  ctx.managed('m-claude-idle', { name: 'Fix flaky checkout test', cwd: web, sessionId: uid(0x5e, 1), messages: msgs('m1', 'Fix the flaky checkout test', 'Fixed. The test waited on a timer; now it awaits the event.'), updatedAt: ctx.now() - 19 * MIN })
  ctx.managed('m-claude-running', { name: 'Migrate settings screen', cwd: web, status: 'running', currentTool: 'Bash', sessionId: uid(0x5e, 2), messages: [...msgs('m2', 'Migrate the settings screen', 'Starting with the form state.'), ctx.tool('m2-t', 'Bash', { command: 'npm test' }, ctx.now() - 30000, { status: 'running', result: null, ms: null, target: 'npm test' })], updatedAt: ctx.now() - 10000 })
  const approving = ctx.managed('m-claude-approval', { name: 'Clean up stale branches', cwd: api, status: 'approval', sessionId: uid(0x5e, 3), messages: msgs('m3', 'Delete merged branches', 'I need approval to run git.'), approvals: [{ id: 'ap-1', tool: 'Bash', input: { command: 'git push origin --delete old-branch' }, at: ctx.now() - 2 * MIN, reason: 'Pushes to a remote', description: 'Delete the remote branch', role: null }], updatedAt: ctx.now() - 2 * MIN })
  ctx.livePending(approving)
  ctx.managed('m-claude-queued', { name: 'Waiting for a free agent', cwd: docs, status: 'queued', waitingForRelease: false, messages: [ctx.message('m4-u', 'user', 'Rewrite the changelog', ctx.now() - 3 * MIN)], updatedAt: ctx.now() - 3 * MIN })
  ctx.managed('m-claude-error', { name: 'Broken deploy script', cwd: api, status: 'error', error: 'The agent stopped: model request failed.', sessionId: uid(0x5e, 5), messages: msgs('m5', 'Fix the deploy script', 'Trying again.'), updatedAt: ctx.now() - 40 * MIN })
  ctx.managed('m-claude-stopped', { name: 'Interrupted by restart', cwd: docs, status: 'stopped', error: 'Fleet restarted. Send a message to continue this conversation.', sessionId: uid(0x5e, 6), messages: msgs('m6', 'Draft release notes', 'Halfway through.'), updatedAt: ctx.now() - 5 * HOUR })
  ctx.managed('m-codex-idle', { name: 'Codex: tidy imports', engine: 'codex', cwd: web, model: 'gpt-fixture', sessionId: uid(0x5e, 7), messages: msgs('m7', 'Tidy the imports', 'Imports sorted and unused ones removed.'), updatedAt: ctx.now() - 25 * MIN })
  ctx.managed('m-codex-running', { name: 'Codex: add retry logic', engine: 'codex', cwd: api, status: 'running', model: 'gpt-fixture', sessionId: uid(0x5e, 8), messages: msgs('m8', 'Add retry logic', 'Adding exponential backoff.'), updatedAt: ctx.now() - 8000 })
  // A forked copy of a live terminal session, not yet given its own id.
  ctx.managed('m-fork-pending', { name: 'Copy of api-review', cwd: api, status: 'running', forkPending: true, forkedFrom: uid(0xc1, 2), continuedFrom: uid(0xc1, 2), sessionId: uid(0xc1, 2), messages: msgs('m9', 'Continue the review', 'Reading the diff.'), updatedAt: ctx.now() - 5000 })
  // Continues a transcript that a terminal still holds open: shows the holder and waits.
  ctx.managed('m-held', { name: 'Waiting on the terminal', cwd: api, status: 'idle', sessionId: uid(0xc1, 8), queue: [{ id: 'q-1', message: 'Continue when free', attachments: [], references: [] }], waitingForRelease: true, messages: msgs('m10', 'Continue', 'Waiting for the terminal to release the session.'), updatedAt: ctx.now() - 4 * MIN })
  ctx.managed('m-tagged', { name: 'Tagged to a project', cwd: docs, projectId: null, messages: msgs('m11', 'Draft the plan', 'Plan drafted.'), updatedAt: ctx.now() - 15 * MIN })
  // The account's plan windows, as a rate_limit_event with unifiedWindows reports them.
  ctx.manager.usage.recordEvent({ unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: Math.floor((ctx.now() + 2 * HOUR) / 1000) }, seven_day: { utilization: 0.34, resetsAt: Math.floor((ctx.now() + 3 * DAY) / 1000) } } })
  ctx.save()
}

exports.capture = async ctx => {
  const { uid } = ctx
  await ctx.getCommon()
  await ctx.post('post-archive-external', '/api/archive', { ids: [uid(0xc1, 7)] })
  await ctx.post('post-archive-rule', '/api/archive/rule', { enabled: true, days: 7 })
  const snapshot = await ctx.getSessions()
  ctx.write('summary', { counts: snapshot.counts, total: snapshot.total, archived: snapshot.archived, rows: snapshot.sessions.map(s => ({ key: s.managedId || s.sessionId, engine: s.engine, managed: !!s.managed, state: s.state, managedStatus: s.managedStatus || null, alive: s.alive, archived: s.archived, background: !!s.background, forkPending: !!s.forkPending, holder: s.openElsewhere ? s.openElsewhere.name : null })) })
  await ctx.getDetails({ histories: 4 })
  await ctx.get('get-attachment-missing', '/api/attachments/00000000-0000-4000-8000-000000000000.png')

  await ctx.captureEvents('events-sse', async () => {
    ctx.manager.emit('change', 'm-claude-idle')
    ctx.manager.emit('change', 'm-claude-running')
    ctx.manager.emit('change', 'projects')
  })

  // POSTs, representative success and error bodies.
  await ctx.postGuards()
  await ctx.post('post-queue-enable', '/api/queue', { enabled: true, limit: 2 })
  await ctx.post('post-queue-invalid-limit', '/api/queue', { limit: 99 })
  await ctx.post('post-approval-mode', '/api/settings/approval-mode', { mode: 'auto' })
  await ctx.post('post-approval-mode-invalid', '/api/settings/approval-mode', { mode: 'yolo' })
  await ctx.post('post-gateway-remove', '/api/settings/gateway', { action: 'remove' })
  await ctx.post('post-gateway-invalid', '/api/settings/gateway', { action: 'explode' })
  await ctx.post('post-service-disable', '/api/service', { enabled: false })
  await ctx.post('post-update', '/api/update', {})
  const search = await ctx.post('post-search', '/api/search', { question: 'what did we decide about the checkout?' })
  await ctx.settle(200)
  if (search.body?.job) await ctx.get('get-search-job', `/api/search/${search.body.job.id}`)
  await ctx.post('post-search-invalid', '/api/search', { question: '' })

  ctx.script('Created from the fixture launch.')
  const created = await ctx.post('post-managed-create', '/api/managed', { requestId: 'fixture-launch-1', cwd: ctx.dirs.repos, prompt: 'Start a new fixture agent', model: '' })
  await ctx.settle()
  await ctx.post('post-managed-create-same-request', '/api/managed', { requestId: 'fixture-launch-1', cwd: ctx.dirs.repos, prompt: 'Start a new fixture agent' }, { note: 'retry with the same request id returns the same session' })
  await ctx.post('post-managed-create-no-request-id', '/api/managed', { cwd: ctx.dirs.repos, prompt: 'x' })
  await ctx.post('post-managed-create-bad-cwd', '/api/managed', { requestId: 'fixture-launch-2', cwd: '/does/not/exist', prompt: 'x' })
  await ctx.post('post-managed-create-codex-with-team', '/api/managed', { requestId: 'fixture-launch-3', cwd: ctx.dirs.repos, prompt: 'x', engine: 'codex', teamId: 'anything' })
  const id = created.body.session?.id
  if (id) {
    ctx.script('A follow-up reply.')
    await ctx.post('post-message', `/api/managed/${id}/messages`, { requestId: 'fixture-msg-1', message: 'And a follow-up' })
    await ctx.settle()
    await ctx.post('post-message-no-request-id', `/api/managed/${id}/messages`, { message: 'no id' })
    await ctx.post('post-name', `/api/managed/${id}/name`, { name: 'Renamed in the fixture' })
    await ctx.post('post-name-empty', `/api/managed/${id}/name`, { name: '' })
    await ctx.post('post-mode', `/api/managed/${id}/mode`, { mode: 'all' })
    await ctx.post('post-mode-invalid', `/api/managed/${id}/mode`, { mode: 'nope' })
    await ctx.post('post-model', `/api/managed/${id}/model`, { model: 'sonnet' })
    await ctx.post('post-stop', `/api/managed/${id}/stop`, {})
    await ctx.post('post-approval-stale', `/api/managed/${id}/approvals/missing`, { decision: 'allow' }, { note: 'an approval that no longer exists' })
    await ctx.post('post-close', `/api/managed/${id}/close`, {})
  }
  await ctx.post('post-message-missing-session', '/api/managed/missing/messages', { requestId: 'fixture-msg-2', message: 'x' })
  await ctx.post('post-restore-external', '/api/archive', { ids: [uid(0xc1, 7)], archived: false })
}
