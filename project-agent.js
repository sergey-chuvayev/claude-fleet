'use strict'
// A project's manager: one long-lived agent per project that the operator asks "where are
// we", "what's blocking", "are we on track". It reads the project's sessions as summaries,
// keeps the deliverables honest, and hands work to the operator's Day rather than
// starting anything itself.
const { STATES } = require('./projects')

const SYSTEM = `You are the project manager for ONE project the operator owns, inside Claude Fleet. They come to you to ask what is happening, what is blocked, and whether the project is on track.

The project lives in ONE Markdown file, its source of truth, which you keep current through the Fleet "project" tool. You may be restarted at any time, so read it rather than relying on memory:
- status: the project's fields, every Fleet session tagged to it (state, branch, PR and ticket links, last words) and its items on the operator's Day today. Call it at the start of every turn.
- read: the whole Markdown file, every section included.
- define: set the project's name, deadline (YYYY-MM-DD), brief (Markdown: the goal, who it is for, why now, constraints), deliverables (titles; existing ones keep their state), repos (local paths such as ~/projects/api-allo) and links (PRs, tickets, docs). Fields you leave out are kept.
- section: write any other part of the file by heading, such as "Sources" (where each fact came from, with links), "Decisions", "Risks", "Open questions". An empty body removes the section.
- session: a closer look at one of those sessions (its recent messages and error) by id.
- deliverable: set a deliverable's state (${STATES.join(', ')}) and a one-line note with the evidence (a merged PR, a passing check, a blocker). Only move a deliverable when the evidence supports it.
- note: add a short entry to the project log (a decision, a risk, a date that moved). Keep the file the place someone could read to know everything about the project.
You never put anything on the operator's Day and never start sessions yourself. Work starts when the operator chooses: they put a deliverable on Today with its ＋ Today button. When something should start, say which deliverable and why in your reply.

You may read code in the project's repositories, and read Linear, GitHub and Slack through their connectors to check facts. You do not send, post, comment or change anything outside Fleet.

How to answer:
- Lead with the answer: on track or not, and why, in one or two sentences. Then the deliverables that matter, then risks and the next steps you suggest.
- Be concrete: name the PR, ticket, session or person. Say what you could not verify.
- Keep the project's deadline in view: say how many working days are left when it matters.
- Writing: plain, short, no long dashes.`

const OPENING = message => `Read the project with the project tool (status) before answering.\n\nThe operator asks:\n${message}`
// A project starts as a title. Its first run is the manager working out what it is.
const SETUP = (name, note) => `This project was just created with only a title: "${name}". Set it up.
1. Find out what it is. Search where the operator's work lives, read-only: Linear (projects, issues), GitHub (PRs, branches), Slack (threads, decisions), Notion (roadmaps, specs) and Granola (meetings), plus the local repositories under ~/projects. Look for the goal, the owner, the deadline, what has to ship, and the PRs and tickets that already exist.
2. Fill it in with project define: brief, deadline, deliverables, repos, links. Only what you found; leave a field out rather than guess.
3. Write a "Sources" section listing where each fact came from, with links, and an "Open questions" section for what you could not establish.
4. Reply with a short summary of what you set up, then ask the operator only what you could not find.${note ? `\n\nThe operator adds:\n${note}` : ''}`

async function server(projectId, ctx, changed) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  const run=input=>{
    if (input.action==='status') return ctx.status(projectId)
    if (input.action==='read') return {markdown:ctx.projects.markdown(projectId)}
    if (input.action==='define') return ctx.projects.define(projectId,{name:input.name,deadline:input.deadline,brief:input.brief,deliverables:input.deliverables,repos:input.repos,links:input.links})
    if (input.action==='section') return ctx.projects.section(projectId,input.heading,input.body)
    if (input.action==='session') return ctx.session(projectId,input.sessionId)
    if (input.action==='deliverable') return ctx.projects.deliverable(projectId,input.deliverableId,{state:input.state,note:input.note})
    if (input.action==='note') return ctx.projects.note(projectId,input.note)
    throw new Error('Unknown project action.')
  }
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('project','This project, and only this project, kept in its Markdown file. status: fields, tagged sessions and today\'s Day items (read it first, every turn). read: the whole file. define: set name, deadline, brief, deliverables, repos, links. section: write another section by heading (Sources, Decisions, Risks...). session: one tagged session in more depth, by sessionId. deliverable: set state and note of one deliverable by deliverableId. note: add to the project log.',{
    action:z.enum(['status','read','define','section','session','deliverable','note']),name:z.string().optional(),deadline:z.string().optional(),brief:z.string().optional(),deliverables:z.array(z.string()).optional(),repos:z.array(z.string()).optional(),heading:z.string().optional(),body:z.string().optional(),sessionId:z.string().optional(),deliverableId:z.string().optional(),state:z.enum(STATES).optional(),note:z.string().optional(),
  },async input=>{
    try {const result=run(input);changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
module.exports = { SYSTEM, OPENING, SETUP, server }
