// POST to a project route, then mark what it changes out of date. Never retried: a
// command after an ambiguous failure is reconciled by refetching (the client's rule).
import { useCallback } from 'react'
import type { Project } from '../../transport/contracts'
import type { FleetClient } from '../../transport/client'
import { useFleetClient } from '../../transport/hooks'
import { projectMutationInvalidates, projectsResource } from '../../transport/resources'

/** A request id for a mutation, so a repeated send of the same click is deduplicated server side. */
export const newRequestId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`

export function useProjectPost(): (path: string, body: Readonly<Record<string, unknown>>) => Promise<unknown> {
  const client = useFleetClient()
  return useCallback((path, body) => client.post(path, body, { invalidate: projectMutationInvalidates() }), [client])
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'Fleet could not do that.')

/**
 * Put a project the server just answered with into the list at once. Selecting it
 * before the list has caught up would make the selection fall back to another
 * project; the follow-up refetch then fills in what the answer did not carry
 * (progress, members, manager) and puts it in the server's order.
 */
export function adoptProject(client: FleetClient, project: Project): void {
  const held = client.store.get(projectsResource).data ?? []
  client.store.set(projectsResource, held.some(p => p.id === project.id) ? held.map(p => (p.id === project.id ? { ...p, ...project } : p)) : [...held, project])
}

/** Drop an archived project from the list at once, for the same reason. */
export function dropProject(client: FleetClient, id: string): void {
  const held = client.store.get(projectsResource).data
  if (held) client.store.set(projectsResource, held.filter(p => p.id !== id))
}
