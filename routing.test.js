'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {randomUUID}=require('node:crypto')
const {decide,route,AUTO_MODEL}=require('./routing')
const {ManagedSessions}=require('./managed')
const answers=(choice='routine',extra={})=>({complexity:{type:'choice',choice,probabilities:{simple:0,routine:0,complex:0,[choice]:1}},ambiguous:{type:'boolean',probability:0},risk:{type:'boolean',probability:0},readOnly:{type:'boolean',probability:0},...extra})
const boolean=probability=>({type:'boolean',probability})
test('routing uses bounded choices and conservative uncertainty gates',()=>{
  assert.equal(decide(answers('simple',{readOnly:boolean(1)}),'preset').model,'haiku')
  assert.equal(decide(answers('simple'),'preset').model,'sonnet')
  assert.equal(decide(answers(),'preset').model,'sonnet')
  assert.equal(decide(answers('complex'),'preset').model,'claude-opus-5-5')
  assert.equal(decide(answers('routine',{risk:boolean(1)}),'preset').model,'claude-opus-5-5')
  assert.equal(decide(answers('routine',{ambiguous:boolean(0.6)}),'preset').model,'preset')
  assert.equal(decide(answers('routine',{risk:boolean(0.3)}),'preset').model,'preset')
  assert.equal(decide(answers('routine',{complexity:{type:'choice',choice:'routine',probabilities:{simple:0.3,routine:0.5,complex:0.2}}}),'preset').reason,'uncertain')
  for(const malformed of [null,{},answers('unknown'),answers('routine',{risk:boolean(NaN)}),answers('routine',{complexity:{type:'choice',choice:'routine',probabilities:{routine:1}}})])assert.equal(decide(malformed,'preset').reason,'invalid')
})
test('Gateway request contains only the bounded brief and typed questions; metadata excludes credentials',async()=>{
  let request
  const result=await route({original:'Fix a unit test',current:'Fix a unit test',fallback:'opus'},{apiKey:'test-secret',fetchImpl:async(url,options)=>{request={url,...options};return {ok:true,json:async()=>({answers:answers(),providerMetadata:{gateway:{cost:'0.000012',credential:'never store'}}})}}})
  assert.equal(request.url,'https://ai-gateway.vercel.sh/v1/evaluate')
  assert.equal(request.headers.Authorization,'Bearer test-secret')
  assert.equal(request.redirect,'error')
  const body=JSON.parse(request.body)
  assert.equal(body.model,'typesafe-ai/jev');assert.deepEqual(body.state,{originalTask:'Fix a unit test',currentRequest:'Fix a unit test'})
  assert.equal(result.model,'sonnet');assert.equal(result.costUsd,0.000012)
  assert.doesNotMatch(JSON.stringify(result),/test-secret|never store/)
})
test('missing keys/context skip API; HTTP errors, invalid bodies and timeouts retain the preset',async()=>{
  const input={original:'Task',fallback:'claude-opus-5-5'}
  const noCall=()=>assert.fail('Must not contact Gateway')
  assert.equal((await route(input,{apiKey:'',fetchImpl:noCall})).reason,'missing_key')
  assert.equal((await route({...input,hasExtraContext:true},{apiKey:'key',fetchImpl:noCall})).reason,'context')
  assert.equal((await route({...input,original:'a'.repeat(12001)},{apiKey:'key',fetchImpl:noCall})).reason,'context')
  for(const fetchImpl of [async()=>({ok:false}),async()=>{throw Error('secret')},async()=>({ok:true,json:async()=>{throw Error('bad json')}})])assert.equal((await route(input,{apiKey:'key',fetchImpl})).model,input.fallback)
  assert.equal((await route(input,{apiKey:'key',fetchImpl:async()=>({ok:true,json:async()=>({answers:{}})})})).reason,'invalid')
  const keepAlive=setTimeout(()=>{},100)
  try{const result=await route(input,{apiKey:'key',timeoutMs:5,fetchImpl:async(_,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))))});assert.equal(result.reason,'unavailable')}finally{clearTimeout(keepAlive)}
})
const done=()=>({close(){},async *[Symbol.asyncIterator](){yield {type:'system',subtype:'init',session_id:randomUUID(),model:'sonnet'};yield {type:'result',result:'done',is_error:false,total_cost_usd:0}}})
async function idle(manager,s){for(let i=0;i<200;i++){if(!manager.runs.has(s.id))return;await new Promise(r=>setTimeout(r,5))}throw Error('Timed out')}
test('automatic selection is pinned through followups and restart; manual choices bypass it',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-route-')),calls=[];let routes=0,manager
  const options={directory,queryFactory:async args=>{calls.push(args);return done()},modelRouter:async()=>{routes++;return {model:'haiku',reason:'selected'}}}
  try{
    manager=new ManagedSessions(options)
    const s=manager.create({cwd:directory,prompt:'Summarize this text',model:AUTO_MODEL,requestId:randomUUID()})
    await idle(manager,s);assert.equal(calls[0].options.model,'haiku');assert.equal(routes,1)
    manager.send(s.id,{message:'Continue',requestId:randomUUID()});await idle(manager,s);assert.equal(routes,1)
    await manager.close();manager=new ManagedSessions(options)
    const saved=manager.get(s.id);manager.send(s.id,{message:'Continue again',requestId:randomUUID()});await idle(manager,saved)
    assert.equal(routes,1);assert.equal(calls[2].options.model,'haiku')
    manager.setModelChoice(s.id,{model:'sonnet'});manager.send(s.id,{message:'Use my choice',requestId:randomUUID()});await idle(manager,saved)
    assert.equal(calls[3].options.model,'sonnet');assert.equal(routes,1)
    const manual=manager.create({cwd:directory,prompt:'Task',model:'opus',requestId:randomUUID()});await idle(manager,manual);assert.equal(routes,1)
  }finally{await manager?.close();fs.rmSync(directory,{recursive:true,force:true})}
})
test('stopping during routing never launches Claude or pins a canceled decision',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-route-stop-'));let release,called=false
  const manager=new ManagedSessions({directory,queryFactory:async()=>{called=true;return done()},modelRouter:()=>new Promise(r=>{release=r})})
  try{
    const s=manager.create({cwd:directory,prompt:'Task',model:AUTO_MODEL,requestId:randomUUID()})
    manager.stop(s.id);release({model:'haiku',reason:'selected'});await idle(manager,s)
    assert.equal(called,false);assert.equal(s.modelRouting,undefined);assert.equal(s.status,'stopped')
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})
test('team routing changes only the manager and missing-key fallback preserves the preset',async()=>{
  const {execFileSync}=require('node:child_process')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-route-team-')),repo=path.join(directory,'repo'),calls=[],inputs=[]
  fs.mkdirSync(repo)
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'ignore'})
  git('init','-q','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Test');fs.writeFileSync(path.join(repo,'README.md'),'test');git('add','.');git('commit','-qm','initial')
  const manager=new ManagedSessions({directory,queryFactory:async args=>{calls.push(args);return done()},modelRouter:async input=>{inputs.push(input);return route(input,{apiKey:''})}})
  try{
    const s=manager.create({cwd:repo,prompt:'Fix this',teamId:'owner-review',model:AUTO_MODEL,requestId:randomUUID()});await idle(manager,s)
    assert.equal(inputs[0].fallback,'claude-opus-5-5')
    assert.equal(calls[0].options.model,'claude-opus-5-5');assert.equal(calls[0].options.agents.owner.model,'claude-opus-5-5')
    assert.equal(calls[0].options.agents.reviewer.model,'sonnet');assert.equal(s.modelRouting.reason,'missing_key')
    assert.equal(s.teamSnapshot.roles.owner.model,'claude-opus-5-5')
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})
test('new sessions read key changes immediately without leaking credentials to session storage',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-route-keys-')),keys=[]
  const manager=new ManagedSessions({directory,queryFactory:async()=>done(),modelRouter:async(input,options)=>{keys.push(options.apiKey);return {model:input.fallback,reason:'selected'}}})
  manager.gatewaySettings.env={}
  try{
    for(const key of ['first-secret','second-secret','']){
      if(key)manager.gatewaySettings.save(key);else manager.gatewaySettings.remove()
      const s=manager.create({cwd:directory,prompt:'Task',model:AUTO_MODEL,requestId:randomUUID()});await idle(manager,s)
      assert.doesNotMatch(JSON.stringify(manager.detail(s.id)),/first-secret|second-secret/)
    }
    fs.writeFileSync(manager.gatewaySettings.file,'invalid json')
    const recovered=manager.create({cwd:directory,prompt:'Task',model:AUTO_MODEL,requestId:randomUUID()});await idle(manager,recovered)
    assert.deepEqual(keys,['first-secret','second-secret','',''])
    assert.doesNotMatch(fs.readFileSync(path.join(directory,'sessions.json'),'utf8'),/first-secret|second-secret/)
  }finally{await manager.close();fs.rmSync(directory,{recursive:true,force:true})}
})
