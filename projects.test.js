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
const queue={name:'Queue in the ring node',deadline:'2026-10-30',brief:'Customers rebuild a queue by hand in call flows.',deliverables:['Queue as a ring option','Waiting music and announcements','Max wait and fallback']}
// The way a manager sets a project up: create from a title, then define the rest.
const make=(store,extra={})=>{const p=store.create({name:queue.name});return store.define(p.id,{...queue,...extra})}

test('a project is one Markdown file, readable by a person and kept on every change',()=>{
  const directory=tmp(),store=new ProjectStore(directory)
  const p=make(store,{repos:['~/projects/api-allo','~/projects/desktop-allo'],links:['https://github.com/acme/api-allo/pull/3796','not a link']})
  assert.equal(path.dirname(p.file),path.join(directory,'projects'))
  assert.equal(path.basename(p.file),'queue-in-the-ring-node.md')
  assert.deepEqual(p.links,['https://github.com/acme/api-allo/pull/3796'],'only real links are kept')
  store.deliverable(p.id,p.deliverables[0].id,{state:'doing',note:'#3796 rebasing'})
  store.section(p.id,'Sources','- Roadmap section, 2 Oct\n- Slack thread with Franco')
  store.note(p.id,'Agreed scope with Franco.')
  const md=fs.readFileSync(p.file,'utf8')
  assert.match(md,/^---\nid: [\w-]+\nname: Queue in the ring node\ndeadline: 2026-10-30\nrepos:\n  - ~\/projects\/api-allo/)
  assert.match(md,/## Brief\n\nCustomers rebuild a queue by hand/)
  assert.match(md,/## Deliverables\n\n- \[~\] Queue as a ring option · #3796 rebasing\n- \[ \] Waiting music and announcements/)
  assert.match(md,/## Sources\n\n- Roadmap section, 2 Oct/)
  assert.match(md,/## Log\n\n- \d{4}-\d\d-\d\d \d\d:\d\d Project created\.\n- \d{4}-\d\d-\d\d \d\d:\d\d Agreed scope with Franco\./)
  assert.doesNotMatch(md,/\u2014/,'no long dashes in the file')
  const again=new ProjectStore(directory).get(p.id)
  assert.deepEqual(again.deliverables.map(d=>[d.title,d.state,d.note]),[['Queue as a ring option','doing','#3796 rebasing'],['Waiting music and announcements','todo',''],['Max wait and fallback','todo','']])
  assert.deepEqual(progress(again),{total:3,done:0,doing:1})
  const redefined=store.define(p.id,{deliverables:['Queue as a ring option','Max wait and fallback','Queue tab in settings']})
  assert.deepEqual(redefined.deliverables.map(d=>[d.title,d.state]),[['Queue as a ring option','doing'],['Max wait and fallback','todo'],['Queue tab in settings','todo']],'known deliverables keep their state')
  assert.equal(redefined.brief,queue.brief,'fields left out are kept')
  assert.throws(()=>store.deliverable(p.id,redefined.deliverables[0].id,{state:'shipped'}),/State must be/)
  assert.throws(()=>store.define(p.id,{deadline:'next week'}),/Deadline/)
  assert.throws(()=>store.section(p.id,'Deliverables','x'),/its own action/)
  store.section(p.id,'Sources','')
  assert.doesNotMatch(fs.readFileSync(p.file,'utf8'),/## Sources/,'an empty section is removed')
  store.archive(p.id)
  assert.equal(store.list().length,0)
  assert.equal(store.list({archived:true}).length,1)
})

test('an edit made by hand to the file is what Fleet reads next',async()=>{
  const directory=tmp(),store=new ProjectStore(directory),p=make(store)
  await delay(20)
  const md=fs.readFileSync(p.file,'utf8').replace('- [ ] Waiting music and announcements','- [x] Waiting music and announcements · shipped in #2090').replace('deadline: 2026-10-30','deadline: 2026-11-06')+'\n## Decisions\n\nQueue lives in the ring node, not a separate node.\n'
  fs.writeFileSync(p.file,md)
  const read=store.get(p.id)
  assert.equal(read.deadline,'2026-11-06')
  assert.deepEqual(read.deliverables[1],{id:'waiting-music-and-announcements',title:'Waiting music and announcements',state:'done',note:'shipped in #2090'})
  assert.deepEqual(read.sections,[{heading:'Decisions',body:'Queue lives in the ring node, not a separate node.'}])
  store.note(p.id,'Checked.')
  assert.match(fs.readFileSync(p.file,'utf8'),/## Decisions\n\nQueue lives in the ring node/,'a hand-written section survives Fleet writing the file')
})

test('projects from 0.28.0 move into their own files once',()=>{
  const directory=tmp()
  fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({version:1,projects:[{id:'p-1',name:'Failed payment',deadline:'2026-10-30',brief:'Pay from the app.',repos:[],links:[],deliverables:[{id:'x',title:'Pay from the app on web',state:'doing',note:''}],log:[],archived:false}]}))
  const store=new ProjectStore(directory)
  assert.deepEqual(store.list().map(p=>[p.name,p.deliverables[0].state]),[['Failed payment','doing']])
  assert.ok(fs.existsSync(path.join(directory,'projects.json.migrated')))
  assert.equal(new ProjectStore(directory).list().length,1,'and only once')
})

test('sessions belong to a project, and a launch from the Day carries the item\'s project',async()=>{
  const {directory,manager}=setup()
  try{
    const p=make(manager.projects)
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
    const p=make(manager.projects,{repos:[path.join(directory,'missing'),path.join(directory,'api-allo')]})
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
    const p=make(manager.projects)
    const pm=manager.askProject(p.id,{message:'Post a status to Slack'})
    await until(()=>decisions.length===2)
    assert.equal(decisions[0].behavior,'allow','reading is free')
    assert.equal(decisions[1],'pending','sending stops for the operator, whatever the approval mode')
    assert.match(reason || '',/does not send anything outside Fleet/)
    assert.ok(pm)
  } finally { await manager.close() }
})

test('a new project is just a title, and its manager starts setting it up at once',async()=>{
  const {manager,calls}=setup()
  try{
    const p=manager.createProject({name:'Live status for calls',note:'Spec is due Tue 6 Oct.'})
    assert.equal(p.name,'Live status for calls')
    assert.equal(p.brief,'')
    const pm=manager.managerOf(p.id)
    await until(()=>pm.status==='idle')
    assert.equal(pm.messages[0].text,'Spec is due Tue 6 Oct.','the console shows what the operator said')
    assert.match(calls.at(-1).prompt,/only a title: "Live status for calls"[\s\S]*Linear[\s\S]*project define[\s\S]*Sources[\s\S]*Spec is due Tue 6 Oct\./)
    assert.throws(()=>manager.createProject({name:''}),/Project name/)
  } finally { await manager.close() }
})

test('a manager\'s suggestion, as its tool sends it, lands on today\'s Day with the project set',async()=>{
  const {directory,manager}=setup()
  try{
    const p=make(manager.projects)
    // Exactly what the project tool passes on: its own action and unrelated keys included.
    const input={action:'suggest',title:'Rebase #3799 onto main',context:'Stalled since July.',priority:'must',mode:'agent',links:['https://github.com/acme/api-allo/pull/3799'],estimateMin:30,deliverableId:'queue-as-a-ring-option',sessionId:'x'}
    assert.throws(()=>manager.suggestForProject(p.id,input),/There is no Day running today/,'without a Day the manager is told to ask the operator to start one')
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    const {item}=manager.suggestForProject(p.id,input)
    assert.equal(item.projectId,p.id)
    assert.equal(item.status,'proposed')
    assert.deepEqual([item.title,item.context,item.priority,item.mode,item.estimateMin,item.links],['Rebase #3799 onto main','Stalled since July.','must','agent',30,['https://github.com/acme/api-allo/pull/3799']])
    assert.equal(item.deliverableId,undefined,'keys a Day item does not take stay out')
    assert.ok(d.dayBoard.items.some(i=>i.id===item.id),'it is on today\'s board')
  } finally { await manager.close() }
})

test('a deliverable goes on today as work to start, once, and the project knows it is there',async()=>{
  const {directory,manager}=setup()
  try{
    const p=make(manager.projects,{brief:'Ship the queue.'})
    const [first,second]=p.deliverables
    manager.projects.deliverable(p.id,first.id,{note:'Waiting on #3799'})
    assert.throws(()=>manager.planDeliverable(p.id,first.id),/Start your day/,'there has to be a Day to put it on')
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    const {item,existing}=manager.planDeliverable(p.id,first.id)
    assert.equal(existing,false)
    assert.deepEqual([item.title,item.status,item.mode,item.projectId,item.deliverableId],[first.title,'today','agent',p.id,first.id],'decided work for the Day agent, tagged with its project')
    assert.match(item.context,/Ship the queue\./)
    assert.deepEqual(item.links,[],'no links, so it cannot be merged into another item')
    const after=manager.projects.get(p.id).deliverables.find(x=>x.id===first.id)
    assert.equal(after.state,'doing')
    assert.equal(after.note,'Waiting on #3799','the manager\'s note is kept')
    assert.equal(manager.planDeliverable(p.id,first.id).existing,true,'a second click finds it rather than adding a twin')
    assert.equal(d.dayBoard.items.filter(i=>i.deliverableId===first.id).length,1)
    assert.deepEqual(manager.deliverablesOnToday(p.id),{[first.id]:{itemId:item.id,status:'today'}})
    assert.throws(()=>manager.planDeliverable(p.id,'nope'),/not in this project/)
    assert.equal(manager.projects.get(p.id).deliverables.find(x=>x.id===second.id).state,'todo','only the one asked for moves')
  } finally { await manager.close() }
})
