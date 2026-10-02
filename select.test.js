'use strict'
// The dropdown's decisions that do not need a page: type-ahead and where the menu opens.
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {match,placement}=require('./public/select')
const models=['Fleet default','Opus','Sonnet','Haiku','Auto · Jev']
test('type-ahead finds the next option that starts with what was typed, and cycles',()=>{
  assert.equal(match(models,'s'),2)
  assert.equal(match(models,'h',2),3)
  assert.equal(match(models,'au'),4)
  assert.equal(match(['Should','Must','Could'],'s',0),0,'typing the same letter again comes back round')
  assert.equal(match(['Should','Sometimes','Must'],'s',0),1,'or moves to the next match')
  assert.equal(match(models,'z'),-1)
  assert.equal(match(models,''),-1)
})
test('the menu opens below the trigger unless there is more room above',()=>{
  assert.equal(placement({top:100,bottom:132},200,900),'below')
  assert.equal(placement({top:760,bottom:792},200,900),'above','near the bottom edge it flips up')
  assert.equal(placement({top:120,bottom:152},800,900),'below','too tall for either side: the bigger side wins')
})
