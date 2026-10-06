// Placeholder (shell slot): the Projects page. Replace this file with the Projects
// feature; the shell renders it inside section#projects-pane. Select a project with
// useActions().select({ kind: 'project-manager', projectId }), which also remembers
// it in fleet:project.
import { EmptyState } from '../../components/EmptyState'

export function ProjectsPane() {
  return <EmptyState title="Your projects." text="Projects, their deliverables and their managers will appear here." />
}
