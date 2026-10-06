// The project the Projects view is showing: the selection, else the first project, as
// the legacy page fell back. Shared by the pane and the console beside it, so they
// always agree. Selection itself (and its persistence in fleet:project) is the app
// store's job; the pane keeps it pointing at a project that exists.
import { useSelection } from '../../app/AppStore'
import type { Project } from '../../transport/contracts'
import { useResource } from '../../transport/hooks'
import { projectsResource } from '../../transport/resources'

export function useCurrentProject(): { projects: Project[] | undefined; project: Project | undefined; error: Error | null } {
  const state = useResource(projectsResource)
  const selection = useSelection('projects')
  const projects = state.data
  const wanted = selection?.kind === 'project-manager' ? selection.projectId : null
  const project = projects ? (projects.find(p => p.id === wanted) ?? projects[0]) : undefined
  return { projects, project, error: state.error }
}
