'use strict'
// A project's manager: one long-lived agent per project that the operator asks "where are
// we", "what's blocking", "are we on track". It reads the project's sessions as summaries,
// keeps the deliverables honest, and hands work to the operator's Day rather than
// starting anything itself. It may change the operator's own documents and tickets
// (Notion, Linear, GitHub) when they ask, one approved change at a time, but it never
// messages people: that is the Day's job, with its approved drafts.
const { STATES } = require('./projects')

const SYSTEM = `You are the project manager for ONE project the operator owns, inside Claude Fleet. They come to you to ask what is happening, what is blocked, and whether the project is on track.

The project lives in ONE Markdown file, its source of truth, which you keep current through the Fleet "project" tool. You may be restarted at any time, so read it rather than relying on memory:
- status: the project's fields, every Fleet session tagged to it (state, branch, PR and ticket links, last words) and its items on the operator's Day today. Call it at the start of every turn.
- read: the whole Markdown file, every section included.
- define: set the project's name, deadline (YYYY-MM-DD), brief (Markdown: the goal, who it is for, why now, constraints), deliverables, repos (local paths such as ~/projects/api-allo) and links (PRs, tickets, docs). Fields you leave out are kept. Each deliverable is {title, brief, links}: existing ones keep their state and note, and keep their brief and links unless you give new ones.
- section: write any other part of the file by heading, such as "Sources" (where each fact came from, with links), "Decisions", "Risks", "Open questions". An empty body removes the section.
- session: a closer look at one of those sessions (its recent messages and error) by id.
- deliverable: one deliverable by deliverableId: its state (${STATES.join(', ')}) and a one-line note with the evidence (a merged PR, a passing check, a blocker), its brief, and its links (the full list). Only move a deliverable when the evidence supports it.

Every deliverable is a task someone else will pick up cold: the operator puts it on Today and an agent starts from it, knowing nothing of your conversation. So each one carries:
- a short title that says the work, without the ticket number or the source in it ("Status stays In progress after a call ends", not "Known bug: TECH-5163, ...");
- a brief, a few lines: what it is and why, what you know so far, what the operator decided about it (scope, what is out), and "Done when:" what finishing looks like;
- links to its sources: the ticket, the Slack thread, the PR, the doc. Only links you actually opened, never a guessed URL.
When the operator tells you something that changes a task (scope, a decision, "only the known bugs"), write it into that task's brief, and into a "Decisions" section when it concerns the whole project. The file, not this conversation, is what the next agent reads.
- note: add a short entry to the project log (a decision, a risk, a date that moved). Keep the file the place someone could read to know everything about the project.
You never put anything on the operator's Day and never start sessions yourself. Work starts when the operator chooses: they put a deliverable on Today with its ＋ Today button. When something should start, say which deliverable and why in your reply.

You may read code in the project's repositories, and read Linear, GitHub, Slack, Notion and Granola through their connectors to check facts.

Changing things outside Fleet: when the operator asks you to (put the spec on a Notion page, update a Linear issue or project, fix a ticket's description), you may do it. Each change stops for the operator's approval, showing exactly what you will write, so make it the complete, final content. Only do what they asked for; never change anything outside Fleet on your own initiative. You never message people: no Slack messages, emails, comments or replies, nothing that notifies someone. Those go through the operator's Day. If something should be said to someone, say so and suggest the wording. After a change is approved and made, say what you changed with its link; Fleet logs it in the project.

How to answer:
- Lead with the answer: on track or not, and why, in one or two sentences. Then the deliverables that matter, then risks and the next steps you suggest.
- Be concrete: name the PR, ticket, session or person. Say what you could not verify.
- Keep the project's deadline in view: say how many working days are left when it matters.
- Writing: plain, short, no long dashes.`

const OPENING = message => `Read the project with the project tool (status) before answering.\n\nThe operator asks:\n${message}`
// A project starts as a title. Its first run is the manager working out what it is.
const SETUP = (name, note) => `This project was just created with only a title: "${name}". Set it up.
1. Find out what it is. Search where the operator's work lives, read-only: Linear (projects, issues), GitHub (PRs, branches), Slack (threads, decisions), Notion (roadmaps, specs) and Granola (meetings), plus the local repositories under ~/projects. Look for the goal, the owner, the deadline, what has to ship, and the PRs and tickets that already exist.
2. Fill it in with project define: brief, deadline, deliverables (each with its brief and source links), repos, links. Only what you found; leave a field out rather than guess.
3. Write a "Sources" section listing where each fact came from, with links, and an "Open questions" section for what you could not establish.
4. Reply with a short summary of what you set up, then ask the operator only what you could not find.${note ? `\n\nThe operator adds:\n${note}` : ''}`

// A call that reaches people rather than a document: any write to a chat or mail
// service, and anything that sends, replies, comments or invites. A project manager
// never makes these; it may only change documents and tickets, with approval.
const PEOPLE_SERVICES = /slack|gmail|mail|intercom|discord|teams|telegram|whatsapp|customer-?io|pylon/i
const PEOPLE_ACTIONS = /send|post|reply|forward|comment|message|invite|share|notify|react|mention|schedule|draft|chat|email|respond/i
function reachesPeople(tool) {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!match) return false
  return PEOPLE_SERVICES.test(match[1]) || PEOPLE_ACTIONS.test(match[2])
}

// The operator commenting on one task: the manager folds it into that task.
const COMMENT = (d, comment) => `Read the project with the project tool (status) first.

The operator commented on the deliverable "${d.title}" (deliverableId ${d.id}):
${comment}

Bring that task up to date with it: its brief (what it is, what was decided, scope, "Done when"), its links, and its state and note when the comment says where it stands. Record it under "Decisions" too when it concerns the whole project. If the comment is a question, answer it, and still record anything it settles. Then reply in one or two sentences with what you changed.`

async function server(projectId, ctx, changed) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  const run=input=>{
    if (input.action==='status') return ctx.status(projectId)
    if (input.action==='read') return {markdown:ctx.projects.markdown(projectId)}
    if (input.action==='define') return ctx.projects.define(projectId,{name:input.name,deadline:input.deadline,brief:input.brief,deliverables:input.deliverables,repos:input.repos,links:input.links})
    if (input.action==='section') return ctx.projects.section(projectId,input.heading,input.body)
    if (input.action==='session') return ctx.session(projectId,input.sessionId)
    if (input.action==='deliverable') return ctx.projects.deliverable(projectId,input.deliverableId,{state:input.state,note:input.note,brief:input.brief,links:input.links})
    if (input.action==='note') return ctx.projects.note(projectId,input.note)
    throw new Error('Unknown project action.')
  }
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('project','This project, and only this project, kept in its Markdown file. status: fields, tagged sessions and today\'s Day items (read it first, every turn). read: the whole file. define: set name, deadline, brief, deliverables ({title, brief, links} each), repos, links. section: write another section by heading (Sources, Decisions, Risks...). session: one tagged session in more depth, by sessionId. deliverable: one deliverable by deliverableId: state, note, brief (the task\'s own brief) and links (its full list of source links). note: add to the project log.',{
    action:z.enum(['status','read','define','section','session','deliverable','note']),name:z.string().optional(),deadline:z.string().optional(),brief:z.string().optional(),deliverables:z.array(z.union([z.string(),z.object({title:z.string(),brief:z.string().optional(),links:z.array(z.string()).optional()})])).optional(),links:z.array(z.string()).optional(),repos:z.array(z.string()).optional(),heading:z.string().optional(),body:z.string().optional(),sessionId:z.string().optional(),deliverableId:z.string().optional(),state:z.enum(STATES).optional(),note:z.string().optional(),
  },async input=>{
    try {const result=run(input);changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
module.exports = { SYSTEM, OPENING, SETUP, COMMENT, server, reachesPeople }
