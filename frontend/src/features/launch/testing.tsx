// Test support for the launch dialog: a fake Fleet answering from the fixture packs
// (fleet-mixed for control, sessions, models and launches; teams-heavy for the team
// catalog and definitions), recording every request, with hooks to make the next
// answer fail or wait.
import controlFixture from '../../test/fixtures/fleet-mixed/get-control.json'
import modelsFixture from '../../test/fixtures/fleet-mixed/get-models.json'
import createFixture from '../../test/fixtures/fleet-mixed/post-managed-create.json'
import sessionsFixture from '../../test/fixtures/fleet-mixed/get-sessions.json'
import teamsFixture from '../../test/fixtures/teams-heavy/get-teams.json'
import bugfixFixture from '../../test/fixtures/teams-heavy/team-bugfix.json'
import deliveryFixture from '../../test/fixtures/teams-heavy/team-delivery.json'
import ownerFixture from '../../test/fixtures/teams-heavy/team-owner-review.json'
import quickFixture from '../../test/fixtures/teams-heavy/team-quick.json'
import { jsonResponse, strip, syncRoute } from '../../test/fakes'
import type { FetchLike } from '../../transport/conditional'

export interface Recorded {
  readonly method: string
  readonly url: string
  readonly body: Record<string, unknown> | null
}

type Answer = Response | Promise<Response>
type Override = (request: Recorded) => Answer | undefined

const clone = <T,>(value: T): T => structuredClone(value)
const body = <T,>(file: { response: { body: unknown } }): T => strip(file.response.body) as T

interface SessionRow {
  managedId?: string
  [key: string]: unknown
}

export function launchFleet() {
  const requests: Recorded[] = []
  const overrides: Override[] = []
  let control = body<Record<string, unknown> & { codex: { available: boolean; model?: string } }>(controlFixture)
  const snapshot = body<{ sessions: SessionRow[]; usage: Record<string, unknown> } & Record<string, unknown>>(sessionsFixture)
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(snapshot)
  const teams = body<{ teams: Array<Record<string, unknown>>; tools: string[] }>(teamsFixture)
  const definitions = new Map<string, Record<string, unknown>>(
    [bugfixFixture, deliveryFixture, ownerFixture, quickFixture].map(file => {
      const { team } = body<{ team: Record<string, unknown> & { id: string } }>(file)
      return [team.id, team]
    }),
  )
  let created = 0

  const answer = async (request: Recorded, init: RequestInit | undefined): Promise<Response> => {
    for (let i = 0; i < overrides.length; i++) {
      const hit = overrides[i]!(request)
      if (hit) {
        overrides.splice(i, 1)
        return hit
      }
    }
    const { method, url } = request
    if (url === '/api/control') return jsonResponse(control)
    if (url === '/api/models') return jsonResponse(body(modelsFixture))
    if (url === '/api/teams' && method === 'GET') return jsonResponse(teams)
    const team = /^\/api\/teams\/([\w-]+)$/.exec(url)
    if (team?.[1]) {
      const definition = definitions.get(team[1])
      return definition
        ? jsonResponse({ team: clone(definition) })
        : jsonResponse({ error: 'That team does not exist.', code: 'NOT_FOUND' }, 404)
    }
    if (url === '/api/teams' && method === 'POST') {
      const saved = clone(request.body!) as Record<string, unknown> & { id: string; name: string }
      definitions.set(saved.id, saved)
      const summary = {
        id: saved.id,
        name: saved.name,
        description: saved.description,
        manager: saved.manager,
        mode: (saved.workflow as { mode?: string } | undefined)?.mode ?? 'team',
        custom: true,
        roles: Object.entries(saved.roles as Record<string, { description: string; model: string }>).map(([name, r]) => ({
          name,
          description: r.description,
          model: r.model,
        })),
      }
      const at = teams.teams.findIndex(t => t.id === saved.id)
      if (at >= 0) teams.teams[at] = summary
      else teams.teams.push(summary)
      return jsonResponse({ team: saved })
    }
    if (url === '/api/managed' && method === 'POST') {
      const session = clone(body<{ session: Record<string, unknown> }>(createFixture).session)
      const id = `m-launched-${++created}`
      Object.assign(session, { id, cwd: request.body?.cwd, createRequestId: request.body?.requestId })
      snapshot.sessions = [
        { managedId: id, sessionId: null, engine: request.body?.engine ?? 'claude', title: 'Launched', state: 'busy', managed: true },
        ...snapshot.sessions,
      ]
      sessions.set(clone(snapshot))
      return jsonResponse({ session }, 201)
    }
    if (url === '/api/sessions') return sessions.fetch(url, init)
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const request: Recorded = {
      method,
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    }
    requests.push(request)
    return answer(request, init)
  }

  return {
    fetch,
    requests,
    posts: (url?: string) => requests.filter(r => r.method === 'POST' && (!url || r.url === url)),
    gets: (url: string) => requests.filter(r => r.method === 'GET' && r.url === url),
    /** Answer the next request `when` matches with `respond` instead. */
    once(when: (request: Recorded) => boolean, respond: () => Answer) {
      overrides.push(request => (when(request) ? respond() : undefined))
    },
    setCodex(codex: { available: boolean; model?: string }) {
      control = { ...control, codex, capabilities: { ...(control.capabilities as object), engines: { claude: true, codex: codex.available } } }
    },
    setDefaultApprovalMode(mode: string) {
      control = { ...control, defaultApprovalMode: mode }
    },
    setUsage(usage: Record<string, unknown>) {
      snapshot.usage = usage
      sessions.set(clone(snapshot))
    },
    snapshot,
  }
}

export const isPost = (url: string) => (request: Recorded) => request.method === 'POST' && request.url === url
export const isGet = (url: string) => (request: Recorded) => request.method === 'GET' && request.url === url

export const errorResponse = (status: number, error: string, code: string) =>
  jsonResponse({ error, code, ...(code === 'CAPACITY' ? { retryable: true } : {}) }, status)
