// One of the Day's subagents, read-only: its assignment, steps, latest output and its
// report to the Day, with the role's other runs today to pick from.
import { useNow } from '../../components/clock'
import { elapsed } from '../../domain/format'
import type { DaySubagent } from '../../transport/contracts'
import { AGENT_STATE, runGist } from './day'

const clockOf = (at: number | null | undefined) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
const plainInput = (input: unknown) => (typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2))
// mcp__server__tool reads as tool.
const stepTool = (tool: string) => tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')

export function ScoutView({ run, runs, onPick }: { run: DaySubagent; runs: readonly DaySubagent[]; onPick: (id: string) => void }) {
  const running = run.status === 'running'
  const now = useNow(running ? 1000 : 60_000)
  const history = runs.filter(x => x.role === run.role).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  const steps = run.steps ?? []
  const took = run.startedAt ? ` · ${elapsed((run.finishedAt || now) - run.startedAt)}` : ''
  return (
    <section id="day-agent-view" className="day-agent-view" aria-label={`${run.role} run`}>
      <header className="day-agent-head">
        <span className={`badge ${AGENT_STATE[run.status] ?? ''}`}>
          <span className="dot" />
          {run.status}
        </span>
        <h3>{run.role}</h3>
        <span className="note">
          {run.model ? run.model.replace('claude-', '') : ''}
          {took}
          {run.description ? ` · ${run.description}` : ''}
        </span>
      </header>
      {history.length > 1 ? (
        <section className="detail-section">
          <h3>
            Runs today <span>{history.length}</span>
          </h3>
          <ol className="scout-runs">
            {history.map(x => (
              <li key={x.id}>
                <button type="button" className="scout-run" data-agent={x.id} aria-current={x.id === run.id} onClick={() => onPick(x.id)}>
                  <span className={`dot ${AGENT_STATE[x.status] ?? ''}`} />
                  <time>{clockOf(x.startedAt)}</time>
                  <span className="scout-run-gist">{runGist(x)}</span>
                  <small>
                    {(x.steps ?? []).length} step{(x.steps ?? []).length === 1 ? '' : 's'}
                  </small>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <section className="detail-section">
        <h3>Assignment</h3>
        <div className="response">{run.prompt || 'Not recorded.'}</div>
      </section>
      <section className="detail-section">
        <h3>Steps</h3>
        {steps.length ? (
          <ol className="child-steps">
            {steps.map(step => (
              <li key={step.id} className="child-step" data-status={step.status}>
                <span className="child-step-tool">{stepTool(step.tool)}</span>
                {step.target ? <span className="child-step-target">{step.target}</span> : null}
                <span className="child-step-state">{step.status}</span>
                <span className="child-step-time">{step.ms != null ? elapsed(step.ms) : step.status === 'running' ? 'running…' : ''}</span>
                <details className="child-step-detail">
                  <summary>Input and output</summary>
                  <h4>Input</h4>
                  <pre>{plainInput(step.input)}</pre>
                  <h4>Output{step.truncated ? ' · truncated' : ''}</h4>
                  <pre>{step.result ?? 'No result yet.'}</pre>
                </details>
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">No tool steps yet.</p>
        )}
      </section>
      {run.output && running ? (
        <section className="detail-section">
          <h3>Latest output</h3>
          <div className="response">{run.output}</div>
        </section>
      ) : null}
      <section className="detail-section">
        <h3>Report to the Day</h3>
        <div className={`response${run.report ? '' : ' missing'}`}>{run.report || (running ? 'Still working…' : 'No report.')}</div>
      </section>
    </section>
  )
}
