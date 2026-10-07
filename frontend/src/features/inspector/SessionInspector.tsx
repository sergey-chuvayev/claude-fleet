// The inspector column for a managed or external session (F04, F30), ported from
// public/app.js renderDetail and public/review.js: the review strip for the PRs a
// session mentioned (#review-panel), then #detail-content with the latest request and
// response (external sessions), context pressure, activity, message count, linked
// work, environment and identity, the transcript truncation note, archive/restore and
// the resume command. SessionDetail mounts it beside the control panel; with a
// composer present the page head is hidden by CSS, as legacy did.
import { Fragment } from 'react'
import type { Selection } from '../../app/state'
import { selectionKey } from '../../app/state'
import { RelativeTime } from '../../components/clock'
import { CopyButton } from '../../components/CopyButton'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { sessionKey } from '../../domain/ids'
import { tokens } from '../../domain/format'
import { contextPercent, heat, partitionSessions, shortModel } from '../../domain/sessions'
import type { SessionRow } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { useArchive } from '../archive/useArchive'
import { Callout, Bar, PageHead, Section, Stat } from '../../components/ui'
import { ReviewStrip } from '../sessions/review/ReviewStrip'
import { StatusBadgeView } from '../sessions/SessionRow'
import '../archive/archive.css'
import '../sessions/sessions.css'
import './session-inspector.css'

export interface SessionInspectorProps {
  readonly selection: Extract<Selection, { kind: 'managed' | 'external' }>
}

/** Only GitHub and Linear links are linked work; everything else stays in the transcript. */
/** What an unknown fact reads as (legacy printed an em dash). */
const ABSENT = '\u2014'

const WORK_LINK = /^https:\/\/(github\.com|linear\.app)\//

export function SessionInspector({ selection }: SessionInspectorProps) {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const key = selectionKey(selection)
  const row = sessions.data ? partitionSessions(sessions.data).rows.find(candidate => sessionKey(candidate) === key) : undefined
  if (!row) {
    return (
      <div id="detail-content">
        <EmptyState title="The full picture." text="Select a session to inspect it." />
      </div>
    )
  }
  return (
    <>
      <ReviewStrip key={key} row={row} />
      <InspectorBody row={row} />
    </>
  )
}

function controlText(row: SessionRow): string {
  if (row.managed) return 'Fleet-managed'
  return row.alive ? 'Terminal · monitor only' : 'Saved · ready to continue'
}

function InspectorBody({ row }: { row: SessionRow }) {
  const { setArchived } = useArchive()
  const percent = contextPercent(row)
  const tone = heat(percent)
  const links = (row.links ?? []).filter(link => WORK_LINK.test(link.url))
  const model = shortModel(row.model)
  const facts: Array<[string, string | null | undefined]> = [
    ['Project', row.cwdShort],
    ['Branch', row.branch],
    ['Model', model],
    ['Permissions', row.permissionMode || 'Default'],
    ['Control', controlText(row)],
    ['Session', row.sessionId],
  ]
  const archivable = !row.managed && !!row.sessionId

  return (
    <div id="detail-content">
      <PageHead
        className="detail-head"
        title={row.title || row.name || 'Untitled session'}
        actions={
          <>
            <StatusBadgeView row={row} />
            {archivable ? (
              <button type="button" className="button ghost" id="toggle-archive" onClick={() => void setArchived([row.sessionId!], !row.archived)}>
                {row.archived ? 'Restore' : 'Archive'}
              </button>
            ) : null}
            {row.resumeCmd && !row.managed ? (
              <CopyButton
                id="copy-resume"
                text={row.resumeCmd}
                copiedMessage="Resume command copied"
                failedMessage="Clipboard unavailable. The command is shown below."
              >
                Copy resume command
              </CopyButton>
            ) : null}
          </>
        }
        strip={
          <>
            {/* Unknown context is "Not available", never 0%. */}
            <Stat label="Context" tone={percent === null ? 'quiet' : tone || undefined}>
              {percent === null ? (
                'Not available'
              ) : (
                <>
                  <Bar percent={percent} />
                  {Math.round(percent)}%{' '}
                  <small>
                    {tokens(row.contextTokens ?? 0)} / {tokens(row.contextLimit ?? 0)}
                  </small>
                </>
              )}
            </Stat>
            <Stat label="Active">
              <RelativeTime at={row.lastActivity} /> <small>ago</small>
            </Stat>
            <Stat label="Messages">{row.messages ?? 0}</Stat>
            {model ? <Stat label="Model">{model}</Stat> : null}
          </>
        }
      />
      <div className="page-body detail-body">
        {percent !== null && percent >= 75 ? (
          <Callout title={percent >= 90 ? 'Context nearly full' : 'Context is getting full'} tone="needs">
            {percent >= 90 ? 'Compaction may happen soon.' : null}
          </Callout>
        ) : null}
        {row.managed ? null : (
          <Section label="Latest response" aside={row.latestResponseAt ? <RelativeTime at={row.latestResponseAt} suffix=" ago" /> : undefined}>
            <div className={`response ${row.latestResponse ? '' : 'missing'}`}>{row.latestResponse || 'No assistant response recorded yet.'}</div>
          </Section>
        )}
        {row.lastPrompt && !row.managed ? (
          <Section label="Latest request">
            <div className="response">{row.lastPrompt}</div>
          </Section>
        ) : null}
        <Section label="Linked work" aside="From transcript">
          {links.length ? (
            <>
              <div className="links">
                {links.map(link => (
                  <a key={link.url} className="work-link" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                    <Icon name={link.kind === 'pr' ? 'pr' : 'ticket'} /> {link.label ?? link.url} <Icon name="arrow" />
                  </a>
                ))}
              </div>
              <p className="note">Recorded references, not live status.</p>
            </>
          ) : (
            <p className="note">GitHub PR and Linear issue URLs appear here when mentioned in the conversation.</p>
          )}
        </Section>
        <Section label="Environment">
          <dl className="facts">
            {facts.map(([label, value]) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value ?? ABSENT}</dd>
              </Fragment>
            ))}
          </dl>
        </Section>
        {row.transcriptTruncated ? (
          <p className="note">Showing the most recent 6 MB of this transcript. Earlier responses and links may be absent.</p>
        ) : null}
        {row.archived ? <p className="note archived-note">Archived. Hidden from your fleet, still on disk, still resumable and still searchable.</p> : null}
      </div>
    </div>
  )
}
