'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {Service,LABEL,RESTART_CODE}=require('./service')

// A Service on a throwaway home, with launchctl recorded instead of run.
function fixture({platform='darwin',env={},answers={}}={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-service-'))
  const calls=[]
  const run=(command,args)=>{calls.push([command,...args]);return answers[args[0]] || {status:0,stdout:'',stderr:''}}
  const svc=new Service({home,platform,uid:501,node:process.execPath,entry:'/opt/fleet/bin/claude-fleet.js',env,run})
  return {home,svc,calls,done:()=>fs.rmSync(home,{recursive:true,force:true})}
}

test('turning it on writes a login job that restarts only after an unclean exit, then loads it',()=>{
  const {svc,calls,done}=fixture({env:{CLAUDE_FLEET_HOME:'/tmp/fleet-home'}})
  try {
    const status=svc.enable({port:7788})
    assert.equal(status.enabled,true)
    const plist=fs.readFileSync(svc.file,'utf8')
    assert.match(plist,new RegExp(`<key>Label</key><string>${LABEL.replace(/\./g,'\\.')}</string>`))
    assert.match(plist,/<string>\/opt\/fleet\/bin\/claude-fleet\.js<\/string><string>start<\/string><string>--no-open<\/string>/)
    assert.match(plist,/<key>RunAtLoad<\/key><true\/>/)
    assert.match(plist,/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/,'a clean exit stays stopped; a crash or a restart code comes back')
    assert.match(plist,/<key>CLAUDE_FLEET_SERVICE<\/key><string>1<\/string>/)
    assert.match(plist,/<key>PORT<\/key><string>7788<\/string>/,'the service keeps the port the window already uses')
    assert.match(plist,/<key>CLAUDE_FLEET_HOME<\/key><string>\/tmp\/fleet-home<\/string>/)
    assert.match(plist,/\/usr\/local\/bin/,'the login PATH is widened so the claude CLI and npm are found')
    assert.deepEqual(calls.map(c=>c[1]),['bootout','bootstrap','print'],'clear any old job, load the new one, then report')
    assert.equal(calls.find(c=>c[1]==='bootstrap')[2],'gui/501')
  } finally { done() }
})

test('a job launchd refuses is not left behind',()=>{
  const {svc,done}=fixture({answers:{bootstrap:{status:5,stdout:'',stderr:'Bootstrap failed: 5: Input/output error'}}})
  try {
    assert.throws(()=>svc.enable(),/Bootstrap failed: 5/)
    assert.equal(fs.existsSync(svc.file),false)
  } finally { done() }
})

test('turning it off removes the job; the service process is not unloaded from under itself',()=>{
  const outside=fixture()
  try {
    outside.svc.enable()
    outside.calls.length=0
    assert.equal(outside.svc.disable().enabled,false)
    assert.ok(outside.calls.some(c=>c[1]==='bootout'),'a Fleet started some other way unloads the job at once')
  } finally { outside.done() }
  const inside=fixture({env:{CLAUDE_FLEET_SERVICE:'1'}})
  try {
    inside.svc.enable()
    inside.calls.length=0
    inside.svc.disable()
    assert.equal(fs.existsSync(inside.svc.file),false)
    assert.ok(!inside.calls.some(c=>c[1]==='bootout'),'unloading the job would end this very server')
  } finally { inside.done() }
})

test('running means launchd has the process up, not just the job loaded',()=>{
  const up=fixture({answers:{print:{status:0,stdout:'\tstate = running\n'}}})
  const loaded=fixture({answers:{print:{status:0,stdout:'\tstate = not running\n'}}})
  try { assert.equal(up.svc.running(),true); assert.equal(loaded.svc.running(),false) }
  finally { up.done(); loaded.done() }
})

test('other platforms say it is unavailable rather than failing',()=>{
  const {svc,calls,done}=fixture({platform:'linux'})
  try {
    assert.deepEqual(svc.status(),{supported:false,enabled:false,loaded:false,managed:false})
    assert.throws(()=>svc.enable(),/only available on macOS/)
    assert.equal(calls.length,0)
  } finally { done() }
})

test('a restart under launchd exits with the code launchd restarts on',()=>{
  assert.equal(RESTART_CODE,75)
  const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8')
  assert.match(source,/if\(service\.managed\)\{await app\.close\(\);process\.exit\(RESTART_CODE\)\}/)
})
