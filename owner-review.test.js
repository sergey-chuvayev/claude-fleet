'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {execFileSync}=require('node:child_process')
const {getTeam}=require('./teams')
const tasks=require('./tasks'),review=require('./owner-review')
const git=(s,...args)=>execFileSync('git',args,{cwd:s.cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
function fixture(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-owner-review-'))
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
  const s={cwd,teamSnapshot:getTeam('owner-review'),ownerRequest:'Preserve the login query string.',messages:[]}
  git(s,'init','-q','-b','main');git(s,'config','user.name','Test');git(s,'config','user.email','test@example.invalid')
  fs.writeFileSync(path.join(cwd,'login.js'),'original\n');git(s,'add','.');git(s,'commit','-qm','initial')
  s.reviewBaseCommit=review.snapshot(s).commit
  return s
}
const create=s=>tasks.act(s,{action:'create',owner:'owner',title:'Fix login',criteria:['Keep the redirect query string.']})
const ready=(s,t)=>tasks.act(s,{action:'ready',taskId:t.id,evidence:'node --test login.test.js: passed the redirect and query string regression cases.'})
const start=(s,t,id='review')=>tasks.start(s,id,{subagent_type:'reviewer',prompt:`Fleet task: ${t.id}`})
const pass='PASS\nInspected the actual login diff and ran regression cases for query strings and missing redirects.\nOptional: simplify variable names later.'
const fail='FAIL\nBlocking: login.js drops query parameters. The query-string regression case fails.'
function change(s,text='fixed\n') {fs.writeFileSync(path.join(s.cwd,'login.js'),text);git(s,'add','login.js');git(s,'commit','-qm','fix login')}
test('one owner owns the request and only a ready snapshot can be reviewed',t=>{
  const s=fixture(t),task=create(s)
  assert.throws(()=>create(s),/one durable request/)
  assert.throws(()=>start(s,task),/action ready/)
  fs.writeFileSync(path.join(s.cwd,'login.js'),'pending\n')
  assert.throws(()=>ready(s,task),/clean worktree/)
  assert.equal(task.attempt,0)
  change(s);ready(s,task)
  assert.throws(()=>ready(s,task),/already been submitted/)
  assert.throws(()=>tasks.start(s,'owner',{subagent_type:'owner',prompt:`Fleet task: ${task.id}`}),/Only the independent reviewer/)
  assert.throws(()=>tasks.start(s,'background',{subagent_type:'reviewer',prompt:`Fleet task: ${task.id}`,run_in_background:true}),/foreground/)
  start(s,task);assert.throws(()=>start(s,task,'collision'),/Wait/)
  tasks.finish(s,'review',pass)
  assert.equal(task.status,'verified')
  assert.equal(task.reviews.reviewer.commit,git(s,'rev-parse','HEAD'))
  assert.throws(()=>start(s,task,'redundant'),/action ready/)
})
test('review findings return to the same owner and limits cover the entire request after restart',t=>{
  let s=fixture(t),task=create(s)
  for (let n=1;n<=3;n++) {
    change(s,`fix ${n}\n`);ready(s,task);start(s,task,`r${n}`);tasks.finish(s,`r${n}`,fail)
    assert.equal(task.status,'changes_requested');assert.equal(task.attempt,n)
    s=JSON.parse(JSON.stringify(s));task=s.taskBoard.tasks[0]
  }
  assert.throws(()=>ready(s,task),/Request-wide/)
  assert.throws(()=>create(s),/one durable request/)
  assert.throws(()=>tasks.act(s,{action:'create',owner:'owner',title:'Repair follow-up',criteria:['Fix the bug']}),/one durable request/)
  s.limits={maxAttempts:4,budgetUsd:10};ready(s,task);start(s,task,'r4');tasks.finish(s,'r4',pass)
  assert.equal(task.status,'verified');assert.equal(task.attempt,4)
})
test('untracked, staged, unstaged and committed changes invalidate a passing review',t=>{
  for (const kind of ['untracked','staged','unstaged','committed']) {
    const s=fixture(t),task=create(s);ready(s,task);start(s,task);tasks.finish(s,'review',pass)
    if (kind==='untracked') fs.writeFileSync(path.join(s.cwd,'new.js'),'new')
    else fs.writeFileSync(path.join(s.cwd,'login.js'),'changed')
    if (kind==='staged') git(s,'add','login.js')
    if (kind==='committed') {git(s,'add','login.js');git(s,'commit','-qm','changed')}
    assert.equal(review.refresh(s),true,kind);assert.equal(task.status,'stale',kind)
    assert.deepEqual(task.reviews,{})
  }
})
test('administrative reads and empty commits preserve verification of the same tree',t=>{
  const s=fixture(t),task=create(s);ready(s,task);start(s,task);tasks.finish(s,'review',pass)
  const reviewed=task.reviews.reviewer.commit
  git(s,'status');git(s,'commit','--allow-empty','-qm','administrative marker')
  assert.notEqual(git(s,'rev-parse','HEAD'),reviewed)
  assert.equal(review.refresh(s),false);assert.equal(task.status,'verified')
})
test('a passing report for code changed during review cannot verify the request',t=>{
  const s=fixture(t),task=create(s);ready(s,task);start(s,task)
  change(s);tasks.finish(s,'review',pass)
  assert.equal(task.status,'stale');assert.deepEqual(task.reviews,{})
  ready(s,task);assert.equal(task.attempt,2)
})
test('execution failures and malformed reports get one bounded retry without a repair attempt',t=>{
  for (const report of ['PASS','Unclear report','REVIEW_ERROR\nThe test runner could not start.']) {
    const s=fixture(t),task=create(s);ready(s,task);start(s,task);tasks.finish(s,'review',report)
    assert.equal(task.status,'review_error');assert.equal(task.reviewErrors,1)
    assert.equal(task.attempt,1);assert.deepEqual(task.reviews,{})
    start(s,task,'retry');tasks.finish(s,'retry','Runtime crashed',true)
    assert.equal(task.status,'review_error');assert.equal(task.reviewErrors,2)
    assert.throws(()=>start(s,task,'retry-again'),/execution retry limit/)
    tasks.finish(s,'retry',pass);assert.equal(task.reviewErrors,2,'duplicate results cannot count twice')
  }
})
test('interrupted reviewer recovery keeps attempts and permits the one execution retry',t=>{
  let s=fixture(t),task=create(s);ready(s,task);start(s,task)
  s=JSON.parse(JSON.stringify(s));tasks.interrupt(s);task=s.taskBoard.tasks[0]
  assert.equal(task.status,'review_error');assert.equal(task.reviewErrors,1);assert.equal(task.attempt,1)
  start(s,task,'retry');tasks.finish(s,'retry',pass);assert.equal(task.status,'verified')
})
test('a missing repository cannot remain verified',t=>{
  const s=fixture(t),task=create(s);ready(s,task);start(s,task);tasks.finish(s,'review',pass)
  fs.rmSync(path.join(s.cwd,'.git'),{recursive:true,force:true})
  assert.equal(review.refresh(s),true);assert.equal(task.status,'stale')
})
test('review mandate retains original request, actual Git evidence and prior findings',t=>{
  const s=fixture(t),task=create(s);change(s);ready(s,task);start(s,task);tasks.finish(s,'review',fail)
  s.messages=[{role:'user',text:s.ownerRequest,attachments:[{id:'example.png'}]},{role:'user',text:'Also preserve fragments.'}]
  ready(s,task)
  const mandate=review.mandate(s,task,'/tmp/attachments')
  for (const value of [s.ownerRequest,s.reviewBaseCommit,task.snapshot.commit,task.evidence,fail,'Also preserve fragments.','/tmp/attachments/example.png']) assert.ok(mandate.includes(value))
})
