'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const {label,problem}=require('./public/pr-state.js')

const ok=(state,extra={})=>({ok:true,state,draft:false,number:12,...extra})

test('each state has its word and tone, and a draft reads as Draft',()=>{
  assert.deepEqual(label(ok('open')),['Open','running'])
  assert.deepEqual(label(ok('merged')),['Merged','done'])
  assert.deepEqual(label(ok('closed')),['Closed','hot'])
  assert.deepEqual(label(ok('open',{draft:true})),['Draft','idle'])
  assert.deepEqual(label(ok('merged',{draft:true})),['Merged','done'],'a merged PR is merged whatever its draft flag says')
})

test('nothing is shown until gh has answered, or when it could not',()=>{
  assert.equal(label(undefined),null)
  assert.equal(label({ok:false,reason:'missing'}),null)
  assert.equal(label(ok('unknown')),null)
})

test('only an unavailable gh earns a line of explanation',()=>{
  assert.match(problem([{ok:false,reason:'missing'}]),/Install the gh CLI/)
  assert.match(problem([ok('open'),{ok:false,reason:'unauthenticated'}]),/gh auth login/)
  assert.match(problem([{ok:false,reason:'rate-limited'}]),/rate limiting/)
  assert.equal(problem([{ok:false,reason:'not-found'},{ok:false,reason:'failed'},ok('open'),undefined]),'','a PR gh cannot read is not worth a warning')
  assert.equal(problem([]),'')
})

// The browser side against a stub: it asks once, shows the pill once gh answers, and redraws.
function page(answer){
  const asked=[],renders=[]
  const context=vm.createContext({console,AbortSignal,encodeURIComponent,Date,JSON,
    fetch:async url=>{asked.push(decodeURIComponent(url.split('url=')[1]));return {json:async()=>({status:answer(asked.at(-1))})}}})
  context.window=context
  context.Fleet={render:()=>renders.push(1)}
  context.FleetUI={pill:(text,tone)=>`[${text}:${tone}]`}
  new vm.Script(fs.readFileSync(path.join(__dirname,'public/pr-state.js'),'utf8')).runInContext(context)
  return {state:context.FleetPrState,asked,renders}
}
const settle=()=>new Promise(r=>setTimeout(r,5))
const URL_A='https://github.com/example-org/demo-repo/pull/12'

test('a PR shows nothing at first, then its state, and the page is redrawn once',async()=>{
  const ui=page(()=>ok('merged'))
  assert.equal(ui.state.pill(URL_A),'')
  assert.equal(ui.state.pill(URL_A),'','a second render while it loads does not ask again')
  await settle()
  assert.equal(ui.asked.length,1)
  assert.equal(ui.renders.length,1)
  assert.equal(ui.state.pill(URL_A),'[Merged:done]')
  assert.equal(ui.asked.length,1,'a merged PR is not asked for again within ten minutes')
})

test('when gh is unavailable the pill stays away and the note says why',async()=>{
  const ui=page(()=>({ok:false,reason:'missing'}))
  ui.state.pill(URL_A);await settle()
  assert.equal(ui.state.pill(URL_A),'')
  assert.match(ui.state.note([URL_A]),/Install the gh CLI/)
})

test('a failed request is an answer too, not an unhandled rejection',async()=>{
  const context=vm.createContext({console,AbortSignal,encodeURIComponent,Date,JSON,fetch:async()=>{throw new Error('offline')}})
  context.window=context;context.Fleet={render(){}};context.FleetUI={pill:()=>'x'}
  new vm.Script(fs.readFileSync(path.join(__dirname,'public/pr-state.js'),'utf8')).runInContext(context)
  context.FleetPrState.pill(URL_A);await settle()
  assert.equal(context.FleetPrState.pill(URL_A),'')
})

test('Linked work wires the state into each PR chip, from the five most recent PRs',()=>{
  const app=fs.readFileSync(path.join(__dirname,'public/app.js'),'utf8')
  assert.match(app,/prUrls\.includes\(l\.url\) \? window\.FleetPrState\?\.pill\(l\.url\)/)
  assert.match(app,/slice\(-5\)/)
  const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8')
  assert.match(html,/src="\/pr-state\.js"/)
  assert.ok(!/review-panel|review\.js/.test(html),'the bottom panel is gone')
})
