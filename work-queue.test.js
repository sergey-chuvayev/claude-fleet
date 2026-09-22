'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {state,visible,nextAction}=require('./public/work-queue')
const row=(id,extra={})=>({managedId:id,managed:true,name:id,managedStatus:'idle',...extra})
test('work groups use live session state rather than declaring idle work verified',()=>{
  assert.equal(state(row('one')),'idle')
  assert.equal(state(row('one',{taskProgress:{total:0,verified:0}})),'idle')
  assert.equal(state(row('one',{taskProgress:{total:2,verified:2}})),'review')
  assert.equal(state(row('one',{taskProgress:{total:2,verified:1}})),'idle')
  assert.equal(state(row('one',{managedStatus:'running',taskProgress:{blocked:1}})),'running')
  assert.equal(state(row('one',{managedStatus:'approval'})),'attention')
  assert.equal(state(row('one',{approvals:1})),'attention')
  assert.equal(state(row('one',{taskProgress:{blocked:1}})),'attention')
  assert.equal(state(row('one',{managedStatus:'queued',taskProgress:{blocked:1}})),'queued')
  assert.equal(state(row('one',{managedStatus:'error'})),'attention')
  assert.equal(state(row('one',{openElsewhere:{state:'busy'},managedStatus:'idle'})),'running')
  assert.equal(state(row('one',{openElsewhere:{state:'idle'},taskProgress:{total:1,verified:1}})),'attention')
})
test('queue grouping excludes external and archived sessions and preserves dispatcher order',()=>{
  const rows=[row('ready'),row('q2',{managedStatus:'queued',queuePosition:2}),row('external',{managed:false}),row('archived',{archived:true}),row('q1',{managedStatus:'queued',queuePosition:1}),row('running',{managedStatus:'running'}),row('attention',{managedStatus:'approval'})]
  assert.deepEqual(visible(rows).map(s=>s.managedId),['attention','running','q1','q2','ready'])
  assert.deepEqual(visible(rows,'queued').map(s=>s.managedId),['q1','q2'])
  assert.deepEqual(visible([row('fix',{cwd:'/projects/backend',teamName:'Owner + review'})],'all',' BACKEND ').map(s=>s.managedId),['fix'])
  assert.match(nextAction(rows[1],{paused:true}),/Dispatch paused · position 2/)
  assert.match(nextAction(rows[0]),/Turn finished/)
})

test('live tab handlers select real sessions and call authenticated queue controls',async()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
  const elements=new Map(),calls=[],errors=[]
  const element=id=>{
    if (!elements.has(id)) elements.set(id,{id,hidden:false,value:'',textContent:'',innerHTML:'',dataset:{},handlers:{},
      addEventListener(type,fn){this.handlers[type]=fn},setAttribute(name,value){this[name]=value},querySelector(){return null},scrollIntoView(){},
      insertAdjacentHTML(_,html){for (const match of html.matchAll(/id="([^"]+)"/g)) element(match[1])},
    })
    return elements.get(id)
  }
  for (const id of ['sessions-pane','view-sessions','view-queue','work-total','detail']) element(id)
  const snapshot={sessions:[row('real-session',{title:'<script>unsafe</script>',managedStatus:'queued',queuePosition:1})],queue:{enabled:false,limit:4,paused:false,running:0,waiting:1}}
  let launches=0,selected=null
  const Fleet={$:id=>elements.get(id),esc:s=>String(s ?? '').replaceAll('<','&lt;').replaceAll('>','&gt;'),update:(id,html)=>{element(id).innerHTML=html},store:{get:()=>null,set(){}},toast:message=>calls.push(message),key:s=>s.managedId,money:()=>null,snapshot:()=>snapshot,
    render:()=>context.FleetQueue?.render(snapshot,selected),select:id=>{selected=id;Fleet.render()},tick:async()=>{}}
  const context=vm.createContext({window:{},document:{querySelector:()=>element('workspace'),activeElement:null},matchMedia:()=>({matches:false}),console})
  context.window=context;context.Fleet=Fleet
  context.FleetControl={openLaunch:()=>launches++,api:async(url,body)=>{calls.push({url,body});if(errors.length)throw Error(errors.shift());Object.assign(snapshot.queue,body)}}
  new vm.Script(fs.readFileSync(path.join(__dirname,'public/work-queue.js'),'utf8')).runInContext(context)
  element('view-queue').handlers.click()
  assert.equal(element('sessions-pane').hidden,true)
  assert.equal(element('work-pane').hidden,false)
  assert.match(element('work-list').innerHTML,/&lt;script&gt;/)
  assert.doesNotMatch(element('work-list').innerHTML,/<script>/)
  element('work-list').handlers.click({target:{closest:()=>({dataset:{session:'real-session'}})}})
  assert.equal(selected,'real-session')
  element('work-add').handlers.click();assert.equal(launches,1)
  await element('work-enable').handlers.click()
  assert.equal(calls[0].url,'/api/queue');assert.equal(calls[0].body.enabled,true)
  assert.equal(element('work-enable').hidden,true)
  await element('work-pause').handlers.click();assert.equal(snapshot.queue.paused,true)
  await element('work-limit').handlers.change({target:{value:'2'}});assert.equal(snapshot.queue.limit,2)
  errors.push('Disk full')
  await element('work-pause').handlers.click()
  assert.equal(element('work-error').textContent,'Disk full');assert.equal(element('work-error').hidden,false)
  assert.equal(element('work-pause').disabled,false)
  element('view-sessions').handlers.click();assert.equal(element('sessions-pane').hidden,false)
})
