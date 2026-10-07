'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const http=require('node:http')
const {randomUUID}=require('node:crypto')
const {respond,tagOf}=require('./sync')

// The server's half over real HTTP. The page's half (rebuilding a packed answer, asking again
// for a fingerprint it cannot place) is frontend/src/transport/conditional.test.ts, which runs
// against this same module through a fake fetch.
async function harness() {
  let current
  const server=http.createServer((req,res)=>respond(req,res,current(),{paths:['sessions','detail.messages'],volatile:['generatedAt']}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const get=async(headers={})=>{const r=await fetch(base+'/',{headers});return {status:r.status,etag:r.headers.get('etag'),text:await r.text()}}
  return {set:fn=>{current=fn},get,close:()=>server.close()}
}
const rows=n=>Array.from({length:n},(_,i)=>({sessionId:`s${i}`,title:`Session ${i}`,latestResponse:'x'.repeat(2000)}))

test('an unchanged answer is a 304, and a changed one sends whole only the items the page does not hold',async()=>{
  const h=await harness()
  try {
    let sessions=rows(50),messages=[{id:'m1',text:'hi'},{id:'m2',text:'there'}],at=1
    h.set(()=>({generatedAt:at++,counts:{all:sessions.length},sessions,detail:{messages}}))
    const first=await h.get()
    assert.equal(first.status,200)
    const body=JSON.parse(first.text)
    assert.equal(body.sessions.length,50)
    assert.ok(body.sessions.every(s=>/^[\w-]{16}$/.test(s.h) && s.title),'a first answer is whole, each item with its fingerprint')

    const second=await h.get({'if-none-match':first.etag})
    assert.equal(second.status,304,'only generatedAt moved, which does not count')
    assert.equal(second.text,'')

    const known=[...body.sessions,...body.detail.messages].map(x=>x.h).join(',')
    sessions=sessions.map((s,i)=>i===7 ? {...s,title:'Renamed'} : s)
    messages=[...messages,{id:'m3',text:'new'}]
    const third=await h.get({'if-none-match':first.etag,'x-fleet-known':known})
    assert.equal(third.status,200)
    assert.ok(third.text.length<first.text.length/10,`a one-row change sends a fraction of the list (${third.text.length} of ${first.text.length} bytes)`)
    const packed=JSON.parse(third.text)
    assert.equal(packed.sessions.length,50,'every row is still there, by fingerprint or whole')
    assert.deepEqual(packed.sessions.filter(s=>s.title).map(s=>s.title),['Renamed'])
    assert.deepEqual(packed.detail.messages.map(m=>m.text),[undefined,undefined,'new'])
    assert.notEqual(third.etag,first.etag)

    sessions=sessions.slice(1)
    const fourth=JSON.parse((await h.get({'x-fleet-known':known})).text)
    assert.equal(fourth.sessions.length,49,'a row that went away is gone')
  } finally { h.close() }
})

test('a fingerprint header the server cannot use is ignored, and the answer comes back whole',async()=>{
  const h=await harness()
  try {
    h.set(()=>({generatedAt:1,sessions:rows(3),detail:{messages:[]}}))
    for(const known of ['not-a-fingerprint','short,also bad,///']){
      const body=JSON.parse((await h.get({'x-fleet-known':known})).text)
      assert.ok(body.sessions.every(s=>s.title),known.slice(0,20))
    }
  } finally { h.close() }
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
