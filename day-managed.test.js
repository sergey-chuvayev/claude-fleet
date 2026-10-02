'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {ManagedSessions}=require('./managed')
const day=require('./day')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(5)}throw Error('Condition timed out')}
// Each turn runs `script` against the options it was given, then finishes cleanly.
function setup(script=async()=>{}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-day-')),calls=[]
  const manager=new ManagedSessions({directory,queryFactory:async args=>{
    calls.push(args)
    return {close(){},async *[Symbol.asyncIterator](){
      yield {type:'system',subtype:'init',session_id:args.options.resume || `main-${calls.length}`,model:'claude-sonnet'}
      await script(args)
      yield {type:'result',result:'Done',is_error:false,total_cost_usd:0.01}
    }}
  }})
  return {directory,manager,calls}
}
const startDay=(manager,cwd,extra={})=>manager.create({kind:'day',cwd,requestId:randomUUID(),...extra})

test('a Day starts with an intake run on Sonnet, scouts, the day tool and no file editing',async()=>{
  const {directory,manager,calls}=setup()
  try{
    const s=startDay(manager,directory,{prompt:'Also remind me to renew the domain.'})
    await until(()=>s.status==='idle' && calls.length===1)
    const {options}=calls[0]
    assert.equal(s.kind,'day')
    assert.equal(s.dayBoard.date,day.dateOf())
    assert.equal(options.model,'sonnet')
    assert.match(options.systemPrompt.append,/chief of staff/)
    assert.deepEqual(Object.keys(options.agents).sort(),['calendar-scout','github-scout','granola-scout','linear-scout','slack-scout'])
    assert.ok(Object.values(options.agents).every(a=>a.model==='haiku'))
    assert.deepEqual(options.disallowedTools,['Edit','Write','NotebookEdit'])
    assert.ok(options.mcpServers.fleet)
    assert.equal(options.maxBudgetUsd,undefined,'a Day runs on the subscription with no usage cap')
    assert.equal(s.messages[0].text,'Start my day','the conversation shows a label, not the whole intake prompt')
    assert.match(calls[0].prompt,/Morning intake[\s\S]*renew the domain/)
    assert.throws(()=>startDay(manager,directory),/already has a Day/)
  } finally { await manager.close() }
})

test('a new Day carries over the previous one\'s unfinished items',async()=>{
  const {directory,manager}=setup()
  try{
    const old=startDay(manager,directory)
    await until(()=>old.status==='idle')
    day.act(old,{action:'add',title:'Finish the migration review',source:'me'},'operator')
    old.dayBoard.date='2026-01-01'
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    assert.deepEqual(s.dayBoard.items.map(i=>i.title),['Finish the migration review'])
    assert.equal(s.dayBoard.items[0].carriedFrom,'2026-01-01')
  } finally { await manager.close() }
})

test('outward connector calls need an approved draft on the board, whatever the approval mode',async()=>{
  const decisions=[]
  let item,need,session,reason
  const {directory,manager}=setup(async({options})=>{
    if (!item) return
    const signal=options.abortController.signal
    decisions.push(await options.canUseTool('mcp__claude_ai_Slack__slack_read_thread',{channel:'C1'},{signal}))
    decisions.push(await options.canUseTool('mcp__claude_ai_Slack__slack_send_message',{channel_id:'C1',message:'Looks good, merging after lunch.'},{signal}))
    // Spent: the same approval does not license the message a second time.
    decisions.push(await Promise.race([options.canUseTool('mcp__claude_ai_Slack__slack_send_message',{channel_id:'C1',message:'Looks good, merging after lunch.'},{signal}),delay(50).then(()=>'pending')]))
    reason=session.approvals[0]?.reason
  })
  try{
    const s=session=startDay(manager,directory,{approvalMode:'all'})
    await until(()=>s.status==='idle')
    item=day.act(s,{action:'add',title:'Reply to Marc',source:'slack'},'operator').item
    need=day.act(s,{action:'ask',itemId:item.id,kind:'approve',question:'Send?',draft:'Looks good, merging after lunch.'})
    manager.dayAction(s.id,{op:'answer',itemId:item.id,needId:need.id,answer:'approve'})
    manager.send(s.id,{message:'Go',requestId:randomUUID()})
    await until(()=>decisions.length===3)
    assert.equal(decisions[0].behavior,'allow','reads run freely')
    assert.equal(decisions[1].behavior,'allow','the approved draft goes out')
    assert.equal(decisions[2],'pending','a second send waits for the operator')
    assert.match(reason,/no approved draft/)
    assert.ok(need.spent)
    assert.match(item.log.at(-1).text,/slack_send_message/)
  } finally { await manager.close() }
})

test('an edited answer is what may be sent, and a rejected draft licenses nothing',()=>{
  const s={dayBoard:{date:day.dateOf(),items:[],cursors:{}}}
  const item=day.act(s,{action:'add',title:'Reply',source:'slack'},'operator').item
  const a=day.act(s,{action:'ask',itemId:item.id,kind:'approve',question:'Send?',draft:'Merging after lunch.'})
  const b=day.act(s,{action:'ask',itemId:item.id,kind:'approve',question:'Send?',draft:'Shipping tonight, all good.'})
  day.answer(s,item.id,a.id,'Merging tomorrow morning instead.')
  day.answer(s,item.id,b.id,'reject')
  assert.equal(day.approvedFor(s,{message:'Merging after lunch.'}),null)
  assert.equal(day.approvedFor(s,{message:'Shipping tonight, all good.'}),null)
  assert.equal(day.approvedFor(s,{message:'Merging tomorrow morning instead.'}).need.id,a.id)
  assert.equal(day.outward('mcp__linear-server__save_comment'),true)
  assert.equal(day.outward('mcp__linear-server__get_issue'),false)
  assert.equal(day.outward('mcp__fleet__day'),false)
  assert.equal(day.outward('Bash'),false,'built-in tools keep the normal approval mode')
})

test('sweeps and resumes start from the board and never replace the main conversation',async()=>{
  const {directory,manager,calls}=setup()
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const main=s.sessionId
    const noon=new Date();noon.setHours(12,0,0,0)
    manager.sweepDays(noon)
    await until(()=>calls.length===2 && s.status==='idle')
    assert.equal(calls[1].options.resume,undefined)
    assert.match(calls[1].prompt,/Scheduled sweep/)
    assert.ok(s.dayChecks.lastAt>0 && s.dayChecks.everyMin>=10,'the header can say when the last check ran and the next is due')
    assert.equal(s.sessionId,main)
    const night=new Date();night.setHours(22,0,0,0)
    manager.sweepDays(night)
    await delay(20)
    assert.equal(calls.length,2,'no sweeps outside working hours')
    manager.send(s.id,{message:'What is left?',requestId:randomUUID()})
    await until(()=>calls.length===3 && s.status==='idle')
    assert.equal(calls[2].options.resume,main,'the operator\'s own turns continue the main conversation')
  } finally { await manager.close() }
})

test('operator changes are validated, rolled back on error and schedule one resume',async()=>{
  const {directory,manager}=setup()
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const {item}=manager.dayAction(s.id,{op:'add',item:{title:'Renew the domain',source:'me'}})
    assert.equal(item.status,'today')
    assert.ok(manager.dayTimers.has(s.id))
    assert.throws(()=>manager.dayAction(s.id,{op:'triage',itemId:item.id,status:'waiting_on_you'}),/Triage/)
    assert.equal(s.dayBoard.items[0].status,'today')
    assert.throws(()=>manager.dayAction(s.id,{op:'nope'}),/Unknown Day action/)
    const agent=manager.create({cwd:directory,prompt:'hi',requestId:randomUUID()})
    assert.throws(()=>manager.dayAction(agent.id,{op:'sweep'}),/not a Day/)
  } finally { await manager.close() }
})

test('a failed sweep is retried, but three failures in a row wait for the operator',async()=>{
  let fail=false
  const {directory,manager,calls}=setup(async()=>{if(fail)throw new Error('connector timed out')})
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    fail=true
    const noon=new Date();noon.setHours(12,0,0,0)
    for (let i=1;i<=3;i++) {
      manager.sweepDays(noon)
      await until(()=>calls.length===1+i && s.status==='error')
      assert.equal(s.dayFailures,i)
    }
    manager.sweepDays(noon)
    await delay(20)
    assert.equal(calls.length,4,'the fourth sweep does not start')
    fail=false
    manager.send(s.id,{message:'Try again',requestId:randomUUID()})
    await until(()=>calls.length===5 && s.status==='idle')
    assert.equal(s.dayFailures,0,'a good run resets the count')
  } finally { await manager.close() }
})

test('a Day keeps its scouts in the foreground so their tool calls outlive no stream',async()=>{
  const {directory,manager,calls}=setup()
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const hook=calls[0].options.hooks.PreToolUse[0].hooks[0]
    const moved=await hook({tool_name:'Agent',tool_input:{subagent_type:'slack-scout',prompt:'Cursor: none',run_in_background:true}})
    assert.equal(moved.hookSpecificOutput.updatedInput.run_in_background,false)
    assert.equal(moved.hookSpecificOutput.updatedInput.subagent_type,'slack-scout')
    assert.deepEqual(await hook({tool_name:'Agent',tool_input:{subagent_type:'github-scout',prompt:'x'}}),{})
    assert.deepEqual(await hook({tool_name:'mcp__fleet__day',tool_input:{action:'list'}}),{})
    assert.match(calls[0].prompt,/Granola at \d{4}-\d\d-\d\dT/)
  } finally { await manager.close() }
})

test('a Day totals its tokens across every model, scouts included',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-day-'))
  let turns=0
  const manager=new ManagedSessions({directory,queryFactory:async()=>(turns++,{close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:'main',model:'claude-sonnet'}
    yield {type:'result',result:'Done',is_error:false,modelUsage:{'claude-sonnet':{inputTokens:1000,outputTokens:200,cacheReadInputTokens:5000,cacheCreationInputTokens:300},'claude-haiku':{inputTokens:400,outputTokens:100,cacheReadInputTokens:0,cacheCreationInputTokens:0}}}
  }})})
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    manager.send(s.id,{message:'again',requestId:randomUUID()})
    await until(()=>s.status==='idle' && turns===2)
    assert.deepEqual(s.tokenUsage,{input:2800,output:600,cacheRead:10000,cacheCreation:600})
    assert.deepEqual(manager.summaries().find(x=>x.managedId===s.id).tokenUsage,s.tokenUsage)
  } finally { await manager.close() }
})

test('approving a launch makes Fleet start that session, once, and the Day can follow it',async()=>{
  const {directory,manager,calls}=setup()
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const item=day.act(s,{action:'add',title:'Fix TECH-7166 retry',source:'linear'},'operator').item
    assert.throws(()=>day.act(s,{action:'ask',itemId:item.id,kind:'launch',question:'Launch?',draft:'Fix it',cwd:'relative/path'}),/absolute path/)
    assert.throws(()=>day.act(s,{action:'ask',itemId:item.id,kind:'launch',question:'Launch?',draft:'Fix it',cwd:directory,teamId:'nope'},'agent',{teams:()=>manager.teams.list()}),/Unknown team/)
    const need=day.act(s,{action:'ask',itemId:item.id,kind:'launch',question:'Launch a quick fix?',draft:'Fix the retry in TECH-7166.',cwd:directory,name:'TECH-7166 retry'})
    manager.dayAction(s.id,{op:'answer',itemId:item.id,needId:need.id,answer:'Fix the retry in TECH-7166, and add a test.'})
    const launched=manager.sessions.get(need.launched)
    assert.ok(launched,'a session was started')
    assert.equal(launched.kind,'agent')
    assert.equal(launched.name,'TECH-7166 retry')
    assert.equal(launched.messages[0].text,'Fix the retry in TECH-7166, and add a test.','the operator\'s edited brief is what starts')
    assert.deepEqual(item.launched,[launched.id])
    assert.equal(item.status,'in_progress')
    assert.throws(()=>manager.dayAction(s.id,{op:'answer',itemId:item.id,needId:need.id,answer:'approve'}),/already answered/)
    await until(()=>launched.status==='idle')
    const seen=day.act(s,{action:'list'},'agent',{launched:id=>manager.launchedStatus(id)}).items.find(i=>i.id===item.id).launched[0]
    assert.equal(seen.status,'idle')
    assert.equal(seen.name,'TECH-7166 retry')
    assert.ok(calls.some(c=>c.options.cwd===fs.realpathSync(directory) && !c.options.agents?.['slack-scout']),'the launched session is a normal agent, not a Day')
  } finally { await manager.close() }
})

test('a launch that cannot start rolls the answer back so it can be retried',async()=>{
  const {directory,manager}=setup()
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const item=day.act(s,{action:'add',title:'Work',source:'me'},'operator').item
    const need=day.act(s,{action:'ask',itemId:item.id,kind:'launch',question:'Launch?',draft:'Do the work.',cwd:'/definitely/not/here'})
    assert.throws(()=>manager.dayAction(s.id,{op:'answer',itemId:item.id,needId:need.id,answer:'approve'}),/does not exist/)
    assert.equal(s.dayBoard.items[0].needs[0].answer,undefined,'still open')
    assert.equal(s.dayBoard.items[0].launched,undefined)
  } finally { await manager.close() }
})

test('a Day records each subagent with its assignment, steps and report',async()=>{
  const {directory,manager}=setup(async()=>{})
  manager.queryFactory=async()=>({close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:'main',model:'claude-sonnet'}
    yield {type:'assistant',message:{content:[{type:'tool_use',id:'agent-1',name:'Agent',input:{subagent_type:'slack-scout',description:'Slack intake',prompt:'Cursor: none'}}]}}
    yield {type:'assistant',parent_tool_use_id:'agent-1',message:{id:'m1',model:'claude-haiku',content:[{type:'text',text:'Searching mentions'},{type:'tool_use',id:'step-1',name:'mcp__claude_ai_Slack__slack_search_public_and_private',input:{query:'to:me'}}]}}
    yield {type:'user',parent_tool_use_id:'agent-1',message:{content:[{type:'tool_result',tool_use_id:'step-1',content:'3 messages'}]}}
    yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'agent-1',content:'[{"title":"Reply to Marc"}]'}]}}
    yield {type:'result',result:'Done',is_error:false}
  }})
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const [d]=s.subagents
    assert.equal(d.role,'slack-scout')
    assert.equal(d.prompt,'Cursor: none')
    assert.equal(d.status,'completed')
    assert.equal(d.model,'claude-haiku')
    assert.equal(d.output,'Searching mentions')
    assert.deepEqual(d.steps.map(x=>[x.tool,x.status,x.result]),[['mcp__claude_ai_Slack__slack_search_public_and_private','done','3 messages']])
    assert.match(d.report,/Reply to Marc/)
  } finally { await manager.close() }
})

test('asking about an item starts its own thread in the item\'s repository, then continues it',async()=>{
  const {directory,manager,calls}=setup()
  try{
    fs.mkdirSync(path.join(directory,'desktop-allo'))
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const item=day.act(s,{action:'add',title:'Review desktop #2951: CSV import',source:'github',links:['https://github.com/acme/desktop-allo/pull/2951'],context:'Christoph requested your review.'},'operator').item
    s.subagents=[{id:'sub-1',role:'general-purpose',prompt:'Run /red-flags on https://github.com/acme/desktop-allo/pull/2951',report:'6 red flags. (2) pollers lost on branch switch.',status:'completed',steps:[]}]
    const {threadId}=manager.dayAction(s.id,{op:'thread',itemId:item.id,message:'Why is (2) a problem?'})
    const t=manager.sessions.get(threadId)
    await until(()=>t.status==='idle')
    assert.equal(t.kind,'thread')
    assert.equal(t.cwd,fs.realpathSync(path.join(directory,'desktop-allo')))
    assert.equal(t.messages[0].text,'Why is (2) a problem?','the console shows the question, not the context dump')
    const first=calls.at(-1)
    assert.match(first.prompt,/Christoph requested your review[\s\S]*pollers lost on branch switch[\s\S]*You are in its repository[\s\S]*Why is \(2\) a problem\?/)
    assert.match(first.options.systemPrompt.append,/ONE item/)
    assert.deepEqual(first.options.disallowedTools,['Edit','Write','NotebookEdit'])
    assert.equal(first.options.agents,undefined,'a thread is not a Day: no scouts')
    assert.equal(item.thread.summary,'Done','the item carries the gist of the last turn')
    assert.equal(day.act(s,{action:'list'}).items[0].thread,'Done','and the Day reads it')
    const again=manager.dayAction(s.id,{op:'thread',itemId:item.id,message:'Drop comment 4.'})
    assert.equal(again.threadId,threadId)
    await until(()=>calls.length===3 && t.status==='idle')
    assert.equal(calls.at(-1).prompt,'Drop comment 4.')
    assert.equal(calls.at(-1).options.resume,t.sessionId)
    const row=manager.summaries().find(x=>x.managedId===threadId)
    assert.equal(row.threadOpen,true)
    manager.dayAction(s.id,{op:'triage',itemId:item.id,status:'done'})
    assert.ok(item.thread.closed,'a settled item closes its thread')
    assert.equal(manager.summaries().find(x=>x.managedId===threadId).threadOpen,false)
    assert.throws(()=>manager.dayAction(s.id,{op:'thread',itemId:day.act(s,{action:'add',title:'x',source:'me'},'operator').item.id,message:''}),/Message/)
  } finally { await manager.close() }
})

test('a thread reaches only its own item, and its sends need an approval on the Day\'s board',async()=>{
  const decisions=[]
  let ready=false
  const {directory,manager}=setup(async({options})=>{
    if (!ready || !options.systemPrompt.append.includes('ONE item')) return
    const signal=options.abortController.signal
    decisions.push(await options.canUseTool('mcp__github__add_issue_comment',{body:'Pollers are lost on branch switch; lift them into a store.'},{signal}))
  })
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    const a=day.act(s,{action:'add',title:'Review #2951',source:'github'},'operator').item
    const b=day.act(s,{action:'add',title:'Other',source:'me'},'operator').item
    const need=day.threadAct(s,a.id,{action:'ask',kind:'approve',question:'Post this comment?',draft:'Pollers are lost on branch switch; lift them into a store.'})
    assert.equal(a.needs.length,1)
    assert.equal(b.needs.length,0,'nothing leaks to other items')
    assert.throws(()=>day.threadAct(s,a.id,{action:'add',title:'x',source:'me'}),/only inspect, note, ask, withdraw/)
    day.threadAct(s,a.id,{action:'note',note:'Explained the poller issue.'})
    assert.match(a.log.at(-1).text,/^Thread: Explained/)
    manager.dayAction(s.id,{op:'answer',itemId:a.id,needId:need.id,answer:'approve'})
    ready=true
    const {threadId}=manager.dayAction(s.id,{op:'thread',itemId:a.id,message:'Post it.'})
    await until(()=>decisions.length===1)
    assert.equal(decisions[0].behavior,'allow','the approved text on the Day\'s board licenses the thread\'s send')
    assert.ok(need.spent)
    const second=day.threadAct(s,a.id,{action:'ask',kind:'approve',question:'Also this?',draft:'Second comment text here.'})
    day.threadAct(s,a.id,{action:'withdraw',needId:second.id})
    assert.equal(second.decision,'withdrawn')
    assert.equal(day.approvedFor(s,{body:'Second comment text here.'}),null,'a withdrawn question licenses nothing')
    assert.ok(manager.sessions.get(threadId))
  } finally { await manager.close() }
})

test('the next Day closes yesterday\'s threads, and a new thread starts from the earlier gist',async()=>{
  const {directory,manager,calls}=setup()
  try{
    const old=startDay(manager,directory)
    await until(()=>old.status==='idle')
    const item=day.act(old,{action:'add',title:'Review #2951',source:'github'},'operator').item
    const {threadId}=manager.dayAction(old.id,{op:'thread',itemId:item.id,message:'Why (2)?'})
    await until(()=>manager.sessions.get(threadId).status==='idle')
    item.thread.summary='Agreed to drop comment 4 and keep the rest.'
    old.dayBoard.date='2026-01-01'
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    assert.ok(item.thread.closed,'yesterday\'s thread is closed on yesterday\'s board')
    assert.equal(manager.summaries().find(x=>x.managedId===threadId).threadOpen,false,'so it shows in Sessions')
    const carried=s.dayBoard.items[0]
    assert.equal(carried.thread,undefined)
    assert.match(calls.find(c=>/Morning intake/.test(c.prompt) && c!==calls[0]).prompt,/carriedFrom/)
    const next=manager.dayAction(s.id,{op:'thread',itemId:carried.id,message:'Where were we?'})
    assert.notEqual(next.threadId,threadId,'a fresh thread, on today\'s board')
    const t=manager.sessions.get(next.threadId)
    assert.equal(t.parentDayId,s.id)
    await until(()=>t.status==='idle')
    assert.match(calls.at(-1).prompt,/carried over from 2026-01-01[\s\S]*Agreed to drop comment 4/)
  } finally { await manager.close() }
})

test('a subagent named for an item is tied to it, and the Day\'s own focus lasts only the run',async()=>{
  let item,focusSeen
  const {directory,manager}=setup(async()=>{})
  manager.queryFactory=async({options})=>({close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:'main',model:'claude-sonnet'}
    if (item) {
      yield {type:'assistant',message:{content:[
        {type:'tool_use',id:'sub-a',name:'Agent',input:{subagent_type:'general-purpose',description:'Attio sync',prompt:`Fleet item: ${item.id}\nFind out why the summary does not sync.`}},
        {type:'tool_use',id:'sub-b',name:'Agent',input:{subagent_type:'general-purpose',description:'Unknown',prompt:'Fleet item: 00000000-not-an-item\nx'}},
      ]}}
      const s=[...manager.sessions.values()].find(x=>x.kind==='day')
      day.act(s,{action:'focus',itemId:item.id})
      focusSeen=structuredClone(s.dayBoard.focus)
      yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'sub-a',content:'Webhook missing'},{type:'tool_result',tool_use_id:'sub-b',content:'x'}]}}
    }
    yield {type:'result',result:'Done',is_error:false}
  }})
  try{
    const s=startDay(manager,directory)
    await until(()=>s.status==='idle')
    item=day.act(s,{action:'add',title:'Investigate Attio sync',source:'granola'},'operator').item
    manager.send(s.id,{message:'go',requestId:randomUUID()})
    await until(()=>s.status==='idle' && s.subagents?.length===2)
    assert.equal(s.subagents[0].itemId,item.id)
    assert.equal(s.subagents[1].itemId,null,'an id that is not on the board links nothing')
    assert.equal(focusSeen.itemId,item.id)
    assert.equal(item.status,'in_progress','starting work on an item moves it along')
    assert.equal(s.dayBoard.focus,null,'focus ends with the run')
    assert.throws(()=>day.act(s,{action:'focus',itemId:'nope'}),/Item not found/)
  } finally { await manager.close() }
})
