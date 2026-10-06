'use strict'
// failure-lifecycle: what the client sees when things go wrong. Captured for real where
// the server can be made to do it (token rotation by restart, the storage latch and its
// recovery, SSE connection limit and bursts, 304, 431, missing assets). Everything that
// is about timing or the network (reversed responses, a dropped mutation response, a
// request timeout, an incompatible build) is a scripted list of responses in
// scenarios.json, for a mock transport to replay.

const http = require('node:http')

exports.prepare = async ctx => {
  const { MIN, uid } = ctx
  const repo = ctx.git('fail-repo', { branch: 'main' })
  ctx.claudeExternal({ id: uid(0xc1, 1), cwd: repo, name: 'terminal-session', alive: true, ageMin: 2 })
  ctx.managed('f-one', { name: 'First agent', cwd: repo, sessionId: uid(0x5e, 60), messages: [ctx.message('f1-u', 'user', 'Do the thing', ctx.now() - 9 * MIN), ctx.message('f1-a', 'assistant', 'Done.', ctx.now() - 8 * MIN)], updatedAt: ctx.now() - 8 * MIN })
  ctx.managed('f-two', { name: 'Second agent', cwd: repo, sessionId: uid(0x5e, 61), messages: [ctx.message('f2-u', 'user', 'Do the other thing', ctx.now() - 7 * MIN)], updatedAt: ctx.now() - 6 * MIN })
  ctx.save()
}

const rawGet = (base, route, headers) => new Promise((resolve, reject) => {
  const req = http.get(base + route, { headers }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
  })
  req.on('error', error => resolve({ status: null, error: error.code || error.message }))
})

exports.capture = async ctx => {
  // 1. Token rotation by server restart: a new app on the same state has a new token.
  const first = await ctx.get('token-1-control', '/api/control')
  const staleToken = ctx.token
  const second = ctx.createApp()
  await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve))
  const nextBase = `http://127.0.0.1:${second.server.address().port}`
  const control2 = await (await fetch(nextBase + '/api/control')).json()
  ctx.secrets.push(control2.token)
  const stale = await fetch(nextBase + '/api/queue', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-token': staleToken, origin: nextBase }, body: '{"enabled":true}' })
  ctx.write('token-2-stale-token-rejected', { request: { method: 'POST', path: '/api/queue', note: 'token from the previous process' }, response: { status: stale.status, contentType: 'application/json', body: await stale.json() } })
  ctx.write('token-3-control-after-restart', { request: { method: 'GET', path: '/api/control', note: 'new process, new token and a new instanceId' }, response: { status: 200, contentType: 'application/json', body: { ...control2 } } })
  const retried = await fetch(nextBase + '/api/queue', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet-token': control2.token, origin: nextBase }, body: '{"enabled":true}' })
  ctx.write('token-4-retry-with-new-token', { request: { method: 'POST', path: '/api/queue' }, response: { status: retried.status, contentType: 'application/json', body: await retried.json() } })
  await second.close(); second.server.closeAllConnections()
  void first

  // 2. The storage latch: a failed write locks POSTs (except stop and update) and clears
  //    when a write lands again, not when a page reads the list.
  ctx.manager.emit('storage-error', new Error('ENOSPC: no space left on device'))
  await ctx.get('storage-1-control-latched', '/api/control')
  await ctx.post('storage-2-post-refused', '/api/queue', { enabled: true }, { note: 'any write is refused with 503 while latched' })
  await ctx.get('storage-3-reads-still-work', '/api/sessions')
  await ctx.get('storage-4-control-still-latched-after-read', '/api/control')
  await ctx.post('storage-5-stop-allowed', '/api/managed/f-one/stop', {}, { note: 'stop stays available' })
  await ctx.post('storage-6-update-allowed', '/api/update', {}, { note: 'update stays available' })
  ctx.manager.save()
  await ctx.get('storage-7-control-recovered', '/api/control')
  await ctx.post('storage-8-post-after-recovery', '/api/queue', { enabled: false })

  // 3. Conditional requests: 304, the packed sequence, an oversized header (431).
  const list = await ctx.record('GET', '/api/sessions')
  const notModified = await ctx.record('GET', '/api/sessions', { headers: { 'if-none-match': list.etag } })
  ctx.write('conditional-1-not-modified', { request: { method: 'GET', path: '/api/sessions', headers: { 'If-None-Match': '<etag>' } }, response: { status: notModified.status, body: notModified.text || null } })
  const known = list.body.sessions.map(s => s.h).join(',')
  const packed = await ctx.record('GET', '/api/sessions', { headers: { 'x-fleet-known': known } })
  ctx.write('conditional-2-packed', { request: { method: 'GET', path: '/api/sessions', headers: { 'X-Fleet-Known': '<every h>' } }, response: { status: packed.status, body: packed.body } })
  const huge = await rawGet(ctx.base, '/api/sessions', { 'x-fleet-known': ('A'.repeat(16) + ',').repeat(1500), 'if-none-match': list.etag })
  ctx.write('conditional-3-header-too-large', { request: { method: 'GET', path: '/api/sessions', headers: { 'X-Fleet-Known': '<25 KB of fingerprints>' } }, response: { status: huge.status, error: huge.error || null, body: huge.body || null } })
  const retry = await ctx.record('GET', '/api/sessions')
  ctx.write('conditional-4-retry-without-headers', { request: { method: 'GET', path: '/api/sessions', note: 'one retry without conditional headers' }, response: { status: retry.status, body: { sessions: retry.body.sessions.length } } })

  // 4. SSE: the 20-connection limit and a burst of invalidations.
  const open = []
  for (let i = 0; i < 20; i++) open.push(await new Promise(resolve => { const req = http.get(ctx.base + '/api/events', res => { res.resume(); resolve({ req, status: res.statusCode }) }) }))
  await ctx.get('sse-1-twenty-first-connection', '/api/events')
  for (const c of open) c.req.destroy()
  await ctx.sleep(100)
  await ctx.captureEvents('sse-2-burst-and-duplicates', async () => {
    for (let i = 0; i < 30; i++) ctx.manager.emit('change', i % 2 ? 'f-one' : 'f-two')
    ctx.manager.emit('change', 'f-one')
    ctx.manager.emit('change', 'queue')
    ctx.manager.emit('change', 'projects')
  })

  // 5. Missing assets answer 404 JSON, never HTML; nothing outside the allowlist is served.
  await ctx.get('asset-1-missing-attachment', '/api/attachments/00000000-0000-4000-8000-000000000000.png')
  await ctx.get('asset-2-unknown-script', '/assets/index-abc123.js')
  const traversal = await rawGet(ctx.base, '/..%2f..%2fetc%2fpasswd', {})
  ctx.write('asset-3-traversal', { request: { method: 'GET', path: '/..%2f..%2fetc%2fpasswd' }, response: { status: traversal.status, body: traversal.body ? JSON.parse(traversal.body) : null } })

  // 6. Scripted network behavior, replayed by a mock transport.
  ctx.write('scenarios', {
    note: 'Scripted responses for the cases the real server cannot produce on demand. `at` is milliseconds from the start of the scenario. Shapes reference real fixtures where they exist.',
    scenarios: [
      { id: 'reversed-responses', covers: 'A25', steps: [
        { at: 0, send: 'GET /api/managed/f-one', respondAt: 400, respond: { fixtureLike: 'managed detail', messages: 2 }, note: 'sent first, answers last' },
        { at: 50, send: 'POST /api/managed/f-one/messages', respondAt: 100, respond: { status: 200, session: { messages: 3 } }, note: 'the mutation answers first' },
        { at: 120, send: 'GET /api/managed/f-one', respondAt: 200, respond: { fixtureLike: 'managed detail', messages: 3 } },
      ], expect: 'the 400 ms response with 2 messages must not replace the 3-message state' },
      { id: 'dropped-mutation-response', covers: 'A26', steps: [
        { at: 0, send: 'POST /api/managed/f-one/messages {requestId:R}', serverEffect: 'message accepted', networkError: 'ECONNRESET before the response' },
        { at: 200, send: 'GET /api/managed/f-one', respond: { messages: 3 } },
        { at: 300, send: 'POST /api/managed/f-one/messages {requestId:R}', respond: { status: 200, note: 'same request id: the same session, no second message' } },
      ], expect: 'reconcile by refetching; only a requestId-deduped route may be retried' },
      { id: 'request-timeout', covers: 'A25', steps: [
        { at: 0, send: 'GET /api/sessions', hangMs: 20000 },
        { at: 15000, abort: true },
        { at: 15500, send: 'GET /api/sessions', respond: { status: 200 } },
      ], expect: 'last good data stays on screen with a stale indicator, one retry with jitter' },
      { id: 'disk-full-and-recovery', covers: 'A27', real: ['storage-1-control-latched', 'storage-2-post-refused', 'storage-4-control-still-latched-after-read', 'storage-7-control-recovered'], expect: 'banner appears with the latch, survives reads, clears after a write lands; stop and update stay allowed' },
      { id: 'server-restart', covers: 'A26', real: ['token-1-control', 'token-2-stale-token-rejected', 'token-3-control-after-restart', 'token-4-retry-with-new-token'], steps: [
        { at: 0, sse: 'drop' },
        { at: 800, send: 'GET /api/control', respond: { tokenChanged: true, instanceId: '<new>' } },
      ], expect: 'new token fetched once, ETags and fingerprint maps cleared when instanceId changes, drafts and selection kept' },
      { id: 'sse-drop-duplicate-burst', covers: 'A25', real: ['sse-2-burst-and-duplicates'], steps: [
        { at: 0, sse: ['sessions:[f-one]', 'sessions:[f-one]', 'list:{}'] },
        { at: 10, sse: 'burst 50 x sessions:[f-two]' },
        { at: 500, sse: 'drop' }, { at: 2500, sse: 'reconnect' },
      ], expect: 'coalesced into one refetch per key; a reconnect triggers a full refresh' },
      { id: 'unknown-fingerprint', covers: 'A24', steps: [
        { at: 0, send: 'GET /api/sessions', respond: { fixture: 'fleet-mixed/get-sessions-packed', note: 'the client holds none of these hashes' } },
        { at: 10, send: 'GET /api/sessions (no conditional headers)', respond: { fixture: 'fleet-mixed/get-sessions' } },
      ], expect: 'exactly one full retry, never a partly reconstructed list' },
      { id: 'incompatible-build', covers: 'A22, WP2', steps: [
        { at: 0, send: 'GET /api/control', respond: { apiVersion: 99, buildId: 'zzz', instanceId: 'i-2' } },
      ], expect: 'a readable reload state instead of errors; the server now sends apiVersion and buildId (#103), but no client rejects a mismatch yet' },
      { id: 'missing-hashed-asset-after-update', covers: 'A22, A29', steps: [
        { at: 0, send: 'GET /assets/index-OLD.js', respond: { status: 404, body: { error: 'Not found.' }, contentType: 'application/json' } },
      ], expect: 'a 404 JSON (see asset-2-unknown-script), never the index HTML' },
    ],
  })
}
