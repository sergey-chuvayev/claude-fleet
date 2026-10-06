// Vite dev server to a local Fleet server. Fleet accepts only an exact Host
// (127.0.0.1:<port> or localhost:<port>) and, when present, an Origin equal to
// http://<host>. The page in development is served by Vite on another port, so the
// proxy deliberately rewrites both for the Fleet target. To keep that from turning
// the dev server into a way around Fleet's guards, the same checks Fleet makes are
// made first, against the dev server's own address: anything the real server would
// refuse from its own page is refused here before it is forwarded.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ProxyOptions } from 'vite'

export interface FleetTarget {
  /** `127.0.0.1:7777` */
  readonly host: string
  /** `http://127.0.0.1:7777` */
  readonly origin: string
}

export function fleetTarget(port: number): FleetTarget {
  const host = `127.0.0.1:${port}`
  return { host, origin: `http://${host}` }
}

/** Paths that belong to the Fleet server rather than to Vite. */
export const FLEET_PATHS = ['/api', '/theme.css', '/manifest.webmanifest'] as const

const isFleetPath = (url: string | undefined): boolean =>
  !!url && FLEET_PATHS.some(path => url === path || url.startsWith(`${path}/`) || url.startsWith(`${path}?`))

/**
 * Fleet's own guard (server.js), applied to the dev server's address. Returns the
 * refusal message, or null when the request may go through.
 */
export function refuse(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  devPort: number,
): string | null {
  const host = headers.host
  if (host !== `127.0.0.1:${devPort}` && host !== `localhost:${devPort}`) return 'Invalid host.'
  const origin = headers.origin
  if (origin !== undefined && origin !== `http://${host}`) return 'Cross-origin requests are not allowed.'
  if (headers['sec-fetch-site'] === 'cross-site') return 'Cross-site requests are not allowed.'
  return null
}

/** Headers to set on the forwarded request so Fleet sees its own host and origin. */
export function forwardedHeaders(
  incoming: Readonly<Record<string, string | string[] | undefined>>,
  target: FleetTarget,
): Record<string, string> {
  const out: Record<string, string> = { host: target.host }
  if (incoming.origin !== undefined) out.origin = target.origin
  return out
}

/** Refuses what Fleet would refuse, before Vite's proxy sees it. */
export function fleetGuardPlugin(devPort: number): Plugin {
  return {
    name: 'fleet-dev-guard',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!isFleetPath(req.url)) return next()
        const refusal = refuse(req.headers, devPort)
        if (!refusal) return next()
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: refusal }))
      })
    },
  }
}

/** Vite `server.proxy` entries for every Fleet path, SSE included. */
export function fleetProxy(target: FleetTarget): Record<string, ProxyOptions> {
  const options: ProxyOptions = {
    target: target.origin,
    // The rewrite below sets Host and Origin exactly; changeOrigin would only set Host.
    changeOrigin: false,
    // Event streams stay open; never time them out at the proxy.
    timeout: 0,
    proxyTimeout: 0,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        for (const [name, value] of Object.entries(forwardedHeaders(req.headers, target))) proxyReq.setHeader(name, value)
      })
    },
  }
  return Object.fromEntries(FLEET_PATHS.map(path => [path, options]))
}
