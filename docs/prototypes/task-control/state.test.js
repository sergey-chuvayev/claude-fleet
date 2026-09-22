'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const demo=require('./state');
const running=s=>s.tasks.filter(t=>t.status==='running');
test('admission obeys concurrency and lowering the limit does not stop existing work',()=>{
  const s=demo.initial();demo.schedule(s);assert.equal(running(s).length,2);
  s.limit=1;demo.schedule(s);assert.equal(running(s).length,2);
  demo.advance(s);assert.equal(running(s).length,1);assert.equal(s.tasks.find(t=>t.id===105).status,'queued');
  demo.advance(s);assert.equal(running(s).length,1);assert.equal(running(s)[0].id,105);
});
test('paused dispatch lets current work finish but admits no new tasks',()=>{
  const s=demo.initial();s.paused=true;demo.advance(s);demo.advance(s);
  assert.equal(running(s).length,0);assert.equal(s.tasks.find(t=>t.id===105).status,'queued');
  s.paused=false;demo.schedule(s);assert.equal(running(s).length,1);
});
test('a decision queues work without exceeding the active limit',()=>{
  const s=demo.initial();assert.equal(demo.resolve(s,101,' '),false);
  assert.equal(demo.resolve(s,101,'Show a recovery page'),true);
  assert.equal(s.tasks[0].status,'queued');assert.equal(running(s).length,2);
  demo.advance(s);assert.equal(s.tasks[0].status,'running');
  assert.ok(s.tasks[0].log.includes('Your decision: Show a recovery page'));
});
test('integration must run against current main before acceptance; another acceptance invalidates it',()=>{
  const s=demo.initial();s.limit=4;
  assert.equal(demo.accept(s,102),false);
  demo.checkIntegration(s,102);demo.advance(s);
  const second=s.tasks.find(t=>t.id===104);demo.checkIntegration(s,104);demo.advance(s);
  assert.equal(second.integration,s.revision);
  assert.equal(demo.accept(s,102),true);assert.equal(demo.accept(s,104),false);
  demo.checkIntegration(s,104);demo.advance(s);assert.equal(demo.accept(s,104),true);
  assert.equal(demo.accept(s,104),false);
});
test('requested changes clear old evidence and re-enter builder stage',()=>{
  const s=demo.initial(),t=s.tasks.find(t=>t.id===102);
  assert.equal(demo.repair(s,102,'Handle invalid URL parameters'),true);
  assert.deepEqual(t.checks,[]);assert.equal(t.integration,null);assert.equal(t.phase,'implement');assert.equal(t.status,'queued');
});
test('team assignments are snapshots; later tasks receive edited configuration',()=>{
  const s=demo.initial();s.teams[0].builder='opus';s.teams[0].cap=5;
  assert.equal(s.tasks[0].team.builder,'sonnet');
  const t=demo.add(s,{title:'Add keyboard shortcuts',repo:'web-app',teamId:'quick',brief:'Cover keyboard navigation'});
  assert.equal(t.team.builder,'opus');assert.equal(t.team.cap,5);assert.equal(t.status,'queued');
  t.team.cap=9;assert.equal(s.teams[0].cap,5);
});
test('budget exhaustion blocks work and releases the slot',()=>{
  const s=demo.initial(),t=s.tasks.find(t=>t.id===103);t.team.cap=.7;
  demo.advance(s);assert.equal(t.status,'attention');assert.equal(t.budgetBlocked,true);assert.equal(t.spend,.65);
  assert.equal(demo.resolve(s,t.id,'Continue'),false);assert.ok(running(s).length<=s.limit);
});
test('valid state round trips and malformed storage restores the demo',()=>{
  const s=demo.initial();demo.advance(s);assert.deepEqual(demo.restore(JSON.stringify(s)),s);
  for(const raw of [null,'{broken','{}',JSON.stringify({...s,limit:99}),JSON.stringify({...s,tasks:[{id:1}]})])assert.deepEqual(demo.restore(raw),demo.initial());
});
