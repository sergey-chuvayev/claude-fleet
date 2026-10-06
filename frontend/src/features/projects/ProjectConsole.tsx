// The Projects tab's console (F19, F33), in aside#detail: the selected project's
// manager and its conversation. Before a project has a manager the console says what
// goes there. The manager edits Notion, Linear and GitHub only with per-change
// approval and never messages people; the header says so, as the legacy console did.
//
// TODO(features/approvals, features/composer): the manager's approval cards and the
// full composer (model, mode, attachments) belong to those features; they plug in
// below the conversation. Until then a question goes through the project's own ask
// route, which reuses the manager.
import { type KeyboardEvent, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import type { Project } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { Conversation, toolLabel } from '../conversation'
import './projects.css'
import { errorMessage, newRequestId, useProjectPost } from './useProjectPost'
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
  const session = detail.data?.session
  const status = session?.status
  const tool = typeof session?.currentTool === 'string' ? toolLabel(session.currentTool) : null
  const queued = Array.isArray(session?.queue) && session.queue.length ? ` · ${session.queue.length} queued` : ''
  const state = status ? `${tool && status === 'running' ? `Using ${tool}` : (STATUS_LABEL[status] ?? status)}${queued}` : ''
  return (
    <section id="control-panel" aria-label="Agent controls" style={CONSOLE_STYLE}>
      <header className="project-console-head">
        <strong className="project-console-title">Project manager · {project.name}</strong>
        <span className={`subtle${status === 'approval' ? ' stale' : ''}`} aria-live="polite">
          {state}
        </span>
        <span className="subtle day-gate-note" title={GATE_TITLE}>
          Changes need your approval
        </span>
      </header>
      {session?.error ? (
        <p className="form-error" role="alert">
          {session.error}
        </p>
      ) : null}
      <Conversation sessionKey={`managed:${managerId}`} onNotice={toast} />
      <AskBox project={project} />
    </section>
  )
}

/** Send the manager a message. Enter sends, Shift+Enter breaks the line. */
function AskBox({ project }: { project: Project }) {
  const toast = useToast()
  const post = useProjectPost()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = async () => {
    const message = text.trim()
    if (!message) return toast('Type your question first.')
    setSending(true)
    try {
      await post(`/api/projects/${project.id}/ask`, { message, requestId: newRequestId() })
      setText('')
    } catch (error) {
      // The text stays, so a refused send (the agents are busy) can be sent again.
      toast(errorMessage(error))
    } finally {
      setSending(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!sending) void send()
  }
  return (
    <div className="project-ask">
      <textarea
        rows={2}
        maxLength={8000}
        placeholder="Ask about this project: status, blockers, are we on track…"
        aria-label="Message to the project manager"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="button resume" disabled={sending} onClick={() => void send()}>
        Send <Icon name="arrow" />
      </button>
    </div>
  )
}

