// What a tool block shows: its input per tool (command, diff, file, todo list,
// delegation mandate) and its result. Ported from toolBody/resultHtml in
// public/blocks.js. Tool input is always rendered as React text, or as highlight.js
// output, which escapes what it is given; it never reaches the Markdown boundary
// except a delegation's mandate and report, which are agent prose.
import { memo, useRef } from 'react'
import { cachedHighlight } from '../../components/markdown/cache'
import { Markdown } from '../../components/markdown/Markdown'
import type { Message } from '../../transport/contracts'
import { TARGET_KEYS, isDelegation, languageFor, text } from './format'
import { Disclosure, useSeen } from './primitives'

/** A code panel: highlighted once it is near the screen, plain escaped text before that. */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  variant,
}: {
  code: string
  language: string | null
  variant?: 'is-command' | undefined
}) {
  const ref = useRef<HTMLPreElement>(null)
  const seen = useSeen(ref)
  const source = code.replace(/\s+$/, '')
  if (!source) return null
  return (
    <pre ref={ref} className={variant ? `block-code ${variant}` : 'block-code'}>
      {seen ? (
        // highlight.js escapes its input; cachedHighlight falls back to escaped text.
        <code className="hljs" dangerouslySetInnerHTML={{ __html: cachedHighlight(source, language) }} />
      ) : (
        <code className="hljs">{source}</code>
      )}
    </pre>
  )
})

const MARK: Readonly<Record<string, string>> = { completed: '☑', in_progress: '▸' }

interface Todo {
  readonly content?: unknown
  readonly activeForm?: unknown
  readonly status?: unknown
}

function TodoList({ todos }: { todos: readonly Todo[] }) {
  if (!todos.length) return null
  return (
    <ul className="block-todos">
      {todos.map((todo, index) => {
        const status = text(todo.status)
        return (
          // Todos carry no id; their order is their identity within one call.
          <li key={index} className={`todo-${status}`}>
            <span aria-hidden="true">{MARK[status] ?? '☐'}</span>
            {text(todo.content) || text(todo.activeForm)}
          </li>
        )
      })}
    </ul>
  )
}

function editDiff(before: string, after: string): string {
  const lines: string[] = []
  if (before) for (const line of before.split('\n')) lines.push(`- ${line}`)
  if (after) for (const line of after.split('\n')) lines.push(`+ ${line}`)
  return lines.join('\n')
}

export function ToolBody({ message }: { message: Message }) {
  // A grouped block (the Day's board calls) brings its own plain-language lines.
  if (Array.isArray(message.lines)) {
    return (
      <ul className="block-lines">
        {message.lines.map((line, index) => (
          <li key={index} className={line.error ? 'is-error' : ''}>
            {line.text}
          </li>
        ))}
      </ul>
    )
  }
  const input = message.input ?? {}
  const name = message.tool ?? ''
  if (name === 'Bash' || name === 'BashOutput') {
    return <CodeBlock code={text(input.command) || text(input.bash_id)} language="bash" variant="is-command" />
  }
  if (name === 'Edit' || name === 'NotebookEdit') {
    const before = text(input.old_string ?? input.old_source)
    const after = text(input.new_string ?? input.new_source)
    if (!before && !after) return <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    return <CodeBlock code={editDiff(before, after)} language="diff" />
  }
  if (name === 'Write') return <CodeBlock code={text(input.content)} language={languageFor(input.file_path)} />
  if (name === 'TodoWrite') return <TodoList todos={Array.isArray(input.todos) ? (input.todos as Todo[]) : []} />
  if (isDelegation(name)) {
    return (
      <Disclosure className="delegation-mandate" name="mandate" summary="Mandate">
        <Markdown source={text(input.prompt) || text(input.description) || 'No mandate recorded.'} />
      </Disclosure>
    )
  }
  if (name === 'Skill') return <CodeBlock code={text(input.prompt) || text(input.args) || text(input.description)} language="plaintext" />
  if (name === 'AskUserQuestion') return null
  // The header already shows the main argument, so repeating it as JSON is noise.
  const shown = TARGET_KEYS[name] ?? 'file_path'
  const rest = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => key !== shown && key !== 'path' && value !== '' && value != null),
  )
  return Object.keys(rest).length ? <CodeBlock code={JSON.stringify(rest, null, 2)} language="json" /> : null
}

const LONG_REPORT_CHARS = 1200
const LONG_REPORT_LINES = 16

export function ToolResult({ message }: { message: Message }) {
  if (isDelegation(message.tool)) {
    const report = message.result ?? ''
    if (!report) {
      const note =
        message.status === 'running'
          ? 'Awaiting report…'
          : message.status === 'error'
            ? 'Delegation failed without a report.'
            : 'No report returned.'
      return <p className="block-note">{note}</p>
    }
    const long = report.length > LONG_REPORT_CHARS || report.split('\n').length > LONG_REPORT_LINES
    return (
      <Disclosure className="delegation-report" name="report" defaultOpen={!long} summary={`Returned report${long ? ' · long' : ''}`}>
        <Markdown source={report} />
        {message.truncated ? <p className="block-note">Report truncated by Fleet.</p> : null}
      </Disclosure>
    )
  }
  if (!message.result) return null
  const error = message.status === 'error'
  const language = message.tool === 'Read' ? languageFor(message.input?.file_path) : error ? 'plaintext' : null
  return (
    <div className={error ? 'block-result is-error' : 'block-result'}>
      <CodeBlock code={message.result} language={language} />
      {message.truncated ? <p className="block-note">Output truncated by Fleet.</p> : null}
    </div>
  )
}
