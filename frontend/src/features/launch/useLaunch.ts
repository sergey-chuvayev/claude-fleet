// What the New agent dialog does, as hooks over the launch store: read the draft, and
// launch it, open the team editor, save a team. The async work lives here, outside the
// component, so a launch that is still in flight when the dialog closes still lands:
// the store records the outcome and the app selects the new session.
import { useMemo, useSyncExternalStore } from 'react'
import { useActions, usePreferences } from '../../app/AppStore'
import { useToast } from '../../components/Toast'
import type { ManagedId } from '../../domain/ids'
import type { FleetClient } from '../../transport/client'
import { type ApprovalMode, type ControlInfo, type TeamCatalog, parseLaunched, parseManagedDetail } from '../../transport/contracts'
import { HttpError } from '../../transport/errors'
import { useFleetClient } from '../../transport/hooks'
import { keys } from '../../transport/resources'
import { freshCatalog, fetchTeam, saveTeam } from '../teams/catalog'
import { startEditing, toDefinition } from '../teams/catalogDraft'
import { perClient } from './get'
import { type LaunchFields, type LaunchState, LaunchStore } from './launchState'

export const launchStoreFor = perClient(() => new LaunchStore())

export function useLaunchStore(): LaunchStore {
  return launchStoreFor(useFleetClient())
}

export function useLaunchState(): LaunchState {
  const store = useLaunchStore()
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

export const DEFAULT_APPROVAL: ApprovalMode = 'all'

/** Whether Codex can run here, as the server last reported it. */
export function codexAvailable(control: ControlInfo | undefined): boolean {
  if (!control) return false
  return control.codex.available && control.capabilities?.engines?.codex !== false
}

/** The POST /api/managed body for a draft, legacy field for field (no name: the server names it from the prompt). */
export function launchBody(fields: LaunchFields, requestId: string): Record<string, unknown> {
  const codex = fields.engine === 'codex'
  return {
    ...(fields.teamId && !codex ? { teamId: fields.teamId } : {}),
    ...(codex ? { engine: 'codex' } : {}),
    cwd: fields.cwd ?? '',
    prompt: fields.prompt,
    approvalMode: fields.approvalMode ?? DEFAULT_APPROVAL,
    model: codex ? '' : fields.model,
    requestId,
  }
}

const newRequestId = (): string => crypto.randomUUID()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'The request failed.')
const codeOf = (error: unknown): string | null => (error instanceof HttpError ? error.code : null)

async function postLaunch(client: FleetClient, body: Record<string, unknown>): Promise<unknown> {
  const send = () => client.post('/api/managed', body, { invalidate: [keys.sessions] })
  try {
    return await send()
  } catch (error) {
    // A restarted server refused the old token before doing anything; create dedupes by
    // request id anyway, so one retry with the fresh token is safe.
    if (error instanceof HttpError && error.code === 'TOKEN_INVALID') return send()
    throw error
  }
}

/** Refresh the session list until it shows `managedId` (twice at most: one refresh may predate the launch). */
async function listHas(client: FleetClient, managedId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await client.store.refresh(client.resources.sessions)
    if (client.store.get(client.resources.sessions).data?.sessions.some(row => row.managedId === managedId)) return
  }
}

export interface LaunchActions {
  /** Validate and launch the current draft. Resolves when the attempt settles. */
  launch(options: { codexReady: boolean }): Promise<void>
  /** Fetch the chosen team (or Software delivery) and switch the dialog to the editor. */
  openEditor(): Promise<void>
  saveEditor(): Promise<void>
}

export function useLaunchActions(): LaunchActions {
  const client = useFleetClient()
  const store = useLaunchStore()
  const app = useActions()
  const preferences = usePreferences()
  const toast = useToast()

  return useMemo(() => {
    const dispatch = store.dispatch
    return {
      async launch({ codexReady }) {
        const state = store.getState()
        if (state.submitting || state.editor.status === 'open') return
        const { fields } = state
        if (!fields.prompt.trim()) {
          dispatch({ type: 'invalid', error: { message: 'Describe the task first.', code: null, field: 'prompt' } })
          return
        }
        if (!(fields.cwd ?? '').trim()) {
          dispatch({
            type: 'invalid',
            error: { message: 'Choose the directory this agent works in.', code: null, field: 'cwd' },
          })
          return
        }
        if (fields.engine === 'codex' && !codexReady) {
          dispatch({
            type: 'invalid',
            error: {
              message: 'Codex is unavailable. Check the setup instructions above, then reopen New agent to retry.',
              code: 'UNSUPPORTED_ENGINE',
            },
          })
          return
        }
        const requestId = state.requestId ?? newRequestId()
        dispatch({ type: 'submit', requestId })
        let session: ReturnType<typeof parseLaunched>
        try {
          const raw = await postLaunch(client, launchBody(fields, requestId))
          session = parseLaunched(raw)
          // Seed the console with the answer so the new session opens without a blank frame.
          try {
            client.store.set(client.resources.managed(session.id), parseManagedDetail(raw))
            // ...and still fetch it fresh once the console watches it.
            client.store.invalidate(keys.managed(session.id))
          } catch {
            // A partial answer: the console fetches the detail itself.
          }
        } catch (error) {
          dispatch({ type: 'failed', error: { message: messageOf(error), code: codeOf(error) } })
          return
        }
        // Select only once the list has the new row (legacy awaited tick() here), or the
        // list, reconciling against rows without it, would move the selection elsewhere.
        await listHas(client, session.id)
        preferences.set('launchCwd', (fields.cwd ?? '').trim())
        dispatch({ type: 'launched' })
        app.closeModal('launch')
        // A new agent lives in Sessions; launched from Today or Projects, go there to see it.
        app.select({ kind: 'managed', managedId: session.id as ManagedId }, { reveal: true })
        toast(session.status === 'queued' ? 'Task queued' : fields.teamId && fields.engine !== 'codex' ? 'Initiative launched' : 'Agent launched')
      },

      async openEditor() {
        const state = store.getState()
        if (state.submitting || state.editor.status !== 'closed') return
        const returnTeam = state.fields.teamId
        const selected = returnTeam || 'delivery'
        const token = store.nextToken()
        dispatch({ type: 'editor-loading', token })
        let team: Awaited<ReturnType<typeof fetchTeam>>
        let catalog: TeamCatalog
        try {
          ;[team, catalog] = await Promise.all([fetchTeam(client, selected), freshCatalog(client)])
        } catch (error) {
          dispatch({ type: 'editor-failed', token })
          toast(messageOf(error))
          return
        }
        dispatch({ type: 'editor-opened', token, session: { ...startEditing(team, catalog, selected), returnTeam } })
      },

      async saveEditor() {
        const { editor } = store.getState()
        if (editor.status !== 'open' || editor.saving) return
        let definition: ReturnType<typeof toDefinition>
        try {
          definition = toDefinition(editor.draft, editor.tools)
        } catch (error) {
          dispatch({ type: 'editor', action: { type: 'error', message: messageOf(error) } })
          return
        }
        dispatch({ type: 'editor', action: { type: 'saving', saving: true } })
        try {
          const saved = await saveTeam(client, definition)
          dispatch({ type: 'editor-saved', teamId: saved.id })
          toast('Team saved. Ready for your task.')
        } catch (error) {
          dispatch({ type: 'editor', action: { type: 'error', message: messageOf(error) } })
          dispatch({ type: 'editor', action: { type: 'saving', saving: false } })
        }
      },
    }
  }, [client, store, app, preferences, toast])
}
