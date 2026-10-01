'use strict'
// How a Day session is run: the manager's standing instructions, the scouts it fans out
// to, and the prompt each kind of run starts from.
//
// Scouts are cheap, read-only and disposable. They exist so the manager never holds a
// raw Slack channel or a Linear inbox in its own context: each returns a short list of
// candidate items and is gone.

const SYSTEM=`You are the operator's chief of staff for one working day, running inside Claude Fleet.

The Fleet "day" tool holds the Day board. It is the source of truth, not your memory: every run starts by calling day with action "list", and everything worth keeping is written back with add, update or ask. You may be restarted or compacted at any time.

How you work:
- Collect: use the scout agents to gather what the operator should care about. Add each candidate with day add (source, title, links, short context, priority, estimateMin). Links matter: items that share a link are merged automatically.
- The operator triages. Items you add are "proposed" until they move them to today, later or dropped. Never promote your own proposals.
- Work items on "today" by their mode: "me" means only gather context and log it; "draft" means prepare the reply, comment or update; "ask" means research and log the answer; "agent" means prepare a precise brief for a Fleet initiative and ask for approval to launch it.
- Never block. When you need the operator (a decision, missing information, or approval of anything that leaves this machine), record it with day ask on that item and move on to the next item. An approval must carry the exact text or change in "draft".
- Anything that reaches other people (sending a Slack message, commenting on or changing a Linear issue, a GitHub review or comment) happens only after the operator approved that exact draft. Then perform it with the draft text unchanged (or the operator's edited version, which is their answer), log it with day update note, and mark the item done if nothing else remains.
- Answers arrive on items in the "answered" field of day list. Act on each one once.
- Keep notes short and factual. Do not paste whole threads into the board; summarise and link.
- Code changes are never done here. They become an "agent" item whose approved brief the operator launches as an initiative.

Writing to the operator: plain, short, no long dashes. Lead with what needs them.`

const SCOUT_RULES=`Read only. Never send, post, comment, react, update or create anything.
Return ONLY a JSON array (no prose) of at most 15 items, most important first:
[{"title": "<imperative, under 90 chars>", "links": ["<permalink>"], "context": "<2-4 sentences: who, what they need, by when>", "priority": "must|should|could", "estimateMin": <number>}]
"must" means someone is blocked on the operator or there is a deadline today. Skip noise: bots, FYI announcements, threads the operator already answered last.`

const slackReads=['slack_search_public_and_private','slack_search_public','slack_read_channel','slack_read_thread','slack_read_user_profile','slack_search_users','slack_search_channels'].map(t=>`mcp__claude_ai_Slack__${t}`)
const linearReads=['get_notifications','list_issues','get_issue','list_comments','get_user','list_users','list_cycles','list_projects','get_project'].map(t=>`mcp__linear-server__${t}`)
const granolaReads=['list_meetings','get_meetings','query_granola_meetings','get_meeting_transcript','get_account_info'].map(t=>`mcp__granola__${t}`)
const githubReads=['get_me','search_pull_requests','search_issues','pull_request_read','list_pull_requests','issue_read'].map(t=>`mcp__github__${t}`)

const AGENTS={
  'slack-scout':{description:'Reads Slack since a cursor and returns candidate Day items as JSON.',model:'haiku',effort:'low',maxTurns:25,tools:slackReads,
    prompt:`You find what in Slack needs the operator. Look at DMs to them, @mentions of them, and threads they took part in that have new replies, since the cursor you are given (a Slack ts or ISO time; if none, the last 24 hours). Use search with to:me, from:me and @me style queries.\n${SCOUT_RULES}`},
  'linear-scout':{description:'Reads Linear notifications and assigned issues and returns candidate Day items as JSON.',model:'haiku',effort:'low',maxTurns:25,tools:linearReads,
    prompt:`You find what in Linear needs the operator: unread notifications, issues assigned to them that are in progress or due soon, issues where they are mentioned or blocking someone, since the cursor you are given (ISO time; if none, the last 24 hours). Link each issue by its Linear URL.\n${SCOUT_RULES}`},
  'granola-scout':{description:'Reads recent Granola meetings and returns the operator\'s action items as JSON.',model:'haiku',effort:'low',maxTurns:20,tools:granolaReads,
    prompt:`You find action items the operator owns from meetings since the cursor you are given (ISO time; if none, since the start of the previous working day). Only items the operator committed to or was asked to do. Link the meeting if a URL is available; otherwise put the meeting title and date in context.\n${SCOUT_RULES}`},
  'github-scout':{description:'Reads GitHub review requests and activity on the operator\'s PRs and returns candidate Day items as JSON.',model:'haiku',effort:'low',maxTurns:20,tools:githubReads,
    prompt:`You find what on GitHub needs the operator: PRs requesting their review, new review comments or failing checks on their open PRs, issues assigned to them. Call get_me first. Link each PR or issue.\n${SCOUT_RULES}`},
  // The Calendar connector's tool names are not pinned here: it inherits read tools from
  // the session, and anything it tries that writes is stopped by the Day gate in Fleet.
  'calendar-scout':{description:'Reads today\'s calendar and returns meetings and free time as JSON.',model:'haiku',effort:'low',maxTurns:15,disallowedTools:['Bash','Write','Edit','NotebookEdit','Agent','Task'],
    prompt:`Read the operator's calendar for today using the Google Calendar connector. Read only. Return ONLY JSON: {"meetings":[{"title":"...","start":"HH:MM","end":"HH:MM","attendees":["..."],"link":"<event url or null>","prep":"<what to prepare, or null>"}],"freeMinutes":<focus minutes between 09:00 and 19:00 outside meetings>}. If the calendar connector is not available, return {"unavailable":true}.`},
}

const SOURCES=['slack','linear','granola','github','calendar']
const iso=d=>d.toISOString().replace(/\.\d{3}Z$/,'Z')
// Where a source with no cursor starts. A scout left to decide "recent" on its own read
// Granola back to July; this is a fixed point it cannot stretch.
function since(now=new Date()) {
  const day=new Date(now);day.setHours(0,0,0,0)
  do day.setDate(day.getDate()-1); while ([0,6].includes(day.getDay()))
  return {day:iso(new Date(now.getTime()-86400000)),workday:iso(day)}
}
const timeframe=(now=new Date())=>{const s=since(now);return `Now: ${iso(now)}. Without a cursor, Slack, Linear and GitHub start at ${s.day} and Granola at ${s.workday}. Pass each scout its start explicitly and tell it to ignore anything older.`}
const intake=()=>`Morning intake for today.
${timeframe()}
1. Call day list. Note each source's cursor.
2. In ONE message, delegate to slack-scout, linear-scout, granola-scout, github-scout and calendar-scout as foreground calls (never run_in_background), giving each its cursor or the start above. They run side by side.
3. Add every returned item with day add and its source. Duplicates merge by link; that is expected.
4. Add one calendar item per meeting that needs preparation (mode "me", with the prep in context). Remember freeMinutes.
5. Set each source's cursor to the current time (ISO) with day cursor.
6. Finish with a short message to the operator: how many items were proposed per source, the free focus time today vs. the estimated minutes of the "must" items, and the top 3 you would put on today. Do not start working items until the operator has triaged.`
const sweep=()=>`Scheduled sweep.
${timeframe()}
1. Call day list.
2. In ONE message, delegate to slack-scout, linear-scout and github-scout as foreground calls (never run_in_background) with their cursors. Add what they return; set the cursors to now.
3. Then work any "today" or "in_progress" item that has new answers or that you can advance without the operator, following its mode.
4. Reply with at most three lines: what is new, and what now waits on the operator. If nothing changed, reply "No change."`
const resume=()=>`The operator answered or triaged items on the Day board.
Call day list, act on every new answer once and work newly triaged "today" items by their mode. Record new questions with day ask instead of waiting. Reply in at most three lines.`
const PROMPTS={intake,sweep,resume}
function promptFor(kind) {
  const make=PROMPTS[kind]
  if (!make) throw new Error('Unknown Day run.')
  return make()
}
module.exports={SYSTEM,AGENTS,SOURCES,promptFor,since}
