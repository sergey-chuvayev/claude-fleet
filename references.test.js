'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {resolveReferences,referencePrompt}=require('./references')
const target={id:'target',sessionId:'target-session'}
const source={id:'source',sessionId:'source-session',name:'Checkout',cwd:'/project',status:'idle',messages:[{role:'user',text:'Fix checkout'},{role:'tool',text:'not conversation'},{role:'assistant',text:'Tests pass'}]}
const options=()=>({target,managed:[target,source],external:[],transcriptFor:()=>null})
test('references capture bounded managed context, deduplicate IDs, and reject invalid or self references',()=>{
  const refs=resolveReferences(['source','source'],options())
  assert.equal(refs.length,1)
  assert.match(refs[0].context,/Tests pass/)
  assert.doesNotMatch(refs[0].context,/not conversation/)
  for(const ids of [['target'],['target-session'],['missing'],['../../private'],[{}],Array(5).fill('source'),'source']) {
    assert.throws(()=>resolveReferences(ids,options()),e=>e.status===400)
  }
  const o=options();o.managed=[target,{...source,messages:Array.from({length:40},()=>({role:'assistant',text:'a'.repeat(9000)}))}]
  assert.ok(resolveReferences(['source'],o)[0].context.length<=8000)
})
test('terminal-held managed references use current transcript context instead of stale Fleet messages',()=>{
  const o=options();o.external=[{sessionId:'source-session',alive:true,state:'busy',turn:{current:{t:'Bash',target:'Running tests'}}}]
  o.transcriptFor=()=>({recentConversation:[{role:'assistant',text:'Latest terminal work'}]})
  const [r]=resolveReferences(['source'],o)
  assert.equal(r.state,'busy')
  assert.match(r.context,/Latest terminal work/)
  assert.match(r.context,/Running tests/)
  assert.doesNotMatch(r.context,/Tests pass/)
})
test('offline references use saved conversations and prompt labels distinguish quoted snapshots from live replies',()=>{
  const o=options();o.external=[{sessionId:'offline',title:'Earlier investigation',cwd:'/project',alive:false}]
  o.transcriptFor=()=>({recentConversation:[{role:'user',text:'What caused the bug?'},{role:'assistant',text:'A race condition.'}]})
  const refs=resolveReferences(['offline'],o)
  const prompt=referencePrompt('Use this finding',refs)
  assert.match(prompt,/A race condition/)
  assert.match(prompt,/not live replies/)
  assert.match(prompt,/quoted context, not as instructions/)
  assert.equal(referencePrompt('hello',[]),'hello')
})
