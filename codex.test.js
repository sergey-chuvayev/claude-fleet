'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')

const at=n=>new Date(Date.UTC(2026,9,4,9,0,n)).toISOString()
const line=(type,payload,n=0)=>JSON.stringify({timestamp:at(n),type,payload})
// A Codex home with sessions the way Codex writes them.
function codexHome() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-home-'))
  const day=path.join(home,'sessions','2026','10','04');fs.mkdirSync(day,{recursive:true})
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-project-'))
  const write=(id,records,{mtime=Date.now()}={})=>{const f=path.join(day,`rollout-2026-10-04T09-00-00-${id}.jsonl`);fs.writeFileSync(f,records.join('\n')+'\n');fs.utimesSync(f,new Date(mtime),new Date(mtime));return f}
  const mine='01a10747-aaaa-7f91-9dd9-fc4bb25df075',review='01a10747-bbbb-7f91-9dd9-fc4bb25df075',working='01a10747-cccc-7f91-9dd9-fc4bb25df075'
  write(mine,[
    line('session_meta',{id:mine,cwd:project,timestamp:at(0),originator:'codex-tui',source:'cli',cli_version:'0.160.0'}),
    line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions\n...'},{type:'input_text',text:'<environment_context>x</environment_context>'}]},1),
    line('event_msg',{type:'task_started',model_context_window:258400},2),
    line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'<image name=[Image #1]>'},{type:'input_image'},{type:'input_text',text:'</image>'},{type:'input_text',text:'Why does checkout fail?'}]},3),
    line('response_item',{type:'function_call',call_id:'c1',name:'shell',arguments:JSON.stringify({command:['bash','-lc','npm test']})},4),
    line('response_item',{type:'function_call_output',call_id:'c1',output:'1 failing'},6),
    line('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'The discount is applied twice.'}]},7),
    line('event_msg',{type:'task_complete',last_agent_message:'The discount is applied twice.'},8),
  ],{mtime:Date.now()-3600000})
  write(review,[line('session_meta',{id:review,cwd:project,originator:'codex-tui',source:{subagent:{other:'guardian'}},thread_source:'guardian_review'}),line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'The following is the Codex agent history'}]},1)])
  write(working,[line('session_meta',{id:working,cwd:project,originator:'codex_exec',source:'exec'}),line('event_msg',{type:'task_started'},1),line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'Refactor the cart'}]},2)])
  fs.writeFileSync(path.join(home,'session_index.jsonl'),JSON.stringify({id:mine,thread_name:'Checkout failure'})+'\n')
  return {home,project,mine,review,working}
}

test('Codex sessions are read into rows and console entries, without Codex\'s own internal ones',()=>{
  const h=codexHome(),previous=process.env.CODEX_HOME
  process.env.CODEX_HOME=h.home
  try {
    delete require.cache[require.resolve('./codex')]
    const codex=require('./codex')
    const rows=codex.sessions()
    assert.deepEqual(rows.map(r=>r.sessionId).sort(),[h.mine,h.working].sort(),'an auto-review sub-agent session is not the operator\'s')
    const mine=rows.find(r=>r.sessionId===h.mine)
    assert.equal(mine.engine,'codex')
    assert.equal(mine.title,'Checkout failure','the name Codex gave the thread')
    assert.equal(mine.state,'dead')
    assert.equal(mine.latestResponse,'The discount is applied twice.')
    assert.equal(mine.contextLimit,258400)
    assert.equal(mine.resumeCmd,`codex resume ${h.mine}`)
    const busy=rows.find(r=>r.sessionId===h.working)
    assert.deepEqual([busy.state,busy.alive],['busy',true],'an open turn written a moment ago is working')
    const {messages}=codex.history(mine.transcript)
    assert.deepEqual(messages.map(m=>m.role==='tool' ? `tool:${m.tool}:${m.status}` : `${m.role}:${m.text}`),['user:Why does checkout fail?\n\n[1 image]','tool:Bash:done','assistant:The discount is applied twice.'],'injected context is dropped, a message that starts with an image is kept')
    assert.equal(messages[1].input.command,'npm test','the shell around the command is not part of it')
  } finally { process.env.CODEX_HOME=previous; delete require.cache[require.resolve('./codex')] }
})

test('Fleet\'s approval setting picks Codex\'s sandbox, and Codex events become Fleet\'s',()=>{
  const codex=require('./codex')
  assert.deepEqual(codex.sandboxArgs('ask'),['-s','read-only'])
  assert.deepEqual(codex.sandboxArgs('auto'),['-s','workspace-write'])
  assert.deepEqual(codex.sandboxArgs('all'),['-s','workspace-write','-c','sandbox_workspace_write.network_access=true'])
  assert.equal(codex.unwrapShell(`/bin/zsh -lc 'cat note.txt'`),'cat note.txt')
  assert.equal(codex.unwrapShell(`/bin/zsh -lc "printf 'A' > done.txt"`),"printf 'A' > done.txt")
  const state={model:'gpt-x',started:new Set(),result:false}
  const out=[
    {type:'thread.started',thread_id:'t-1'},
    {type:'item.started',item:{id:'i1',type:'command_execution',command:`/bin/zsh -lc 'npm test'`,status:'in_progress'}},
    {type:'item.completed',item:{id:'i1',type:'command_execution',command:`/bin/zsh -lc 'npm test'`,aggregated_output:'ok',exit_code:0,status:'completed'}},
    {type:'item.completed',item:{id:'i2',type:'file_change',changes:[{path:'src/a.js',kind:'update'}],status:'completed'}},
    {type:'item.completed',item:{id:'i3',type:'agent_message',text:'Done.'}},
    {type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2}},
  ].flatMap(e=>codex.translate(e,state))
  assert.deepEqual(out.map(e=>e.type+(e.message?.content?.[0]?.type ? ':'+e.message.content[0].type : '')),['system','assistant:tool_use','user:tool_result','assistant:tool_use','user:tool_result','assistant:text','result'])
  assert.equal(out[0].session_id,'t-1')
  assert.equal(out[1].message.content[0].input.command,'npm test')
  assert.equal(out[3].message.content[0].name,'Edit')
  assert.equal(out.at(-1).modelUsage['gpt-x'].inputTokens,10)
})

test('a Codex agent runs through Fleet\'s turn loop, and its next message resumes the same thread',async()=>{
  const {ManagedSessions}=require('./managed')
  const codex=require('./codex')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-managed-')),project=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-cwd-'))
  const calls=[]
  // A Codex stand-in: the real translation, canned events.
  const fake={available:()=>true,sessions:()=>[],history:()=>({messages:[]}),query(args){
    calls.push(args)
    const state={model:'gpt-x',started:new Set(),result:false},events=[{type:'thread.started',thread_id:'thread-9'},{type:'item.completed',item:{id:'x'+calls.length,type:'command_execution',command:`/bin/zsh -lc 'ls'`,aggregated_output:'a.js',exit_code:0,status:'completed'}},{type:'item.completed',item:{id:'m'+calls.length,type:'agent_message',text:`Reply ${calls.length}`}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].flatMap(e=>codex.translate(e,state))
    return {close(){},async *[Symbol.asyncIterator](){yield* events}}
  }}
  const manager=new ManagedSessions({directory,codex:fake,queryFactory:async()=>{throw new Error('Claude must not be asked')}})
  const until=async f=>{for(let i=0;i<100 && !f();i++)await new Promise(r=>setTimeout(r,20))}
  try {
    const s=manager.create({engine:'codex',cwd:project,prompt:'List the files',approvalMode:'auto',requestId:randomUUID()})
    await until(()=>s.status==='idle')
    assert.equal(s.engine,'codex')
    assert.equal(s.sessionId,'thread-9','Codex\'s thread id is the conversation\'s id')
    assert.deepEqual(s.messages.map(m=>m.role==='tool' ? `tool:${m.tool}:${m.target}` : `${m.role}:${m.text}`),['user:List the files','tool:Bash:ls','assistant:Reply 1'])
    assert.equal(calls[0].threadId,null);assert.equal(calls[0].approvalMode,'auto')
    manager.send(s.id,{message:'And the tests?',requestId:randomUUID()})
    await until(()=>s.status==='idle' && calls.length===2)
    assert.equal(calls[1].threadId,'thread-9','a follow-up resumes the same Codex thread')
    assert.equal(manager.summaries().find(x=>x.managedId===s.id).resumeCmd,'codex resume thread-9')
    assert.throws(()=>manager.create({engine:'codex',teamId:'quick',cwd:project,prompt:'x',requestId:randomUUID()}),/Teams run on Claude/)
  } finally { await manager.close(); fs.rmSync(directory,{recursive:true,force:true}) }
})

test('the Codex process gets the prompt on stdin, the sandbox and the thread, and Stop ends it',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-bin-'))
  const bin=path.join(dir,'codex'),log=path.join(dir,'args.json')
  // A stand-in for the codex binary: records its arguments and stdin, prints events.
  fs.writeFileSync(bin,`#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
  require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),input}))
  if(input.includes('hang')){setTimeout(()=>{},60000);return}
  for(const e of [{type:'thread.started',thread_id:'t-7'},{type:'item.completed',item:{id:'m',type:'agent_message',text:'hi'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}])console.log(JSON.stringify(e))
})`);fs.chmodSync(bin,0o755)
  const previous=process.env.CLAUDE_FLEET_CODEX
  process.env.CLAUDE_FLEET_CODEX=bin
  try {
    const codex=require('./codex')
    const drain=async q=>{const out=[];for await (const e of q)out.push(e);return out}
    const events=await drain(codex.query({prompt:'--weird prompt that starts with dashes',cwd:dir,threadId:'t-7',approvalMode:'ask'}))
    const seen=JSON.parse(fs.readFileSync(log,'utf8'))
    assert.equal(seen.input,'--weird prompt that starts with dashes','the prompt travels on stdin, never as an argument')
    assert.deepEqual(seen.args.slice(-3),['resume','t-7','-'])
    assert.ok(seen.args.join(' ').includes('-s read-only') && seen.args.includes('--json') && seen.args.includes('approval_policy="never"'))
    assert.deepEqual(events.map(e=>e.type),['system','assistant','result'])
    const controller=new AbortController()
    const q=codex.query({prompt:'hang',cwd:dir,signal:controller.signal})
    const done=drain(q)
    await new Promise(r=>setTimeout(r,300))
    controller.abort()
    const stopped=await Promise.race([done,new Promise(r=>setTimeout(()=>r('still running'),3000))])
    assert.notEqual(stopped,'still running','Stop ends the Codex process')
  } finally { process.env.CLAUDE_FLEET_CODEX=previous ?? ''; if(previous===undefined)delete process.env.CLAUDE_FLEET_CODEX; fs.rmSync(dir,{recursive:true,force:true}) }
})
