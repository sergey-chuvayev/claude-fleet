'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {TEAMS,getTeam,listTeams,compile}=require('./teams')

test('all presets have bounded roles and a budgeted workflow',()=>{
  for (const team of Object.values(TEAMS)) {
    const {agents}=compile(team)
    assert.ok(team.workflow.budgetUsd>0)
    assert.ok(team.workflow.maxAttempts>0)
    if (team.workflow.mode==='owner-review') {
      assert.equal(agents.owner.maxTurns,100)
      assert.equal(agents.owner.model,'claude-opus-5-5')
      assert.equal(agents.reviewer.maxTurns,25)
      assert.ok(agents.owner.tools.includes('Edit'))
      assert.ok(!agents.owner.disallowedTools.includes('Bash'))
      assert.ok(agents.reviewer.disallowedTools.includes('Edit'))
      assert.ok(agents.reviewer.disallowedTools.includes('Agent'))
      assert.match(agents.owner.prompt,/ONE task/)
      assert.doesNotMatch(agents.owner.prompt,/You do not write code/)
      continue
    }
    assert.equal(agents.manager.maxTurns,100)
    assert.equal(agents.manager.effort,'high')
    assert.equal(agents.developer.maxTurns,40)
    assert.equal(agents.developer.effort,'medium')
    assert.equal(agents.developer.model,'sonnet')
    assert.equal(agents.qa.maxTurns,20)
    assert.equal(agents.qa.effort,'low')
    assert.equal(agents.qa.model,'haiku')
    assert.match(agents.developer.prompt,/30 lines/)
    assert.match(agents.manager.prompt,/SPLIT_REQUIRED/)
    for (const role of Object.values(agents)) assert.ok(role.tools.length)
  }
  const {agents}=compile(getTeam('delivery'))
  assert.equal(agents.reviewer.model,'sonnet')
  assert.equal(agents.reviewer.maxTurns,20)
  assert.equal(agents.product.maxTurns,15)
})

test('legacy snapshots get missing limits and models lose the extended-context suffix',()=>{
  const team=getTeam('delivery')
  delete team.roles.developer.maxTurns
  delete team.roles.developer.effort
  team.roles.manager.model='opus[1m]'
  team.roles.developer.model='sonnet[1m]'
  const {agents}=compile(team)
  assert.equal(agents.manager.model,'opus')
  assert.equal(agents.developer.model,'sonnet')
  assert.equal(agents.developer.maxTurns,40)
  assert.equal(agents.developer.effort,'medium')
  assert.equal(team.roles.manager.model,'opus[1m]','compilation preserves the saved snapshot')
})

test('a team compiles into the two options the SDK needs',()=>{
  const team=getTeam('bugfix')
  const {agent,agents}=compile(team)
  assert.equal(agent,'manager')
  // `agent` resolves the main-thread name out of `agents`, so the manager has to be in
  // there too. Dropping it is the obvious-looking tidy-up that breaks every initiative.
  assert.ok(agents.manager,'the manager must appear in agents or `agent` cannot resolve')
  assert.deepEqual(Object.keys(agents).sort(),['developer','manager','qa'])
  for (const role of Object.values(agents)) {
    assert.equal(typeof role.description,'string')
    assert.ok(role.prompt.length>200,'a role prompt short enough to fit in a tweet is not a mandate')
  }
})

test('the manager cannot write code and nobody but the manager can delegate',()=>{
  const {agents}=compile(getTeam('bugfix'))
  // The whole arrangement rests on this: give the manager edit tools and it stops
  // delegating and starts patching, and the team becomes decoration.
  for (const tool of ['Write','Edit','NotebookEdit']) {
    assert.ok(agents.manager.disallowedTools.includes(tool),`manager must not have ${tool}`)
    assert.ok(agents.qa.disallowedTools.includes(tool),`qa must not have ${tool}`)
  }
  assert.ok(!(agents.developer.disallowedTools||[]).some(t=>['Write','Edit'].includes(t)),'the developer is the one who edits')
  // Subagents spawning subagents is unsupervised and expensive before it is visible.
  for (const role of ['developer','qa']) {
    assert.ok(agents[role].disallowedTools.includes('Agent'),`${role} must not delegate`)
    assert.ok(agents[role].disallowedTools.includes('Task'),`${role} must not delegate`)
  }
  assert.ok(!(agents.manager.disallowedTools||[]).includes('Agent'),'the manager delegates for a living')
})

test('every non-manager role is told that it is one',()=>{
  const {agents}=compile(getTeam('bugfix'))
  for (const role of ['developer','qa']) {
    assert.match(agents[role].prompt,/You are a subagent/,`${role} must know it is a subagent`)
    assert.match(agents[role].prompt,/never address the operator/i,`${role} must not write to the operator`)
  }
  assert.doesNotMatch(agents.manager.prompt,/You are a subagent/,'the manager talks to the operator')
})

test('listTeams is safe to hand to a browser',()=>{
  const [team]=listTeams()
  assert.equal(team.id,'bugfix')
  assert.equal(team.manager,'manager')
  assert.deepEqual(team.roles.map(r=>r.name).sort(),['developer','manager','qa'])
  // Prompts are large and of no use to the UI; shipping them is pure weight.
  assert.equal(JSON.stringify(listTeams()).includes(TEAMS.bugfix.roles.manager.prompt),false)
})

test('an unknown or absent team is null rather than a throw',()=>{
  assert.equal(getTeam('nope'),null)
  assert.equal(getTeam(''),null)
  assert.equal(getTeam(undefined),null)
  // A team id is operator input and must not be able to reach up the prototype chain.
  assert.equal(getTeam('constructor'),null)
  assert.equal(getTeam('__proto__'),null)
  assert.equal(compile(null),null)
})

test('a team whose manager is missing fails loudly',()=>{
  assert.throws(()=>compile({id:'broken',manager:'ghost',roles:{developer:{prompt:'x',description:'y'}}}),/manager role that does not exist/)
})

test('Quick is an explicit lighter preset and snapshots remain independent',()=>{
  const quick=getTeam('quick'),full=getTeam('delivery')
  assert.deepEqual(quick.workflow.reviewers,['qa'])
  assert.deepEqual(full.workflow.reviewers,['reviewer','qa'])
  const {agents}=compile(quick)
  assert.equal(agents.developer.model,'sonnet')
  assert.ok(agents.qa.disallowedTools.includes('Edit'))
  assert.ok(agents.developer.disallowedTools.includes('Agent'))
  quick.roles.developer.model='custom'
  assert.equal(getTeam('quick').roles.developer.model,'sonnet')
})
