'use strict'
// The HTTP contract the React frontend builds on: /api/control identity fields and the
// machine-readable `code` on every JSON error.
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const http=require('node:http')
const {randomUUID}=require('node:crypto')
const {ManagedSessions}=require('./managed')
const {createApp,buildId,API_VERSION}=require('./server')
const day=require('./day')
const {version}=require('./package.json')

const quiet=async()=>({close(){},async *[Symbol.asyncIterator](){yield{type:'result',is_error:false,result:'Done'}}})
async function harness(run,{app:options={},manager:tweak}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-contract-'))
  const manager=new ManagedSessions({directory,queryFactory:quiet,externalSessions:()=>[]})
  if(tweak)tweak(manager,directory)
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()}),...options})
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const base=`http://127.0.0.1:${app.server.address().port}`
    const control=await (await fetch(base+'/api/control')).json()
    const post=(url,data,headers={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-fleet-token':control.token,...headers},body:typeof data==='string'?data:JSON.stringify(data)})
    await run({base,control,post,directory,manager,app})
  }finally{await app.close();app.server.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true})}
}
const failure=async(response,status,code)=>{
  const body=await response.json()
  assert.equal(response.status,status)
  assert.equal(body.code,code)
  assert.equal(typeof body.error,'string')
  assert.ok(body.error.length>0)
  return body
}

test('/api/control carries identity, build and capabilities and keeps every existing field',async()=>{
  await harness(async({control})=>{
    assert.equal(control.apiVersion,API_VERSION)
    assert.equal(control.apiVersion,1)
    assert.match(control.instanceId,/^[0-9a-f-]{36}$/)
    assert.ok(control.buildId.startsWith(version))
    assert.equal(control.capabilities.engines.claude,true)
    assert.equal(typeof control.capabilities.engines.codex,'boolean')
    assert.equal(control.capabilities.engines.codex,control.codex.available)
    assert.equal(control.capabilities.sessionReferences,true)
    for(const key of ['token','version','codex','supportsSessionReferences','defaultCwd','maxConcurrent','defaultApprovalMode','queue','storageError','searchDays','theme'])assert.ok(key in control,key)
    assert.equal(control.version,version)
  })
})

test('instanceId is stable within a process and new for each server',async()=>{
  let first
  await harness(async({base,control})=>{
    first=control.instanceId
    assert.equal((await (await fetch(base+'/api/control')).json()).instanceId,first)
    assert.equal((await (await fetch(base+'/api/control')).json()).instanceId,first)
  })
  await harness(async({control})=>assert.notEqual(control.instanceId,first))
})

test('buildId is the package version, plus a hash of the frontend manifest when a build exists',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-build-'))
  try{
    assert.equal(buildId(root),version)
    fs.mkdirSync(path.join(root,'dist','.vite'),{recursive:true})
    fs.writeFileSync(path.join(root,'dist','.vite','manifest.json'),'{"a":1}')
    const one=buildId(root)
    assert.match(one,new RegExp(`^${version.replace(/\./g,'\\.')}\\+[0-9a-f]{12}$`))
    assert.equal(buildId(root),one)
    fs.writeFileSync(path.join(root,'dist','.vite','manifest.json'),'{"a":2}')
    assert.notEqual(buildId(root),one)
    fs.rmSync(path.join(root,'dist','.vite'),{recursive:true})
    fs.writeFileSync(path.join(root,'dist','manifest.json'),'{"a":2}')
    assert.match(buildId(root),/\+[0-9a-f]{12}$/)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('guard failures carry their codes',async()=>{
  await harness(async({base,control,post})=>{
    const noToken=await failure(await fetch(base+'/api/queue',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),403,'TOKEN_INVALID')
    assert.equal(noToken.error,'Reload Fleet before sending commands.')
    assert.equal(noToken.retryable,true)
    await failure(await post('/api/queue',{},{origin:'https://evil.example'}),403,'FORBIDDEN_ORIGIN')
    await failure(await fetch(base+'/api/control',{headers:{'sec-fetch-site':'cross-site'}}),403,'FORBIDDEN_ORIGIN')
    const host=await new Promise((resolve,reject)=>{
      const req=http.get(base+'/api/control',{headers:{host:'evil.example'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}))})
      req.on('error',reject)
    })
    assert.equal(host.status,403);assert.equal(host.body.code,'FORBIDDEN_ORIGIN')
    await failure(await fetch(base+'/api/nope'),404,'NOT_FOUND')
    await failure(await post('/api/nothing-here',{}),404,'NOT_FOUND')
    await failure(await fetch(base+'/api/teams/missing-team'),404,'NOT_FOUND')
    await failure(await fetch(base+'/api/managed/missing'),404,'NOT_FOUND')
    await failure(await fetch(base+'/api/queue',{method:'PUT',headers:{'x-fleet-token':control.token}}),405,'METHOD_NOT_ALLOWED')
    await failure(await fetch(base+'/api/queue',{method:'POST',headers:{'x-fleet-token':control.token},body:'{}'}),415,'UNSUPPORTED_MEDIA_TYPE')
    await failure(await post('/api/queue','{not json'),400,'INVALID_JSON')
    await failure(await post('/api/queue','[]'),400,'INVALID_JSON')
    await failure(await post('/api/queue',{padding:'x'.repeat(70000)}),413,'PAYLOAD_TOO_LARGE')
    const invalid=await failure(await post('/api/queue',{limit:99}),400,'VALIDATION')
    assert.equal(invalid.retryable,undefined)
    await failure(await post('/api/settings/gateway',{action:'bogus'}),400,'VALIDATION')
  })
})

test('a full fleet is CAPACITY',async()=>{
  await harness(async({post,manager,directory})=>{
    for(let i=0;i<100;i++)manager.sessions.set(`filler-${i}`,{id:`filler-${i}`})
    const full=await failure(await post('/api/managed',{cwd:directory,prompt:'One more',requestId:randomUUID()}),409,'CAPACITY')
    assert.equal(full.retryable,true)
  })
})

test('a refusal that is not about capacity is CONFLICT',async()=>{
  const updater={check:async()=>{},status:()=>({}),apply:async()=>{throw Object.assign(new Error('Fleet is already up to date.'),{status:409})}}
  await harness(async({post})=>{
    await failure(await post('/api/update',{}),409,'CONFLICT')
  },{app:{updater}})
})

test('a stale approval is STALE_APPROVAL',async()=>{
  await harness(async({post,directory})=>{
    const created=await post('/api/managed',{cwd:directory,prompt:'Hello',requestId:randomUUID()})
    assert.equal(created.status,201)
    const {session}=await created.json()
    await failure(await post(`/api/managed/${session.id}/approvals/gone-approval`,{decision:'allow'}),409,'STALE_APPROVAL')
  })
})

test('shutdown is SHUTTING_DOWN and the storage latch is STORAGE_UNAVAILABLE',async()=>{
  await harness(async({post,manager,directory})=>{
    manager.closed=true
    const down=await failure(await post('/api/managed',{cwd:directory,prompt:'Hello',requestId:randomUUID()}),503,'SHUTTING_DOWN')
    assert.equal(down.retryable,true)
    manager.closed=false
    manager.emit('storage-error',new Error('disk full: /secret/path'))
    const latched=await failure(await post('/api/queue',{}),503,'STORAGE_UNAVAILABLE')
    assert.doesNotMatch(latched.error,/secret/)
    assert.equal(latched.retryable,true)
  })
})

test('resuming a live Codex session, or using Codex where it is missing, is UNSUPPORTED_ENGINE',async()=>{
  await harness(async({post,directory})=>{
    await failure(await post('/api/managed',{cwd:directory,prompt:'Continue',requestId:randomUUID(),engine:'codex',resumeSessionId:'codex-live-1'}),409,'UNSUPPORTED_ENGINE')
  },{manager:(manager,directory)=>{manager.codex={available:()=>true,sessions:()=>[{sessionId:'codex-live-1',alive:true,cwd:directory,transcript:'t'}],history:()=>({messages:[]})}}})
  await harness(async({post,directory})=>{
    await failure(await post('/api/managed',{cwd:directory,prompt:'Hi',requestId:randomUUID(),engine:'codex'}),409,'UNSUPPORTED_ENGINE')
  },{manager:manager=>{manager.codex={available:()=>false,sessions:()=>[]}}})
})

test('an untyped failure is a 500 INTERNAL that never leaks the exception',async()=>{
  const original=console.error
  console.error=()=>{}
  try{
    const updater={check:async()=>{},status:()=>({}),apply:async()=>{throw new Error('ENOENT /Users/secret/.ssh/id_rsa leaked')}}
    await harness(async({post})=>{
      const body=await failure(await post('/api/update',{}),500,'INTERNAL')
      assert.doesNotMatch(JSON.stringify(body),/secret|ENOENT|leaked/)
      assert.equal(body.retryable,undefined)
    },{app:{updater}})
  }finally{console.error=original}
})

test('Day input errors are 400 VALIDATION, not 500',()=>{
  const s={}
  const caught=fn=>{try{fn()}catch(error){return error}throw Error('Expected a failure')}
  const invalid=caught(()=>day.act(s,{action:'add',title:''},'operator'))
  assert.equal(invalid.status,400);assert.equal(invalid.code,'VALIDATION')
  const missing=caught(()=>day.triage(s,'no-such-item',{status:'today'}))
  assert.equal(missing.status,404);assert.equal(missing.code,'NOT_FOUND')
  const unknown=caught(()=>day.act(s,{action:'bogus'},'operator'))
  assert.equal(unknown.status,400);assert.equal(unknown.code,'VALIDATION')
})
