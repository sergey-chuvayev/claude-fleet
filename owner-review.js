'use strict'
const {execFileSync}=require('node:child_process')
const path=require('node:path')
const enabled=s=>s.teamSnapshot?.workflow?.mode==='owner-review'
const fail=message=>{throw new Error(message)}
function git(s,args) {
  return execFileSync('git',args,{cwd:s.cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:1024*1024}).trim()
}
function snapshot(s) {
  const [commit,tree]=git(s,['rev-parse','HEAD','HEAD^{tree}']).split('\n')
  const dirty=!!git(s,['status','--porcelain','--untracked-files=normal','--ignore-submodules=none'])
  return {commit,tree,dirty}
}
function same(a,b) {return a && b && !b.dirty && a.tree===b.tree}
function refresh(s) {
  if (!enabled(s)) return false
  const task=s.taskBoard?.tasks[0]
  if (!task?.snapshot || !['review','review_error','verified'].includes(task.status)) return false
  let current
  try {current=snapshot(s)} catch {}
  if (same(task.snapshot,current)) return false
  task.status='stale';task.reviews={}
  task.blocker='Code changed or the Git snapshot is unavailable. Commit a clean worktree and submit it for review again.'
  return true
}
function ready(s,task,input) {
  if (s.taskBoard.delegations.some(d=>d.status==='running')) fail('Wait for the current review before submitting changes.')
  if (typeof input.evidence!=='string' || input.evidence.trim().length<20 || input.evidence.length>8000) fail('Provide 20–8,000 characters of test commands, results and limitations.')
  refresh(s)
  if (['review','review_error','verified'].includes(task.status)) fail('This snapshot has already been submitted. Read the board; retry an execution error directly.')
  if (task.attempt>=(s.limits?.maxAttempts ?? s.teamSnapshot.workflow.maxAttempts)) fail('Request-wide review attempt limit reached. Report the blocker; a follow-up task cannot reset it.')
  const current=snapshot(s)
  if (current.dirty) fail('Commit the implementation and leave a clean worktree, including untracked files, before review.')
  task.attempt++;task.snapshot=current;task.evidence=input.evidence.trim()
  task.reviews={};task.status='review';task.blocker=null
  return task
}
function start(s,task,id,input) {
  refresh(s)
  if (input.subagent_type!==s.teamSnapshot.workflow.reviewers[0]) fail('Only the independent reviewer may be delegated. The owner does implementation and finishing in this session.')
  if (!['review','review_error'].includes(task.status)) fail('Submit a clean committed implementation with action ready before review.')
  if ((task.reviewErrors || 0)>=2) fail('Review execution retry limit reached. Report the execution blocker to the operator.')
  const d={id,taskId:task.id,role:input.subagent_type,attempt:task.attempt,status:'running',startedAt:Date.now(),prompt:String(input.prompt).slice(0,24000),snapshot:{...task.snapshot},report:null}
  task.status='review';task.blocker=null
  s.taskBoard.delegations.push(d)
  return d
}
function executionError(task,message) {
  task.reviewErrors=(task.reviewErrors || 0)+1
  task.status='review_error';task.blocker=message
}
function finish(s,task,d,error) {
  refresh(s)
  if (task.status==='stale') return
  const verdict=d.report.trim().replace(/^\*\*/, '').match(/^(PASS|FAIL)\b/)?.[1]
  const evidence=d.report.replace(/^\s*\*{0,2}(PASS|FAIL)\*{0,2}[\s:—-]*/, '').trim()
  if (error || !verdict || evidence.length<20) {
    executionError(task,'Review did not produce a valid verdict with evidence. Inspect the report; one execution retry is allowed per request.')
    return
  }
  task.reviews[d.role]={verdict,delegationId:d.id,attempt:d.attempt,commit:d.snapshot.commit,tree:d.snapshot.tree}
  task.status=verdict==='PASS' ? 'verified':'changes_requested'
  task.blocker=verdict==='FAIL' ? 'Blocking review findings require repair in the owner session. Inspect the review report.':null
}
function mandate(s,task,attachmentsDir) {
  const previous=s.taskBoard.delegations.filter(d=>d.taskId===task.id && d.report).at(-1)
  const messages=s.messages?.filter(m=>m.role==='user') || []
  const followups=messages.slice(1).map(m=>m.text).filter(Boolean).join('\n').slice(-16000)
  const images=attachmentsDir ? messages.flatMap(m=>(m.attachments || []).map(a=>path.join(attachmentsDir,a.id))) : []
  return `\n\nFleet review mandate (authoritative):
Original request: ${s.ownerRequest || task.title}
${followups ? 'User follow-ups:\n'+followups : ''}
${images.length ? 'User image attachments (read relevant images):\n'+images.join('\n') : ''}
Acceptance criteria:\n${task.criteria.map(c=>'- '+c).join('\n')}
Working directory: ${s.cwd}
Base commit: ${s.reviewBaseCommit}
Review commit: ${task.snapshot.commit}
Review tree: ${task.snapshot.tree}
Owner test evidence (verify claims against the code):\n${task.evidence}
${previous ? `Previous review (focus on repairs and affected behavior):\n${previous.report.slice(0,8000)}`:''}
Inspect the actual diff from base to review commit and relevant files. PASS means no
blocking correctness or required-evidence issues; optional suggestions do not block.
FAIL must identify concrete blocking findings. REVIEW_ERROR means execution could not
complete. Never edit source. Return the verdict first, followed by evidence.`
}
module.exports={enabled,snapshot,refresh,ready,start,finish,executionError,mandate}
