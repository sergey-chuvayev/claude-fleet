// Archived projects and how to bring one back (F19 restore). The legacy page had no
// control for this although the route exists; this is a quiet fold at the foot of the
// page that reads the archived list only when it is opened. Restoring needs a free
// slot among the 30 active projects: when there is none the server answers CAPACITY,
// the project stays archived, and its message is shown as it is.
import { useState } from 'react'
import { useActions } from '../../app/AppStore'
import type { ProjectId } from '../../domain/ids'
import { Fold } from '../../components/Disclosure'
import { useToast } from '../../components/Toast'
import { parseProject } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { archivedProjectsResource } from '../../transport/resources'
import { List, Row } from './pageKit'
import { adoptProject, errorMessage, useProjectPost } from './useProjectPost'

export function ArchivedProjects() {
  return (
    <div className="ui-folds">
      <Fold summary="Archived projects" lazy data-archived-projects="">
        <ArchivedList />
      </Fold>
    </div>
  )
}

function ArchivedList() {
  const client = useFleetClient()
  const toast = useToast()
  const post = useProjectPost()
  const { select } = useActions()
  const state = useResource(archivedProjectsResource)
  const [restoring, setRestoring] = useState<string | null>(null)
  // Opening the fold reads the list again: it may have changed since it was last open.
  const archived = state.data?.filter(p => p.archived)

  const restore = async (id: string, name: string) => {
    setRestoring(id)
    try {
      const restored = parseProject(await post(`/api/projects/${id}/archive`, { archived: false }))
      adoptProject(client, restored)
      select({ kind: 'project-manager', projectId: restored.id as ProjectId })
      toast(`Restored ${name}.`)
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setRestoring(null)
    }
  }

  if (!archived) return <p className="note">{state.error ? 'Could not read the archived projects.' : 'Reading…'}</p>
  if (!archived.length) return <p className="note">Nothing is archived.</p>
  return (
    <List compact>
      {archived.map(p => (
        <Row
          key={p.id}
          tone="idle"
          orbTitle="Archived"
          title={p.name}
          meta={`${p.progress.done} of ${p.progress.total} done`}
          side={
            <button type="button" className="button ghost" data-restore-project={p.id} disabled={restoring !== null} onClick={() => void restore(p.id, p.name)}>
              {restoring === p.id ? 'Restoring…' : 'Restore'}
            </button>
          }
        />
      ))}
    </List>
  )
}
