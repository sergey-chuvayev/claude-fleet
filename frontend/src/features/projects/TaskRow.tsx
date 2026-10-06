// One deliverable (F19, F31, F34): its state, its note, its brief and sources, a comment
// box that goes to the project manager, and "Today" to hand it to the Day. Keyed by the
// stable deliverable id, scoped to its project, never by title or position.
import { type KeyboardEvent, useState } from 'react'
import { useActions } from '../../app/AppStore'
import type { DayItemId } from '../../domain/ids'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { useToast } from '../../components/Toast'
import { Markdown } from '../../components/markdown/Markdown'
import { type Deliverable, type Project, DELIVERABLE_STATES } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { useDraft, useProjectsMemory } from './ProjectsContext'
import { DAY_STATUS, STATE, STATE_TONE } from './model'
import { LinkChips, Row } from '../../components/ui'
import { errorMessage, newRequestId, useProjectPost } from './useProjectPost'

const STATE_OPTIONS = DELIVERABLE_STATES.map(value => ({ value, label: STATE[value] ?? value }))

export function TaskRow({ project, deliverable: d }: { project: Project; deliverable: Deliverable }) {
  const toast = useToast()
  const client = useFleetClient()
  const post = useProjectPost()
  const { select } = useActions()
  const { openTasks, setTaskOpen } = useProjectsMemory()
  const taskKey = `${project.id}:${d.id}`
  // What the select shows while its change is on the wire, so it never snaps back.
  const [pendingState, setPendingState] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const shownState = pendingState ?? d.state
  const today = project.onToday[d.id]

  const changeState = async (state: string) => {
    setPendingState(state)
    try {
      await post(`/api/projects/${project.id}/deliverable`, { deliverableId: d.id, state })
      await client.store.refresh(client.resources.projects)
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setPendingState(null)
    }
  }

  const planOnToday = async () => {
    setPlanning(true)
    try {
      const answer = (await post(`/api/projects/${project.id}/today`, { deliverableId: d.id })) as { existing?: boolean }
      toast(answer.existing ? 'Already on today.' : 'On today. The Day agent is preparing a launch brief.')
      await client.store.refresh(client.resources.projects)
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setPlanning(false)
    }
  }

  const todayButton = today ? (
    <button
      type="button"
      className="button ghost is-on-today"
      data-open-today={today.itemId}
      title={`On today's Day: ${DAY_STATUS[today.status] ?? today.status}`}
      onClick={() => select({ kind: 'day-thread', itemId: today.itemId as DayItemId }, { reveal: true })}
    >
      {today.status === 'done' ? 'Done today' : 'On Today'} <Icon name="arrow" />
    </button>
  ) : d.state === 'done' ? null : (
    <button
      type="button"
      className="button ghost"
      data-plan-today={d.id}
      disabled={planning}
      title="Put this on today's Day. The Day agent prepares a launch brief for you to approve."
      onClick={() => void planOnToday()}
    >
      <Icon name="plus" /> Today
    </button>
  )

  return (
    <Row
      tone={STATE_TONE[shownState] ?? 'todo'}
      orbTitle={STATE[shownState] ?? shownState}
      title={d.title}
      evidence={`task:${d.id}`}
      meta={
        <>
          <LinkChips urls={d.links} limit={3} quiet />
          {d.note ? (
            <span className="ui-row-latest" title={d.note}>
              {d.note}
            </span>
          ) : null}
        </>
      }
      side={
        <>
          {todayButton}
          <Select
            label={`State of ${d.title}`}
            value={shownState}
            options={shownState in STATE ? STATE_OPTIONS : [...STATE_OPTIONS, { value: shownState, label: shownState }]}
            onChange={value => void changeState(value)}
          />
        </>
      }
      detail={<TaskDetail project={project} deliverable={d} />}
      open={openTasks.has(taskKey)}
      onOpenChange={open => setTaskOpen(taskKey, open)}
    />
  )
}

/** Its brief and sources, and a comment box. A comment goes to the project manager, which updates the task. */
function TaskDetail({ project, deliverable: d }: { project: Project; deliverable: Deliverable }) {
  const toast = useToast()
  const client = useFleetClient()
  const post = useProjectPost()
  const comment = useDraft(`comment:${project.id}:${d.id}`)
  const [sending, setSending] = useState(false)

  const send = async () => {
    const message = comment.value.trim()
    if (!message) return toast('Write your comment first.')
    setSending(true)
    try {
      await post(`/api/projects/${project.id}/comment`, { deliverableId: d.id, message, requestId: newRequestId() })
      comment.clear()
      toast('Comment sent. The project manager is updating the task.')
      await client.store.refresh(client.resources.projects)
    } catch (error) {
      // The text stays, so a refused comment (the agents are busy) can be sent again.
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
    <div className="task-detail">
      {d.brief ? (
        <div className="project-md">
          <Markdown source={d.brief} />
        </div>
      ) : (
        <p className="note">No brief yet. Comment below to give it one, or ask the project manager.</p>
      )}
      {d.links.length ? (
        <div className="task-sources">
          <span className="task-sources-label">Sources</span>
          <LinkChips urls={d.links} />
        </div>
      ) : null}
      <div className="ui-ask task-comment">
        <textarea
          rows={1}
          maxLength={8000}
          placeholder="Comment on this task: a decision, new info, what changed…"
          aria-label={`Comment on ${d.title}`}
          value={comment.value}
          onChange={comment.onChange}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="button" data-send-comment={d.id} disabled={sending} onClick={() => void send()}>
          Comment <Icon name="arrow" />
        </button>
      </div>
    </div>
  )
}
