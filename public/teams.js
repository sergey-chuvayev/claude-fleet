'use strict'
// An isolated scope: Fleet's browser files are classic scripts.
window.FleetTeams=(()=>{
  const { esc, toast } = window.Fleet
  const control = () => window.FleetControl
  const api = (...args) => window.FleetControl.api(...args)
  let draft=null,tools=[],originalId=null,returnTeam=null,openToken=0
  const escape=value=>esc(String(value ?? ''))
  const field=(label,key,value,max=500)=>`<label>${label}<input data-team-field="${key}" value="${escape(value)}" maxlength="${max}" required></label>`
  function mount() {
    if(document.getElementById('team-editor'))return
    const container=document.createElement('section')
    container.id='team-editor';container.hidden=true;container.setAttribute('aria-label','Team editor')
    container.innerHTML='<div class="team-editor-head"><div><span class="modal-eyebrow">YOUR TEAM, YOUR WAY</span><h3>Shape the team.</h3><p class="note">Choose the specialists. Fleet handles task tracking and independent verification.</p></div><button type="button" class="button" id="team-editor-back">Back to task</button></div><div id="team-editor-fields"></div><p id="team-editor-error" class="form-error" role="alert" hidden></p><div class="team-editor-actions"><button type="button" class="button" id="team-add-role">+ Add role</button><button type="button" class="button resume" id="team-save">Save team</button></div>'
    document.getElementById('launch-form').append(container)
    container.querySelector('#team-editor-back').addEventListener('click',()=>toggle(false))
    container.querySelector('#team-add-role').addEventListener('click',()=>{try{read();if(Object.keys(draft.roles).length>=8)throw new Error('A team can have up to eight roles.');let key='specialist';while(draft.roles[key])key+='x';draft.roles[key]={description:'A specialist for this task',prompt:'Describe this specialist’s responsibility and expected output.',model:'sonnet',tools:['Read','Glob','Grep']};render()}catch(error){showError(error)}})
    container.querySelector('#team-save').addEventListener('click',save)
    container.querySelector('#team-editor-fields').addEventListener('change',event=>{if(['manager','reviewer'].includes(event.target.dataset.roleField))syncTools()})
    container.querySelector('#team-editor-fields').addEventListener('click',event=>{
      const button=event.target.closest('[data-remove-role]');if(!button)return
      try{read();const key=button.dataset.removeRole;if(key===draft.manager)throw new Error('Choose another manager before removing this role.');delete draft.roles[key];draft.workflow.reviewers=draft.workflow.reviewers.filter(r=>r!==key);render()}catch(error){showError(error)}
    })
  }
  function toggle(editing) {
    const form=document.getElementById('launch-form')
    form.noValidate=editing
    document.querySelector('.modal-launch').classList.toggle('is-editing-team',editing)
    for(const child of form.children)child.hidden=editing ? child.id!=='team-editor' : child.id==='team-editor' || child.id==='launch-error'
    // Hidden editor fields must not participate in the launch form's validation.
    document.querySelectorAll('#team-editor input,#team-editor textarea,#team-editor select').forEach(el=>el.disabled=!editing)
    if(editing){syncTools();document.querySelector('#team-editor input')?.focus()}
    else {document.getElementById('launch-team').value=returnTeam || '';control().updateLaunchTeam();document.getElementById('launch-prompt').focus()}
  }
  async function open() {
    mount()
    // Closing (or resetting) the launch modal bumps this past whatever token a call
    // to open() captured, so a fetch that resolves after the dialog moved on updates
    // nothing instead of quietly hijacking whatever's open now into team-edit mode.
    const token=++openToken
    try {
      const selected=document.getElementById('launch-team').value || 'delivery'
      const [data,catalog]=await Promise.all([api(`/api/teams/${encodeURIComponent(selected)}`),api('/api/teams')])
      if(token!==openToken)return
      tools=catalog.tools;draft=data.team;returnTeam=selected
      const custom=catalog.teams.find(t=>t.id===selected)?.custom
      originalId=custom ? selected:null
      if(!custom){draft.id=`${draft.id}-custom`;while(catalog.teams.some(t=>t.id===draft.id))draft.id+='-copy';draft.name+= ' · custom'}
      draft.workflow ||= {reviewers:['qa'],maxAttempts:3,budgetUsd:10}
      for(const [name,role] of Object.entries(draft.roles))role.tools ||= tools.filter(t=>!(role.disallowedTools || []).includes(t) && (name!==draft.manager || ['Read','Glob','Grep','WebSearch','WebFetch'].includes(t)))
      render();toggle(true)
    } catch(error){if(token===openToken)toast(error.message)}
  }
  function render() {
    document.getElementById('team-editor-error').hidden=true
    const roles=Object.entries(draft.roles)
    document.getElementById('team-editor-fields').innerHTML=`<div class="team-meta">${field('Team name','name',draft.name,80)}${field('Team ID','id',draft.id,60)}${field('Purpose','description',draft.description,500)}</div><div class="team-rules"><label>Repair attempts per task<input data-team-field="maxAttempts" type="number" min="1" max="10" value="${draft.workflow.maxAttempts}"></label><label>Usage cap · API-rate equivalent<input data-team-field="budgetUsd" type="number" min="0.1" max="1000" step="0.1" value="${draft.workflow.budgetUsd}"></label></div><p class="note">The usage cap is not a bill. It’s the API-rate equivalent the SDK reports, accumulated across the whole initiative; on a Claude subscription nothing is charged. Reaching the cap still stops the run.</p><p class="note">One manager talks to you. Verification roles check every task; at least one separate worker does the work. Shell access permits commands and is governed by your approval mode.</p><div class="team-role-list">${roles.map(([key,role],index)=>`<details class="team-role" data-role-key="${escape(key)}" ${index===0 ? 'open':''}><summary><strong>${escape(key)}</strong><span>${escape(role.description)}</span><small>${escape(role.model)}</small></summary><div class="team-role-fields"><label>Role ID<input data-role-field="id" value="${escape(key)}" maxlength="40" required></label><label>Model<input data-role-field="model" value="${escape(role.model || 'inherit')}" list="team-model-options" maxlength="80" required></label><label class="team-wide">Purpose<input data-role-field="description" value="${escape(role.description)}" maxlength="500" required></label><label class="team-wide">Instructions<textarea data-role-field="prompt" rows="6" maxlength="12000" required>${escape(role.prompt)}</textarea></label><div class="team-role-kind team-wide"><label><input type="radio" name="team-manager-role" data-role-field="manager" ${key===draft.manager ? 'checked':''}> Manager</label><label><input type="checkbox" data-role-field="reviewer" ${draft.workflow.reviewers.includes(key) ? 'checked':''}> Required verifier</label><button type="button" class="button" data-remove-role="${escape(key)}">Remove role</button></div><fieldset class="team-wide"><legend>Allowed tools</legend><div class="team-tools">${tools.map(tool=>`<label><input type="checkbox" data-tool="${escape(tool)}" ${(role.tools || []).includes(tool) ? 'checked':''}> ${escape(tool)}</label>`).join('')}</div></fieldset></div></details>`).join('')}</div><datalist id="team-model-options"><option value="opus"><option value="sonnet"><option value="haiku"><option value="inherit"></datalist>`
    document.querySelector('[data-team-field="id"]').readOnly=!!originalId
    syncTools()
  }
  function syncTools() {
    for(const row of document.querySelectorAll('#team-editor [data-role-key]')) {
      const manager=row.querySelector('[data-role-field="manager"]').checked
      const verifier=row.querySelector('[data-role-field="reviewer"]').checked
      for(const el of row.querySelectorAll('[data-tool]')) {
        el.disabled=(manager && !['Read','Glob','Grep','WebSearch','WebFetch'].includes(el.dataset.tool)) || (verifier && ['Write','Edit','MultiEdit','NotebookEdit'].includes(el.dataset.tool))
        if(el.disabled)el.checked=false
      }
    }
  }
  function read() {
    const next={roles:{},workflow:{reviewers:[]}}
    for(const el of document.querySelectorAll('[data-team-field]')) {
      const key=el.dataset.teamField
      if(['maxAttempts','budgetUsd'].includes(key))next.workflow[key]=Number(el.value)
      else next[key]=el.value.trim()
    }
    for(const row of document.querySelectorAll('#team-editor [data-role-key]')) {
      const value=key=>row.querySelector(`[data-role-field="${key}"]`)
      const id=value('id').value.trim()
      if(!/^[a-z][a-z0-9-]{0,39}$/.test(id) || ['constructor','prototype','__proto__'].includes(id))throw new Error('Role IDs need lowercase letters, numbers and hyphens.')
      if(Object.hasOwn(next.roles,id))throw new Error(`Role ID “${id}” is used twice.`)
      next.roles[id]={description:value('description').value.trim(),prompt:value('prompt').value.trim(),model:value('model').value.trim(),tools:[...row.querySelectorAll('[data-tool]:checked')].map(el=>el.dataset.tool)}
      if(value('manager').checked)next.manager=id
      if(value('reviewer').checked)next.workflow.reviewers.push(id)
    }
    draft=next
  }
  function showError(error){const el=document.getElementById('team-editor-error');el.textContent=error.message;el.hidden=false}
  async function save() {
    const button=document.getElementById('team-save');button.disabled=true
    try {
      read();const {team}=await api('/api/teams',draft)
      const catalog=await api('/api/teams');control().setLaunchTeams(catalog.teams)
      const select=document.getElementById('launch-team');select.replaceChildren(new Option('No team · single agent',''))
      for(const t of catalog.teams)select.add(new Option(t.name,t.id))
      returnTeam=team.id;control().setLaunchRequestId(null);toggle(false);toast('Team saved. Ready for your task.')
    } catch(error){showError(error)}finally{button.disabled=false}
  }
  // The model actually reported by a delegation wins; a role's configured model is
  // only a fallback for a delegation that has not reported one yet (still running,
  // or resumed before its first assistant event).
  const handoffModel=(s,d)=>d.model || s.teamSnapshot.roles[d.role]?.model || ''
  // Assignment and report each get their own collapsed <details>, keyed into the same
  // data-evidence disclosure tracking as the task and handoff they live inside.
  function handoffHtml(s,d,opened) {
    const model=handoffModel(s,d)
    const mandateId=`${d.id}-mandate`,reportId=`${d.id}-report`
    return `<details class="initiative-handoff" data-evidence="${d.id}" ${opened.has(d.id) ? 'open':''}><summary>${escape(s.teamSnapshot.manager)} → ${escape(d.role)} <span>${escape(d.status)}${d.activity && d.status==='running' ? ' · '+escape(d.activity):''}</span>${model ? `<small>${escape(model)}</small>`:''}</summary><details class="handoff-mandate" data-evidence="${mandateId}" ${opened.has(mandateId) ? 'open':''}><summary>Assignment</summary><pre>${escape(d.prompt)}</pre></details><details class="handoff-report" data-evidence="${reportId}" ${opened.has(reportId) ? 'open':''}><summary>Report to ${escape(s.teamSnapshot.manager)}</summary><pre>${escape(d.report || 'Waiting for the agent’s report.')}</pre></details></details>`
  }
  function board(s) {
    let panel=document.getElementById('initiative-board')
    if(!s.teamSnapshot?.workflow){panel?.remove();return}
    if(!panel){panel=document.createElement('details');panel.id='initiative-board';panel.open=true;document.getElementById('conversation').before(panel);panel.addEventListener('click',event=>{if(event.target.closest('[data-adjust-limits]'))adjustLimits(s.id)})}
    const b=s.taskBoard || {tasks:[],delegations:[]},done=b.tasks.filter(t=>t.status==='verified').length
    const signature=JSON.stringify([b,s.status,s.costUsd,s.teamSnapshot,s.limits])
    if(panel.fleetSignature===signature)return
    const opened=new Set([...panel.querySelectorAll('details[open][data-evidence]')].map(el=>el.dataset.evidence))
    const scrollTop=panel.querySelector('.initiative-body')?.scrollTop || 0
    const focused=document.activeElement?.closest('[data-evidence]')?.dataset.evidence
    panel.fleetSignature=signature
    const active=b.delegations.find(d=>d.status==='running')
    panel.innerHTML=`<summary><strong>${escape(s.teamName)}</strong><span>${done}/${b.tasks.length} verified</span><span title="API-rate equivalent the SDK reports. Not billed on a Claude subscription; the run still stops here.">$${(s.costUsd || 0).toFixed(2)} / $${s.limits?.budgetUsd ?? s.teamSnapshot.workflow.budgetUsd} cap</span></summary><div class="initiative-body"><div class="initiative-roster" aria-label="Team and active agent">${Object.entries(s.teamSnapshot.roles).map(([name,r])=>`<div class="initiative-role ${(active?.role || (control().isWorking(s) ? s.teamSnapshot.manager:null))===name ? 'is-active':''}"><strong>${escape(name)}</strong><small>${escape(name===s.teamSnapshot.manager && s.selectedModel ? s.selectedModel : r.model)}${name===s.teamSnapshot.manager ? ' · your contact':active?.role===name ? ' · working':''}</small></div>`).join('<span class="team-connector" aria-hidden="true">·</span>')}</div>${b.tasks.length ? `<ol class="initiative-tasks">${b.tasks.map(t=>`<li><details data-evidence="${t.id}" ${opened.has(t.id) ? 'open':''}><summary><span class="task-state" data-state="${escape(t.status)}">${escape(t.status.replaceAll('_',' '))}</span><strong>${escape(t.title)}</strong><small>${escape(t.owner)} · attempt ${t.attempt}</small></summary><ul>${t.criteria.map(c=>`<li>${escape(c)}</li>`).join('')}</ul>${t.blocker ? `<p class="form-error">${escape(t.blocker)}</p>`:''}${t.dependencies.length ? `<p class="note">After: ${t.dependencies.map(id=>escape(b.tasks.find(t=>t.id===id)?.title || id)).join(', ')}</p>`:''}${b.delegations.filter(d=>d.taskId===t.id).map(d=>handoffHtml(s,d,opened)).join('')}</details></li>`).join('')}</ol>`:'<p class="note">The manager is shaping your brief. Tasks and handoffs will appear here as work begins.</p>'}<button type="button" class="button" data-adjust-limits ${control().isWorking(s) ? 'disabled':''}>Adjust limits</button><p class="note">Verified means all configured verifiers returned passing reports for that task’s attempt. Expand a task to inspect the evidence.</p></div>`
    panel.querySelector('.initiative-body').scrollTop=scrollTop
    if(focused)panel.querySelector(`[data-evidence="${CSS.escape(focused)}"]>summary`)?.focus({preventScroll:true})
    const composer=document.getElementById('message-input');composer.placeholder=`Message ${s.teamSnapshot.manager}…`
  }
  async function adjustLimits(id){
    const s=controlSession;if(!s || s.id!==id)return
    const panel=document.getElementById('initiative-board')
    if(panel.querySelector('.initiative-limits'))return
    const box=document.createElement('div');box.className='initiative-limits'
    box.innerHTML=`<label>Usage cap · API-rate equivalent<input type="number" data-limit="budgetUsd" min="0.1" max="1000" step="0.1" value="${s.limits?.budgetUsd ?? s.teamSnapshot.workflow.budgetUsd}"></label><label>Attempts per task<input type="number" data-limit="maxAttempts" min="1" max="10" value="${s.limits?.maxAttempts ?? s.teamSnapshot.workflow.maxAttempts}"></label><button type="button" class="button">Save limits</button><p class="note">Not a bill: the SDK reports this as an API-rate equivalent, and a Claude subscription is charged nothing. The cap still stops the run.</p><p class="form-error" role="alert" hidden></p>`
    panel.querySelector('.initiative-body').append(box)
    box.querySelector('input').focus()
    box.querySelector('button').addEventListener('click',async event=>{
      event.target.disabled=true
      try{const limits=Object.fromEntries([...box.querySelectorAll('[data-limit]')].map(el=>[el.dataset.limit,Number(el.value)]));await api(`/api/managed/${id}/limits`,limits);await refreshControl();toast('Limits saved. Message the manager to continue.')}
      catch(error){const el=box.querySelector('p');el.textContent=error.message;el.hidden=false;event.target.disabled=false}
    })
  }
  function reset(){openToken++;if(document.getElementById('team-editor'))toggle(false)}
  return {open,board,reset,save,isEditing:()=>!!document.getElementById('team-editor') && !document.getElementById('team-editor').hidden}
})()
