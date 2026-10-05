'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createPrStatus,parsePr,classify,ghExecutable}=require('./pr-status')

const URL_A='https://github.com/example-org/demo-repo/pull/12'
const URL_B='https://github.com/example-org/demo-repo/pull/13'
const run=(name,conclusion,status='COMPLETED')=>({__typename:'CheckRun',name,status,conclusion})
const pr=(state,rollup,extra={})=>JSON.stringify({state,isDraft:false,title:'Add widget',url:URL_A,number:12,statusCheckRollup:rollup,...extra})

test('an open PR with every check green reads as open and passing',()=>{
  const s=parsePr(pr('OPEN',[run('build','SUCCESS'),run('lint','NEUTRAL'),run('docs','SKIPPED')]))
  assert.equal(s.state,'open')
  assert.deepEqual(s.ci,{result:'pass',failing:[],total:3,pending:0})
  assert.equal(s.number,12)
})

test('failing checks are named, and a failure outranks a check still running',()=>{
  const s=parsePr(pr('OPEN',[run('build','FAILURE'),run('e2e','TIMED_OUT'),run('lint','',"IN_PROGRESS"),run('unit','SUCCESS')]))
  assert.equal(s.ci.result,'fail')
  assert.deepEqual(s.ci.failing,['build','e2e'])
  assert.equal(s.ci.pending,1)
})

test('a check that has not finished is pending, not passing',()=>{
  const s=parsePr(pr('OPEN',[run('build','',"QUEUED"),run('lint','SUCCESS')]))
  assert.equal(s.ci.result,'pending')
  assert.deepEqual(s.ci.failing,[])
})

test('commit statuses count the same way as check runs',()=>{
  const s=parsePr(pr('OPEN',[{__typename:'StatusContext',context:'deploy/preview',state:'ERROR'},{__typename:'StatusContext',context:'ci/legacy',state:'PENDING'},{__typename:'StatusContext',context:'ci/ok',state:'SUCCESS'}]))
  assert.equal(s.ci.result,'fail')
  assert.deepEqual(s.ci.failing,['deploy/preview'])
  assert.equal(s.ci.pending,1)
})

test('a re-run replaces the earlier result of the same check',()=>{
  const s=parsePr(pr('OPEN',[run('build','FAILURE'),run('build','SUCCESS')]))
  assert.equal(s.ci.result,'pass')
  assert.equal(s.ci.total,1)
})

test('no checks at all is its own answer, and merged, closed and draft are kept',()=>{
  assert.equal(parsePr(pr('OPEN',[])).ci.result,'none')
  assert.equal(parsePr(pr('MERGED',[run('build','SUCCESS')])).state,'merged')
  assert.equal(parsePr(pr('CLOSED',null)).state,'closed')
  assert.equal(parsePr(pr('OPEN',[],{isDraft:true})).draft,true)
  assert.equal(parsePr(pr('WEIRD',[])).state,'unknown')
})

test('output that is not a PR throws rather than inventing a status',()=>{
  assert.throws(()=>parsePr('not json'))
  assert.throws(()=>parsePr('null'))
})

test('a failed gh call is sorted into why it failed',()=>{
  assert.equal(classify(Object.assign(new Error('spawn gh ENOENT'),{code:'ENOENT'})),'missing')
  assert.equal(classify({stderr:'To get started with GitHub CLI, please run:  gh auth login'}),'unauthenticated')
  assert.equal(classify({stderr:'HTTP 401: Bad credentials'}),'unauthenticated')
  assert.equal(classify({stderr:'GraphQL: API rate limit exceeded'}),'rate-limited')
  assert.equal(classify({stderr:'GraphQL: Could not resolve to a PullRequest with the number of 99.'}),'not-found')
  assert.equal(classify({stderr:'connection reset'}),'failed')
})

test('gh is found on PATH, then in the Homebrew locations a Dock launch lacks',()=>{
  assert.equal(ghExecutable({PATH:'/a:/b'},f=>f==='/b/gh'),'/b/gh')
  assert.equal(ghExecutable({PATH:'/a'},f=>f==='/opt/homebrew/bin/gh'),'/opt/homebrew/bin/gh')
  assert.equal(ghExecutable({PATH:'/a'},()=>false),'gh')
  assert.equal(ghExecutable({CLAUDE_FLEET_GH:'/custom/gh',PATH:'/a'},()=>true),'/custom/gh')
})

function clock(){let t=1000;const now=()=>t;now.advance=ms=>{t+=ms};return now}

test('answers are cached, concurrent asks share one gh call, and the cache expires',async()=>{
  const now=clock(),calls=[]
  const status=createPrStatus({now,run:async args=>{calls.push(args);return pr('OPEN',[run('build','SUCCESS')])}})
  const [a,b]=await Promise.all([status.get(URL_A),status.get(URL_A)])
  assert.equal(calls.length,1,'two asks at once are one gh call')
  assert.deepEqual(calls[0],['pr','view',URL_A,'--json','state,isDraft,title,url,number,statusCheckRollup'])
  assert.equal(a.ok,true);assert.equal(b.ci.result,'pass')
  await status.get(URL_A)
  assert.equal(calls.length,1,'a second ask inside the window is served from cache')
  now.advance(61000)
  await status.get(URL_A)
  assert.equal(calls.length,2,'an open PR is looked at again after a minute')
})

test('a merged PR is not re-read for ten minutes, and a pending one is re-read sooner',async()=>{
  const now=clock(),calls=[]
  const status=createPrStatus({now,run:async args=>{calls.push(args[2]);return args[2]===URL_A?pr('MERGED',[]):pr('OPEN',[run('build','',"IN_PROGRESS")])}})
  await status.get(URL_A);await status.get(URL_B)
  now.advance(35000)
  await status.get(URL_A);await status.get(URL_B)
  assert.deepEqual(calls,[URL_A,URL_B,URL_B])
})

test('a link that is not a GitHub PR never reaches gh',async()=>{
  const calls=[]
  const status=createPrStatus({run:async args=>{calls.push(args);return '{}'}})
  for(const bad of ['','https://example.com/a/b/pull/1','https://github.com/a/b/issues/1','--help','https://github.com/a/b/pull/1; rm -rf /','https://github.com/a/b/pull/1/files'])
    assert.deepEqual(await status.get(bad),{ok:false,url:bad,reason:'invalid'})
  assert.equal(calls.length,0)
})

test('a missing gh is an answer, and is not asked again for every PR',async()=>{
  const now=clock();let calls=0
  const status=createPrStatus({now,run:async()=>{calls++;throw Object.assign(new Error('spawn gh ENOENT'),{code:'ENOENT'})}})
  assert.deepEqual([await status.get(URL_A)].map(s=>[s.ok,s.reason]),[[false,'missing']])
  assert.equal((await status.get(URL_B)).reason,'missing')
  assert.equal(calls,1,'the second PR waited out the back-off instead of spawning gh')
  now.advance(301000)
  await status.get(URL_B)
  assert.equal(calls,2,'it tries again after the back-off')
})

test('signed-out and rate-limited gh back off the same way',async()=>{
  for(const [stderr,reason] of [['gh auth login','unauthenticated'],['API rate limit exceeded','rate-limited']]){
    let calls=0
    const status=createPrStatus({run:async()=>{calls++;throw Object.assign(new Error('exit 1'),{stderr})}})
    assert.equal((await status.get(URL_A)).reason,reason)
    assert.equal((await status.get(URL_B)).reason,reason)
    assert.equal(calls,1)
  }
})

test('one unreadable PR does not silence the others',async()=>{
  const calls=[]
  const status=createPrStatus({run:async args=>{calls.push(args[2]);if(args[2]===URL_A)throw Object.assign(new Error('exit 1'),{stderr:'Could not resolve to a PullRequest'});return pr('OPEN',[run('build','SUCCESS')])}})
  assert.equal((await status.get(URL_A)).reason,'not-found')
  assert.equal((await status.get(URL_B)).ok,true)
  assert.equal((await status.get(URL_A)).reason,'not-found')
  assert.deepEqual(calls,[URL_A,URL_B],'the failure is cached too')
})

test('no more than two gh calls run at once',async()=>{
  let live=0,peak=0
  const status=createPrStatus({run:async()=>{live++;peak=Math.max(peak,live);await new Promise(r=>setTimeout(r,10));live--;return pr('OPEN',[])}})
  await Promise.all([1,2,3,4,5].map(n=>status.get(`https://github.com/example-org/demo-repo/pull/${n}`)))
  assert.equal(peak,2)
})
