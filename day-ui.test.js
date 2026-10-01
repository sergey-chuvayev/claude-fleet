'use strict'
// The Day's browser-side helpers that decide what the console and board say, loaded
// against a stub DOM the same way fleet.test.js checks script scope.
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
// Arrays made inside the vm context have that realm's prototype; compare plain copies.
const plain=v=>JSON.parse(JSON.stringify(v))
function load() {
  const esc=v=>String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const context=vm.createContext({
    document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({})},
    addEventListener(){},matchMedia:()=>({matches:false}),CSS:{escape:s=>s},console,
  })
  context.window=context
  context.Fleet={esc,toast(){},update(){},snapshot:()=>null}
  for (const file of ['blocks.js','day.js']) new vm.Script(fs.readFileSync(path.join(__dirname,'public',file),'utf8'),{filename:file}).runInContext(context)
  return context
}
test('tools are named the way a person would say them',()=>{
  const {FleetBlocks}=load()
  assert.equal(FleetBlocks.toolLabel('mcp__fleet__day'),'Board')
  assert.equal(FleetBlocks.toolLabel('mcp__claude_ai_Slack__slack_search_public_and_private'),'Slack · search public and private')
  assert.equal(FleetBlocks.toolLabel('mcp__linear-server__get_issue'),'Linear · get issue')
  assert.equal(FleetBlocks.toolLabel('mcp__granola__list_meetings'),'Granola · list meetings')
  assert.equal(FleetBlocks.toolLabel('Bash'),'Bash')
  assert.equal(FleetBlocks.toolLabel('ToolSearch'),'Loading tools')
})
test('the Day console marks automatic runs and folds back-to-back board calls into one block',()=>{
  const {FleetDay}=load()
  const tool=(id,input,status='done',ms=100)=>({id,role:'tool',tool:'mcp__fleet__day',input,status,ms,at:1})
  const out=FleetDay.messages([
    {id:'u1',role:'user',text:'Sweep',runPrompt:'Scheduled sweep…',background:true,at:1},
    tool('t1',{action:'list'}),tool('t2',{action:'add',title:'Reply to Marc'}),tool('t3',{action:'add',title:'Review #2224'}),
    tool('t4',{action:'ask',question:'Send this?'},'error'),
    {id:'a1',role:'assistant',text:'Two new items.',at:2},
    tool('t5',{action:'update',note:'Logged context'},'running',null),
    {id:'u2',role:'user',text:'What is left?',at:3},
  ])
  assert.deepEqual(plain(out.map(m=>m.role)),['event','tool','assistant','tool','user'])
  assert.equal(out[0].text,'Auto check')
  const board=out[1]
  assert.equal(board.label,'Board')
  assert.equal(board.target,'read the board · added 2 · asked 1')
  assert.equal(board.status,'error','one failed call marks the block')
  assert.equal(board.ms,400)
  assert.deepEqual(plain(board.lines.map(l=>l.text.split(':')[0])),['read the board','added','added','asked'])
  assert.equal(board.lines[3].error,true)
  assert.equal(out[3].status,'running')
  assert.equal(out[3].id,'t5~board','a group keeps a stable id across refreshes')
  assert.equal(out[4].text,'What is left?','the operator\'s own messages stay messages')
})
