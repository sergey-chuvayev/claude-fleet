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
    assert.ok(options.maxBudgetUsd>0 && options.maxBudgetUsd<=15)
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
    assert.throws(()=>manager.dayAction(s.id,{op:'triage',itemId:item.id,status:'done'}),/Triage/)
    assert.equal(s.dayBoard.items[0].status,'today')
    assert.throws(()=>manager.dayAction(s.id,{op:'nope'}),/Unknown Day action/)
    const agent=manager.create({cwd:directory,prompt:'hi',requestId:randomUUID()})
    assert.throws(()=>manager.dayAction(agent.id,{op:'sweep'}),/not a Day/)
  } finally { await manager.close() }
})
