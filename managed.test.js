'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {ManagedSessions}=require('./managed')
const {createApp}=require('./server')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await delay(5)}throw Error('Condition timed out')}
function setup(queryFactory,externalSessions){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-managed-'));return {directory,manager:new ManagedSessions({directory,queryFactory,externalSessions})}}
// These tests exercise the approval path, so they opt out of the default auto mode.
const create=(manager,cwd,extra={})=>manager.create({cwd,prompt:'Test task',requestId:randomUUID(),approvalMode:'ask',...extra})
// assert.throws does not hand back the error, and the lock conflict is interesting for
// what it carries, not only for its message.
function refused(directory){try{new ManagedSessions({directory})}catch(error){return error}throw Error('Expected the lock to be refused')}

// Mock the SDK transport, exercise the real manager and HTTP implementation.
test('streams a turn, approves exactly once, resumes follow-ups and persists across restart',async()=>{
  const calls=[],decisions=[]
  const sessionId=randomUUID()
  const {directory,manager}=setup(async args=>{
    calls.push(args)
    return {close(){},async *[Symbol.asyncIterator](){
      yield {type:'system',subtype:'init',session_id:sessionId,model:'claude-sonnet'}
      yield {type:'stream_event',event:{type:'message_start'}}
      yield {type:'stream_event',event:{delta:{type:'text_delta',text:'Hello'}}}
      const decision=await args.options.canUseTool('Bash',{command:'npm test'},{signal:args.options.abortController.signal})
      decisions.push(decision)
      yield {type:'assistant',message:{content:[{type:'text',text:'Hello'}],usage:{input_tokens:30}}}
      yield {type:'result',result:'Hello',is_error:false,total_cost_usd:0.01}
    }}
  })
  try{
    const rid=randomUUID(),s=create(manager,directory,{requestId:rid})
    assert.equal(create(manager,directory,{requestId:rid}).id,s.id)
    await until(()=>s.approvals.length===1)
    assert.equal(s.status,'approval')
    assert.equal(s.messages[1].text,'Hello')
    assert.throws(()=>manager.send(s.id,{message:'Overlap',requestId:randomUUID()}),/still working/)
    const approval=s.approvals[0].id
    manager.decide(s.id,approval,{decision:'allow'})
    assert.throws(()=>manager.decide(s.id,approval,{decision:'allow'}),/no longer pending/)
    await until(()=>s.status==='idle')
    assert.equal(s.messages.filter(m=>m.role==='assistant').length,1)
    assert.deepEqual(decisions[0],{behavior:'allow',updatedInput:{command:'npm test'}})
    const next=randomUUID()
    manager.send(s.id,{message:'Continue',requestId:next})
    manager.send(s.id,{message:'Continue',requestId:next})
    await until(()=>s.approvals.length===1)
    manager.decide(s.id,s.approvals[0].id,{decision:'deny',reason:'Do not run tests'})
    await until(()=>s.status==='idle')
    assert.equal(calls.length,2)
    assert.equal(calls[1].options.resume,sessionId)
    assert.equal(calls[0].options.permissionMode,'default')
    assert.equal(decisions[1].behavior,'deny')
    await manager.close()
    const reopened=new ManagedSessions({directory})
    assert.equal(reopened.detail(s.id).messages.length,4)
    assert.equal(reopened.detail(s.id).sessionId,sessionId)
    await reopened.close()
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('answers questions, cancels pending approvals on stop, and rejects active terminal adoption',async()=>{
  let result
  const terminal={sessionId:randomUUID(),alive:true}
  const {directory,manager}=setup(async args=>({close(){},async *[Symbol.asyncIterator](){
    result=await args.options.canUseTool('AskUserQuestion',{questions:[{question:'Which database?',options:[{label:'SQLite'}]}]},{signal:args.options.abortController.signal})
    if(!args.options.abortController.signal.aborted)yield{type:'result',result:'Answered',is_error:false}
  }}),()=>[terminal])
  terminal.cwd=directory
  try{
    assert.throws(()=>create(manager,directory,{resumeSessionId:terminal.sessionId}),/Only a stopped/)
    const s=create(manager,directory)
    await until(()=>s.approvals.length)
    assert.throws(()=>manager.decide(s.id,s.approvals[0].id,{decision:'allow',answers:{}}),/Answer/)
    manager.decide(s.id,s.approvals[0].id,{decision:'allow',answers:{'Which database?':'SQLite'}})
    await until(()=>s.status==='idle')
    assert.equal(result.updatedInput.answers['Which database?'],'SQLite')
    manager.send(s.id,{message:'Next',requestId:randomUUID()})
    await until(()=>s.approvals.length)
    manager.stop(s.id)
    await until(()=>s.status==='stopped')
    assert.equal(s.approvals.length,0)
    assert.equal(result.behavior,'deny')
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('invalid projects and SDK failures are actionable; only one server owns the store',async()=>{
  const {directory,manager}=setup(async()=>{throw Error('Claude authentication required')})
  try{
    assert.throws(()=>new ManagedSessions({directory}),/already running/)
    assert.throws(()=>create(manager,'/missing/fleet-project'),/does not exist/)
    const s=create(manager,directory)
    await until(()=>s.status==='error')
    assert.match(s.error,/authentication/)
    assert.equal(manager.runs.size,0)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('HTTP controls enforce same-origin, CSRF token, content type, and session ownership',async()=>{
  const {directory,manager}=setup(async()=>({close(){},async *[Symbol.asyncIterator](){yield{type:'result',is_error:false,result:'Done'}}}))
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()})})
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const base=`http://127.0.0.1:${app.server.address().port}`
    const config=await (await fetch(base+'/api/control')).json()
    const body=JSON.stringify({cwd:directory,prompt:'Hello',requestId:randomUUID()})
    const post=(headers={})=>fetch(base+'/api/managed',{method:'POST',headers,body})
    assert.equal((await post({'content-type':'application/json'})).status,403)
    assert.equal((await post({'content-type':'application/json','x-fleet-token':config.token,origin:'https://evil.example'})).status,403)
    assert.equal((await post({'x-fleet-token':config.token})).status,415)
    const badHost = await new Promise((resolve,reject)=>{const req=require('node:http').get(base+'/api/control',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject)})
    assert.equal(badHost,403)
    const response=await post({'content-type':'application/json','x-fleet-token':config.token,origin:base})
    assert.equal(response.status,201)
    const {session}=await response.json()
    assert.equal((await fetch(base+`/api/managed/${session.id}`)).status,200)
    assert.equal((await fetch(base+'/api/managed/not-yours/stop',{method:'POST',headers:{'content-type':'application/json','x-fleet-token':config.token},body:'{}'})).status,404)
    assert.equal((await (await fetch(base+'/api/sessions')).json()).sessions[0].managed,true)
    assert.equal((await fetch(base+'/../managed.js')).status,404)
  }finally{await app.close();app.server.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true})}
})

test('stop during SDK startup cannot leave a live query or pending turn',async()=>{
  let release,closed=0
  const {directory,manager}=setup(()=>new Promise(resolve=>{release=()=>resolve({close(){closed++},async *[Symbol.asyncIterator](){throw Error('Stopped query must not run')}})}))
  try{
    const s=create(manager,directory)
    manager.stop(s.id)
    assert.equal(s.status,'stopping')
    release()
    await until(()=>s.status==='stopped')
    assert.equal(manager.runs.size,0)
    assert.ok(closed>=1)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('concurrency limit prevents a fifth agent and restart marks unfinished work stopped',async()=>{
  const {directory,manager}=setup(async args=>({close(){},async *[Symbol.asyncIterator](){await args.options.canUseTool('Write',{file_path:'test.txt'},{signal:args.options.abortController.signal})}}))
  try{
    const sessions=Array.from({length:4},()=>create(manager,directory))
    assert.throws(()=>create(manager,directory),/Four agents/)
    await until(()=>sessions.every(s=>s.approvals.length===1))
    const persisted=JSON.parse(fs.readFileSync(path.join(directory,'sessions.json'),'utf8'))
    assert.equal(persisted.sessions.length,4)
    await manager.close()
    // Simulate a process exiting abruptly after the last checkpoint.
    fs.writeFileSync(path.join(directory,'sessions.json'),JSON.stringify(persisted))
    const reopened=new ManagedSessions({directory})
    assert.ok([...reopened.sessions.values()].every(s=>s.status==='stopped' && s.approvals.length===0))
    await reopened.close()
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('tool calls become their own conversation blocks, with target, timing, result and failure state', async () => {
  const bigResult = 'x'.repeat(9000)
  const { directory, manager } = setup(async () => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield { type:'system', subtype:'init', session_id:randomUUID(), model:'claude-opus-5' }
    yield { type:'assistant', message:{ content:[
      { type:'text', text:'Running the suite.' },
      { type:'tool_use', id:'tool-1', name:'Bash', input:{ command:'./gradlew test\n--info', timeout:600000 } },
    ], usage:{ input_tokens:20 } } }
    await delay(12)
    yield { type:'user', message:{ content:[{ type:'tool_result', tool_use_id:'tool-1', content:[{ type:'text', text:bigResult }] }] } }
    yield { type:'assistant', message:{ content:[
      { type:'tool_use', id:'tool-2', name:'Edit', input:{ file_path:'/repo/src/main/kotlin/Ring.kt', old_string:'a', new_string:'b' } },
    ] } }
    yield { type:'user', message:{ content:[{ type:'tool_result', tool_use_id:'tool-2', content:'File not found', is_error:true }] } }
    // A nested sub-agent turn must not leak its tools into the parent conversation.
    yield { type:'assistant', parent_tool_use_id:'tool-2', message:{ content:[{ type:'tool_use', id:'tool-3', name:'Read', input:{ file_path:'/repo/x' } }] } }
    yield { type:'result', result:'Done', is_error:false }
  } }))
  try {
    const s = create(manager, directory)
    await until(() => s.status === 'idle')
    const tools = s.messages.filter(m => m.role === 'tool')
    assert.equal(tools.length, 2)
    const [bash, edit] = tools

    assert.equal(bash.tool, 'Bash')
    assert.equal(bash.target, './gradlew test')
    assert.equal(bash.status, 'done')
    assert.equal(bash.input.command, './gradlew test\n--info')
    assert.equal(bash.input.timeout, 600000)
    assert.ok(bash.ms >= 0 && bash.ms < 5000)
    assert.equal(bash.truncated, true)
    assert.equal(bash.result.length, 6000)

    assert.equal(edit.tool, 'Edit')
    assert.equal(edit.target, 'kotlin/Ring.kt')
    assert.equal(edit.status, 'error')
    assert.equal(edit.result, 'File not found')

    // The block sits after the text it followed, and tool blocks are not counted as messages.
    const roles = s.messages.map(m => m.role)
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'assistant'])
    assert.equal(manager.summaries()[0].messages, 3)
    assert.equal(manager.summaries()[0].latestResponse, 'Done')
  } finally { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a tool block whose result never arrives is marked interrupted, on stop and on restart', async () => {
  const { directory, manager } = setup(async args => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield { type:'assistant', message:{ content:[{ type:'tool_use', id:'tool-9', name:'Bash', input:{ command:'sleep 600' } }] } }
    await new Promise(resolve => args.options.abortController.signal.addEventListener('abort', resolve, { once:true }))
  } }))
  try {
    const s = create(manager, directory)
    await until(() => s.messages.some(m => m.role === 'tool'))
    assert.equal(s.messages.find(m => m.role === 'tool').status, 'running')
    manager.stop(s.id)
    await until(() => s.status === 'stopped')
    assert.equal(s.messages.find(m => m.role === 'tool').status, 'interrupted')

    // A crash between checkpoints leaves a running block on disk; reopening must settle it.
    const store = path.join(directory, 'sessions.json')
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'))
    saved.sessions[0].messages.find(m => m.role === 'tool').status = 'running'
    await manager.close()
    fs.writeFileSync(store, JSON.stringify(saved))
    const reopened = new ManagedSessions({ directory })
    assert.equal(reopened.detail(s.id).messages.find(m => m.role === 'tool').status, 'interrupted')
    await reopened.close()
  } finally { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('the console assets and the generated Warp stylesheet are served, and nothing else is', async () => {
  const { directory, manager } = setup(async () => ({ close() {}, async *[Symbol.asyncIterator]() { yield { type:'result', is_error:false, result:'Done' } } }))
  const app = createApp({ manager, collectSessions: () => ({ sessions:[], counts:{}, total:0, generatedAt:Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const css = await fetch(base + '/theme.css')
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /text\/css/)
    assert.match(await css.text(), /--w-bg: #[0-9a-fA-F]{3,8};/)
    for (const asset of ['/blocks.js', '/vendor/libs.js']) {
      const response = await fetch(base + asset)
      assert.equal(response.status, 200, asset)
      assert.match(response.headers.get('content-type'), /javascript/)
    }
    assert.equal((await fetch(base + '/vendor/../managed.js')).status, 404)
    assert.equal((await fetch(base + '/vendor/libs.js.map')).status, 404)
    assert.match((await (await fetch(base + '/api/control')).json()).theme.name, /\w/)
  } finally { await app.close(); app.server.closeAllConnections(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('auto mode answers safe tools itself, still stops for the denylist, and is switchable', async () => {
  const seen = []
  const { directory, manager } = setup(async args => ({ close() {}, async *[Symbol.asyncIterator]() {
    const ask = async (tool, input) => { seen.push([tool, await args.options.canUseTool(tool, input, { signal: args.options.abortController.signal })]) }
    yield { type:'assistant', message:{ content:[{ type:'tool_use', id:'ok-1', name:'Bash', input:{ command:'./gradlew test' } }] } }
    await ask('Bash', { command:'./gradlew test' })
    await ask('Write', { file_path:'/repo/a.kt', content:'x' })
    yield { type:'assistant', message:{ content:[{ type:'tool_use', id:'bad-1', name:'Bash', input:{ command:'cd build && rm -rf .' } }] } }
    await ask('Bash', { command:'cd build && rm -rf .' })
    yield { type:'result', result:'Done', is_error:false }
  } }))
  try {
    // The default mode is auto, so the helper's explicit 'ask' is overridden here.
    const s = manager.create({ cwd:directory, prompt:'Test task', requestId:randomUUID() })
    assert.equal(s.approvalMode, 'auto')
    await until(() => s.approvals.length === 1)
    // Two safe requests were answered without ever reaching the operator.
    assert.deepEqual(seen.map(([tool]) => tool), ['Bash', 'Write'])
    assert.ok(seen.every(([, decision]) => decision.behavior === 'allow'))
    assert.match(s.approvals[0].reason, /rm/)
    const blocks = s.messages.filter(m => m.role === 'tool')
    assert.equal(blocks[0].approval, 'auto')
    assert.equal(blocks[1].approval, 'asked')
    manager.decide(s.id, s.approvals[0].id, { decision:'deny' })
    await until(() => s.status === 'idle')

    manager.setMode(s.id, { mode:'ask' })
    assert.equal(manager.detail(s.id).approvalMode, 'ask')
    assert.throws(() => manager.setMode(s.id, { mode:'whatever' }), /ask, auto, or all/)
  } finally { await manager.close(); fs.rmSync(directory, { recursive:true, force:true }) }
})

test('closing an agent stops its run, frees capacity and survives a restart', async () => {
  let aborted = 0
  const { directory, manager } = setup(async args => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield { type:'system', subtype:'init', session_id:'sess-'+randomUUID(), model:'claude-opus-5' }
    await new Promise(resolve => args.options.abortController.signal.addEventListener('abort', () => { aborted++; resolve() }, { once:true }))
  } }))
  try {
    const running = create(manager, directory)
    // Wait for the turn to actually be underway, not merely queued.
    await until(() => running.sessionId)
    const second = create(manager, directory)
    await until(() => second.sessionId)
    assert.equal(manager.sessions.size, 2)

    // Closing a working agent cancels its run rather than leaving it orphaned.
    const closed = await manager.remove(running.id)
    assert.equal(aborted, 1)
    // Only the closed agent's run ends; the other one carries on untouched.
    assert.equal(manager.runs.has(running.id), false)
    assert.equal(manager.runs.has(second.id), true)
    assert.equal(manager.sessions.size, 1)
    // The Claude session id is handed back so the conversation stays resumable.
    assert.match(closed.sessionId, /^sess-/)
    assert.throws(() => manager.detail(running.id), /not found/)

    await manager.remove(second.id)
    assert.equal(aborted, 2)
    assert.equal(manager.runs.size, 0)
    assert.equal(manager.sessions.size, 0)
    // remove() is async, so a missing session rejects rather than throwing.
    await assert.rejects(() => manager.remove(running.id), /not found/)

    await manager.close()
    const reopened = new ManagedSessions({ directory })
    assert.equal(reopened.sessions.size, 0)
    await reopened.close()
  } finally { await manager.close(); fs.rmSync(directory, { recursive:true, force:true }) }
})

test('the close route removes the session over HTTP and requires the token', async () => {
  const { directory, manager } = setup(async () => ({ close() {}, async *[Symbol.asyncIterator]() { yield { type:'result', is_error:false, result:'Done' } } }))
  const app = createApp({ manager, collectSessions: () => ({ sessions:[], counts:{}, total:0, generatedAt:Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const { token } = await (await fetch(base + '/api/control')).json()
    const headers = { 'content-type':'application/json', 'x-fleet-token':token }
    const { session } = await (await fetch(base + '/api/managed', { method:'POST', headers, body:JSON.stringify({ cwd:directory, prompt:'Hello', requestId:randomUUID() }) })).json()
    assert.equal((await fetch(base + `/api/managed/${session.id}/close`, { method:'POST', headers:{ 'content-type':'application/json' }, body:'{}' })).status, 403)
    const response = await fetch(base + `/api/managed/${session.id}/close`, { method:'POST', headers, body:'{}' })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).closed.id, session.id)
    assert.equal((await fetch(base + `/api/managed/${session.id}`)).status, 404)
  } finally { await app.close(); app.server.closeAllConnections(); fs.rmSync(directory, { recursive:true, force:true }) }
})

test('a chosen model is passed to the SDK, changed per turn, and validated', async () => {
  const calls = []
  const { directory, manager } = setup(async args => {
    calls.push(args.options.model)
    return { close() {}, async *[Symbol.asyncIterator]() { yield { type:'result', is_error:false, result:'Done' } } }
  })
  try {
    const s = manager.create({ cwd:directory, prompt:'Hello', requestId:randomUUID(), model:'haiku' })
    await until(() => s.status === 'idle')
    assert.equal(calls[0], 'haiku')
    assert.equal(manager.summaries()[0].selectedModel, 'haiku')

    // Switching applies to the next turn, since each message starts a fresh query.
    manager.setModelChoice(s.id, { model:'opus' })
    manager.send(s.id, { message:'Again', requestId:randomUUID() })
    await until(() => calls.length === 2)
    assert.equal(calls[1], 'opus')

    // An empty choice hands the decision back to the project rather than forcing one.
    manager.setModelChoice(s.id, { model:'' })
    await until(() => s.status === 'idle')
    manager.send(s.id, { message:'Third', requestId:randomUUID() })
    await until(() => calls.length === 3)
    assert.equal(calls[2], undefined)

    assert.throws(() => manager.setModelChoice(s.id, { model:'not a model!' }), /not valid/)
    assert.throws(() => manager.create({ cwd:directory, prompt:'x', requestId:randomUUID(), model:'a b c' }), /not valid/)
  } finally { await manager.close(); fs.rmSync(directory, { recursive:true, force:true }) }
})

// A real 1x1 PNG, so the magic-byte sniff and the API media type both hold.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('pasted images are sniffed, stored owner-only, sent as content blocks, and removed with the session', async () => {
  let receivedPrompt = null
  const { directory, manager } = setup(async args => {
    receivedPrompt = args.prompt
    return { close() {}, async *[Symbol.asyncIterator]() {
      // Consume the streaming-input prompt the way the SDK would.
      if (typeof args.prompt !== 'string') for await (const m of args.prompt) receivedPrompt = m
      yield { type:'result', is_error:false, result:'I see a 1x1 image.' }
    } }
  })
  try {
    const s = manager.create({ cwd:directory, prompt:'What is this?', requestId:randomUUID(), images:[{ mediaType:'image/png', data:PNG_1x1.toString('base64') }] })
    await until(() => s.status === 'idle')
    // The prompt travelled as one SDKUserMessage holding an image block then the text.
    assert.equal(receivedPrompt.type, 'user')
    assert.equal(receivedPrompt.parent_tool_use_id, null)
    const blocks = receivedPrompt.message.content
    assert.equal(blocks[0].type, 'image')
    assert.equal(blocks[0].source.type, 'base64')
    assert.equal(blocks[0].source.media_type, 'image/png')
    assert.equal(blocks[0].source.data, PNG_1x1.toString('base64'))
    assert.deepEqual(blocks[1], { type:'text', text:'What is this?' })
    // Stored on disk, referenced from the message, readable only by the owner.
    const [attachment] = s.messages[0].attachments
    assert.match(attachment.id, /^[0-9a-f-]{36}\.png$/)
    const file = path.join(directory, 'attachments', attachment.id)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(file).equals(PNG_1x1), true)

    // Image-only follow-ups are allowed; the text falls back to a stand-in.
    manager.send(s.id, { message:'', images:[{ mediaType:'image/png', data:PNG_1x1.toString('base64') }], requestId:randomUUID() })
    await until(() => s.status === 'idle')
    assert.equal(receivedPrompt.message.content.at(-1).text, 'See the attached image.')
    assert.equal(s.lastPrompt, '1 image')
    // A text-only message still goes as a plain string, not as an iterable.
    manager.send(s.id, { message:'Plain', requestId:randomUUID() })
    await until(() => s.status === 'idle')
    assert.equal(receivedPrompt, 'Plain')

    // The declared type is a claim; the bytes decide. Wrong bytes are refused.
    assert.throws(() => manager.send(s.id, { message:'x', images:[{ mediaType:'image/png', data:Buffer.from('not an image at all').toString('base64') }], requestId:randomUUID() }), /Only PNG, JPEG, GIF and WebP/)
    assert.throws(() => manager.send(s.id, { message:'x', images:Array.from({ length:7 }, () => ({ mediaType:'image/png', data:PNG_1x1.toString('base64') })), requestId:randomUUID() }), /up to 6 images/)
    assert.equal(fs.readdirSync(path.join(directory, 'attachments')).length, 2)

    await manager.remove(s.id)
    assert.equal(fs.readdirSync(path.join(directory, 'attachments')).length, 0)
  } finally { await manager.close(); fs.rmSync(directory, { recursive:true, force:true }) }
})

test('only message endpoints accept large bodies, and attachments are served by id alone', async () => {
  const { directory, manager } = setup(async () => ({ close() {}, async *[Symbol.asyncIterator]() { yield { type:'result', is_error:false, result:'Done' } } }))
  const app = createApp({ manager, collectSessions: () => ({ sessions:[], counts:{}, total:0, generatedAt:Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const { token } = await (await fetch(base + '/api/control')).json()
    const headers = { 'content-type':'application/json', 'x-fleet-token':token }
    const big = 'x'.repeat(70000)
    // Create with a ~70KB body: over the old 64KB cap, fine for a message endpoint.
    const created = await fetch(base + '/api/managed', { method:'POST', headers, body:JSON.stringify({ cwd:directory, prompt:'Hi', requestId:randomUUID(), images:[{ mediaType:'image/png', data:PNG_1x1.toString('base64') }], pad:big }) })
    assert.equal(created.status, 201)
    const { session } = await created.json()
    // The same size on a non-message endpoint is still refused.
    assert.equal((await fetch(base + `/api/managed/${session.id}/mode`, { method:'POST', headers, body:JSON.stringify({ mode:'ask', pad:big }) })).status, 413)

    const id = session.messages[0].attachments[0].id
    const served = await fetch(base + `/api/attachments/${id}`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await served.arrayBuffer()).equals(PNG_1x1), true)
    // Anything that is not a fresh id plus a known extension is not a path we serve.
    assert.equal((await fetch(base + '/api/attachments/../sessions.json')).status, 404)
    assert.equal((await fetch(base + '/api/attachments/00000000-0000-0000-0000-000000000000.png')).status, 404)
    assert.equal((await fetch(base + `/api/attachments/${id}.js`)).status, 404)
  } finally { await app.close(); app.server.closeAllConnections(); fs.rmSync(directory, { recursive:true, force:true }) }
})

test('a managed conversation resumed in a terminal is shown as held there, and sends are refused by name', async () => {
  const sessionId = randomUUID()
  const terminal = { sessionId, alive:true, name:'projects-ac', entrypoint:'cli', state:'busy', pid:4242, startedAt:Date.now() - 600000, lastActivity:Date.now(), links:[], turn:{ steps:[{ t:'Bash', k:'run', ok:true, target:'gradlew test' }], current:{ t:'Bash', target:'gradlew test', at:Date.now() }, last:null, turnStartedAt:Date.now() - 5000, answers:0 } }
  let holders = []
  const { directory, manager } = setup(async () => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield { type:'system', subtype:'init', session_id:sessionId, model:'claude-opus-5' }
    yield { type:'result', is_error:false, result:'Done' }
  } }), () => holders)
  const app = createApp({ manager, collectSessions: () => ({ sessions:holders, counts:{ busy:holders.length, idle:0, stale:0, dead:0 }, total:holders.length, generatedAt:Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const s = create(manager, directory)
    await until(() => s.status === 'idle')
    assert.equal(s.sessionId, sessionId)

    // Nobody else has it: a plain managed row, no holder, sending allowed.
    let row = (await (await fetch(base + '/api/sessions')).json()).sessions.find(x => x.managedId === s.id)
    assert.equal(row.openElsewhere, undefined)

    // Now a Warp tab resumes the same session id.
    holders = [terminal]
    const snap = await (await fetch(base + '/api/sessions')).json()
    row = snap.sessions.find(x => x.managedId === s.id)
    assert.equal(row.openElsewhere.name, 'projects-ac')
    assert.equal(row.openElsewhere.entrypoint, 'cli')
    assert.equal(row.state, 'busy', 'the row mirrors the terminal, not the stale "stopped"')
    assert.equal(row.turn.current.target, 'gradlew test', 'the row shows what the terminal is doing')
    // The terminal registry row is absorbed into the managed row, not listed twice.
    assert.equal(snap.sessions.filter(x => x.sessionId === sessionId).length, 1)
    const detail = (await (await fetch(base + `/api/managed/${s.id}`)).json()).session
    assert.equal(detail.openElsewhere.name, 'projects-ac')

    // Sending is refused, and the refusal says which window has it.
    assert.throws(() => manager.send(s.id, { message:'continue', requestId:randomUUID() }), /open in a terminal \(projects-ac since \d{1,2}:\d{2}(?: [AP]M)?\)/)
    // A program, not a person, gets the other wording.
    holders = [{ ...terminal, entrypoint:'sdk-ts', name:'observer-sessions-6d' }]
    assert.throws(() => manager.send(s.id, { message:'continue', requestId:randomUUID() }), /open in another program \(observer-sessions-6d/)
    // Once it exits, Fleet takes the conversation back without ceremony.
    holders = []
    manager.send(s.id, { message:'continue', requestId:randomUUID() })
    await until(() => s.status === 'idle')
    assert.equal(s.messages.filter(m => m.role === 'user').length, 2)
  } finally { await app.close(); app.server.closeAllConnections(); fs.rmSync(directory, { recursive:true, force:true }) }
})

test('the lock carries the port so a second start can open the running server, and still reads an old bare-PID lock',async()=>{
  const {directory,manager}=setup()
  try{
    // Written before the server has listened, so there is no port to record yet.
    assert.deepEqual(JSON.parse(fs.readFileSync(manager.lock,'utf8')),{pid:process.pid})
    manager.recordPort(7781)
    assert.deepEqual(manager.readLock(),{pid:process.pid,port:7781})

    // A second server is refused, and told where the first one already is.
    const conflict=refused(directory)
    assert.match(conflict.message,/already running/)
    assert.equal(conflict.code,'FLEET_ALREADY_RUNNING')
    assert.deepEqual(conflict.holder,{pid:process.pid,port:7781})

    // Upgrading in place leaves a lock written by the previous version behind.
    fs.writeFileSync(manager.lock,String(process.pid))
    assert.deepEqual(manager.readLock(),{pid:process.pid,port:null})
    assert.equal(refused(directory).holder.port,null)

    // Garbage is still garbage, and says so rather than being treated as a live PID.
    fs.writeFileSync(manager.lock,'not a pid')
    assert.throws(()=>new ManagedSessions({directory}),/Invalid Fleet lock file/)
    fs.writeFileSync(manager.lock,JSON.stringify({pid:process.pid,port:7781}))
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('a lock left by a process that is gone is cleared rather than blocking the next start',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-managed-'))
  // PID 2^22 is above every configured pid_max on macOS and Linux, so it cannot exist.
  fs.writeFileSync(path.join(directory,'server.lock'),JSON.stringify({pid:4194304,port:7777}))
  const manager=new ManagedSessions({directory})
  try{ assert.equal(manager.readLock().pid,process.pid) }
  finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

// --- Initiatives -----------------------------------------------------------------
// A team is only real if it reaches the SDK, so these assert on the options the
// transport actually receives rather than on what the session says about itself.
const {execFileSync}=require('node:child_process')
function gitRepo(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-initiative-repo-'))
  const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'ignore'})
  git('init','-q','-b','main');git('config','user.email','t@example.invalid');git('config','user.name','T')
  fs.writeFileSync(path.join(dir,'README.md'),'hi');git('add','README.md');git('commit','-qm','initial')
  return dir
}
const finished=()=>({close(){},async *[Symbol.asyncIterator](){yield {type:'result',result:'done',is_error:false,total_cost_usd:0}}})

test('a team puts the manager on the main thread and the work on its own branch',async()=>{
  const calls=[]
  const {directory,manager}=setup(async args=>{calls.push(args);return finished()})
  const repo=gitRepo()
  try{
    const s=manager.create({cwd:repo,prompt:'Fix the login redirect',requestId:randomUUID(),teamId:'bugfix'})
    await until(()=>s.status==='idle')
    assert.equal(s.kind,'initiative')
    assert.equal(s.teamId,'bugfix')
    // The operator talks to the main thread, so naming the manager there is what makes
    // "you only talk to the manager" true by construction rather than by instruction.
    assert.equal(calls[0].options.agent,'manager')
    assert.deepEqual(Object.keys(calls[0].options.agents).sort(),['developer','manager','qa'])
    // The preset must survive alongside the agent, or the team loses its built-in tools.
    assert.equal(calls[0].options.systemPrompt.preset,'claude_code')
    // The team works on a branch of its own; the operator's checkout is untouched.
    assert.notEqual(s.cwd,fs.realpathSync(repo))
    assert.equal(calls[0].options.cwd,s.cwd)
    assert.match(s.worktree.branch,/^initiative\//)
    assert.equal(execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),'main')
    const [summary]=manager.summaries()
    assert.equal(summary.kind,'initiative')
    assert.equal(summary.teamName,'Bug fix')
    // Forgetting the conversation must not delete a branch that may hold real work.
    const gone=await manager.remove(s.id)
    assert.equal(gone.branch,s.worktree.branch)
    assert.ok(fs.existsSync(s.worktree.path),'the worktree outlives the Fleet record on purpose')
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(repo,{recursive:true,force:true})}
})

test('a plain agent is untouched by any of this',async()=>{
  const calls=[]
  const {directory,manager}=setup(async args=>{calls.push(args);return finished()})
  try{
    const s=manager.create({cwd:directory,prompt:'Just do the thing',requestId:randomUUID()})
    await until(()=>s.status==='idle')
    assert.equal(s.kind,'agent')
    assert.equal(s.worktree,null)
    assert.equal(calls[0].options.agent,undefined)
    assert.equal(calls[0].options.agents,undefined)
    assert.equal(calls[0].options.cwd,fs.realpathSync(directory))
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('an unknown team, or a team on a resumed conversation, is refused',async()=>{
  const {directory,manager}=setup(async()=>finished())
  const repo=gitRepo()
  try{
    assert.throws(()=>manager.create({cwd:repo,prompt:'x',requestId:randomUUID(),teamId:'ghost'}),/does not exist/)
    // Nothing should be left behind by a launch that was refused.
    assert.equal(manager.sessions.size,0)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(repo,{recursive:true,force:true})}
})

test('an initiative outside a git repository is refused at launch',async()=>{
  const {directory,manager}=setup(async()=>finished())
  try{
    assert.throws(()=>manager.create({cwd:directory,prompt:'x',requestId:randomUUID(),teamId:'bugfix'}),/needs a git repository/)
    assert.equal(manager.sessions.size,0)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('the browser can list teams and launch an initiative over HTTP',async()=>{
  const calls=[]
  const {directory,manager}=setup(async args=>{calls.push(args);return finished()})
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()})})
  const repo=gitRepo()
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const base=`http://127.0.0.1:${app.server.address().port}`
    const config=await (await fetch(base+'/api/control')).json()

    const {teams}=await (await fetch(base+'/api/teams')).json()
    assert.equal(teams[0].id,'bugfix')
    assert.deepEqual(teams[0].roles.map(r=>r.name).sort(),['developer','manager','qa'])
    // Prompts are large and the browser has no use for them.
    assert.equal(JSON.stringify(teams).includes('You are the manager of an initiative'),false)

    // Creation lives on /api/managed. /api/sessions is the read-only snapshot, and
    // pointing the launch form at it is a silent way to break every launch.
    const launch=await fetch(base+'/api/managed',{method:'POST',
      headers:{'content-type':'application/json','x-fleet-token':config.token,origin:base},
      body:JSON.stringify({cwd:repo,prompt:'Fix the login redirect',teamId:'bugfix',requestId:randomUUID()})})
    assert.equal(launch.status,201)
    const {session}=await launch.json()
    assert.equal(session.kind,'initiative')
    assert.equal(session.teamId,'bugfix')
    await until(()=>calls.length===1)
    assert.equal(calls[0].options.agent,'manager')

    // A bad team id must fail as a request error, not a 500.
    const bad=await fetch(base+'/api/managed',{method:'POST',
      headers:{'content-type':'application/json','x-fleet-token':config.token,origin:base},
      body:JSON.stringify({cwd:repo,prompt:'x',teamId:'ghost',requestId:randomUUID()})})
    assert.equal(bad.status,400)
  }finally{await app.close?.();await manager.close();fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(repo,{recursive:true,force:true})}
})

test('an approval says which role is asking for it',async()=>{
  const seen=[]
  const {directory,manager}=setup(async args=>({close(){},async *[Symbol.asyncIterator](){
    // The manager asks from the main thread: no agentID.
    const ask=args.options.canUseTool('Bash',{command:'rm -rf build'},{signal:args.options.abortController.signal,toolUseID:'t1'})
    yield {type:'assistant',message:{content:[{type:'text',text:'thinking'}]}}
    seen.push(await ask)
    // Now a delegation is in flight, and the request carries a sub-agent id.
    yield {type:'assistant',message:{content:[{type:'tool_use',id:'d1',name:'Agent',input:{subagent_type:'developer',description:'Fix it',prompt:'Fix it properly'}}]}}
    seen.push(await args.options.canUseTool('Bash',{command:'rm -rf dist'},{signal:args.options.abortController.signal,toolUseID:'t2',agentID:'sub-1'}))
    yield {type:'result',result:'done',is_error:false}
  }}))
  const repo=gitRepo()
  try{
    const s=manager.create({cwd:repo,prompt:'Fix the login redirect',requestId:randomUUID(),teamId:'bugfix',approvalMode:'ask'})
    await until(()=>s.approvals.length===1)
    assert.equal(s.approvals[0].role,'manager','a main-thread request is the manager')
    manager.decide(s.id,s.approvals[0].id,{decision:'allow'})
    await until(()=>s.approvals.length===1 && s.approvals[0].input.command==='rm -rf dist')
    assert.equal(s.approvals[0].role,'developer','a request from a subagent names the delegate')
    manager.decide(s.id,s.approvals[0].id,{decision:'allow'})
    await until(()=>s.status==='idle')
    assert.equal(seen.length,2)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true});fs.rmSync(repo,{recursive:true,force:true})}
})

test('a plain agent carries no role on its approvals',async()=>{
  const {directory,manager}=setup(async args=>({close(){},async *[Symbol.asyncIterator](){
    const ask=args.options.canUseTool('Bash',{command:'rm -rf build'},{signal:args.options.abortController.signal,toolUseID:'t1'})
    yield {type:'assistant',message:{content:[{type:'text',text:'x'}]}}
    await ask
    yield {type:'result',result:'done',is_error:false}
  }}))
  try{
    const s=create(manager,directory)
    await until(()=>s.approvals.length===1)
    assert.equal(s.approvals[0].role,null)
    manager.decide(s.id,s.approvals[0].id,{decision:'allow'})
    await until(()=>s.status==='idle')
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('what a conversation cost is accumulated across turns and reaches the dashboard',async()=>{
  let spend=0.02
  const {directory,manager}=setup(async()=>({close(){},async *[Symbol.asyncIterator](){
    yield {type:'result',result:'done',is_error:false,total_cost_usd:spend}
  }}))
  try{
    const s=manager.create({cwd:directory,prompt:'First',requestId:randomUUID()})
    await until(()=>s.status==='idle')
    assert.equal(manager.summaries()[0].costUsd,0.02)
    // A second turn adds to the total rather than replacing it: the row shows what the
    // whole conversation has cost, which is the number worth knowing before sending again.
    spend=0.03
    manager.send(s.id,{message:'Second',requestId:randomUUID()})
    await until(()=>s.status==='idle')
    assert.ok(Math.abs(manager.summaries()[0].costUsd-0.05)<1e-9,`expected 0.05, got ${manager.summaries()[0].costUsd}`)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test('the control endpoint carries the running version, so the UI has something to show',async()=>{
  const {directory,manager}=setup(async()=>finished())
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()})})
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const config=await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/control`)).json()
    // The version of the process that is answering, which is the thing a restart changes.
    assert.equal(config.version,require('./package.json').version)
  }finally{await app.close?.();await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})
