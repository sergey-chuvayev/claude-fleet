// Creating a project (F19): a title and an optional note, nothing else. The project
// manager looks the rest up. If no agent is free the project is kept and the manager
// does not start; the answer says so (`setup.started === false`) and the toast reports
// it as it is. That is not a storage failure and nothing else stops working.
import { type FormEvent, useState } from 'react'
import { useActions } from '../../app/AppStore'
import type { ProjectId } from '../../domain/ids'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { type Project, parseProject } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { ArchivedProjects } from './ArchivedProjects'
import { useDraft } from './ProjectsContext'
import { Switcher } from './ProjectPage'
import { PageHead } from '../../components/ui'
import { adoptProject, errorMessage, newRequestId, useProjectPost } from './useProjectPost'

export interface NewProjectProps {
  readonly projects: readonly Project[]
  readonly selected: string | undefined
  readonly onPick: (id: string) => void
  /** The form is finished (created) or cancelled. */
  readonly onDone: (cancelled: boolean) => void
}

export function NewProject({ projects, selected, onPick, onDone }: NewProjectProps) {
  const client = useFleetClient()
  const toast = useToast()
  const post = useProjectPost()
  const { select } = useActions()
  const name = useDraft('new:name')
  const note = useDraft('new:note')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const title = name.value.trim()
    const extra = note.value.trim()
    if (!title) return toast('Give it a title.')
    setBusy(true)
    try {
      const project = parseProject(await post('/api/projects', { name: title, ...(extra ? { note: extra } : {}), requestId: newRequestId() }))
      adoptProject(client, project)
      select({ kind: 'project-manager', projectId: project.id as ProjectId })
      name.clear()
      note.clear()
      toast(project.setup?.started === false ? `Project created. Its manager did not start: ${project.setup.error ?? 'no reason given'}` : 'Project created. Its manager is setting it up.')
      onDone(false)
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="New project" actions={<Switcher projects={projects} selected={selected} creating onPick={onPick} />} />
      <div className="page-body">
        <form className="ui-form project-new-form" data-project-new="" onSubmit={event => void submit(event)}>
          <h3>What are you working towards?</h3>
          <p className="note">
            Just a title. The project manager looks it up in Linear, GitHub, Slack, Notion and your meetings, writes the brief, deadline and
            deliverables into the project&apos;s file, and asks you what it could not find.
          </p>
          <input
            name="name"
            required
            maxLength={100}
            placeholder="Queue in the ring node"
            autoComplete="off"
            aria-label="Project title"
            value={name.value}
            onChange={name.onChange}
          />
          <textarea
            name="note"
            rows={3}
            maxLength={8000}
            placeholder="Anything to start from? A link, a deadline, who asked. Optional."
            aria-label="Note"
            value={note.value}
            onChange={note.onChange}
          />
          <div className="ui-actions">
            <button type="submit" className="button resume" disabled={busy}>
              Create and set up <Icon name="arrow" />
            </button>
            <button type="button" className="button" data-cancel onClick={() => onDone(true)}>
              Cancel
            </button>
          </div>
        </form>
        {projects.length ? null : <ArchivedProjects />}
      </div>
    </>
  )
}

