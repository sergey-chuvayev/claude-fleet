'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {randomUUID}=require('node:crypto')

const PNG_1x1=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64')
const GIF_1x1=Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;','binary')

test('a Codex agent gets string text on stdin and image file paths, never the content-block iterable',async()=>{
  const {ManagedSessions}=require('./managed')
  const codex=require('./codex')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-img-')),project=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-img-cwd-'))
  const calls=[]
  const fake={available:()=>true,sessions:()=>[],history:()=>({messages:[]}),query(args){
    calls.push(args)
    const state={model:'gpt-x',started:new Set(),result:false},events=[{type:'thread.started',thread_id:'thread-img'},{type:'item.completed',item:{id:'m'+calls.length,type:'agent_message',text:'ok'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].flatMap(e=>codex.translate(e,state))
    return {close(){},async *[Symbol.asyncIterator](){yield* events}}
  }}
  const manager=new ManagedSessions({directory,codex:fake,queryFactory:async()=>{throw new Error('Claude must not be asked')}})
  const until=async f=>{for(let i=0;i<100 && !f();i++)await new Promise(r=>setTimeout(r,20))}
  const png=()=>({mediaType:'image/png',data:PNG_1x1.toString('base64')})
  try {
    const s=manager.create({engine:'codex',cwd:project,prompt:'What is in this?',approvalMode:'auto',images:[png()],requestId:randomUUID()})
    await until(()=>s.status==='idle'&&calls.length===1)
    assert.equal(typeof calls[0].prompt,'string');assert.equal(calls[0].prompt,'What is in this?')
    assert.equal(calls[0].images.length,1);assert.ok(fs.existsSync(calls[0].images[0]),'the image argument is a file on disk')
    manager.send(s.id,{message:'',images:[png(),png()],requestId:randomUUID()})
    await until(()=>s.status==='idle'&&calls.length===2)
    assert.equal(typeof calls[1].prompt,'string');assert.equal(calls[1].prompt,'See the attached images.')
    assert.equal(calls[1].images.length,2)
    assert.throws(()=>manager.send(s.id,{message:'x',images:[{mediaType:'image/gif',data:GIF_1x1.toString('base64')}],requestId:randomUUID()}),/Codex agents take PNG, JPEG and WebP/)
    const filesBefore=fs.readdirSync(manager.attachmentsDir).length
    assert.throws(()=>manager.send(s.id,{message:'x',images:[png(),{mediaType:'image/gif',data:GIF_1x1.toString('base64')}],requestId:randomUUID()}),/Codex agents take PNG, JPEG and WebP/)
    assert.equal(fs.readdirSync(manager.attachmentsDir).length,filesBefore,'a PNG saved before a rejected GIF is cleaned up')
    assert.equal(calls.length,2,'a rejected image never reaches the runtime')
    assert.equal(s.messages.filter(m=>m.role==='user').length,2,'a rejected message is not recorded')
  } finally { await manager.close(); fs.rmSync(directory,{recursive:true,force:true}) }
})

test('Claude still gets content blocks for images, and GIF stays allowed there',()=>{
  const {ManagedSessions}=require('./managed')
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-claude-img-'))
  const manager=new ManagedSessions({directory,queryFactory:async()=>{throw new Error('unused')}})
  try {
    const [a]=manager.saveImages([{mediaType:'image/gif',data:GIF_1x1.toString('base64')}])
    assert.equal(a.mediaType,'image/gif')
    const prompt=manager.promptFor({text:'',attachments:[a]})
    assert.equal(typeof prompt[Symbol.asyncIterator],'function')
    assert.equal(manager.promptFor({text:'hi',attachments:[a]},'codex'),'hi')
  } finally { fs.rmSync(directory,{recursive:true,force:true}) }
})
