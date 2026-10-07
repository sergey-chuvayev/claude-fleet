// One project (F19): its title and what can be done to it, a strip of figures, the
// project manager's ask box until it has a manager, its deliverables, member sessions,
// log, brief, the other sections of its Markdown file and its links. Everything shown
// comes from the project file through /api/projects, so a hand edit appears with the
// next refresh.
import { useEffect, useRef, useState } from 'react'
import { useActions } from '../../app/AppStore'
import type { ManagedId } from '../../domain/ids'
import { CopyButton } from '../../components/CopyButton'
import { Fold } from '../../components/Disclosure'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { useToast } from '../../components/Toast'
import { Markdown } from '../../components/markdown/Markdown'
import { useNow } from '../../components/clock'
import type { Project, SessionSummary } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { ArchivedProjects } from './ArchivedProjects'
import { useDraft } from './ProjectsContext'
import { TaskRow } from './TaskRow'
import { MANAGER_BUSY, SESSION_STATE, SESSION_TONE, daysLeft, linkText, managerOf, membersOf, sectionKeys } from './model'
import { Callout, List, Log, PageHead, Pill, Ring, Row, Section, Stat } from '../../components/ui'
import { isWebLink } from '../../domain/links'
import { dropProject, errorMessage, newRequestId, useProjectPost } from './useProjectPost'

/** Archiving takes two clicks, the second within a few seconds, like closing an agent. */
const ARM_MS = 4000

export interface SwitcherProps {
  readonly projects: readonly Project[]
  readonly selected: string | undefined
  /** On the new-project form the switcher reads "New project". */
  readonly creating: boolean
  readonly onPick: (id: string) => void
}

/** The header every project view shares: a switcher between projects. */
export function Switcher({ projects, selected, creating, onPick }: SwitcherProps) {
  if (!projects.length) return null
  const options = projects.map(p => ({ value: p.id, label: p.name }))
  if (creating) options.push({ value: '', label: 'New project' })
  return <Select label="Switch project" value={creating ? '' : (selected ?? '')} options={options} onChange={id => id && onPick(id)} />
}

export function NewProjectButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button ghost" data-new onClick={onClick}>
      <Icon name="plus" /> New project
    </button>
  )
}

export interface ProjectPageProps {
  readonly project: Project
  readonly projects: readonly Project[]
  readonly sessions: readonly SessionSummary[]
  readonly onPick: (id: string) => void
  readonly onNew: () => void
}

export function ProjectPage({ project: p, projects, sessions, onPick, onNew }: ProjectPageProps) {
  const now = useNow(60_000)
  const left = daysLeft(p.deadline, now)
  const members = membersOf(sessions, p.id)
  const log = p.log.slice(-5).reverse()
  const keys = sectionKeys(p.sections.map(section => section.heading))
  const webLinks = p.links.filter(isWebLink)
  return (
    <>
      <PageHead
        title={p.name}
        actions={
          <>
            <Switcher projects={projects} selected={p.id} creating={false} onPick={onPick} />
            <NewProjectButton onClick={onNew} />
            <CopyButton
              text={p.file}
              data-copy-path={p.file}
              title={p.file}
              copiedMessage="Path copied. Edit the file by hand any time; Fleet reads it."
              failedMessage={p.file}
              fallback={false}
            >
              Copy file path
            </CopyButton>
            <ArchiveButton project={p} />
          </>
        }
        strip={
          <>
            {p.deadline ? (
              <Stat label="Deadline">{new Date(`${p.deadline}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}</Stat>
            ) : null}
            {left !== null ? (
              <Stat label="Left" tone={left <= 2 ? 'hot' : left <= 5 ? 'warn' : undefined}>
                {left} <small>working day{left === 1 ? '' : 's'}</small>
              </Stat>
            ) : null}
            <Stat label="Done">
              <Ring done={p.progress.done} total={p.progress.total} />
              {p.progress.done} <small>of {p.progress.total}</small>
            </Stat>
            <Stat label="Sessions">{members.length}</Stat>
          </>
        }
      />
      <div className="page-body">
        <SettingUp project={p} sessions={sessions} />
        {p.managerId ? null : <AskManager project={p} />}
        <Section label="Deliverables" count={`${p.progress.done}/${p.progress.total}`}>
          {p.deliverables.length ? (
            <List>
              {p.deliverables.map(d => (
                <TaskRow key={d.id} project={p} deliverable={d} />
              ))}
            </List>
          ) : (
            <p className="note">No deliverables yet. The project manager adds them as it learns what has to ship, or tell it.</p>
          )}
        </Section>
        <Section label="Sessions" count={members.length}>
          <Members members={members} />
        </Section>
        {log.length ? (
          <Section label="Log">
            <Log entries={log.map(l => [new Date(l.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), l.text] as const)} />
          </Section>
        ) : null}
        {p.brief ? (
          <Section label="Brief">
            <div className="project-md">
              <Markdown source={p.brief} />
            </div>
          </Section>
        ) : null}
        {p.sections.length ? (
          <div className="ui-folds">
            {p.sections.map((section, index) => (
              <Fold key={keys[index]} summary={section.heading} data-keep-open={section.heading}>
                <div className="project-md">
                  <Markdown source={section.body} />
                </div>
              </Fold>
            ))}
          </div>
        ) : null}
        {webLinks.length ? (
          <Section label="Links">
            <span className="day-links">
              {webLinks.map(url => (
                <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                  {linkText(url)} <Icon name="arrow" />
                </a>
              ))}
            </span>
          </Section>
        ) : null}
        <ArchivedProjects />
      </div>
    </>
  )
}

function ArchiveButton({ project }: { project: Project }) {
  const client = useFleetClient()
  const toast = useToast()
  const post = useProjectPost()
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  // The armed state belongs to one project: switching away disarms it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: disarm exactly when the project changes
  useEffect(() => setArmed(false), [project.id])

  const click = async () => {
    if (!armed) {
      setArmed(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setArmed(false), ARM_MS)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    setArmed(false)
    try {
      await post(`/api/projects/${project.id}/archive`, { archived: true })
      dropProject(client, project.id)
      toast(`Archived ${project.name}. Restore it from Archived projects.`)
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  return (
    <button type="button" className="button ghost" data-archive={project.id} onClick={() => void click()}>
      {armed ? 'Archive for good?' : 'Archive'}
    </button>
  )
}

/** While the manager's first run is under way, the empty parts of the project say why. */
function SettingUp({ project: p, sessions }: { project: Project; sessions: readonly SessionSummary[] }) {
  if (p.brief && p.deliverables.length) return null
  const manager = managerOf(sessions, p)
  const busy = !!manager && (MANAGER_BUSY as readonly string[]).includes(manager.managedStatus ?? '')
  return busy ? (
    <Callout
      tone="working"
      title={
        <>
          <span className="day-spinner" aria-hidden="true" /> Setting up
        </>
      }
    >
      The project manager is filling in the brief, deadline, deliverables and sources. Watch it on the right.
    </Callout>
  ) : (
    <Callout title="Not set up yet">Tell the project manager on the right what this project is, or ask it to look it up.</Callout>
  )
}

function AskManager({ project }: { project: Project }) {
  const client = useFleetClient()
  const toast = useToast()
  const post = useProjectPost()
  const ask = useDraft(`ask:${project.id}`)
  const [sending, setSending] = useState(false)
  const send = async () => {
    const message = ask.value.trim()
    if (!message) return toast('Type your question first.')
    setSending(true)
    try {
      await post(`/api/projects/${project.id}/ask`, { message, requestId: newRequestId() })
      ask.clear()
      await client.store.refresh(client.resources.sessions)
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <Section label="Project manager">
      <p className="note">
        One agent that follows this project: its sessions, PRs and tickets, and the deliverables below. Ask it where things stand; it can put next
        steps on your Day.
      </p>
      <div className="ui-ask">
        <input
          maxLength={2000}
          placeholder="Where are we? What is blocking? Are we on track for the deadline?"
          aria-label="Ask the project manager"
          data-project-ask=""
          value={ask.value}
          onChange={ask.onChange}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (!sending) void send()
          }}
        />
        <button type="button" className="button resume" data-ask-project={project.id} disabled={sending} onClick={() => void send()}>
          Ask <Icon name="arrow" />
        </button>
      </div>
    </Section>
  )
}

function Members({ members }: { members: readonly SessionSummary[] }) {
  const { select } = useActions()
  if (!members.length) return <p className="note">No sessions yet. Tag one from its console, or launch from your Day.</p>
  return (
    <List compact>
      {members.map(s => {
        const status = s.managedStatus ?? ''
        const label = SESSION_STATE[status] ?? status
        const title = String(s.title || s.name || 'Session').slice(0, 80)
        return (
          <Row
            key={s.managedId ?? title}
            tone={SESSION_TONE[status]}
            orbTitle={label}
            title={title}
            meta={<Pill tone={SESSION_TONE[status]}>{label}</Pill>}
            side={
              <button
                type="button"
                className="button ghost"
                data-open-session={s.managedId}
                onClick={() => s.managedId && select({ kind: 'managed', managedId: s.managedId as ManagedId }, { reveal: true })}
              >
                Open <Icon name="arrow" />
              </button>
            }
          />
        )
      })}
    </List>
  )
}
