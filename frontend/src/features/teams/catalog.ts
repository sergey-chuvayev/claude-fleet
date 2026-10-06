// The team catalog (GET /api/teams), one team's full definition (GET /api/teams/:id)
// and saving a custom team (POST /api/teams). The launch dialog's team field and its
// team editor read the catalog; nothing else does. Saving a team changes the catalog
// only: a running initiative carries its own team snapshot, which no save touches
// (plan section 7, "team save affects catalog and launch editor only").
import { getJson, perClient } from '../launch/get'
import type { FleetClient } from '../../transport/client'
import { type TeamCatalog, type TeamDefinition, parseTeamAnswer, parseTeamCatalog } from '../../transport/contracts'
import type { Resource } from '../../transport/store'

export const TEAMS_KEY = 'teams'

/** The catalog as a store resource: last good copy kept through a failed refresh. */
export const teamsResource = perClient(
  (client): Resource<TeamCatalog> => ({
    key: TEAMS_KEY,
    load: async ({ signal }) => ({ data: await getJson(client, '/api/teams', parseTeamCatalog, signal) }),
  }),
)

export function fetchTeam(client: FleetClient, id: string): Promise<TeamDefinition> {
  return getJson(client, `/api/teams/${encodeURIComponent(id)}`, parseTeamAnswer)
}

/** Save a custom team, then reload the catalog so the launch form lists it. */
export async function saveTeam(client: FleetClient, team: TeamDefinition): Promise<TeamDefinition> {
  const saved = parseTeamAnswer(await client.post('/api/teams', team))
  await client.store.refresh(teamsResource(client))
  return saved
}

/** The catalog fresh from the server, failing when it cannot be had. */
export async function freshCatalog(client: FleetClient): Promise<TeamCatalog> {
  const resource = teamsResource(client)
  await client.store.refresh(resource)
  const state = client.store.get(resource)
  if (state.status === 'error' || !state.data) throw state.error ?? new Error('Teams are unavailable.')
  return state.data
}
