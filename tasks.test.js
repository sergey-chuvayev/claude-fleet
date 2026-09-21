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
test('a plain verdict several lines down, after other report content, still passes verification',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  tasks.finish(s,'review','Checked the redirect and the error states manually first.\n\nPASS\nBoth flows matched the requested behavior end to end.')
  assert.equal(t.reviews.reviewer.verdict,'PASS');assert.equal(t.status,'review')
})
test('a bolded verdict several lines down, after quoted test output, still passes verification',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  // Real failing-report shape from production: the QA agent led with its test summary, and
  // the pinned-to-offset-zero parser recorded a genuine PASS as a FAIL.
  tasks.finish(s,'review','Full summary: ℹ tests 118 / ℹ pass 118 / ℹ fail 0\n\n**PASS**')
  assert.equal(t.reviews.reviewer.verdict,'PASS');assert.equal(t.status,'review')
})
test('a report with no verdict-shaped line anywhere still fails closed',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  tasks.finish(s,'review','Ran the tests.\nEverything looked fine, no issues spotted.\nNo further comments.')
  assert.equal(t.reviews.reviewer.verdict,'FAIL');assert.equal(t.status,'changes_requested')
})
test('lowercase "fail" quoted from test output is never mistaken for the verdict',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  tasks.finish(s,'review','ℹ tests 42 / ℹ pass 42 / ℹ fail 0\n\nPASS\nAll assertions covered the requested behavior end to end.')
  assert.equal(t.reviews.reviewer.verdict,'PASS')
})
test('prose that only opens with "PASS " cannot steal a real, later, standalone FAIL',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  tasks.finish(s,'review','PASS on criteria 1-4. Criterion 5 is not met.\n\nFAIL\ntasks.js:80-82 goes fail-open on a leading verdict-shaped line.')
  assert.equal(t.reviews.reviewer.verdict,'FAIL');assert.equal(t.status,'changes_requested')
})
test('a quoted mandate line beginning "FAIL" cannot outrank the real standalone verdict',()=>{
  const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
  tasks.finish(s,'review','Do not soften a\nFAIL into a pass with reservations, and do not pad a PASS with speculative concerns to look\nthorough. If it works, say it works.\n\n**PASS**\nRan the integration test and verified the requested redirect and error cases.')
  assert.equal(t.reviews.reviewer.verdict,'PASS');assert.equal(t.status,'review')
})
test('"PASS:" and "PASS —" on their own line are still recognized, pinning the accepted punctuation',()=>{
  for (const line of ['PASS:','PASS —']) {
    const s=session(),t=create(s);delegate(s,t,'dev');tasks.finish(s,'dev','Done');delegate(s,t,'review','reviewer')
    tasks.finish(s,'review',`${line}\nRan the integration test and verified the requested redirect and error cases.`)
    assert.equal(t.reviews.reviewer.verdict,'PASS')
  }
})
