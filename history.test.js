'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {history,userText}=require('./history')
const {ManagedSessions}=require('./managed')

const at=n=>new Date(Date.UTC(2026,9,3,9,0,n)).toISOString()
// A transcript the way Claude Code writes one: one record per content block, tool
// results as user records, slash commands and reminders wrapped in tags.
function transcript(dir,records){const file=path.join(dir,'session.jsonl');fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');return file}
const RECORDS=[
  {type:'summary',summary:'ignored'},
  {type:'user',uuid:'u1',timestamp:at(0),message:{role:'user',content:'Fix the login redirect<system-reminder>internal</system-reminder>'}},
  {type:'assistant',uuid:'a1',timestamp:at(1),message:{id:'m1',content:[{type:'text',text:'Looking at the router.'}]}},
  {type:'assistant',uuid:'a2',timestamp:at(1),message:{id:'m1',content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'/repo/src/router.ts'}}]}},
  {type:'user',uuid:'u2',timestamp:at(3),message:{content:[{type:'tool_result',tool_use_id:'t1',content:'export const routes = []'}]}},
  {type:'assistant',uuid:'a3',timestamp:at(4),message:{id:'m2',content:[{type:'tool_use',id:'t2',name:'Bash',input:{command:'npm test'}}]}},
  {type:'user',uuid:'u3',timestamp:at(9),message:{content:[{type:'tool_result',tool_use_id:'t2',content:'1 failing',is_error:true}]}},
  {type:'assistant',uuid:'a4',timestamp:at(10),isSidechain:true,message:{id:'m3',content:[{type:'text',text:'a subagent talking'}]}},
  {type:'user',uuid:'u4',timestamp:at(11),message:{content:'<command-name>/model</command-name><command-args>opus</command-args>'}},
  {type:'user',uuid:'u5',timestamp:at(11),isMeta:true,message:{content:'Caveat: meta'}},
  {type:'user',uuid:'u6',timestamp:at(12),message:{content:'<local-command-stdout>Set model to opus</local-command-stdout>'}},
  {type:'assistant',uuid:'a5',timestamp:at(13),message:{id:'m4',content:[{type:'tool_use',id:'t3',name:'Edit',input:{file_path:'/repo/src/router.ts',old_string:'a',new_string:'b'}}]}},
]

test('a transcript reads back as the entries the console draws',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-history-'))
  try {
    const {messages,truncated}=history(transcript(dir,RECORDS))
    assert.equal(truncated,false)
    assert.deepEqual(messages.map(m=>m.role==='tool' ? `tool:${m.tool}:${m.status}` : `${m.role}:${m.text}`),[
      'user:Fix the login redirect',
      'assistant:Looking at the router.',
      'tool:Read:done',
      'tool:Bash:error',
      'user:/model opus',
      'tool:Edit:interrupted',
    ],'reminders, meta records, command output and subagent chatter stay out; a stopped session\'s unfinished call is interrupted')
    const read=messages.find(m=>m.tool==='Read')
    assert.match(read.target,/router\.ts/,'a tool call says what it touched')
    assert.equal(read.result,'export const routes = []')
    assert.equal(read.ms,2000)
    assert.equal(messages.find(m=>m.tool==='Bash').result,'1 failing','a failure keeps its output')
    const alive=history(transcript(dir,RECORDS),{alive:true}).messages
    assert.equal(alive.at(-1).status,'running','a session still open in its terminal may be mid-call')
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('typed words are kept, and the tags Claude Code wraps around them are not',()=>{
  assert.equal(userText('hello <system-reminder>x</system-reminder> there'),'hello  there')
  assert.equal(userText('<command-name>/clear</command-name>'),'/clear')
  assert.equal(userText('<local-command-stdout>ok</local-command-stdout>'),'')
})

function manager({alive,cwd,file,calls}) {
  const sessionId=randomUUID()
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-adopt-'))
  const m=new ManagedSessions({directory,externalSessions:()=>[{sessionId,cwd,alive}],findTranscript:id=>id===sessionId ? file : null,queryFactory:async args=>{calls.push(args.options);return {close(){},async *[Symbol.asyncIterator](){
    yield {type:'system',subtype:'init',session_id:alive ? 'forked-id' : sessionId,model:'claude-sonnet'}
    yield {type:'result',result:'Continuing.',is_error:false}
  }}}})
  return {m,sessionId,directory}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,50))

test('a stopped terminal session is taken over with its conversation, as itself',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-adopt-src-')),calls=[]
  const {m,sessionId,directory}=manager({alive:false,cwd:dir,file:transcript(dir,RECORDS),calls})
  try {
    const s=m.create({cwd:dir,prompt:'Now make it pass',requestId:randomUUID(),resumeSessionId:sessionId})
    await settle()
    assert.equal(calls[0].resume,sessionId)
    assert.equal(calls[0].forkSession,undefined)
    assert.deepEqual(s.messages.slice(0,2).map(m=>m.text),['Fix the login redirect','Looking at the router.'],'the console starts with what was said in the terminal')
    assert.ok(s.messages.some(m=>m.role==='user' && m.text==='Now make it pass'))
    assert.equal(s.sessionId,sessionId)
  } finally { await m.close(); fs.rmSync(directory,{recursive:true,force:true}); fs.rmSync(dir,{recursive:true,force:true}) }
})

test('a session still open in its terminal is continued as a fork, never driven twice',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-fork-src-')),calls=[]
  const {m,sessionId,directory}=manager({alive:true,cwd:dir,file:transcript(dir,RECORDS),calls})
  try {
    assert.throws(()=>m.create({cwd:dir,prompt:'x',requestId:randomUUID(),resumeSessionId:sessionId}),/still open in its terminal/)
    const s=m.create({cwd:dir,prompt:'Try another approach',requestId:randomUUID(),resumeSessionId:sessionId,fork:true})
    await settle()
    assert.equal(calls[0].resume,sessionId)
    assert.equal(calls[0].forkSession,true,'the first turn forks the terminal\'s conversation')
    assert.equal(s.sessionId,'forked-id','from then on the copy is its own session')
    assert.equal(s.forkPending,undefined)
    assert.equal(s.forkedFrom,sessionId)
    assert.ok(s.messages.length>2,'the copy starts with the conversation so far')
  } finally { await m.close(); fs.rmSync(directory,{recursive:true,force:true}); fs.rmSync(dir,{recursive:true,force:true}) }
})
