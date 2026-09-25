'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {Connections}=require('./connections')
function fixture(options={}){
  const calls=[],queries=[],dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-connections-'))
  const manager={runs:new Map(),get(id){if(id!=='session')throw Object.assign(Error('Session not found'),{status:404});return {id,cwd:dir}},async queryFactory(args){
    calls.push(args)
    const query={closed:0,servers:[{name:'linear',status:'needs-auth',scope:'claudeai',config:{headers:{Authorization:'secret'}},error:'secret',tools:[]},{name:'local',status:'disabled',scope:'project',tools:[]}],
      async mcpServerStatus(){return this.servers},async reconnectMcpServer(name){this.servers.find(s=>s.name===name).status='connected'},async toggleMcpServer(name,enabled){this.servers.find(s=>s.name===name).status=enabled?'connected':'disabled'},close(){this.closed++}}
    queries.push(query);return query
  }}
  const connections=new Connections(manager,options)
  return {calls,queries,dir,manager,connections,close(){connections.close();fs.rmSync(dir,{recursive:true,force:true})}}
}
test('idle checks start no model prompt, reuse a bounded transport, and never return credentials',async()=>{
  const f=fixture()
  try{
    const result=await f.connections.request({sessionId:'session'})
    assert.equal(result.source,'project');assert.equal(f.calls.length,1)
    assert.equal(typeof f.calls[0].prompt,'object');assert.equal(f.calls[0].options.persistSession,false)
    assert.deepEqual(f.calls[0].options.settingSources,['user','project','local'])
    assert.equal((await f.calls[0].options.canUseTool()).behavior,'deny')
    assert.equal(result.servers[0].auth,'claudeai');assert.doesNotMatch(JSON.stringify(result),/secret|Authorization/)
    await f.connections.request({cwd:f.dir});assert.equal(f.calls.length,1)
    f.connections.close();assert.equal(f.queries[0].closed,1)
    assert.equal((await f.calls[0].prompt.next()).done,true)
  }finally{f.close()}
})
test('reconnect and enable/disable target only known servers on the checked connection',async()=>{
  const f=fixture()
  try{
    const r=await f.connections.request({cwd:f.dir}),target={cwd:f.dir,source:r.source,connectionId:r.connectionId}
    assert.equal((await f.connections.request({...target,action:'enable',name:'local'})).servers[1].status,'connected')
    assert.equal((await f.connections.request({...target,action:'disable',name:'local'})).servers[1].status,'disabled')
    assert.equal((await f.connections.request({...target,action:'reconnect',name:'linear'})).servers[0].status,'connected')
    await assert.rejects(f.connections.request({...target,action:'enable',name:'unknown'}),{status:404})
  }finally{f.close()}
})
test('live sessions use their own transport and stale actions cannot reach a new turn',async()=>{
  const f=fixture()
  try{
    const live=await f.manager.queryFactory({})
    live.servers.push({name:'fleet',status:'connected',tools:[]})
    f.manager.runs.set('session',{query:live})
    const r=await f.connections.request({sessionId:'session'})
    assert.equal(r.source,'session');assert.equal(r.servers[2].canToggle,false);assert.equal(f.calls.length,1)
    await assert.rejects(f.connections.request({sessionId:'session',source:r.source,connectionId:r.connectionId,action:'disable',name:'fleet'}),{status:400})
    const next=await f.manager.queryFactory({});f.manager.runs.set('session',{query:next})
    await assert.rejects(f.connections.request({sessionId:'session',source:r.source,connectionId:r.connectionId,action:'enable',name:'local'}),{status:409})
    assert.equal(next.servers[1].status,'disabled')
    f.connections.close();assert.equal(live.closed,0);assert.equal(next.closed,0)
  }finally{f.close()}
})
test('startup, timeout, shutdown and concurrent checks release diagnostics without touching agents',async()=>{
  const f=fixture({timeoutMs:20})
  try{
    f.manager.runs.set('session',{})
    await assert.rejects(f.connections.request({sessionId:'session'}),{status:409})
    f.manager.runs.clear()
    let resolve
    f.manager.queryFactory=()=>new Promise(r=>{resolve=r})
    const first=f.connections.request({cwd:f.dir})
    await assert.rejects(f.connections.request({cwd:f.dir}),{status:409})
    await assert.rejects(first,{status:504})
    let closed=0;resolve({close(){closed++}})
    await new Promise(r=>setImmediate(r));assert.equal(closed,1)
    f.connections.close()
    await assert.rejects(f.connections.request({cwd:f.dir}),{status:503})
  }finally{f.close()}
})
test('switching projects and an idle lease close the diagnostic process',async()=>{
  const f=fixture({idleMs:15}),second=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-other-'))
  try{
    await f.connections.request({cwd:f.dir})
    await f.connections.request({cwd:second});assert.equal(f.queries[0].closed,1)
    await new Promise(r=>setTimeout(r,30));assert.equal(f.queries[1].closed,1)
  }finally{f.close();fs.rmSync(second,{recursive:true,force:true})}
})
test('HTTP connection checks require same-origin control authorization and ship the UI',async()=>{
  const {ManagedSessions}=require('./managed'),{createApp}=require('./server')
  const f=fixture(),manager=new ManagedSessions({directory:f.dir,queryFactory:f.manager.queryFactory})
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{}})})
  try{
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
    const base=`http://127.0.0.1:${app.server.address().port}`,{token}=await (await fetch(base+'/api/control')).json()
    const post=headers=>fetch(base+'/api/connections',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({cwd:f.dir})})
    assert.equal((await post({})).status,403);assert.equal(f.calls.length,0)
    assert.equal((await post({'x-fleet-token':token,origin:'https://other.example'})).status,403)
    const res=await post({'x-fleet-token':token});assert.equal(res.status,200)
    assert.equal((await res.json()).connections.servers.length,2)
    assert.equal((await fetch(base+'/connections.js')).status,200)
    assert.match(await (await fetch(base)).text(),/id="open-connections"/)
  }finally{await app.close();f.close()}
})
