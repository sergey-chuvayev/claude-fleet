'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {execFileSync}=require('node:child_process')
const {randomUUID}=require('node:crypto')
const worktrees=require('./worktree')

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()

// assert.throws does not hand the error back, and these failures are interesting for the
// status they carry, not only for their message.
function refused(fn){try{fn()}catch(error){return error}throw Error('Expected this to be refused')}

function repo({commit=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-worktree-'))
  git(dir,'init','-q','-b','main')
  git(dir,'config','user.email','test@example.invalid')
  git(dir,'config','user.name','Fleet Test')
  if(commit){fs.writeFileSync(path.join(dir,'README.md'),'hi');git(dir,'add','README.md');git(dir,'commit','-qm','initial')}
  return dir
}

test('an initiative outside a git repository is refused with a usable message',()=>{
  const plain=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-plain-'))
  const error=refused(()=>worktrees.create({cwd:plain,id:randomUUID(),name:'Fix the thing'}))
  assert.equal(error.status,400)
  assert.match(error.message,/needs a git repository/)
})

test('a repository with no commits is refused rather than half-created',()=>{
  const dir=repo({commit:false})
  const error=refused(()=>worktrees.create({cwd:dir,id:randomUUID(),name:'Fix the thing'}))
  assert.equal(error.status,400)
  assert.match(error.message,/no commits/)
})

test('creates a branch and a worktree outside the operator checkout',()=>{
  const dir=repo()
  const id=randomUUID()
  const wt=worktrees.create({cwd:dir,id,name:'Fix the login redirect'})
  assert.equal(wt.branch,'initiative/fix-the-login-redirect')
  assert.equal(wt.base,'main')
  assert.ok(fs.existsSync(path.join(wt.path,'README.md')),'the worktree is a real checkout')
  // The point of the worktree: the operator's own tree is untouched and still on main.
  assert.equal(git(dir,'rev-parse','--abbrev-ref','HEAD'),'main')
  assert.ok(!wt.path.startsWith(fs.realpathSync(dir)),'Fleet must not create directories inside the project')
  assert.equal(git(wt.path,'rev-parse','--abbrev-ref','HEAD'),wt.branch)
  assert.ok(worktrees.remove(wt))
  assert.equal(fs.existsSync(wt.path),false)
})

test('a second initiative with the same name does not collide',()=>{
  const dir=repo()
  const first=worktrees.create({cwd:dir,id:randomUUID(),name:'Fix the thing'})
  const second=worktrees.create({cwd:dir,id:randomUUID(),name:'Fix the thing'})
  assert.equal(first.branch,'initiative/fix-the-thing')
  assert.notEqual(second.branch,first.branch)
  assert.notEqual(second.path,first.path)
  worktrees.remove(first);worktrees.remove(second)
})

test('a name that is all punctuation still yields a usable branch',()=>{
  const dir=repo()
  const wt=worktrees.create({cwd:dir,id:'abcdef1234',name:'!!! ??? ***'})
  assert.equal(wt.branch,'initiative/abcdef12')
  worktrees.remove(wt)
})

test('slugify refuses to emit anything a shell or git would choke on',()=>{
  assert.equal(worktrees.slugify('Fix the Login  Redirect!','x'),'fix-the-login-redirect')
  assert.equal(worktrees.slugify('   ','fallback'),'fallback')
  assert.equal(worktrees.slugify('../../etc/passwd','x'),'etc-passwd')
  assert.equal(worktrees.slugify('a; rm -rf /','x'),'a-rm-rf')
  assert.ok(worktrees.slugify('x'.repeat(200),'y').length<=40)
})

test('removing a worktree that is already gone reports false rather than throwing',()=>{
  assert.equal(worktrees.remove(null),false)
  assert.equal(worktrees.remove({path:'/nonexistent',repo:'/nonexistent'}),false)
})
