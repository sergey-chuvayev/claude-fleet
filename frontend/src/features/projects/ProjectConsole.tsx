// The Projects tab's console (F19, F33), in aside#detail: the selected project's
// manager and its conversation. Before a project has a manager the console says what
// goes there. The manager edits Notion, Linear and GitHub only with per-change
// approval and never messages people; the header says so, as the legacy console did.
// The manager is a managed session, and legacy drew it in the same console as any
// other: model picker, Connections and Close in the header, then the console tail
// (approvals, queued follow-ups, the full composer posting to its message route).
// The project's own ask route is the project page's, for a project with no manager.
import { useState } from 'react'
import { useToast } from '../../components/Toast'
import { type Project, readControlFields } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { Conversation, toolLabel } from '../conversation'
import { isWorking } from '../conversation/format'
import { CloseButton, ConnectionsButton, ModelPicker } from '../session-header/SessionHeader'
import { SessionTail } from '../session-header/SessionTail'
import '../../styles/console.css'
import './projects.css'
import { useCurrentProject } from './useCurrentProject'

// The conversation needs a flex column with a set height (as the Sessions console).
const CONSOLE_STYLE = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } as const

const STATUS_LABEL: Readonly<Record<string, string>> = {
  starting: 'Starting Claude…',
  running: 'Working on your task',
  approval: 'Your input is needed',
  stopping: 'Stopping the agent…',
  stopped: 'Stopped · ready to continue',
  error: 'Turn failed',
  idle: 'Ready for your next message',
  queued: 'Queued · waiting for a free slot',
}

const GATE_TITLE =
  'When you ask, it can change your Notion pages, Linear issues and GitHub, one approved change at a time, and logs each one in the project. It never messages people.'

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
  const status = session?.status
  const fields = session ? readControlFields(session) : null
  const tool = typeof session?.currentTool === 'string' ? toolLabel(session.currentTool) : null
  const queued = Array.isArray(session?.queue) && session.queue.length ? ` · ${session.queue.length} queued` : ''
  const state = status ? `${tool && status === 'running' ? `Using ${tool}` : (STATUS_LABEL[status] ?? status)}${queued}` : ''
  if (closed) {
    return (
      <section id="control-panel" className="project-console" aria-label="Agent controls" style={CONSOLE_STYLE}>
        <p className="note">Closed. Claude still has its own transcript of it.</p>
      </section>
    )
  }
  return (
    <section id="control-panel" className="project-console" aria-label="Agent controls" style={CONSOLE_STYLE}>
      <header className="project-console-head">
        <strong className="project-console-title">Project manager · {project.name}</strong>
        <span className={`subtle${status === 'approval' ? ' stale' : ''}`} aria-live="polite">
          {state}
        </span>
        <span className="header-controls">
          {fields && session?.engine !== 'codex' ? <ModelPicker managedId={managerId} selected={fields.selectedModel ?? ''} /> : null}
          <span className="subtle day-gate-note" title={GATE_TITLE}>
            Changes need your approval
          </span>
          <ConnectionsButton managedId={managerId} />
          <CloseButton managedId={managerId} working={isWorking(status ?? '')} onClosed={() => setClosed(true)} />
        </span>
      </header>
      <Conversation sessionKey={`managed:${managerId}`} onNotice={toast} />
      {session ? (
        <SessionTail
          session={session}
          draftKey={`managed:${managerId}`}
          placeholder="Ask about this project: status, blockers, are we on track…"
          refreshError={detail.status === 'error' ? (detail.error?.message ?? '') : ''}
        />
      ) : null}
    </section>
  )
}
