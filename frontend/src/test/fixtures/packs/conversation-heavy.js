'use strict'
// conversation-heavy: 200 mixed messages, a growing streaming message, code, diff, tool
// and truncated output, images and references, queued follow-ups, stale and current
// approvals, and an actual error. Also a Codex conversation and an external history.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const BIG_OUTPUT = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: ${'x'.repeat(30)}`).join('\n')
const REPLIES = [
  'Here is the plan:\n\n1. Read the failing test\n2. Reproduce it\n3. Fix the cause, not the symptom\n\n> Note: the timer is the suspect.',
  'I changed the helper:\n\n```js\nexport function wait(ms) {\n  return new Promise(resolve => setTimeout(resolve, ms))\n}\n```\n\nThe `wait` call now takes the real clock.',
  'The table below summarises the run.\n\n| Suite | Result |\n| --- | --- |\n| unit | pass |\n| e2e | fail |\n\nUnsafe markup must stay inert: <script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)>',
  'Done. See https://github.com/example-org/web-app/pull/41 and https://linear.app/team/issue/TECH-101/checkout for context.',
]

exports.prepare = async ctx => {
  const { MIN, uid } = ctx
  const web = ctx.git('web-app', { branch: 'feat/checkout' })
  const base = ctx.now() - 200 * MIN
  const messages = []
  let n = 0
  const at = () => base + (n++) * 40000
  for (let i = 0; i < 40; i++) {
    messages.push(ctx.message(`h-u-${i}`, 'user', i % 7 === 0 ? `Question ${i}: why does the checkout test flake on slow machines?\nPlease include the exact failing assertion.` : `Follow-up ${i}`, at()))
    messages.push(ctx.tool(`h-t-${i}-a`, 'Read', { file_path: `${web}/src/checkout.ts` }, at(), { result: 'export const total = (items) => items.reduce((a, b) => a + b.price, 0)', target: 'src/checkout.ts', ms: 12 }))
    if (i % 4 === 0) messages.push(ctx.tool(`h-t-${i}-b`, 'Bash', { command: 'npm test -- checkout' }, at(), { result: BIG_OUTPUT.slice(0, 6000), target: 'npm test -- checkout', ms: 8200, approval: 'asked' }))
    else if (i % 4 === 1) messages.push(ctx.tool(`h-t-${i}-b`, 'Edit', { file_path: `${web}/src/checkout.ts`, old_string: 'const wait = () => sleep(500)', new_string: 'const wait = () => events.once("settled")' }, at(), { result: 'The file has been updated.', target: 'src/checkout.ts', ms: 30 }))
    else if (i % 4 === 2) messages.push(ctx.tool(`h-t-${i}-b`, 'TodoWrite', { todos: [{ content: 'Reproduce the flake', status: 'completed', activeForm: 'Reproducing' }, { content: 'Fix the wait', status: 'in_progress', activeForm: 'Fixing the wait' }, { content: 'Add a regression test', status: 'pending', activeForm: 'Adding a test' }] }, at(), { result: 'Todos updated.', ms: 4 }))
    else messages.push(ctx.tool(`h-t-${i}-b`, 'Task', { description: 'Review the change', subagent_type: 'reviewer', prompt: 'Review the checkout change for races.' }, at(), { result: 'The reviewer found no races but asked for one more test.', target: 'Review the change', ms: 15000 }))
    if (i === 13) messages.push(ctx.tool(`h-t-${i}-c`, 'Bash', { command: 'cat build.log' }, at(), { status: 'error', result: BIG_OUTPUT, target: 'cat build.log', ms: 90 }))
    if (i === 20) messages.push(ctx.message('h-e-1', 'event', 'Context was compacted to keep the conversation going.', at()))
    messages.push(ctx.message(`h-a-${i}`, 'assistant', REPLIES[i % REPLIES.length], at()))
  }
  const trimmed = messages.slice(-197)
  // The last assistant message is still streaming.
  trimmed.push(ctx.message('h-u-last', 'user', 'Now summarise what changed.', base + 7900000, { attachments: [{ id: `${uid(0xa77, 1)}.png`, mediaType: 'image/png', bytes: PNG.length }], references: [{ id: 'ref-1', sessionId: uid(0xc1, 1), title: 'checkout-refactor', project: web, state: 'busy', capturedAt: base, context: 'Recent activity: Edit: src/checkout.ts' }] }))
  trimmed.push(ctx.message('h-a-stream', 'assistant', 'Summary so far: the checkout test waited on a fixed timer, so', base + 7940000))
  const attachments = path.join(ctx.dirs.home, 'attachments')
  fs.mkdirSync(attachments, { recursive: true })
  fs.writeFileSync(path.join(attachments, `${uid(0xa77, 1)}.png`), PNG)
  const heavy = ctx.managed('c-heavy', {
    name: 'Fix flaky checkout test', cwd: web, status: 'running', currentTool: null, sessionId: uid(0x5e, 20), contextTokens: 168000,
    messages: trimmed, updatedAt: ctx.now() - 2000,
    queue: [{ message: 'After that, update the changelog', attachments: [], references: [] }, { message: 'And open the PR', attachments: [], references: [] }],
    approvals: [
      { id: 'ap-current', tool: 'Bash', input: { command: 'git push --force origin feat/checkout' }, at: ctx.now() - MIN, reason: 'Force pushes', description: 'Force push the branch', role: null },
      { id: 'ap-ask', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which test runner should I use?', header: 'Runner', multiSelect: false, options: [{ label: 'vitest', description: 'Fast, ESM native' }, { label: 'jest', description: 'Already configured' }] }, { question: 'Which areas to cover?', header: 'Areas', multiSelect: true, options: [{ label: 'unit', description: '' }, { label: 'e2e', description: '' }] }] }, at: ctx.now() - 30000, reason: 'Asks you a question', description: null, role: null },
    ],
  })
  ctx.livePending(heavy)
  ctx.managed('c-error', { name: 'Run that failed', cwd: web, status: 'error', error: 'The model request failed: 529 overloaded. Send a message to retry.', sessionId: uid(0x5e, 21), messages: [ctx.message('e-u', 'user', 'Run the full suite', ctx.now() - 20 * MIN), ctx.tool('e-t', 'Bash', { command: 'npm run build' }, ctx.now() - 19 * MIN, { status: 'error', result: 'Error: build failed', ms: 3000 })], updatedAt: ctx.now() - 18 * MIN })
  ctx.managed('c-codex', { name: 'Codex: add retries', engine: 'codex', cwd: web, model: 'gpt-fixture', sessionId: uid(0x5e, 22), messages: [ctx.message('x-u', 'user', 'Add retries to the client', ctx.now() - 30 * MIN), ctx.tool('x-t', 'Bash', { command: 'rg retry src' }, ctx.now() - 29 * MIN, { result: 'src/client.ts:12: // retry later', ms: 40 }), ctx.message('x-a', 'assistant', 'Added exponential backoff to `client.ts`.', ctx.now() - 28 * MIN)], updatedAt: ctx.now() - 28 * MIN })
  ctx.claudeExternal({ id: uid(0xc1, 1), cwd: web, name: 'checkout-refactor', alive: true, busy: true, ageMin: 1, prompt: 'Refactor checkout', reply: 'Working.', extra: [
    { type: 'user', timestamp: new Date(ctx.now() - 90000).toISOString(), message: { content: 'Add a test for the refund path' } },
    { type: 'assistant', timestamp: new Date(ctx.now() - 60000).toISOString(), message: { content: [{ type: 'text', text: 'Adding `refund.test.ts`.' }, { type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: 'refund.test.ts', content: 'test("refund", () => {})' } }] } },
    { type: 'user', timestamp: new Date(ctx.now() - 59000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'File created.' }] } },
  ] })
  // What gh would say about the pull requests the conversation mentions.
  ctx.prStatuses.set('https://github.com/example-org/web-app/pull/41', { ok: true, url: 'https://github.com/example-org/web-app/pull/41', state: 'open', draft: false, number: 41, ci: { result: 'fail', failing: ['build', 'lint'], total: 5, pending: 0 } })
  ctx.save()
}

const fs = require('node:fs')
const path = require('node:path')

exports.capture = async ctx => {
  const { uid } = ctx
  await ctx.getCommon()
  await ctx.getSessions()
  await ctx.getDetails({ histories: 2 })
  await ctx.get('get-pr-status-open-ci-failing', '/api/pr-status?url=' + encodeURIComponent('https://github.com/example-org/web-app/pull/41'))
  // Streaming growth, conditional requests and packed messages (plan section 7).
  const first = await ctx.record('GET', '/api/managed/c-heavy')
  const known = first.body.session.messages.map(m => m.h).filter(Boolean).join(',')
  ctx.write('managed-c-heavy-not-modified', { request: { method: 'GET', path: '/api/managed/c-heavy', headers: { 'If-None-Match': '<etag of managed/c-heavy>' } }, response: { status: (await ctx.record('GET', '/api/managed/c-heavy', { headers: { 'if-none-match': first.etag } })).status, body: null } })
  const s = ctx.manager.sessions.get('c-heavy')
  const last = s.messages.at(-1)
  last.text += ' the real event is awaited instead. The change is in `checkout.ts` and a regression test covers the slow path.'
  s.updatedAt = ctx.now()
  const grown = await ctx.record('GET', '/api/managed/c-heavy', { headers: { 'x-fleet-known': known } })
  ctx.write('managed-c-heavy-grown-packed', { request: { method: 'GET', path: '/api/managed/c-heavy', headers: { 'X-Fleet-Known': '<every message h in managed/c-heavy>' } }, response: { status: grown.status, body: grown.body } })
  // Current and stale approvals.
  await ctx.post('post-approval-stale', '/api/managed/c-heavy/approvals/ap-gone', { decision: 'allow' })
  await ctx.post('post-approval-answer-missing', '/api/managed/c-heavy/approvals/ap-ask', { decision: 'allow' }, { note: 'AskUserQuestion allowed without answers' })
  await ctx.post('post-approval-answer', '/api/managed/c-heavy/approvals/ap-ask', { decision: 'allow', answers: { 'Which test runner should I use?': 'vitest', 'Which areas to cover?': 'unit, e2e' } })
  await ctx.post('post-approval-deny', '/api/managed/c-heavy/approvals/ap-current', { decision: 'deny', reason: 'Not on a shared branch' })
  // Messages: queued behind a turn, then with an image and a reference once idle.
  await ctx.post('post-message-queued', '/api/managed/c-heavy/messages', { requestId: 'conv-msg-1', message: 'One more thing' }, { note: 'a turn is running, so the message queues' })
  await ctx.post('post-stop', '/api/managed/c-heavy/stop', {})
  await ctx.settle()
  const png = PNG.toString('base64')
  await ctx.post('post-message-with-image', '/api/managed/c-error/messages', { requestId: 'conv-msg-2', message: 'Retry with this screenshot', images: [{ data: png, mediaType: 'image/png' }] })
  await ctx.settle()
  await ctx.post('post-message-image-invalid', '/api/managed/c-error/messages', { requestId: 'conv-msg-3', message: 'bad image', images: [{ data: Buffer.from('not an image').toString('base64') }] })
  await ctx.post('post-message-too-many-images', '/api/managed/c-error/messages', { requestId: 'conv-msg-4', message: 'many', images: Array(7).fill({ data: png }) })
  await ctx.post('post-message-with-reference', '/api/managed/c-error/messages', { requestId: 'conv-msg-5', message: 'Compare with that session', references: [uid(0xc1, 1)] })
  await ctx.settle()
  await ctx.post('post-message-self-reference', '/api/managed/c-error/messages', { requestId: 'conv-msg-6', message: 'self', references: ['c-error'] })
  await ctx.post('post-message-gif-to-codex', '/api/managed/c-codex/messages', { requestId: 'conv-msg-7', message: 'gif', images: [{ data: 'R0lGODlhAQABAAAAACw=' }] }, { note: 'Codex refuses GIF before accepting the message' })
  const done = await ctx.record('GET', '/api/managed/c-error')
  ctx.write('managed-c-error-after-image', { request: { method: 'GET', path: '/api/managed/c-error' }, response: { status: done.status, body: done.body } })
  const attachment = done.body.session.messages.flatMap(m => m.attachments || [])[0]
  if (attachment) await ctx.get('get-attachment', `/api/attachments/${attachment.id}`)
  await ctx.post('post-day-on-agent', '/api/managed/c-error/day', { op: 'sweep' }, { note: 'a Day action on a session that is not a Day' })
}
