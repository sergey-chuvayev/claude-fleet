'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const vm=require('node:vm')
const {randomUUID}=require('node:crypto')
const {prLinks,ciFeedback,problem}=require('./public/review.js')

const failing=(number,...names)=>({ok:true,number,state:'open',draft:false,ci:{result:'fail',failing:names,total:3,pending:0}})
const passing=number=>({ok:true,number,state:'open',draft:false,ci:{result:'pass',failing:[],total:2,pending:0}})
const link=n=>({kind:'pr',label:`PR #${n}`,url:`https://github.com/example-org/demo-repo/pull/${n}`})

test('the failing-CI message names the checks and the PR',()=>{
  assert.equal(ciFeedback([failing(12,'build','lint')]),'CI failed on build, lint (PR #12). Fix it and push.')
  assert.equal(ciFeedback([failing(12,'build'),passing(13),failing(14,'e2e')]),'CI failed on build (PR #12). Fix it and push. CI failed on e2e (PR #14). Fix it and push.')
})

test('a long list of failures is trimmed, and nothing red means no prefilled message',()=>{
  assert.match(ciFeedback([failing(1,'a','b','c','d','e','f','g')]),/^CI failed on a, b, c, d, e and 2 more \(PR #1\)/)
  assert.equal(ciFeedback([passing(12)]),'')
  assert.equal(ciFeedback([{ok:false,reason:'missing'},undefined]),'')
  assert.equal(ciFeedback([]),'')
})

test('only GitHub PR links count, and only the latest three',()=>{
  const session={links:[{kind:'linear',label:'ABC-1',url:'https://linear.app/x/issue/ABC-1'},link(1),link(2),link(3),link(4)]}
  assert.deepEqual(prLinks(session).map(l=>l.label),['PR #2','PR #3','PR #4'])
  assert.deepEqual(prLinks({}),[])
  assert.deepEqual(prLinks(null),[])
})

test('each way gh can be unavailable says what to do about it',()=>{
  assert.match(problem('missing'),/not installed/)
  assert.match(problem('unauthenticated'),/gh auth login/)
  assert.match(problem('rate-limited'),/rate limiting/)
  assert.match(problem('anything-else'),/could not read/)
})

// The panel against a stub DOM: what it asks the server for, and what one click sends.
function panel(statusFor,{apiError}={}){
  const els=new Map(),handlers={}
  const el=id=>{if(!els.has(id))els.set(id,{id,hidden:true,value:'',innerHTML:'',textContent:'',title:'',disabled:false,focus(){},querySelectorAll:()=>[]});return els.get(id)}
  for(const id of ['review-panel','review-status','review-preset','review-text','review-error','review-sent','review-ci-send'])el(id)
  const posts=[],fetched=[]
  const context=vm.createContext({console,AbortSignal,encodeURIComponent,crypto:{randomUUID},
    document:{hidden:false,addEventListener:(type,fn)=>{(handlers[type]||=[]).push(fn)}},
    setInterval:()=>1,clearInterval(){},
    fetch:async url=>{fetched.push(url);const status=statusFor(decodeURIComponent(url.split('url=')[1]));return {ok:true,json:async()=>({status})}}})
  context.window=context
  context.Fleet={$:id=>els.get(id)||null,esc:v=>String(v??''),key:s=>s.managedId||s.sessionId,requestTick(){}}
  context.FleetUI={section:(title,body)=>body,pill:text=>text}
  context.FleetControl={api:async(url,body)=>{if(apiError)throw new Error(apiError);posts.push({url,body})}}
  new vm.Script(fs.readFileSync(path.join(__dirname,'public/review.js'),'utf8')).runInContext(context)
  const fire=(type,event)=>{for(const fn of handlers[type]||[])fn(event)}
  return {review:context.FleetReview,el,posts,fetched,fire}
}
const settle=()=>new Promise(r=>setTimeout(r,5))
const managed={managed:true,managedId:'m1',links:[link(12)]}

test('a managed session with red CI offers a one-click request that posts the prefilled message',async()=>{
  const ui=panel(url=>url.endsWith('/12')?failing(12,'build','lint'):passing(13))
  ui.review.show(managed);await settle()
  assert.equal(ui.el('review-panel').hidden,false)
  assert.equal(ui.fetched.length,1)
  assert.match(ui.fetched[0],/^\/api\/pr-status\?url=https%3A%2F%2Fgithub\.com/)
  assert.equal(ui.el('review-ci-send').hidden,false,'red CI shows the quick action')
  assert.match(ui.el('review-preset').innerHTML,/CI failed, fix it/)
  ui.fire('click',{target:{closest:sel=>sel==='#review-ci-send'?{}:null}})
  await settle()
  assert.equal(ui.posts.length,1)
  assert.equal(ui.posts[0].url,'/api/managed/m1/messages')
  assert.equal(ui.posts[0].body.message,'CI failed on build, lint (PR #12). Fix it and push.')
  assert.match(ui.posts[0].body.requestId,/^[0-9a-f-]{36}$/)
})

test('free text is sent as typed, trimmed, and the box is cleared on success',async()=>{
  const ui=panel(()=>passing(12))
  ui.review.show(managed);await settle()
  assert.equal(ui.el('review-ci-send').hidden,true,'green CI has no quick action')
  assert.doesNotMatch(ui.el('review-preset').innerHTML,/CI failed/)
  ui.el('review-text').value='  Rename the helper to match the spec.  '
  let prevented=false
  ui.fire('submit',{target:{id:'review-form'},preventDefault(){prevented=true}})
  await settle()
  assert.equal(prevented,true)
  assert.equal(ui.posts[0].body.message,'Rename the helper to match the spec.')
  assert.equal(ui.el('review-text').value,'')
  assert.match(ui.el('review-sent').textContent,/sent/i)
})

test('an empty box sends nothing',async()=>{
  const ui=panel(()=>passing(12))
  ui.review.show(managed);await settle()
  ui.el('review-text').value='   '
  ui.fire('submit',{target:{id:'review-form'},preventDefault(){}});await settle()
  assert.equal(ui.posts.length,0)
  ui.fire('submit',{target:{id:'some-other-form'},preventDefault(){}});await settle()
  assert.equal(ui.posts.length,0,'only the review form submits')
})

test('a failed send keeps what was typed and says why',async()=>{
  const ui=panel(()=>passing(12),{apiError:'Agent is closed.'})
  ui.review.show(managed);await settle()
  ui.el('review-text').value='Please add a test.'
  ui.fire('submit',{target:{id:'review-form'},preventDefault(){}});await settle()
  assert.equal(ui.el('review-text').value,'Please add a test.')
  assert.equal(ui.el('review-error').hidden,false)
  assert.equal(ui.el('review-error').textContent,'Agent is closed.')
})

test('picking the CI option fills the box with the message',async()=>{
  const ui=panel(()=>failing(12,'build'))
  ui.review.show(managed);await settle()
  ui.el('review-preset').value='ci'
  ui.fire('change',{target:ui.el('review-preset')})
  assert.equal(ui.el('review-text').value,'CI failed on build (PR #12). Fix it and push.')
})

test('a session Fleet only watches shows PR state but no way to message it',async()=>{
  const ui=panel(()=>failing(12,'build'))
  ui.review.show({sessionId:'s1',links:[link(12)]});await settle()
  assert.equal(ui.fetched.length,1)
  assert.match(ui.el('review-panel').innerHTML,/Continue this session in Fleet/)
  assert.doesNotMatch(ui.el('review-panel').innerHTML,/review-form/)
})

test('no PR link means no panel, and showing the same session again changes nothing',async()=>{
  const ui=panel(()=>passing(12))
  ui.review.show({managed:true,managedId:'m2',links:[]})
  assert.equal(ui.el('review-panel').hidden,true)
  assert.equal(ui.fetched.length,0)
  ui.review.show(managed);await settle()
  ui.el('review-text').value='half-typed'
  ui.review.show({...managed});await settle()
  assert.equal(ui.fetched.length,1,'a re-render does not refetch')
  assert.equal(ui.el('review-text').value,'half-typed','a re-render does not wipe the draft')
  ui.review.show(null)
  assert.equal(ui.el('review-panel').hidden,true)
})

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
    const message=ciFeedback([status.status])
    assert.equal(message,'CI failed on build (PR #12). Fix it and push.')
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
