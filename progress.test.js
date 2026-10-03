'use strict'
// The weekly look: what shipped, what stalled, what ran.
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {summarize,prs}=require('./progress')
const DAY=86400000
const now=new Date(2026,9,3,15,0).getTime()
const ago=days=>now-days*DAY
const dateOf=at=>{const d=new Date(at);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const item=(id,status,extra={})=>({id,title:`Item ${id}`,status,links:[],needs:[],log:[],createdAt:ago(10),...extra})
const day=(daysAgo,items)=>({id:`day-${daysAgo}`,kind:'day',status:'idle',updatedAt:ago(daysAgo),dayBoard:{date:dateOf(ago(daysAgo)),items,cursors:{}}})
const agent=(id,status,daysAgo,extra={})=>({id,name:`Agent ${id}`,kind:'agent',status,createdAt:ago(daysAgo+1),updatedAt:ago(daysAgo),...extra})

test('shipped is done items on Days inside the window, with their pull requests',()=>{
  const out=summarize([
    day(0,[item('a','done',{links:['https://github.com/acme/api/pull/12?x=1','https://github.com/acme/api/pull/12','https://linear.app/acme/issue/T-1']}),item('b','today')]),
    day(2,[item('c','done')]),
    day(9,[item('old','done')]),
  ],{now})
  assert.deepEqual(out.shipped.items.map(i=>i.id),['a','c'])
  assert.deepEqual(out.shipped.items[0].prs,['https://github.com/acme/api/pull/12'])
  assert.equal(out.shipped.count,2)
  assert.equal(out.shipped.prs,1)
})
test('an item done on one Day and reopened on a later Day is not shipped',()=>{
  const out=summarize([day(2,[item('a','done')]),day(0,[item('a','today')])],{now})
  assert.equal(out.shipped.count,0)
})
test('stalled is an open item with no update in three days, however it last moved',()=>{
  const out=summarize([day(0,[
    item('quiet','in_progress',{createdAt:ago(5)}),
    item('noted','today',{createdAt:ago(5),log:[{at:ago(1),text:'did a thing'}]}),
    item('asked','waiting_on_you',{createdAt:ago(6),needs:[{at:ago(4),answeredAt:ago(0.5)}]}),
    item('later','later',{createdAt:ago(8)}),
    item('done','done',{createdAt:ago(8)}),
    item('edge','today',{createdAt:ago(3)}),
  ])],{now})
  assert.deepEqual(out.stalled.items.map(i=>i.id).sort(),['edge','quiet'])
  assert.equal(out.stalled.count,2)
})
test('stalled sessions are ones Fleet is still driving that stopped moving, not ones at rest',()=>{
  const out=summarize([agent('stuck','approval',4),agent('fine','running',1),agent('rest','idle',9),agent('end','stopped',9)],{now})
  assert.deepEqual(out.stalled.items.map(i=>[i.kind,i.id]),[['session','stuck']])
})
test('ran counts sessions active in the window by how they ended, leaving out Day and thread runs',()=>{
  const out=summarize([
    agent('a','idle',0),agent('b','error',1),agent('c','stopped',2),agent('d','idle',3),agent('old','idle',12),
    {...agent('scout','idle',0),kind:'day'},{...agent('t','idle',0),kind:'thread'},
  ],{now})
  assert.equal(out.ran.count,4)
  assert.deepEqual(out.ran.outcomes,{finished:2,failed:1,stopped:1})
  assert.deepEqual(out.ran.sessions.map(s=>s.id),['a','b','c','d'],'newest first')
})
test('empty data gives empty sections, not errors',()=>{
  const out=summarize([],{now})
  assert.equal(out.days,7)
  assert.deepEqual([out.shipped.count,out.stalled.count,out.ran.count],[0,0,0])
  assert.deepEqual(out.ran.outcomes,{})
})
test('only GitHub pull request links count as PRs',()=>{
  assert.deepEqual(prs({links:['https://github.com/a/b/issues/3','https://github.com/a/b/pull/4/files','https://example.com/pull/5']}),['https://github.com/a/b/pull/4'])
})
