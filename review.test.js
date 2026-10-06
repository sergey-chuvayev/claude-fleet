'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')

// The browser half (the PR strip, its helpers and the feedback form) is
// frontend/src/features/sessions/review/review.test.ts and SessionInspector.test.tsx.

test('the feedback lands in the session through the real message route',async()=>{
  const {ManagedSessions}=require('./managed'),{createApp}=require('./server')
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-review-'))
  const prompts=[]
  const manager=new ManagedSessions({directory:path.join(root,'managed'),queryFactory:async args=>{prompts.push(args.prompt);return {close(){},async *[Symbol.asyncIterator](){yield {type:'system',subtype:'init',session_id:randomUUID(),model:'claude-sonnet'};yield {type:'result',result:'ok',is_error:false}}}}})
  const stub={get:async url=>({ok:true,url,state:'open',draft:false,number:12,ci:{result:'fail',failing:['build'],total:1,pending:0}})}
  const app=createApp({manager,prStatus:stub,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()})})
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const base=`http://127.0.0.1:${app.server.address().port}`
    const {token}=await (await fetch(base+'/api/control')).json()
    const post=(url,payload)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-fleet-token':token},body:JSON.stringify(payload)})
    const s=manager.create({cwd:root,prompt:'Open the PR',requestId:randomUUID()})
    for(let i=0;i<100&&s.status!=='idle';i++)await new Promise(r=>setTimeout(r,5))
    const link12='https://github.com/example-org/demo-repo/pull/12'
    const status=await (await fetch(`${base}/api/pr-status?url=${encodeURIComponent(link12)}`)).json()
    assert.deepEqual([status.status.number,status.status.ci.failing],[12,['build']])
    // What the page's CI preset (ciFeedback in features/sessions/review) builds from that status.
    const message='CI failed on build (PR #12). Fix it and push.'
    assert.equal((await post(`/api/managed/${s.id}/messages`,{message,requestId:randomUUID()})).status,200)
    for(let i=0;i<100&&prompts.length<2;i++)await new Promise(r=>setTimeout(r,5))
    assert.equal(prompts.length,2)
    assert.match(JSON.stringify(prompts[1]),/CI failed on build/)
  }finally{await app.close();app.server.closeAllConnections();await manager.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('the PR route answers from the cache module and needs no token to read',async()=>{
  const {createApp}=require('./server'),{ManagedSessions}=require('./managed')
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-review-'))
  const asked=[]
  const manager=new ManagedSessions({directory:path.join(root,'managed'),queryFactory:async()=>({close(){},async *[Symbol.asyncIterator](){}})})
  const app=createApp({manager,prStatus:{get:async url=>{asked.push(url);return {ok:false,url,reason:'missing'}}},collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()})})
  try{
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)})
    const base=`http://127.0.0.1:${app.server.address().port}`
    const body=await (await fetch(`${base}/api/pr-status?url=${encodeURIComponent('https://github.com/example-org/demo-repo/pull/9')}`)).json()
    assert.deepEqual(body.status,{ok:false,url:'https://github.com/example-org/demo-repo/pull/9',reason:'missing'})
    await fetch(`${base}/api/pr-status`)
    assert.deepEqual(asked.slice(-1),[''],'a missing url is passed on empty and refused by the module')
  }finally{await app.close();app.server.closeAllConnections();await manager.close();fs.rmSync(root,{recursive:true,force:true})}
})
