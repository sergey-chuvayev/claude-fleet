'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {GatewaySettings}=require('./settings')
function fixture(t,options={}){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-settings-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return new GatewaySettings({directory,env:{},...options})}
test('saved credentials persist privately, override env and never appear in metadata',t=>{
  const settings=fixture(t,{env:{AI_GATEWAY_API_KEY:'environment-secret'}})
  assert.equal(settings.key(),'environment-secret')
  assert.deepEqual(settings.save(' saved-secret '),{configured:true,source:'saved'})
  assert.equal(fs.statSync(settings.file).mode & 0o777,0o600)
  assert.equal(new GatewaySettings({directory:path.dirname(settings.file),env:{}}).key(),'saved-secret')
  settings.save('replacement-secret');assert.equal(settings.key(),'replacement-secret')
  assert.equal(JSON.stringify(settings.status()).includes('secret'),false)
  assert.deepEqual(settings.remove(),{configured:true,source:'environment'})
  assert.equal(settings.key(),'environment-secret')
  settings.remove()
})
test('invalid or failed saves preserve the current credential',t=>{
  const settings=fixture(t);settings.save('original')
  for(const key of ['',null,'a\nb','x'.repeat(4097)])assert.throws(()=>settings.save(key),/valid/)
  assert.equal(settings.key(),'original')
  const rename=fs.renameSync
  t.mock.method(fs,'renameSync',()=>{throw new Error('sensitive-detail')})
  assert.throws(()=>settings.save('new-secret'),/Unable to save/)
  assert.equal(settings.key(),'original')
  assert.deepEqual(fs.readdirSync(path.dirname(settings.file)),['gateway-key.json'])
  fs.renameSync=rename
})
test('test uses current key, fixed endpoint and synthetic content',async t=>{
  let request
  const settings=fixture(t,{fetchImpl:async(...args)=>{request=args;return {ok:true,json:async()=>({answers:{connected:{type:'boolean',probability:1}}})}}})
  settings.save('first');assert.equal((await settings.test()).ok,true)
  settings.save('second');await settings.test()
  assert.equal(request[0],'https://ai-gateway.vercel.sh/v1/evaluate')
  assert.equal(request[1].headers.Authorization,'Bearer second')
  assert.equal(request[1].redirect,'error')
  assert.equal(JSON.parse(request[1].body).state.text,'Fleet connection test.')
})
test('test reports sanitized authentication, billing, response and network failures',async t=>{
  const settings=fixture(t);settings.save('private-secret')
  for(const status of [401,403,402,429,500]){
    settings.fetchImpl=async()=>({ok:false,status,body:{cancel:async()=>{}}})
    const result=await settings.test();assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('private-secret'))
  }
  settings.fetchImpl=async()=>{throw new Error('private-secret')}
  assert.equal((await settings.test()).ok,false)
  settings.fetchImpl=async()=>({ok:true,json:async()=>({})})
  assert.equal((await settings.test()).ok,false)
  settings.remove();await assert.rejects(settings.test(),/Save an AI Gateway key first/)
})
test('settings HTTP endpoints enforce authorization and return no key',async t=>{
  const settings=fixture(t),{ManagedSessions}=require('./managed'),{createApp}=require('./server')
  const manager=new ManagedSessions({directory:path.dirname(settings.file)})
  manager.gatewaySettings=settings
  const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{}})})
  try{
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
    const base=`http://127.0.0.1:${app.server.address().port}`,{token}=await (await fetch(base+'/api/control')).json()
    const post=(data,headers={})=>fetch(base+'/api/settings/gateway',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)})
    assert.equal((await post({action:'save',apiKey:'secret'})).status,403)
    assert.equal((await post({action:'save',apiKey:'secret'},{'x-fleet-token':token,origin:'https://other.example'})).status,403)
    const response=await post({action:'save',apiKey:'secret'},{'x-fleet-token':token})
    assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/secret/)
    assert.deepEqual(await (await fetch(base+'/api/settings/gateway')).json(),{gateway:{configured:true,source:'saved'}})
    // The legacy settings script went with public/ at cutover; the dialog is in the React build.
    assert.equal((await fetch(base+'/settings.js')).status,404)
    assert.equal((await post({action:'remove'},{'x-fleet-token':token})).status,200)
    assert.equal(settings.key(),'')
  }finally{await app.close()}
})
