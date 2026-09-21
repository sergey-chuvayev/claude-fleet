'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {UsageTracker}=require('./usage')
const HOUR=3600000
const now=Date.UTC(2026,8,21,10,0,0)
const soon=Math.round((now+38*60000)/1000) // unix seconds, as the push event reports it

test('a pushed window is the live reading and the worst window is the one drawn',()=>{
  const usage=new UsageTracker()
  assert.equal(usage.snapshot({now}).known,false,'nothing measured yet is not zero')
  usage.recordEvent({status:'allowed',rateLimitType:'five_hour',utilization:62,resetsAt:soon},now)
  usage.recordUsage({subscription_type:'max',rate_limits_available:true,rate_limits:{
    seven_day:{utilization:31,resets_at:new Date(now+4*24*HOUR).toISOString()},
    seven_day_opus:{utilization:80,resets_at:new Date(now+4*24*HOUR).toISOString()},
  }},now)
  const snap=usage.snapshot({now})
  assert.equal(snap.known,true)
  assert.equal(snap.binding,'seven_day_opus','the binding window is the closest to stopping the fleet')
  assert.equal(snap.subscription,'max')
  assert.equal(snap.stale,false)
  assert.deepEqual(snap.windows.map(w=>[w.name,w.utilization]),[['five_hour',62],['seven_day',31],['seven_day_opus',80]])
  assert.equal(snap.windows[0].resetsAt,soon*1000,'unix seconds and ISO strings both land as epoch ms')
})

test('a reading older than the staleness window is reported as stale, never as current',()=>{
  const usage=new UsageTracker()
  usage.recordEvent({status:'allowed',rateLimitType:'five_hour',utilization:40,resetsAt:soon},now)
  assert.equal(usage.snapshot({now:now+60000}).stale,false)
  assert.equal(usage.snapshot({now:now+10*60000}).stale,true,'an idle Fleet stops refreshing and must say so')
})

test('plan limits that do not apply hide the cluster rather than reporting zero',()=>{
  const usage=new UsageTracker()
  usage.recordEvent({status:'allowed',rateLimitType:'five_hour',utilization:12,resetsAt:soon},now)
  usage.recordUsage({rate_limits_available:false,rate_limits:null},now)
  const snap=usage.snapshot({now})
  assert.equal(snap.available,false)
  assert.equal(snap.known,false)
  assert.deepEqual(snap.windows,[])
})

test('malformed or out-of-range readings are discarded instead of drawn',()=>{
  const usage=new UsageTracker()
  for (const info of [null,{},{rateLimitType:'five_hour'},{rateLimitType:'five_hour',utilization:-1},{rateLimitType:'five_hour',utilization:140},{rateLimitType:'five_hour',utilization:'62'}]) usage.recordEvent(info,now)
  usage.recordUsage({rate_limits:{five_hour:{utilization:NaN,resets_at:'not a date'}}},now)
  assert.equal(usage.snapshot({now}).known,false)
})

test('a rejection blocks the fleet until its window resets, whichever session hit it',()=>{
  const usage=new UsageTracker()
  // Nothing of Fleet's own is running: the only signal is another session's transcript.
  const rejection={at:now-60000,rateLimitType:'five_hour',resetsAt:soon,reason:'org_spend_cap_reached'}
  const blocked=usage.snapshot({now,rejection}).blocked
  assert.equal(blocked.rateLimitType,'five_hour')
  assert.equal(blocked.reason,'org_spend_cap_reached')
  assert.equal(blocked.source,'transcript')
  assert.equal(usage.snapshot({now:soon*1000+1,rejection}).blocked,null,'the block expires by itself at the reset')
})

test('a block with no reset time is dropped, because it could never clear itself',()=>{
  const usage=new UsageTracker()
  assert.equal(usage.snapshot({now,rejection:{at:now,rateLimitType:'five_hour',resetsAt:null}}).blocked,null)
  usage.recordEvent({status:'rejected',rateLimitType:'five_hour'},now)
  assert.equal(usage.snapshot({now}).blocked,null)
})

test('the newer of two blocks wins and an allowed turn clears the one from a run',()=>{
  const usage=new UsageTracker()
  const rejection={at:now-HOUR,rateLimitType:'seven_day',resetsAt:soon,reason:'out_of_credits'}
  usage.recordEvent({status:'rejected',rateLimitType:'five_hour',resetsAt:soon},now)
  assert.equal(usage.snapshot({now,rejection}).blocked.rateLimitType,'five_hour','the live rejection is newer')
  usage.recordEvent({status:'allowed',rateLimitType:'five_hour',utilization:5,resetsAt:soon},now+1000)
  const snap=usage.snapshot({now:now+1000,rejection})
  assert.equal(snap.blocked.rateLimitType,'seven_day','the transcript block stands until its own window resets')
  assert.equal(snap.windows[0].utilization,5)
})
