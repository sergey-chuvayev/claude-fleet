// The Projects tab (F19): the outcomes the operator owns, each with its deliverables,
// the sessions tagged to it and a project manager to ask. A working pane beside a
// console; the console holds the selected project's manager (ProjectConsole).
//
// The selected project is the app's `projects` selection, remembered in fleet:project.
// Project files can be edited by hand, which emits no event, so the list is read again
// every few seconds while this tab is visible.
import { useMemo, useState } from 'react'
import { useActions, useReconcileSelection } from '../../app/AppStore'
import type { Selection } from '../../app/state'
import type { ProjectId } from '../../domain/ids'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { useFleetClient, useResource } from '../../transport/hooks'
import { ArchivedProjects } from './ArchivedProjects'
import { NewProject } from './NewProject'
import { ProjectPage } from './ProjectPage'
import { ProjectsMemoryProvider } from './ProjectsContext'
import { Callout, PageHead } from './pageKit'
import { useCurrentProject } from './useCurrentProject'
import { useRefreshWhileVisible } from './useRefreshWhileVisible'
import './projects.css'

/** How stale the list may get while Projects is open (the legacy 4 seconds, rounded). */
const REFRESH_MS = 5000

export function ProjectsPane() {
  return (
    <ProjectsMemoryProvider>
      <Projects />
    </ProjectsMemoryProvider>
  )
}

function Projects() {
  const client = useFleetClient()
  const { select } = useActions()
  const { projects, project, error } = useCurrentProject()
  const sessions = useResource(client.resources.sessions).data?.sessions
  // new: the form is open. closed: the operator cancelled it with no project to go back to.
  const [editing, setEditing] = useState<'new' | 'closed' | null>(null)
  useRefreshWhileVisible(client.resources.projects.key, REFRESH_MS)

  // Keep the selection on a project that exists. A fallback (archived, gone) is not a
  // choice, so it is not written back to fleet:project.
  const rows = useMemo(
    () => projects?.map((p): { selection: Selection } => ({ selection: { kind: 'project-manager', projectId: p.id as ProjectId } })) ?? null,
    [projects],
  )
  useReconcileSelection('projects', rows, 'first')

  const pick = (id: string) => {
    setEditing(null)
    select({ kind: 'project-manager', projectId: id as ProjectId })
  }

  if (!projects) {
    return (
      <>
        <PageHead title="Projects" />
        <div className="page-body">
          {error ? <Callout title="Could not load projects" tone="hot">Try again in a moment.</Callout> : <p className="note">Reading your projects…</p>}
        </div>
      </>
    )
  }
  if (editing === 'new' || (!projects.length && editing !== 'closed')) {
    return (
      <NewProject
        projects={projects}
        selected={project?.id}
        onPick={pick}
        onDone={cancelled => setEditing(cancelled && !projects.length ? 'closed' : null)}
      />
    )
  }
  if (!project) {
    return (
      <>
        <PageHead title="Projects" />
        <EmptyState
          title="Group your work by outcome."
          text="A project holds a goal, a deadline and its deliverables. Sessions you tag to it, and items on your Day, roll up here, and its manager can tell you where things stand."
        >
          <button type="button" className="button resume" data-new onClick={() => setEditing('new')}>
            Create a project <Icon name="arrow" />
          </button>
          <ArchivedProjects />
        </EmptyState>
      </>
    )
  }
  return <ProjectPage project={project} projects={projects} sessions={sessions ?? []} onPick={pick} onNew={() => setEditing('new')} />
}
