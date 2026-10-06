// The Projects tab's console (F19, F33), in aside#detail: the selected project's
// manager and its conversation. Before a project has a manager the console says what
// goes there. The manager is a managed session, and legacy drew it in the same
// console as any other: the session header (model picker, the "Changes need your
// approval" gate note, Connections, Close), the conversation, then the console tail
// (approvals, queued follow-ups, the full composer posting to its message route).
// The project's own ask route is the project page's, for a project with no manager.
import { useState } from 'react'
import { useToast } from '../../components/Toast'
import { type Project, readControlFields } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { Conversation } from '../conversation'
import { SessionHeader } from '../session-header/SessionHeader'
import { SessionTail } from '../session-header/SessionTail'
import '../../styles/console.css'
import './projects.css'
import { useCurrentProject } from './useCurrentProject'

export function ProjectConsole() {
  const { project } = useCurrentProject()
  if (!project?.managerId) {
    return (
      <div className="console-empty">
        <strong>{project ? 'No project manager yet' : 'No project selected'}</strong>
        <span>{project ? 'Ask it something on the left. Its conversation appears here.' : 'Create a project to give it a manager.'}</span>
      </div>
    )
  }
  // Keyed by manager: another project starts a fresh log with its own read position.
  return <ManagerConsole key={project.managerId} project={project} managerId={project.managerId} />
}

function ManagerConsole({ project, managerId }: { project: Project; managerId: string }) {
  const client = useFleetClient()
  const toast = useToast()
  const detail = useResource(client.resources.managed(managerId))
  const [closed, setClosed] = useState(false)
  const session = detail.data?.session
  let body
  if (closed) body = <p className="note">Closed. Claude still has its own transcript of it.</p>
  else if (!session)
    body = (
      <>
        <div className="conversation-header">
          <div className="header-title">
            <h3 id="conversation-title">Project manager · {project.name}</h3>
            <span id="agent-state" className="subtle">
              Connecting…
            </span>
          </div>
        </div>
        {/* The conversation says loading or why it could not load. */}
        <Conversation sessionKey={`managed:${managerId}`} onNotice={toast} />
      </>
    )
  else
    body = (
      <>
        <SessionHeader session={session} fields={readControlFields(session)} onClosed={() => setClosed(true)} />
        <Conversation sessionKey={`managed:${managerId}`} onNotice={toast} />
        <SessionTail
          session={session}
          draftKey={`managed:${managerId}`}
          placeholder="Ask about this project: status, blockers, are we on track…"
          refreshError={detail.status === 'error' ? (detail.error?.message ?? '') : ''}
        />
      </>
    )
  return (
    <section id="control-panel" className="project-console" aria-label="Agent controls">
      {body}
    </section>
  )
}
