'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {TeamStore,validateTeam}=require('./team-store')
const {getTeam,compile}=require('./teams')
const template=()=>({...getTeam('delivery'),id:'my-team'})
test('owner-review copies retain their two roles, mode and owner editing tools',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-owner-team-'))
  try {
    const store=new TeamStore(dir),team={...getTeam('owner-review'),id:'my-owner'}
    store.save(team)
    const saved=new TeamStore(dir).get(team.id)
    assert.equal(saved.workflow.mode,'owner-review')
    assert.ok(compile(saved).agents.owner.tools.includes('Bash'))
    assert.ok(compile(saved).agents.owner.tools.includes('Edit'))
    assert.equal(store.list().find(t=>t.id===team.id).mode,'owner-review')
    team.roles.worker={...team.roles.owner}
    assert.throws(()=>validateTeam(team),/exactly two/)
    delete team.roles.worker;team.workflow.reviewers=['owner']
    assert.throws(()=>validateTeam(team),/cannot be the manager/)
    team.workflow.mode='unknown'
    assert.throws(()=>validateTeam(team),/execution mode/)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
test('custom limits survive validation and old configurations receive bounded defaults',()=>{
  const team=template()
  team.roles.developer.maxTurns=12
  team.roles.developer.effort='low'
  team.roles.developer.model='sonnet[1m]'
  delete team.roles.qa.maxTurns
  delete team.roles.qa.effort
  const valid=validateTeam(team)
  assert.equal(valid.roles.developer.maxTurns,12)
  assert.equal(valid.roles.developer.effort,'low')
  assert.equal(valid.roles.developer.model,'sonnet')
  assert.equal(valid.roles.qa.maxTurns,20)
  assert.equal(valid.roles.qa.effort,'low')
  for (const maxTurns of [0,101,1.5,'40',NaN]) {
    team.roles.developer.maxTurns=maxTurns
    assert.throws(()=>validateTeam(team),/turn limit/)
  }
  team.roles.developer.maxTurns=40
  team.roles.developer.effort='unknown'
  assert.throws(()=>validateTeam(team),/effort/)
})
test('custom teams survive reload and callers cannot mutate stored instructions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-teams-'))
  try{
    const store=new TeamStore(dir),team=template();store.save(team)
    team.roles.developer.prompt='changed outside store'
    const copy=store.get(team.id);copy.roles.developer.prompt='also changed'
    assert.notEqual(store.get(team.id).roles.developer.prompt,copy.roles.developer.prompt)
    assert.deepEqual(new TeamStore(dir).get(team.id),store.get(team.id))
    assert.equal(store.list().find(t=>t.id===team.id).custom,true)
    assert.equal(store.list().find(t=>t.id===team.id).roles[0].prompt,undefined)
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('invalid roles, model identifiers, tools and verification rules are rejected',()=>{
  for(const mutate of [t=>t.manager='missing',t=>t.roles.developer.model='x; echo no',t=>t.roles.developer.tools=['Unknown'],t=>t.workflow.reviewers=[],t=>t.workflow.reviewers=['manager'],t=>t.workflow.reviewers=['missing'],t=>t.workflow.maxAttempts=0,t=>t.workflow.budgetUsd=NaN,t=>t.id='constructor',t=>t.roles=[]]){
    const team=template();mutate(team);assert.throws(()=>validateTeam(team))
  }
  const team=template();team.roles=JSON.parse('{"__proto__":{}}');assert.throws(()=>validateTeam(team))
})
test('renamed verification roles still compile with independent permissions',()=>{
  const team=template();team.roles.auditor=team.roles.qa;delete team.roles.qa;team.workflow.reviewers=['reviewer','auditor']
  team.roles.manager.tools.push('Bash','Write');team.roles.auditor.tools.push('Edit')
  const valid=validateTeam(team),{agents}=compile(valid)
  assert.ok(!agents.manager.tools.includes('Bash'));assert.ok(!agents.auditor.tools.includes('Edit'))
  assert.ok(agents.manager.tools.includes('mcp__fleet__tasks'));assert.ok(agents.auditor.disallowedTools.includes('mcp__fleet__tasks'))
  assert.ok(agents.auditor.disallowedTools.includes('Agent'));assert.ok(!agents.developer.tools.includes('AskUserQuestion'))
})
test('corrupt storage and built-in replacement fail without overwriting existing data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-teams-'))
  try{
    const store=new TeamStore(dir);assert.throws(()=>store.save(getTeam('delivery')),/read-only/)
    fs.writeFileSync(path.join(dir,'teams.json'),'broken')
    assert.throws(()=>new TeamStore(dir),/Cannot read Fleet teams/)
    assert.equal(fs.readFileSync(path.join(dir,'teams.json'),'utf8'),'broken')
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
