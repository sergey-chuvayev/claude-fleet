'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const http=require('node:http')
const vm=require('node:vm')
const {randomUUID}=require('node:crypto')
const {respond,tagOf}=require('./sync')

// The page's half (public/sync.js) against the server's half, over real HTTP. Whatever
// travels, the page must end up with exactly what a plain full fetch returns.
async function harness() {
  let current
  const server=http.createServer((req,res)=>respond(req,res,current(),{paths:['sessions','detail.messages'],volatile:['generatedAt']}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const wire=[]
  const context=vm.createContext({AbortSignal,Map,Set,Error,JSON,Object,Array,window:{},fetch:async(url,options)=>{
    const response=await fetch(base+url,options)
    wire.push({status:response.status,bytes:Number(response.headers.get('content-length') || 0) || (response.status===304 ? 0 : (await response.clone().text()).length),known:!!options.headers['x-fleet-known']})
    return response
  }})
  vm.runInContext(fs.readFileSync(path.join(__dirname,'public','sync.js'),'utf8'),context)
  const plain=async()=>{const r=await fetch(base+'/');return r.json()}
  const strip=value=>JSON.parse(JSON.stringify(value,(k,v)=>k==='h' || k==='generatedAt' ? undefined : v))
  return {set:fn=>{current=fn},get:()=>context.window.FleetSync.get('/',{paths:['sessions','detail.messages']}),sync:context.window.FleetSync,plain,strip,wire,close:()=>server.close()}
}
const rows=n=>Array.from({length:n},(_,i)=>({sessionId:`s${i}`,title:`Session ${i}`,latestResponse:'x'.repeat(2000)}))

test('an unchanged answer is a 304, a changed one sends only what changed, and the page always has it all',async()=>{
  const h=await harness()
  try {
    let sessions=rows(50),messages=[{id:'m1',text:'hi'},{id:'m2',text:'there'}],at=1
    h.set(()=>({generatedAt:at++,counts:{all:sessions.length},sessions,detail:{messages}}))
    const first=await h.get()
    assert.equal(first.changed,true)
    assert.deepEqual(h.strip(first.value),h.strip(await h.plain()))
    const full=h.wire.at(-1).bytes

    const second=await h.get()
    assert.equal(second.changed,false,'only generatedAt moved, which does not count')
    assert.equal(h.wire.at(-1).status,304)

    sessions=sessions.map((s,i)=>i===7 ? {...s,title:'Renamed'} : s)
    messages=[...messages,{id:'m3',text:'new'}]
    const third=await h.get()
    assert.equal(third.changed,true)
    assert.ok(h.wire.at(-1).known,'the page said what it holds')
    assert.ok(h.wire.at(-1).bytes<full/10,`a one-row change sends a fraction of the list (${h.wire.at(-1).bytes} of ${full} bytes)`)
    assert.deepEqual(h.strip(third.value),h.strip(await h.plain()),'rebuilt, it is exactly the full answer')
    assert.equal(third.value.sessions[7].title,'Renamed')
    assert.equal(third.value.detail.messages.length,3)

    sessions=sessions.slice(1)
    const fourth=await h.get()
    assert.deepEqual(h.strip(fourth.value),h.strip(await h.plain()),'a row that went away is gone')
  } finally { h.close() }
})

test('a fingerprint the page cannot place makes it ask again for everything',async()=>{
  // A server that answers with a fingerprint the page never had (a copy that drifted,
  // a restart): the page must ask again, without what it holds, and show no hole.
  const http=require('node:http')
  let tamper=true,calls=[]
  const server=http.createServer((req,res)=>{
    calls.push(!!req.headers['x-fleet-known'])
    const body=req.headers['x-fleet-known'] && tamper ? {sessions:[{h:'AAAAAAAAAAAAAAAA'},{sessionId:'b',h:'BBBBBBBBBBBBBBBB'}]} : {sessions:[{sessionId:'a',h:'CCCCCCCCCCCCCCCC'},{sessionId:'b',h:'BBBBBBBBBBBBBBBB'}]}
    res.writeHead(200,{'content-type':'application/json',etag:'"t'+calls.length+'"'});res.end(JSON.stringify(body))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const context=vm.createContext({AbortSignal,Map,Set,Error,JSON,Object,Array,window:{},fetch:(url,options)=>fetch(base+url,options)})
  vm.runInContext(fs.readFileSync(path.join(__dirname,'public','sync.js'),'utf8'),context)
  try {
    await context.window.FleetSync.get('/',{paths:['sessions']})
    const next=await context.window.FleetSync.get('/',{paths:['sessions']})
    assert.deepEqual(calls,[false,true,false],'the second answer had a stranger in it, so the page asked again from scratch')
    assert.deepEqual(next.value.sessions.map(s=>s.sessionId),['a','b'])
  } finally { server.close() }
})

test('the server turns away a fingerprint it does not recognise by sending the item whole',async()=>{
  const {pack,fingerprint}=require('./sync')
  const item={id:'a',text:'x'}
  const known=new Set([fingerprint(JSON.stringify(item))])
  assert.deepEqual(pack({list:[item,{id:'b'}]},['list'],known).list.map(x=>Object.keys(x).sort().join()),['h','h,id'])
  assert.equal(tagOf({generatedAt:1,a:1},['generatedAt']),tagOf({generatedAt:2,a:1},['generatedAt']))
  assert.notEqual(tagOf({a:1}),tagOf({a:2}))
})

test('the server pushes "list changed" when a session changes, so the page need not poll',async()=>{
  const {createApp}=require('./server')
  const {ManagedSessions}=require('./managed')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-push-'))
  let terminal=[]
  const manager=new ManagedSessions({directory,queryFactory:async()=>({close(){},async *[Symbol.asyncIterator](){}})})
  const app=createApp({manager,collectSessions:()=>({sessions:terminal,counts:{},total:terminal.length,generatedAt:Date.now()})})
  try {
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve))
    const base=`http://127.0.0.1:${app.server.address().port}`
    const controller=new AbortController()
    const stream=await fetch(base+'/api/events',{signal:controller.signal})
    const reader=stream.body.getReader(),decoder=new TextDecoder()
    let text=''
    // One read in flight at a time: a read that loses a race to the timer still gets the
    // next chunk, so it is kept rather than replaced.
    let pending=null
    const until=async(pattern,ms=4000)=>{const end=Date.now()+ms;while(!pattern.test(text)){if(Date.now()>end)return false;pending ||= reader.read();const result=await Promise.race([pending,new Promise(r=>setTimeout(()=>r(null),300))]);if(!result)continue;pending=null;if(result.done)return false;text+=decoder.decode(result.value)}return true}
    await until(/connected/)
    await new Promise(resolve=>setTimeout(resolve,2300)) // the server takes its first look
    // A terminal session appears: nothing tells Fleet but its own look every two seconds.
    terminal=[{sessionId:randomUUID(),title:'From a terminal',alive:true,state:'idle'}]
    assert.ok(await until(/event: list/,5000),'a terminal session showing up is pushed')
    controller.abort()
  } finally { await app.close(); fs.rmSync(directory,{recursive:true,force:true}) }
})
