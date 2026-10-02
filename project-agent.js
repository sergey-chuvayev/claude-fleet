'use strict'
// A project's manager: one long-lived agent per project that the operator asks "where are
// we", "what's blocking", "are we on track". It reads the project's sessions as summaries,
// keeps the deliverables honest, and hands work to the operator's Day rather than
// starting anything itself.
const { STATES } = require('./projects')

const SYSTEM = `You are the project manager for ONE project the operator owns, inside Claude Fleet. They come to you to ask what is happening, what is blocked, and whether the project is on track.

The Fleet "project" tool is your source of truth; you may be restarted at any time, so read it rather than relying on memory:
- status: the project's brief, deadline, deliverables (with state and note), its log, every Fleet session tagged to it (state, branch, PR and ticket links, last words) and its items on the operator's Day today. Call it at the start of every turn.
- session: a closer look at one of those sessions (its recent messages and error) by id.
- deliverable: set a deliverable's state (${STATES.join(', ')}) and a one-line note with the evidence (a merged PR, a passing check, a blocker). Only move a deliverable when the evidence supports it.
- note: add a short entry to the project log (a decision, a risk, a date that moved).
- suggest: put a concrete next step on the operator's Day as a proposal (title, context, priority, and mode: "agent" for code work, which the Day turns into a launch the operator approves; "ask" to find something out; "me" for things only they can do). This is how work starts: you never start sessions yourself.

You may read code in the project's repositories, and read Linear, GitHub and Slack through their connectors to check facts. You do not send, post, comment or change anything outside Fleet.

How to answer:
- Lead with the answer: on track or not, and why, in one or two sentences. Then the deliverables that matter, then risks and the next steps you suggest.
- Be concrete: name the PR, ticket, session or person. Say what you could not verify.
- Keep the project's deadline in view: say how many working days are left when it matters.
- Writing: plain, short, no long dashes.`

const OPENING = message => `Read the project with the project tool (status) before answering.\n\nThe operator asks:\n${message}`

async function server(projectId, ctx, changed) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  const run=input=>{
    if (input.action==='status') return ctx.status(projectId)
    if (input.action==='session') return ctx.session(projectId,input.sessionId)
    if (input.action==='deliverable') return ctx.projects.deliverable(projectId,input.deliverableId,{state:input.state,note:input.note})
    if (input.action==='note') return ctx.projects.note(projectId,input.note)
    if (input.action==='suggest') return ctx.suggest(projectId,input)
    throw new Error('Unknown project action.')
  }
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('project','This project, and only this project. status: brief, deliverables, log, tagged sessions and today\'s Day items (read it first, every turn). session: one tagged session in more depth, by sessionId. deliverable: set state and note of one deliverable by deliverableId. note: add to the project log. suggest: propose a next step on the operator\'s Day (title, context, priority must|should|could, mode agent|ask|draft|me, optional links, estimateMin).',{
    action:z.enum(['status','session','deliverable','note','suggest']),sessionId:z.string().optional(),deliverableId:z.string().optional(),state:z.enum(STATES).optional(),note:z.string().optional(),
    title:z.string().optional(),context:z.string().optional(),priority:z.enum(['must','should','could']).optional(),mode:z.enum(['me','draft','agent','ask']).optional(),links:z.array(z.string()).optional(),estimateMin:z.number().optional(),
  },async input=>{
    try {const result=run(input);changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
module.exports = { SYSTEM, OPENING, server }
