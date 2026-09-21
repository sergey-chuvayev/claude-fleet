'use strict'
const {randomUUID}=require('node:crypto')
const fail=message=>{throw new Error(message)}
const idFrom=prompt=>typeof prompt==='string' ? prompt.match(/^Fleet task: ([\w-]+)\s*$/m)?.[1] : null
function ledger(s) {return s.taskBoard ||= {tasks:[],delegations:[]}}
function taskFor(s,id) {const task=ledger(s).tasks.find(t=>t.id===id);if(!task)fail('Task not found. Read the Fleet task board.');return task}
function act(s,input) {
  const board=ledger(s)
  if (input.action==='list') return board
  if (input.action==='create') {
    if (board.tasks.length>=100) fail('This initiative has reached its 100-task limit.')
    const owner=input.owner,team=s.teamSnapshot
    if (!Object.hasOwn(team.roles,owner) || owner===team.manager || team.workflow.reviewers.includes(owner)) fail('Choose a worker role as owner, separate from manager and verification roles.')
    if (typeof input.title!=='string' || !input.title.trim() || input.title.length>200) fail('Task title must contain 1–200 characters.')
    if (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.length>20 || input.criteria.some(c=>typeof c!=='string' || !c.trim() || c.length>2000)) fail('Supply 1–20 concrete acceptance criteria.')
    const dependencies=input.dependencies || []
    if (!Array.isArray(dependencies) || dependencies.length>100) fail('Invalid dependencies.')
    for (const id of dependencies) taskFor(s,id)
    const task={id:randomUUID(),title:input.title.trim(),owner,criteria:input.criteria,dependencies:[...new Set(dependencies)],status:'pending',attempt:0,reviews:{},createdAt:Date.now()}
    board.tasks.push(task);return task
  }
  if (input.action==='block') {
    const task=taskFor(s,input.taskId)
    if (task.status==='verified') fail('This task is already verified. Create a follow-up for additional work.')
    if (board.delegations.some(d=>d.taskId===task.id && d.status==='running')) fail('Wait for the running delegation before blocking this task.')
    if (typeof input.reason!=='string' || !input.reason.trim() || input.reason.length>2000) fail('Explain the blocker in 1–2,000 characters.')
    task.status='blocked';task.blocker=input.reason;return task
  }
  fail('Unknown task action.')
}
function start(s,toolId,input) {
  const board=ledger(s),task=taskFor(s,idFrom(input.prompt)),role=input.subagent_type,team=s.teamSnapshot
  if (board.delegations.some(d=>d.id===toolId)) return board.delegations.find(d=>d.id===toolId)
  if (input.run_in_background || input.resume) fail('Use a fresh foreground delegation so Fleet can track its evidence.')
  if (role!==task.owner && !team.workflow.reviewers.includes(role)) fail('Delegate to the task owner or one of its verification roles.')
  if (board.delegations.some(d=>d.status==='running')) fail('Wait for the current delegation: this initiative shares one worktree.')
  if (task.dependencies.some(id=>taskFor(s,id).status!=='verified')) fail('Complete this task’s dependencies first.')
  if (role===task.owner) {
    if (task.attempt>=(s.limits?.maxAttempts ?? team.workflow.maxAttempts)) fail('Repair attempt limit reached. Report the blocker to the operator.')
    // A worker can touch shared code; prior verification must be refreshed. Reject
    // changes once dependents began, rather than silently invalidating their inputs.
    if (board.tasks.some(t=>t.dependencies.includes(task.id) && t.attempt>0)) fail('A dependent task has already started. Create a follow-up task for new work.')
    task.attempt++;task.reviews={};task.status='working';task.blocker=null
  } else {
    if (task.status!=='review') fail('The owner must complete implementation before independent verification.')
    if (task.reviews[role]?.verdict==='PASS') fail('This role already verified the current attempt.')
  }
  const d={id:toolId,taskId:task.id,role,attempt:task.attempt,status:'running',startedAt:Date.now(),prompt:String(input.prompt).slice(0,24000),report:null}
  board.delegations.push(d)
  return d
}
function unwrapReport(report) {
  const text=String(report || '')
  if (!text.startsWith('[Subagent hand-back]')) return text
  const marker='The report follows:\n'
  const offset=text.indexOf(marker)
  if (offset<0) return text
  const lines=[]
  for (const line of text.slice(offset+marker.length).split('\n')) {
    if (!line.startsWith('  ')) break
    lines.push(line.slice(2))
  }
  return lines.length ? lines.join('\n') : text
}

function finish(s,toolId,report,error=false) {
  const d=ledger(s).delegations.find(d=>d.id===toolId)
  if (!d || d.status!=='running') return
  d.report=String(error ? report : d.output || unwrapReport(report)).slice(0,24000);d.status=error ? 'failed':'completed';d.finishedAt=Date.now()
  const task=taskFor(s,d.taskId)
  if (error) {task.status='blocked';task.blocker='Delegation failed. Read the report before retrying.';return}
  if (d.role===task.owner) {task.status='review';return}
  // Two invariants, both violated in turn before this: (1) the scan is line-based — the
  // verdict can sit below an opening test summary or quoted output, not only on line one —
  // so we check every line rather than anchoring to offset zero; (2) the shape is whole-line —
  // a verdict-shaped match must consume the entire trimmed line, not merely lead it — so prose
  // that opens with "PASS ..." or a quoted mandate line beginning "FAIL into a pass with
  // reservations, ..." cannot masquerade as the real verdict. Stays case-sensitive on purpose:
  // reports routinely quote their own test summaries (e.g. "ℹ fail 0"), and a case-insensitive
  // match would turn every one of those into a false FAIL.
  const verdictShape=/^\*{0,2}(PASS|FAIL)\*{0,2}[\s:—.-]*$/,lines=d.report.split('\n')
  const verdictAt=lines.findIndex(l=>verdictShape.test(l.trim()))
  const verdict=verdictAt<0 ? undefined : lines[verdictAt].trim().match(verdictShape)[1]
  // The whole line is the verdict, so nothing of it belongs in the evidence: drop the line
  // itself rather than replacing a fragment within it.
  const evidence=(verdictAt<0 ? lines : lines.filter((_,i)=>i!==verdictAt)).join('\n').trim()
  task.reviews[d.role]={verdict:verdict==='PASS' && evidence.length>=20 ? 'PASS':'FAIL',delegationId:d.id,attempt:d.attempt}
  if (task.reviews[d.role].verdict==='FAIL') {task.status='changes_requested';return}
  if (s.teamSnapshot.workflow.reviewers.every(r=>task.reviews[r]?.verdict==='PASS')) task.status='verified'
}
function interrupt(s) {
  if (!s.taskBoard) return
  for (const d of s.taskBoard.delegations) if (d.status==='running') {
    d.status='interrupted';d.finishedAt=Date.now()
    const task=taskFor(s,d.taskId);task.status='blocked';task.blocker='Execution interrupted. Ask the manager to resume.'
  }
}
function progress(s) {
  if (!s.taskBoard) return null
  const tasks=s.taskBoard.tasks
  return {total:tasks.length,verified:tasks.filter(t=>t.status==='verified').length,blocked:tasks.filter(t=>['blocked','changes_requested'].includes(t.status)).length}
}
async function sdkServer(s,changed) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('tasks','Read the durable task board; create scoped tasks with criteria and dependencies; record blockers. Fleet records verification from actual agent reports.',{
    action:z.enum(['list','create','block']),title:z.string().optional(),owner:z.string().optional(),criteria:z.array(z.string()).optional(),dependencies:z.array(z.string()).optional(),taskId:z.string().optional(),reason:z.string().optional(),
  },async input=>{
    const before=structuredClone(s.taskBoard)
    try {const result=act(s,input);changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){s.taskBoard=before;return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
module.exports={ledger,act,start,finish,interrupt,progress,sdkServer,idFrom}
