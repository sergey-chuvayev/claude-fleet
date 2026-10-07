// The production build (dist/) served by the real server, for the Playwright journeys, the
// accessibility checks and the performance runs.
//
//   node frontend/e2e/journeys/serve.mjs <pack> [--port 4400]     serve until Ctrl+C
//
// Since the cutover server.js serves dist/ itself (its manifest allowlist, security
// headers and CSP), so the journeys load the page straight from the fixture server:
// `capture.js --serve <pack>`, the real createApp on a throwaway home with fake runtimes
// (see frontend/src/test/fixtures/README.md). No stand-in serves the build any more.
//
// `startFront` is a transparent proxy in front of a fixture server, for the performance
// runs: it counts requests and can answer some itself (a synthetic stream). It applies
// Fleet's own Host/Origin/Sec-Fetch-Site guard to its own address, as the dev proxy does
// (frontend/dev/fleet-proxy.mts), and forwards everything else. The fixture server's
// guards are never relaxed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '../../..')
export const DIST = path.join(REPO, 'dist')
const capture = root => path.join(root, 'frontend/src/test/fixtures/capture.js')

// server.js sends these on every answer; a front that answers itself sends them too.
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

/** Fleet's guard (server.js) against this server's own address. Null when allowed. */
export function refuse(headers, port) {
  const host = headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'Invalid host.'
  if (headers.origin !== undefined && headers.origin !== `http://${host}`) return 'Cross-origin requests are not allowed.'
  if (headers['sec-fetch-site'] === 'cross-site') return 'Cross-site requests are not allowed.'
  return null
}

/**
 * Start `capture.js --serve <pack>` from `root` (this checkout by default, or a pre-cutover
 * checkout for the legacy page); resolves with its base URL and a stop function.
 */
export function startFixture(pack, { verbose = false, root = REPO } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [capture(root), '--serve', pack], {
      stdio: ['ignore', 'pipe', verbose ? 'inherit' : 'ignore'],
    })
    let buffer = ''
    const onExit = code => reject(new Error(`fixture server for ${pack} exited (${code}) before it was ready`))
    child.on('exit', onExit)
    child.stdout.on('data', chunk => {
      buffer += chunk
      const match = /FIXTURE_SERVER (\S+)/.exec(buffer)
      if (!match) return
      child.off('exit', onExit)
      resolve({
        base: match[1],
        pid: child.pid,
        stop: () =>
          new Promise(done => {
            if (child.exitCode !== null) return done()
            child.once('exit', done)
            child.kill('SIGTERM')
          }),
      })
    })
  })
}

/**
 * A proxy on 127.0.0.1:<port> (0 for any) that forwards every request to `fleetBase`.
 * `log` receives every proxied request as {method, path, status, bytes}, for request counts.
 * `intercept(req, res)` may answer a request itself (a synthetic stream) by returning true.
 */
export function startFront({ fleetBase, port = 0, log = null, intercept = null }) {
  const target = new URL(fleetBase)
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const own = server.address().port
    const url = req.url || '/'
    const refusal = refuse(req.headers, own)
    if (refusal) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
      return res.end(JSON.stringify({ error: refusal, code: 'FORBIDDEN_ORIGIN' }))
    }
    if (intercept?.(req, res)) return
    const headers = { ...req.headers, host: target.host }
    if (req.headers.origin !== undefined) headers.origin = target.origin
    const upstream = http.request({ host: target.hostname, port: target.port, method: req.method, path: url, headers }, answer => {
      const entry = { method: req.method, path: url.split('?')[0], status: answer.statusCode, at: Date.now(), bytes: 0 }
      log?.(entry)
      answer.on('data', chunk => {
        entry.bytes += chunk.length
      })
      res.writeHead(answer.statusCode || 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', error => {
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `Fixture server unreachable: ${error.message}` }))
    })
    // The page went away (an event stream closed by the browser): drop the upstream too.
    // On `res`, not `req`: a request emits close once its body is read.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    return req.pipe(upstream)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        stop: () =>
          new Promise(done => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      }),
    )
  })
}

/**
 * A fixture server serving this checkout's dist/. With `port`, a front on that port forwards
 * to it (the fixture server picks its own port).
 */
export async function startStack(pack, { port, verbose = false } = {}) {
  if (!fs.existsSync(path.join(DIST, '.vite', 'manifest.json'))) {
    throw new Error('dist/.vite/manifest.json is missing. Run `npm run build:frontend` first.')
  }
  const fixture = await startFixture(pack, { verbose })
  if (!port) return { base: fixture.base, fixtureBase: fixture.base, fixturePid: fixture.pid, stop: fixture.stop }
  try {
    const front = await startFront({ fleetBase: fixture.base, port })
    return {
      base: front.base,
      fixtureBase: fixture.base,
      fixturePid: fixture.pid,
      stop: async () => {
        await front.stop()
        await fixture.stop()
      },
    }
  } catch (error) {
    await fixture.stop()
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const pack = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--port') || 'fleet-mixed'
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) || 0 : 0
  const stack = await startStack(pack, { port, verbose: !!process.env.FIXTURE_VERBOSE })
  console.log(`React build for ${pack}: ${stack.base}  (fixture server ${stack.fixtureBase})`)
  const stop = () => stack.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
