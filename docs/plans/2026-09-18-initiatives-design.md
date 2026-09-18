# Initiatives: a team of agents behind one conversation

An **initiative** is a goal with a team working on it. The operator states the goal and
talks to one agent, the manager. The manager does not write code; it decomposes the work,
delegates to a developer, has a QA verify the result, and opens a pull request when the
work holds up. The other roles never address the operator.

This is Fleet's third entity, after the read-only external session and the managed
conversation. An external session is something you watch. A managed conversation is one
agent you talk to. An initiative is one goal, several agents, and a single inbox.

## Topology: in-process subagents

The Agent SDK already provides the orchestration. `options.agent` makes a named agent the
main thread; `options.agents` defines the rest programmatically, with no files on disk.
Compiled at launch, an initiative is a managed session with two extra options:

```js
options.agent  = 'manager'           // owns the main thread, so owns the conversation
options.agents = { developer, qa }   // reachable only through the Task tool
options.cwd    = initiative.worktree.path
```

The operator talks to the main thread, therefore to the manager. The developer and QA run
inside the manager's process as Task invocations and have no channel to the operator at
all. That property is structural rather than a rule stated in a prompt, which is the main
reason to prefer this shape.

Consequences accepted:

- Subagents are one-shot. A QA has no memory of the previous round unless given one
  through `AgentDefinition.memory`.
- Team members are not separate rows. They appear as delegation blocks inside the
  manager's conversation.
- An initiative consumes one of the four run slots, not three. Capacity accounting,
  cancellation, the process lock and the held-elsewhere check are unchanged.
- Every subagent's final report lands in the manager's context. Their working transcripts
  do not, which is the point of delegating at all.

Separate Fleet sessions per role was considered and rejected for a first version. It needs
an inter-session protocol, a scheduler against the four-run limit, deadlock handling when a
member blocks on an approval, and it breaks the one-turn-per-agent invariant. The team
definition is kept as stored data so the execution strategy can change later without
changing the entity.

## Data model

A **team** is a reusable template; an **initiative** is one instance of a team pointed at a
goal. The split mirrors Fleet's existing separation of the launch form from the session.

```
team       { id, name, description, manager: <role>, roles: { <role>: AgentDefinition } }
initiative { ...session, kind: 'initiative', teamId, brief,
             worktree: { path, branch, base }, pr: { number, url } | null }
```

Teams are defined in code for the first version, with `bugfix` (manager, developer, qa) as
the only built-in. Initiatives persist alongside managed conversations in
`.fleet/sessions.json` and obey the same 100-conversation cap and message window.

## The three roles

Each role's prompt states that it is a subagent, that it reports to the manager, and that
it never addresses the operator. Without that, subagents behave as standalone agents and
write to the user.

**Manager.** `disallowedTools: ['Write', 'Edit', 'NotebookEdit']`. It cannot ship except by
delegating, which is the whole point of the role; given edit tools it will decide the fix
is small and do it itself. Every delegation must carry four things, or the receiving agent
drifts: the objective, the boundaries it must not touch, the exact gate commands, and the
definition of done. Two tasks may never touch the same file set. The manager replies to the
operator once per turn and opens the pull request after QA passes.

**Developer.** Full tool access inside the worktree. Runs the repo's gates before reporting.
Returns what changed, which files, the gate output, and what it deliberately did not do.

**QA.** `disallowedTools: ['Write', 'Edit', 'NotebookEdit']`, keeps Bash. It reproduces the
original problem and runs the gates itself rather than trusting the developer's account; a
QA that only re-reads the diff agrees with the diff. It returns a verdict with evidence,
and failing the developer is an expected outcome rather than an exception.

Per-role `model` and `effort` are part of the definition, so a role that mostly reads can
run cheaper than one that reasons.

## Worktree and exit

An initiative creates its own git worktree from the base branch and the team works only
there, so concurrent initiatives and the operator's own editing cannot collide. The
initiative ends when QA passes and the manager opens a pull request. Merged worktrees are
cleaned up by the existing `worktree-gc` skill.

## Work

| File | Change |
|---|---|
| `teams.js` | New. Built-in teams, role validation, compilation to `{ agent, agents }` |
| `managed.js` | Carry `teamId` and `worktree` on the session; pass the compiled options in `run()` |
| `public/blocks.js` | Delegation block: role, mandate, returned report, collapsible |
| `public/control.js` | Launch an initiative: brief, project, team, base branch |
| Role prompts | The actual product. Everything above is plumbing |

`fleet.js:77` already categorises `Task` as `delegate` and `blocks.js` already renders its
prompt, so the activity strip needs no new vocabulary.

## Risks

**Approval attribution.** `canUseTool` fires for subagent calls, since they run in the same
process, so a destructive command still stops. The approval card currently names the
session. It must name the role, or Auto mode asks the operator to approve `rm` without
saying who wants it.

**`agent` against the preset system prompt: settled, they compose.** Measured against the
real SDK before the role prompts were written. With both `systemPrompt: { preset:
'claude_code' }` and `agent: 'probe'` set, the main thread answers as the named agent and
keeps the preset's built-in tools. No fallback was needed. Two details the probe fixed:

- The delegation tool is named **`Agent`**, not `Task`. `Task` is the older name for the
  same call and still appears in recorded transcripts, so the UI treats both as delegations.
  Its input is `{ subagent_type, description, prompt }` and its result is the report text.
- The manager must appear in `agents` as well as in `agent`, because that is where the name
  resolves from. It therefore cannot be barred from invoking itself by construction, only by
  instruction, which its prompt does explicitly.

Fleet already drops every subagent-internal event via `!event.parent_tool_use_id`, so a
delegation surfaces as exactly one block and the subagent's own tool calls stay out of the
conversation. That was free.

**Cost.** Multi-agent work runs roughly fifteen times the tokens of a single chat turn and
only pays off when the task genuinely decomposes. An initiative is for a goal, not for a
one-line fix. The launch path should make a plain managed agent the easier choice.

**Turn length.** A manager turn that delegates three tasks in sequence runs for many
minutes, and Fleet allows no message while an agent is working. Whether the operator can
queue a note mid-turn is unresolved.

## Out of scope

Separate sessions per role, teams beyond the built-in three, editing teams from the UI, and
memory shared across initiatives.
