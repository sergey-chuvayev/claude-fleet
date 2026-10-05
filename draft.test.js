'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const html=fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8')

test('the new-agent modal carries every launch control outside the inert workspace',()=>{
  for(const id of ['draft-panel','launch-form','launch-cwd','launch-team','launch-model','launch-mode','launch-prompt','launch-prompt-label','launch-submit','launch-error','launch-blocked','launch-team-note','launch-model-note','launch-model-status','customize-team','draft-discard','draft-title','draft-lead'])
    assert.ok(html.includes(`id="${id}"`),`#${id} is missing from index.html`)
  assert.ok(html.indexOf('id="launch-backdrop"') > html.indexOf('</main>'))
  assert.match(html, /id="draft-panel"[^>]*role="dialog"[^>]*aria-modal="true"/)
  assert.match(html, /id="launch-engine"[\s\S]*?value="codex"/)
  assert.match(html,/id="new-session"[^>]*aria-controls="launch-backdrop"/)
})

test('every control the draft form posts has a field in the pane',()=>{
  const form=html.slice(html.indexOf('id="launch-form"'),html.indexOf('</form>',html.indexOf('id="launch-form"')))
  for(const name of ['cwd','teamId','model','approvalMode','prompt'])
    assert.ok(form.includes(`name="${name}"`),`no field named ${name}`)
  assert.ok(!form.includes('name="name"'),'a new agent no longer asks for a name')
})

test('the launch form opens on Approve everything, the default for new agents',()=>{
  const select=html.match(/<select name="approvalMode"[\s\S]*?<\/select>/)[0]
  assert.match(select,/<option value="all" selected/)
  assert.equal((select.match(/ selected/g) || []).length,1)
})
