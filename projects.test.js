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
  assert.deepEqual(read.deliverables[1],{id:'waiting-music-and-announcements',title:'Waiting music and announcements',state:'done',note:'shipped in #2090',brief:'',links:[]})
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

test('the project manager starts on the first question, reads its sessions as summaries, and leaves the Day to the operator',async()=>{
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
    // Nothing reaches the Day from the manager: only the operator's ＋ Today does.
    assert.doesNotMatch(first.options.systemPrompt.append,/\bsuggest:/)
    assert.match(first.options.systemPrompt.append,/never put anything on the operator's Day/)
  } finally { await manager.close() }
})

test('a project manager changes documents only with approval, logs each change, and never messages people',async()=>{
  const decisions=[]
  let approval
  const directory=tmp()
  const manager=new ManagedSessions({directory,queryFactory:async({options})=>({close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:'pm',model:'claude-sonnet'}
    const signal=options.abortController.signal
    decisions.push(await options.canUseTool('mcp__linear-server__get_issue',{id:'TECH-1'},{signal}))
    decisions.push(await options.canUseTool('mcp__notion__notion-fetch',{id:'page-1'},{signal}))
    decisions.push(await options.canUseTool('mcp__claude_ai_Slack__slack_send_message',{message:'Status: on track'},{signal}))
    decisions.push(await options.canUseTool('mcp__linear-server__save_comment',{issueId:'TECH-1',body:'Done'},{signal}))
    const write=options.canUseTool('mcp__notion__notion-update-page',{page_id:'page-1',content:'# Spec'},{signal})
    await until(()=>pmOf()?.approvals.length===1)
    approval=pmOf().approvals[0]
    decisions.push(await write)
    yield {type:'result',result:'Done',is_error:false}
  }})})
  const pmOf=()=>[...manager.sessions.values()].find(x=>x.kind==='project')
  try{
    const p=make(manager.projects)
    manager.askProject(p.id,{message:'Put the spec on the Notion page'})
    await until(()=>approval)
    assert.equal(decisions[0].behavior,'allow','reading Linear is free')
    assert.equal(decisions[1].behavior,'allow','reading Notion is free')
    assert.equal(decisions[2].behavior,'deny','a Slack message is refused outright')
    assert.match(decisions[2].message,/does not message people/)
    assert.equal(decisions[3].behavior,'deny','so is a comment that notifies someone')
    assert.match(approval.reason,/outside Fleet/,'a document change stops for the operator, whatever the approval mode')
    manager.decide(pmOf().id,approval.id,{decision:'allow'})
    await until(()=>decisions.length===5)
    assert.equal(decisions[4].behavior,'allow')
    await until(()=>manager.projects.get(p.id).log.some(l=>/Approved change outside Fleet/.test(l.text)))
    assert.match(manager.projects.get(p.id).log.at(-1).text,/notion notion-update-page \(page-1\)/,'the log names what changed, not the content')
  } finally { await manager.close() }
})

test('a project manager changes nothing outside Fleet in a run the operator did not ask for',async()=>{
  const {manager}=setup()
  try{
    const p=make(manager.projects)
    const pm=manager.askProject(p.id,{message:'Where are we?'})
    const result=await manager.ask(pm,{background:true},'mcp__notion__notion-update-page',{page_id:'x'},{signal:new AbortController().signal})
    assert.equal(result.behavior,'deny')
    assert.match(result.message,/only when the operator asks/)
  } finally { await manager.close() }
})

test('each deliverable keeps its brief and source links in the file, by define or one at a time',async()=>{
  const directory=tmp(),store=new ProjectStore(directory),p=make(store)
  store.define(p.id,{deliverables:[{title:'Queue as a ring option',brief:'Move the queue into the ring node.\n\nDone when: a queued call rings the next free agent.',links:['https://github.com/acme/api-allo/pull/3796','https://linear.app/acme/issue/TECH-12/queue','not a link']},'Waiting music and announcements']})
  let read=store.get(p.id)
  assert.equal(read.deliverables.length,2)
  assert.equal(read.deliverables[0].brief,'Move the queue into the ring node.\nDone when: a queued call rings the next free agent.','blank lines go, so the brief stays under its task')
  assert.deepEqual(read.deliverables[0].links,['https://github.com/acme/api-allo/pull/3796','https://linear.app/acme/issue/TECH-12/queue'])
  const md=fs.readFileSync(read.file,'utf8')
  assert.match(md,/- \[ \] Queue as a ring option\n {2}Move the queue into the ring node\.\n {2}Done when: .*\n {2}- https:\/\/github\.com\/acme\/api-allo\/pull\/3796\n/)
  // Titles alone keep what a task already has.
  store.define(p.id,{deliverables:['Queue as a ring option','Waiting music and announcements']})
  assert.equal(store.get(p.id).deliverables[0].links.length,2)
  const id=read.deliverables[1].id
  store.deliverable(p.id,id,{brief:'Upload music per queue.',links:['https://acme.slack.com/archives/C1/p1']})
  store.deliverable(p.id,id,{addLinks:['https://github.com/acme/api-allo/pull/4000','https://acme.slack.com/archives/C1/p1']})
  read=store.get(p.id)
  assert.deepEqual(read.deliverables[1].links,['https://acme.slack.com/archives/C1/p1','https://github.com/acme/api-allo/pull/4000'])
  assert.throws(()=>store.deliverable(p.id,id,{brief:'x'.repeat(5000)}),/at most 4000/)
  // A brief written by hand, indented under its task, is read back the same way.
  await delay(20)
  fs.writeFileSync(read.file,fs.readFileSync(read.file,'utf8').replace('- [ ] Waiting music and announcements','- [ ] Waiting music and announcements\n  Ask Franco which formats.'))
  assert.match(store.get(p.id).deliverables[1].brief,/^Ask Franco which formats\.\nUpload music per queue\.$/)
})

test('a task goes to Today with its brief, links and the project story, and its agent starts from the project file',async()=>{
  const {directory,manager}=setup()
  try{
    const p=make(manager.projects,{brief:'Ship the queue.',repos:[directory]})
    manager.projects.section(p.id,'Decisions','Desktop first, mobile later.')
    manager.projects.note(p.id,'Scope agreed with Franco.')
    const task=p.deliverables[0]
    manager.projects.deliverable(p.id,task.id,{brief:'Move the queue into the ring node.\nDone when: a queued call rings.',links:['https://linear.app/acme/issue/TECH-12/queue']})
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    // Something else on the board already points at the same ticket.
    const other=day.act(d,{action:'add',title:'TECH-12 comment',source:'linear',links:['https://linear.app/acme/issue/TECH-12/queue']}).item
    const {item}=manager.planDeliverable(p.id,task.id)
    assert.notEqual(item.id,other.id,'a project task is never folded into another item')
    assert.deepEqual(item.links,['https://linear.app/acme/issue/TECH-12/queue'])
    for (const part of ['Move the queue into the ring node.','Done when: a queued call rings.','Ship the queue.','Desktop first, mobile later.','Scope agreed with Franco.',p.file]) assert.ok(item.context.includes(part),`the hand-off carries: ${part}`)
    assert.ok(item.context.length<=8000)
    const listed=day.act(d,{action:'list'}).items.find(i=>i.id===item.id)
    assert.match(listed.context,/inspect for the rest/,'the list shows there is more to read')
    assert.equal(listed.deliverableId,task.id)
    const need=day.act(d,{action:'ask',itemId:item.id,kind:'launch',question:'Launch?',draft:'Implement the queue in the ring node.',cwd:directory})
    manager.dayAction(d.id,{op:'answer',itemId:item.id,needId:need.id,answer:'approve'})
    const launched=manager.sessions.get(need.launched)
    assert.equal(launched.projectId,p.id)
    const first=launched.messages[0].text
    assert.match(first,/^Implement the queue in the ring node\./)
    assert.ok(first.includes(p.file),'the agent is told where the project file is')
    assert.ok(first.includes('https://linear.app/acme/issue/TECH-12/queue'),'and gets the task links the brief left out')
    await until(()=>launched.status==='idle')
  } finally { await manager.close() }
})

test('an agent working a project task reports to the project: its log, and its PR on the deliverable',async()=>{
  const directory=tmp()
  let agentTurn=false
  const manager=new ManagedSessions({directory,queryFactory:async({options})=>({close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:randomUUID(),model:'claude-sonnet'}
    const text=agentTurn && !options.agents?.['slack-scout'] ? 'Opened https://github.com/acme/api-allo/pull/4100 with the fix.' : 'Ready.'
    yield {type:'assistant',message:{id:randomUUID(),content:[{type:'text',text}]}}
    yield {type:'result',result:text,is_error:false}
  }})})
  try{
    const p=make(manager.projects)
    const task=p.deliverables[0]
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    const {item}=manager.planDeliverable(p.id,task.id)
    const need=day.act(d,{action:'ask',itemId:item.id,kind:'launch',question:'Launch?',draft:'Do it.',cwd:directory})
    agentTurn=true
    manager.dayAction(d.id,{op:'answer',itemId:item.id,needId:need.id,answer:'approve'})
    await until(()=>item.needs.some(n=>n.report))
    let read=manager.projects.get(p.id)
    assert.match(read.log.at(-1).text,new RegExp(`^Agent finished on "${task.title}" \\(https://github.com/acme/api-allo/pull/4100\\): Opened`))
    assert.deepEqual(read.deliverables[0].links,['https://github.com/acme/api-allo/pull/4100'])
    const report=item.needs.find(n=>n.report)
    manager.dayAction(d.id,{op:'answer',itemId:item.id,needId:report.id,answer:'Done',decision:'choose'})
    read=manager.projects.get(p.id)
    assert.equal(read.log.at(-1).text,`Marked done on Today: ${task.title}`)
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

test('a project manager has no way to put anything on the Day',async()=>{
  const projectAgent=require('./project-agent')
  const server=await projectAgent.server('p',{projects:{},status:()=>({}),session:()=>({})},()=>{})
  const tool=server.instance?._registeredTools?.project || null
  const actions=tool?.inputSchema?.shape?.action?.options || tool?.inputSchema?.def?.shape?.action?.options || null
  if (actions) assert.ok(!actions.includes('suggest'),'the project tool has no suggest action')
  assert.doesNotMatch(projectAgent.SYSTEM,/^- suggest:/m)
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
    assert.deepEqual(item.links,[],'a task without links brings none of the project\'s')
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

test('a comment on a task is logged, reaches the task on Today, and asks the manager to update the task',async()=>{
  const {directory,manager}=setup()
  try{
    const p=make(manager.projects)
    const task=p.deliverables[1]
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    const {item}=manager.planDeliverable(p.id,task.id)
    const pm=manager.commentOnTask(p.id,{deliverableId:task.id,message:'Franco says MP3 only, no WAV.',requestId:randomUUID()})
    assert.equal(pm.kind,'project')
    assert.equal(manager.projects.get(p.id).log.at(-1).text,`Comment on "${task.title}": Franco says MP3 only, no WAV.`)
    assert.match(item.log.at(-1).text,/You commented on the project task: Franco says MP3 only/)
    await until(()=>pm.messages.some(m=>m.role==='user' && m.runPrompt?.includes(task.id)))
    const asked=pm.messages.filter(m=>m.role==='user').at(-1)
    assert.equal(asked.text,`On "${task.title}": Franco says MP3 only, no WAV.`,'the console shows the comment as written')
    assert.match(asked.runPrompt,new RegExp(`deliverableId ${task.id}`),'the manager is told which task it is about')
    assert.throws(()=>manager.commentOnTask(p.id,{deliverableId:'nope',message:'x'}),/not in this project/)
    assert.throws(()=>manager.commentOnTask(p.id,{deliverableId:task.id,message:'  '}),/Comment/)
  } finally { await manager.close() }
})

// Every agent busy is a reason the manager cannot start, not a disk failure: the project
// is kept, the answer says setup did not start, and nothing locks the dashboard's writes.
test('a project created while every agent is busy is kept, says setup did not start, and sets up when asked later',async()=>{
  const {createApp}=require('./server')
  const directory=tmp(),releases=[],calls=[]
  const manager=new ManagedSessions({directory,queue:false,queryFactory:async args=>{
    calls.push(args)
    let release;const finished=new Promise(r=>{release=r});releases.push(release)
    return {close(){},async *[Symbol.asyncIterator](){
      yield {type:'system',subtype:'init',session_id:randomUUID(),model:'claude-sonnet'}
      await Promise.race([finished,new Promise(r=>args.options.abortController.signal.addEventListener('abort',r,{once:true}))])
      yield {type:'result',result:'Done.',is_error:false}
    }}
  }})
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()})})
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const base=`http://127.0.0.1:${app.server.address().port}`
    const config=await (await fetch(base+'/api/control')).json()
    const post=(url,data)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-fleet-token':config.token,origin:base},body:JSON.stringify(data)})
    const busy=Array.from({length:manager.dispatch.limit},()=>manager.create({cwd:directory,prompt:'Busy',requestId:randomUUID()}))
    await until(()=>manager.runs.size===busy.length)
    const response=await post('/api/projects',{name:'Live status for calls',note:'Spec is due Tue 6 Oct.',requestId:randomUUID()})
    assert.equal(response.status,200)
    const {project}=await response.json()
    assert.equal(project.setup.started,false)
    assert.match(project.setup.error,/already running/)
    assert.equal(manager.projects.get(project.id).name,'Live status for calls','the project is kept')
    assert.match(manager.projects.get(project.id).log.at(-1).text,/^Setup did not start: .*already running/)
    assert.equal(manager.managerOf(project.id),null)
    assert.equal((await (await fetch(base+'/api/control')).json()).storageError,null,'a busy Fleet is not a storage failure')
    assert.equal((await post('/api/settings/approval-mode',{mode:'auto'})).status,200,'unrelated writes still work')
    // A slot frees; asking the manager now runs the setup, once.
    releases[0]()
    await until(()=>manager.runs.size<busy.length)
    const asked=await post(`/api/projects/${project.id}/ask`,{message:'Go ahead.',requestId:randomUUID()})
    assert.equal(asked.status,200)
    const pms=[...manager.sessions.values()].filter(x=>x.kind==='project' && x.projectId===project.id)
    assert.equal(pms.length,1)
    assert.match(calls.at(-1).prompt,/only a title: "Live status for calls"[\s\S]*Go ahead\./,'the first ask is the setup')
    // A real write failure does latch writes, and only a write that lands clears it.
    manager.emit('storage-error',Error('Disk full'))
    assert.match((await (await fetch(base+'/api/control')).json()).storageError,/Unable to save/)
    assert.match((await (await fetch(base+'/api/sessions')).json()).storageError,/Unable to save/,'reading the list does not clear it')
    assert.equal((await post('/api/settings/approval-mode',{mode:'ask'})).status,503)
    assert.equal((await post(`/api/managed/${busy[1].id}/stop`,{})).status,200)
    assert.equal((await (await fetch(base+'/api/control')).json()).storageError,null,'the stop saved, so storage works again')
  } finally { releases.forEach(r=>r()); await app.close(); app.server.closeAllConnections() }
})

// Deliverable ids are slugs of their titles, so the same title in two projects is the
// same id. Today has to tell them apart by project as well.
test('the same task title in two projects makes two Today items, each tied to its own project',async()=>{
  const {directory,manager}=setup()
  try{
    const a=make(manager.projects),b=manager.projects.define(manager.projects.create({name:'Another project'}).id,{deliverables:[queue.deliverables[0]]})
    assert.equal(a.deliverables[0].id,b.deliverables[0].id,'equal titles, equal ids')
    const d=manager.create({kind:'day',cwd:directory,requestId:randomUUID()})
    await until(()=>d.status==='idle')
    const first=manager.planDeliverable(a.id,a.deliverables[0].id)
    const second=manager.planDeliverable(b.id,b.deliverables[0].id)
    assert.equal(second.existing,false,'the other project\'s task is not mistaken for this one')
    assert.notEqual(second.item.id,first.item.id)
    assert.equal(second.item.projectId,b.id)
    assert.equal(manager.planDeliverable(b.id,b.deliverables[0].id).item.id,second.item.id,'a retry of the same pair finds its own item')
    assert.equal(manager.planDeliverable(a.id,a.deliverables[0].id).item.id,first.item.id)
    assert.equal(d.dayBoard.items.filter(i=>i.deliverableId===a.deliverables[0].id).length,2)
    manager.commentOnTask(b.id,{deliverableId:b.deliverables[0].id,message:'Only for B.',requestId:randomUUID()})
    assert.match(second.item.log.at(-1).text,/Only for B\./,'a comment reaches its own project\'s item')
    assert.ok(!first.item.log.some(l=>/Only for B/.test(l.text)),'and not the other one')
  } finally { await manager.close() }
})
