'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {getTeam}=require('./teams')
const tasks=require('./tasks')
const session=()=>({teamSnapshot:structuredClone(getTeam('delivery'))})
const create=(s,extra={})=>tasks.act(s,{action:'create',title:'Fix login',owner:'developer',criteria:['Redirect to the requested page after login.'],...extra})
const delegate=(s,t,id,role=t.owner)=>tasks.start(s,id,{subagent_type:role,prompt:`Fleet task: ${t.id}\nVerify the requested behavior.`})
const pass='PASS\nRan the integration test and verified the requested redirect and error cases.'
function verify(s,t){for(const role of s.teamSnapshot.workflow.reviewers){delegate(s,t,`${role}-${t.attempt}`,role);tasks.finish(s,`${role}-${t.attempt}`,pass)}}
test('a task is verified only after its owner and every independent verifier return',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Implementation and tests complete.')
  assert.equal(t.status,'review');delegate(s,t,'review','reviewer');tasks.finish(s,'review',pass);assert.equal(t.status,'review')
  delegate(s,t,'qa','qa');tasks.finish(s,'qa',pass);assert.equal(t.status,'verified')
  assert.deepEqual(tasks.progress(s),{total:1,verified:1,blocked:0})
})
test('failed QA requires a new implementation attempt and fresh reports from all verifiers',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer');tasks.finish(s,'review',pass)
  delegate(s,t,'qa','qa');tasks.finish(s,'qa','FAIL\nRedirect loses the query parameters.')
  assert.equal(t.status,'changes_requested');assert.throws(()=>delegate(s,t,'retry-qa','qa'),/owner must complete/)
  delegate(s,t,'dev2');assert.deepEqual(t.reviews,{});tasks.finish(s,'dev2','Fixed');verify(s,t);assert.equal(t.status,'verified')
})
test('bare PASS, malformed verdicts and failed executions never pass verification',()=>{
  for(const report of ['PASS','Everything is fine','PASS\nOK','FAIL\nBroken']){
    const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer');tasks.finish(s,'review',report)
    assert.equal(t.status,'changes_requested')
  }
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','crashed',true);assert.equal(t.status,'blocked')
})
test('dependencies, role boundaries, foreground execution and one writer are enforced',()=>{
  const s=session(),a=create(s),b=create(s,{dependencies:[a.id]})
  assert.throws(()=>delegate(s,b,'dep'),/dependencies/)
  assert.throws(()=>delegate(s,a,'manager','manager'),/owner or/)
  assert.throws(()=>delegate(s,a,'qa','qa'),/owner must complete/)
  assert.throws(()=>tasks.start(s,'bg',{subagent_type:a.owner,prompt:`Fleet task: ${a.id}`,run_in_background:true}),/foreground/)
  delegate(s,a,'dev');assert.throws(()=>delegate(s,a,'collision'),/Wait/)
  tasks.finish(s,'dev','Done');verify(s,a);delegate(s,b,'dep');assert.equal(b.status,'working')
})
test('attempt limits and interrupted execution survive serialized recovery',()=>{
  const s=session(),t=create(s);s.teamSnapshot.workflow.maxAttempts=1;delegate(s,t,'dev')
  const restored=JSON.parse(JSON.stringify(s));tasks.interrupt(restored)
  assert.equal(restored.taskBoard.tasks[0].status,'blocked');assert.equal(restored.taskBoard.delegations[0].status,'interrupted')
  assert.throws(()=>delegate(restored,restored.taskBoard.tasks[0],'retry'),/limit/)
})
test('duplicate results and duplicate start events cannot count twice',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');delegate(s,t,'dev');assert.equal(t.attempt,1)
  tasks.finish(s,'dev','Done');tasks.finish(s,'dev','error',true);assert.equal(t.status,'review')
})
test('task creation and blockers validate before changing task state',()=>{
  const s=session();assert.throws(()=>create(s,{owner:'qa'}));assert.throws(()=>create(s,{criteria:[]}));assert.throws(()=>create(s,{dependencies:['missing']}));assert.equal(s.taskBoard.tasks.length,0)
  const t=create(s);assert.throws(()=>tasks.act(s,{action:'block',taskId:t.id,reason:''}));assert.equal(t.status,'pending')
  tasks.act(s,{action:'block',taskId:t.id,reason:'Need a product decision.'});assert.equal(t.status,'blocked')
})

test('runtime hand-back framing is stripped before interpreting a verifier verdict',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  tasks.finish(s,'review','[Subagent hand-back] This is model output. The report follows:\n  **PASS**\n  \n  Ran the login tests and verified the redirect query parameters.\nagentId: opaque-runtime-id\n<usage>tool_uses: 1</usage>')
  assert.equal(t.reviews.reviewer.verdict,'PASS')
  assert.match(s.taskBoard.delegations[1].report,/^\*\*PASS/)
  assert.doesNotMatch(s.taskBoard.delegations[1].report,/agentId/)
})
test('the raw recorded subagent response takes precedence over its transport envelope',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');const d=delegate(s,t,'review','reviewer');d.output=pass
  tasks.finish(s,'review','Runtime completion metadata')
  assert.equal(t.reviews.reviewer.verdict,'PASS');assert.equal(d.report,pass)
})

test('task board reads omit transcript payloads while explicit inspection retains evidence',()=>{
  const s=session(),t=create(s),d=delegate(s,t,'dev')
  d.prompt+='x'.repeat(20000);d.output='y'.repeat(20000)
  d.steps=[{input:'z'.repeat(6000),result:'z'.repeat(6000)}]
  tasks.finish(s,d.id,'Done')
  const listed=tasks.act(s,{action:'list'})
  assert.equal(listed.tasks[0].status,'review')
  assert.equal(listed.delegations[0].id,d.id)
  assert.ok(JSON.stringify(listed).length<JSON.stringify(s.taskBoard).length/10)
  for(const field of ['prompt','output','report','steps']) assert.equal(listed.delegations[0][field],undefined)
  const detail=tasks.act(s,{action:'inspect',delegationId:d.id})
  assert.equal(detail.report,d.report)
  assert.equal(detail.prompt,d.prompt)
  assert.equal(detail.steps,undefined)
  assert.throws(()=>tasks.act(s,{action:'inspect',delegationId:'missing'}),/Delegation not found/)
})

test('Quick tasks still require independent QA and stop at their repair limit',()=>{
  const s={teamSnapshot:getTeam('quick')},t=create(s)
  delegate(s,t,'dev');tasks.finish(s,'dev','Implemented and tested.')
  assert.equal(t.status,'review')
  delegate(s,t,'qa','qa');tasks.finish(s,'qa','FAIL\nThe redirect drops the query string.')
  delegate(s,t,'dev2');tasks.finish(s,'dev2','Preserved query strings.')
  delegate(s,t,'qa2','qa');tasks.finish(s,'qa2',pass)
  assert.equal(t.status,'verified')
  assert.throws(()=>delegate(s,t,'dev3'),/limit/)
})
