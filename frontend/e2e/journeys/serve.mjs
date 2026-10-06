// The production build (dist/) in front of a fixture server, for the Playwright
// journeys, the accessibility checks and the performance runs.
//
//   node frontend/e2e/journeys/serve.mjs <pack> [--port 4400]     serve until Ctrl+C
//
// What it does, and why it is not Vite preview:
//   - starts `capture.js --serve <pack>` (the real createApp on a throwaway home with
//     fake runtimes, see frontend/src/test/fixtures/README.md);
//   - serves dist/ with the same security headers server.js sends (CSP included), so
//     the build is tested under the policy it ships with;
//   - forwards /api (the event stream included), /theme.css and /manifest.webmanifest
//     to the fixture server, after applying Fleet's own Host/Origin/Sec-Fetch-Site
//     guard to its own address, exactly as the dev proxy does (frontend/dev/fleet-proxy.mts).
//     The fixture server's guards are never relaxed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '../../..')
export const DIST = path.join(REPO, 'dist')
const CAPTURE = path.join(REPO, 'frontend/src/test/fixtures/capture.js')

// server.js sends these on every answer; the build must work under them.
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}
const FLEET_PATHS = ['/api', '/theme.css', '/manifest.webmanifest']
const isFleetPath = url => FLEET_PATHS.some(p => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))

/** Fleet's guard (server.js) against this server's own address. Null when allowed. */
export function refuse(headers, port) {
  const host = headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'Invalid host.'
  if (headers.origin !== undefined && headers.origin !== `http://${host}`) return 'Cross-origin requests are not allowed.'
  if (headers['sec-fetch-site'] === 'cross-site') return 'Cross-site requests are not allowed.'
  return null
}

/** Start `capture.js --serve <pack>`; resolves with its base URL and a stop function. */
export function startFixture(pack, { verbose = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CAPTURE, '--serve', pack], {
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
 * Serve dist/ on 127.0.0.1:<port> (0 for any) and forward Fleet paths to `fleetBase`.
 * `log` receives every proxied request as {method, path, status, bytes}, for request counts.
 * `legacy: true` forwards everything instead, so the server's own public/ page is what
 * loads, behind the same front as the build (the performance runs compare the two).
 * `intercept(req, res)` may answer a request itself (a synthetic stream) by returning true.
 */
export function startStatic({ fleetBase, port = 0, dist = DIST, log = null, legacy = false, intercept = null }) {
  const target = new URL(fleetBase)
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const own = server.address().port
    const url = req.url || '/'
    if (legacy || isFleetPath(url)) {
      const refusal = refuse(req.headers, own)
      if (refusal) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
        return res.end(JSON.stringify({ error: refusal, code: 'FORBIDDEN_ORIGIN' }))
      }
      if (intercept?.(req, res)) return
      const headers = { ...req.headers, host: target.host }
      if (req.headers.origin !== undefined) headers.origin = target.origin
      const upstream = http.request(
        { host: target.hostname, port: target.port, method: req.method, path: url, headers },
        answer => {
          const entry = { method: req.method, path: url.split('?')[0], status: answer.statusCode, at: Date.now(), bytes: 0 }
          log?.(entry)
          answer.on('data', chunk => {
            entry.bytes += chunk.length
          })
          res.writeHead(answer.statusCode || 502, answer.headers)
          answer.pipe(res)
        },
      )
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
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS)
      return res.end()
    }
    // Static assets: dist/ only, no traversal, no directory listings.
    const pathname = decodeURIComponent(url.split('?')[0])
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const file = path.resolve(dist, relative)
    if (!file.startsWith(dist + path.sep) || relative.startsWith('.vite')) {
      res.writeHead(404, SECURITY_HEADERS)
      return res.end()
    }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404, SECURITY_HEADERS)
        return res.end()
      }
      const immutable = relative.startsWith('assets/')
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    })
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

/** Fixture server plus the static front. */
export async function startStack(pack, options = {}) {
  if (!fs.existsSync(path.join(options.dist || DIST, 'index.html'))) {
    throw new Error('dist/index.html is missing. Run `npm run build:frontend` first.')
  }
  const fixture = await startFixture(pack, options)
  try {
    const { verbose: _verbose, ...frontOptions } = options
    const front = await startStatic({ fleetBase: fixture.base, ...frontOptions })
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
  const port = Number(args[args.indexOf('--port') + 1]) || 0
  const stack = await startStack(pack, { port: args.includes('--port') ? port : 0, verbose: !!process.env.FIXTURE_VERBOSE })
  console.log(`React build for ${pack}: ${stack.base}  (fixture server ${stack.fixtureBase})`)
  const stop = () => stack.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
