'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {ProjectStore,progress}=require('./projects')
const {ManagedSessions}=require('./managed')
const day=require('./day')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5)}throw Error('Condition timed out')}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'fleet-projects-'))
function setup(){
  const directory=tmp(),calls=[]
  const manager=new ManagedSessions({directory,queryFactory:async args=>{calls.push(args);return {close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:args.options.resume || `s-${calls.length}`,model:'claude-sonnet'}
    yield {type:'result',result:'On track.',is_error:false}
  }}}})
  return {directory,manager,calls}
}
const queue={name:'Queue in the ring node',deadline:'2026-10-30',brief:'Customers rebuild a queue by hand in call flows.',deliverables:'Queue as a ring option\nWaiting music and announcements\nMax wait and fallback'}

test('a project is defined here, and its deliverables keep their state across edits',()=>{
  const directory=tmp(),store=new ProjectStore(directory)
  const p=store.save({...queue,repos:'~/projects/api-allo\n~/projects/desktop-allo',links:'https://github.com/acme/api-allo/pull/3796\nnot a link'})
  assert.equal(p.deliverables.length,3)
  assert.deepEqual(p.repos,['~/projects/api-allo','~/projects/desktop-allo'])
  assert.deepEqual(p.links,['https://github.com/acme/api-allo/pull/3796'],'only real links are kept')
  store.deliverable(p.id,p.deliverables[0].id,{state:'doing',note:'#3796 rebased'})
  const edited=store.save({...queue,id:p.id,deliverables:'Queue as a ring option\nMax wait and fallback\nQueue tab in settings'})
  assert.deepEqual(edited.deliverables.map(d=>[d.title,d.state]),[['Queue as a ring option','doing'],['Max wait and fallback','todo'],['Queue tab in settings','todo']])
  assert.deepEqual(progress(edited),{total:3,done:0,doing:1})
  assert.throws(()=>store.deliverable(p.id,p.deliverables[0].id,{state:'shipped'}),/State must be/)
  assert.throws(()=>store.save({name:'x',deadline:'next week'}),/Deadline/)
  assert.equal(new ProjectStore(directory).get(p.id).deliverables[0].note,'#3796 rebased','projects survive a restart')
  store.archive(p.id)
  assert.equal(store.list().length,0)
  assert.equal(store.list({archived:true}).length,1)
})

test('sessions belong to a project, and a launch from the Day carries the item\'s project',async()=>{
  const {directory,manager}=setup()
  try{
    const p=manager.projects.save(queue)
    const agent=manager.create({cwd:directory,prompt:'Rebase #3796',projectId:p.id,requestId:randomUUID()})
    assert.equal(agent.projectId,p.id)
    await until(()=>agent.status==='idle')
    manager.setProject(agent.id,{projectId:null})
    assert.equal(agent.projectId,null)
    manager.setProject(agent.id,{projectId:p.id})
    assert.throws(()=>manager.create({cwd:directory,prompt:'x',projectId:'nope',requestId:randomUUID()}),/Project not found/)
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    assert.throws(()=>manager.setProject(d.id,{projectId:p.id}),/Only agents and initiatives/)
    const item=day.act(d,{action:'add',title:'Rebase queue PRs',source:'me',projectId:p.id},'operator').item
    const need=day.act(d,{action:'ask',itemId:item.id,kind:'launch',question:'Launch?',draft:'Rebase #3799 onto main.',cwd:directory})
    manager.dayAction(d.id,{op:'answer',itemId:item.id,needId:need.id,answer:'approve'})
    assert.equal(manager.sessions.get(need.launched).projectId,p.id)
    assert.equal(manager.members(p.id).length,2)
    assert.equal(manager.summaries().find(x=>x.managedId===agent.id).projectId,p.id)
  } finally { await manager.close() }
})

test('the project manager starts on the first question, reads its sessions as summaries, and hands work to the Day',async()=>{
  const {directory,manager,calls}=setup()
  try{
    fs.mkdirSync(path.join(directory,'api-allo'))
    const p=manager.projects.save({...queue,repos:[path.join(directory,'missing'),path.join(directory,'api-allo')]})
    const agent=manager.create({cwd:directory,prompt:'Rebase #3796',projectId:p.id,requestId:randomUUID()})
    await until(()=>agent.status==='idle')
    const pm=manager.askProject(p.id,{message:'Where are we?'})
    await until(()=>pm.status==='idle')
    assert.equal(pm.kind,'project')
    assert.equal(pm.cwd,fs.realpathSync(path.join(directory,'api-allo')),'it works in the first repository that exists')
    assert.equal(pm.messages[0].text,'Where are we?')
    const first=calls.at(-1)
    assert.match(first.prompt,/project tool[\s\S]*Where are we\?/)
    assert.match(first.options.systemPrompt.append,/project manager for ONE project/)
    assert.deepEqual(first.options.disallowedTools,['Edit','Write','NotebookEdit'])
    assert.equal(manager.askProject(p.id,{message:'And now?'}).id,pm.id,'one manager per project')
    const status=manager.projectStatus(p.id)
    assert.deepEqual(status.sessions.map(x=>[x.id,x.lastWords]),[[agent.id,'On track.']],'its own session is not one of the project\'s')
    assert.equal(status.deliverables.length,3)
    assert.throws(()=>manager.projectSession(p.id,pm.id),/not part of this project/)
    assert.throws(()=>manager.suggestForProject(p.id,{title:'Rebase #3799',mode:'agent'}),/no Day running today/)
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    const {item}=manager.suggestForProject(p.id,{title:'Rebase #3799',mode:'agent',priority:'should'})
    assert.equal(item.projectId,p.id)
    assert.equal(item.status,'proposed','a suggestion is a proposal for the operator to triage')
    assert.deepEqual(manager.projectStatus(p.id).today.map(i=>i.title),['Rebase #3799'])
  } finally { await manager.close() }
})

test('a project manager never sends anything outside Fleet on its own',async()=>{
  const decisions=[]
  let reason
  const directory=tmp()
  const manager=new ManagedSessions({directory,queryFactory:async({options})=>({close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:'pm',model:'claude-sonnet'}
    const signal=options.abortController.signal
    decisions.push(await options.canUseTool('mcp__linear-server__get_issue',{id:'TECH-1'},{signal}))
    decisions.push(await Promise.race([options.canUseTool('mcp__claude_ai_Slack__slack_send_message',{message:'Status: on track'},{signal}),delay(50).then(()=>'pending')]))
    reason=[...manager.sessions.values()].find(x=>x.kind==='project')?.approvals[0]?.reason
    yield {type:'result',result:'Done',is_error:false}
  }})})
  try{
    const p=manager.projects.save(queue)
    const pm=manager.askProject(p.id,{message:'Post a status to Slack'})
    await until(()=>decisions.length===2)
    assert.equal(decisions[0].behavior,'allow','reading is free')
    assert.equal(decisions[1],'pending','sending stops for the operator, whatever the approval mode')
    assert.match(reason || '',/does not send anything outside Fleet/)
    assert.ok(pm)
  } finally { await manager.close() }
})
