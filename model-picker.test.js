'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
function select(value=''){
  return {value,isConnected:true,options:[],get innerHTML(){return this.html || ''},set innerHTML(html){this.html=html;this.options=[...html.matchAll(/value="([^"]*)"/g)].map(m=>({value:m[1]}));this.value=this.options[0]?.value || ''}}
}
function setup(api){
  const source=fs.readFileSync(path.join(__dirname,'public/control.js'),'utf8')
  const launch=select(),status={},context=vm.createContext({api,controlSession:{selectedModel:'sonnet'},$:id=>id==='launch-model'?launch:status,esc:String})
  vm.runInContext(source.slice(source.indexOf('// The model list comes'),source.indexOf('async function changeModel'))+'\nthis.fillModels=fillModels;this.launch=typeof fillLaunchModels===\'function\' ? fillLaunchModels:null',context)
  return {context,launch,status}
}
test('failed model fetch keeps choices available and later requests can recover',async()=>{
  let calls=0
  const {context}=setup(async()=>{if(++calls===1)throw Error('offline');return {models:[{value:'',displayName:'Default'},{value:'sonnet'},{value:'custom-model'}]}})
  const current=select()
  await context.fillModels(current)
  assert.ok(current.options.some(o=>o.value==='sonnet'),'failure must not empty the picker')
  await context.fillModels(current)
  assert.ok(current.options.some(o=>o.value==='custom-model'),'failure must not cache an empty list')
})
test('refreshing a session picker does not reset the launch model',async()=>{
  const {context,launch}=setup(async()=>({models:[{value:''},{value:'sonnet'},{value:'opus'}]}))
  launch.value='opus'
  await context.fillModels(select())
  assert.equal(launch.value,'opus')
})
test('opening launch retries loading and preserves choices made during the request',async()=>{
  let resolve,calls=0
  const {context,launch}=setup(()=>{calls++;return new Promise(r=>{resolve=r})})
  assert.equal(typeof context.launch,'function')
  const pending=context.launch()
  assert.ok(launch.options.some(o=>o.value==='auto-jev'))
  launch.value='auto-jev'
  resolve({models:[{value:''},{value:'sonnet'},{value:'auto-jev'}]});await pending
  assert.equal(launch.value,'auto-jev')
  const second=context.launch();assert.equal(calls,2)
  resolve({models:[]});await second
  assert.equal(launch.value,'auto-jev');assert.ok(launch.options.length>1)
})
