// The read-only detail of a delegated agent (F05), in #detail-content: its mandate,
// the steps it took, its report to the manager, model, duration and usage. There is
// no composer and nothing here that could send it input: a sub-agent is not
// addressable on its own. The list row carries only id/role/model/status; the rest
// comes from the parent's managed detail (taskBoard.delegations), which refreshes with
// the list, independent of the manager's own panel.
import type { Selection } from '../../app/state'
import { Disclosure } from '../../components/Disclosure'
import { Elapsed } from '../../components/clock'
import { Icon } from '../../components/Icon'
import { elapsed, tokens } from '../../domain/format'
import { partitionSessions } from '../../domain/sessions'
import { type DelegationRecord, type DelegationStep, delegationOf } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { PageHead, Pill, Section, Stat } from '../../components/ui'
import '../inspector/session-inspector.css'
import './agents.css'
import { DELEGATION_BADGE, DELEGATION_LABEL, formatModel } from './visibleDelegations'

export interface DelegationDetailProps {
  readonly selection: Extract<Selection, { kind: 'delegation' }>
}

const STEP_LABEL: Readonly<Record<string, string>> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  interrupted: 'Interrupted',
  unreported: 'Unreported',
}

function usageText(full: DelegationRecord | null): string {
  const usage = full?.usage
  if (usage)
    return `${tokens(usage.input_tokens || 0)} input · ${tokens(usage.output_tokens || 0)} output · ${tokens(usage.cache_read_input_tokens || 0)} cache read · ${tokens(usage.cache_creation_input_tokens || 0)} cache write`
  const total = full?.runtimeUsage?.total_tokens
  return total != null ? `${tokens(total)} tokens reported` : 'Token usage not reported'
}

const inputText = (input: unknown): string =>
  input == null ? 'Not recorded' : typeof input === 'string' ? input : JSON.stringify(input, null, 2)

function StepRow({ step }: { step: DelegationStep }) {
  return (
    <li className="child-step" data-status={step.status}>
      <span className="child-step-tool">{step.tool}</span>
      {step.target ? <span className="child-step-target">{step.target}</span> : null}
      <span className="child-step-state">{STEP_LABEL[step.status] ?? step.status}</span>
      <span className="child-step-time">{step.ms != null ? elapsed(step.ms) : step.status === 'running' ? 'running…' : ''}</span>
      {step.input != null || step.result != null ? (
        // Keyed by step id in the list, so an opened step stays open as the list grows.
        <Disclosure className="child-step-detail" summary="Input and output" lazy data-child-step={step.id}>
          <h4>Input</h4>
          <pre>{inputText(step.input)}</pre>
          <h4>Output{step.truncated ? ' · truncated' : ''}</h4>
          <pre>{step.result ?? 'No result reported yet.'}</pre>
        </Disclosure>
      ) : null}
    </li>
  )
}

export function DelegationDetail({ selection }: DelegationDetailProps) {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const detail = useResource(client.resources.managed(selection.parent))

  const parent = sessions.data ? partitionSessions(sessions.data).rows.find(row => row.managedId === selection.parent) : undefined
  const compact = parent?.delegations?.find(d => d.id === selection.delegationId)
  if (!parent || !compact) return <div id="detail-content" />

  let full: DelegationRecord | null = null
  let error: string | null = detail.error ? detail.error.message || 'Could not load this delegation.' : null
  if (detail.data) {
    try {
      full = delegationOf(detail.data, selection.delegationId)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not load this delegation.'
    }
  }
  const loaded = !!detail.data && !error
  // The list refreshes on every change, so its status is never staler than the detail's.
  const state = compact.status
  const steps = full?.steps ?? []

  return (
    <div id="detail-content">
      <PageHead
        className="detail-head"
        title={
          <>
            <Icon name="pr" /> {compact.role}
          </>
        }
        actions={
          <>
            <Pill>Sub-agent · read only</Pill>
            <span className={`badge ${DELEGATION_BADGE[state] ?? ''}`}>
              <span className="dot" />
              {DELEGATION_LABEL[state] ?? state}
            </span>
          </>
        }
        strip={
          <>
            <Stat label="Model">{formatModel(full?.model || compact.model)}</Stat>
            <Stat label="Duration">
              {full?.startedAt ? full.finishedAt ? elapsed(full.finishedAt - full.startedAt) : <Elapsed since={full.startedAt} /> : 'Duration unavailable'}
            </Stat>
            {full?.attempt ? <Stat label="Attempt">{full.attempt}</Stat> : null}
          </>
        }
      />
      <div className="page-body detail-body">
        {/* Nothing here can answer an approval on the owning session; point back to the row that can. */}
        {parent.managedStatus === 'approval' ? (
          <p className="note child-approval-notice">
            {parent.name || parent.title || 'This session'} needs your approval to continue. Select its row above to respond. This read-only view can’t.
          </p>
        ) : null}
        <p className="note">{usageText(full)}.</p>
        <Section label="Mandate">
          <div className="response">{loaded ? full?.prompt || 'No mandate recorded.' : 'Loading…'}</div>
        </Section>
        <Section label="Steps" aside={full?.stepsTruncated ? 'Showing the most recent 200' : undefined}>
          {steps.length ? (
            <ol className="child-steps">
              {steps.map(step => (
                <StepRow key={step.id} step={step} />
              ))}
            </ol>
          ) : (
            <p className="note">{loaded ? 'No tool steps recorded.' : 'Loading steps…'}</p>
          )}
        </Section>
        <Section label="Report to the manager">
          <div className={`response ${full?.report ? '' : 'missing'}`}>{loaded ? full?.report || 'Waiting for this agent’s report.' : 'Loading…'}</div>
        </Section>
        {error ? <p className="note">{error}</p> : null}
        <p className="note">A sub-agent is not addressable on its own. This is a read-only report back to the manager.</p>
      </div>
    </div>
  )
}
