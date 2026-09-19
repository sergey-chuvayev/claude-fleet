'use strict'
let controlToken=null, controlSession=null, controlId=null, controlFetch=null, controlVersion=0
const drafts=new Map()
const inFlight=new Set()
let launchRequestId=null, resumeSource=null, fallbackWarned=false, controlHandshake=null
const managedLabels={starting:'Starting Claude…',running:'Working on your task',approval:'Your input is needed',stopping:'Stopping the agent…',stopped:'Stopped · ready to continue',error:'Turn failed',idle:'Ready for your next message'}
const isWorking=s=>['starting','running','approval','stopping'].includes(s.status)

async function api(url,body) {
  // Opening the launch dialog fires several requests at once, and each one would
  // otherwise race its own handshake. Share the first attempt; a failed one is dropped
  // so the next call can retry.
  if(!controlToken) {
    controlHandshake ||= initializeControls().catch(error=>{controlHandshake=null;throw error})
    await controlHandshake
  }
  const response=await fetch(url,{method:body ? 'POST':'GET',headers:body ? {'content-type':'application/json','x-fleet-token':controlToken}: {},body:body ? JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)})
  const data=await response.json()
  if(!response.ok) throw new Error(data.error || 'The request failed.')
  return data
}
async function initializeControls() {
  const response=await fetch('/api/control',{cache:'no-store',signal:AbortSignal.timeout(8000)})
  if(!response.ok) throw new Error('Agent controls are unavailable. Restart the updated Fleet server.')
  const data=await response.json()
  controlToken=data.token
  // The running server's version, not the version on disk: a restart is what picks up an
  // update, and without this the difference is invisible until something 404s.
  if(data.version) $('app-version').textContent=`v${data.version}`
  if(!$('launch-cwd').value) $('launch-cwd').value=data.defaultCwd
}
let launchTeams=null, launchTeamsLoading=false
function updateLaunchTeam() {
  const team=resumeSource ? null : launchTeams?.find(t=>t.id===$('launch-team')?.value)
  $('launch-title').textContent=resumeSource ? 'Continue this conversation in Fleet.' : team ? 'Give your team a brief.' : 'Give your next task a home.'
  document.querySelector('label[for="launch-prompt"]').textContent=team ? 'Brief for the manager' : 'What are we working on?'
  document.querySelector('.launch-task-note').textContent=team ? `You talk to the ${team.manager || 'manager'}. They delegate to the team and bring the reports back here.` : 'Big ideas, small fixes. Every task starts here.'
  $('launch-prompt').placeholder=team ? 'Describe the goal, boundaries, verification steps, and what a good result looks like.' : 'There’s something I’d love your help with…\n\nDescribe the task, what a good result looks like, and anything your agent should know.'
  if(!$('launch-submit').disabled) $('launch-submit').textContent=team ? 'Launch initiative ↗' : 'Launch agent ↗'
  $('launch-team').disabled=!!resumeSource || launchTeamsLoading || $('launch-submit').disabled
  $('launch-team-note').textContent=resumeSource ? 'Continuing with the existing agent.' : team ? [team.description, `Roles: ${team.roles.map(r=>r.name).join(', ')}.`].filter(Boolean).join(' ') : launchTeamsLoading ? 'Loading teams…' : launchTeams ? 'No team keeps this a single-agent conversation.' : 'Teams unavailable. Reopen this dialog to retry; single agents are still available.'
}
async function loadLaunchTeams() {
  if(!$('launch-team')) {
    document.querySelector('.launch-fields').insertAdjacentHTML('afterbegin','<label for="launch-team">Team<select id="launch-team" name="teamId" aria-describedby="launch-team-note"><option value="">No team · single agent</option></select><span class="note" id="launch-team-note" role="status"></span></label>')
    $('launch-team').addEventListener('change',()=>{launchRequestId=null;updateLaunchTeam()})
  }
  if(launchTeams || launchTeamsLoading){updateLaunchTeam();return}
  launchTeamsLoading=true;updateLaunchTeam()
  try {
    const data=await api('/api/teams')
    if(!Array.isArray(data.teams)) throw new Error('Invalid teams')
    launchTeams=data.teams
    for(const team of launchTeams) $('launch-team').add(new Option(team.name,team.id))
  } catch { launchTeams=null }
  finally {launchTeamsLoading=false;updateLaunchTeam()}
}
let launchProjects=null, launchProjectsLoading=false
// A browser cannot offer a real directory picker — the File System Access API returns a
// handle and never a path — so the list comes from the server and the free-text path
// stays as the escape hatch for anything it does not know about.
const OTHER_PROJECT='__other__'
// Two checkouts can share a basename, so the parent earns its place in the label.
const projectLabel=project=>project.parent && project.parent!=='.' ? `${project.name} · ${project.parent}` : project.name
const pickedProject=()=>resumeSource ? null : launchProjects?.find(p=>p.path===$('launch-project').value)
// Keep the select showing whatever the path field holds, so hand-typing a known project
// does not leave the two controls disagreeing about where the agent will run.
function syncLaunchProject() {
  if(!launchProjects) return
  const match=launchProjects.find(p=>p.path===$('launch-cwd').value.trim())
  $('launch-project').value=match ? match.path : OTHER_PROJECT
}
function updateLaunchProject() {
  const picked=pickedProject()
  // The path input is what actually submits. Hiding it while it is `required` and empty
  // gives a form the browser refuses to submit and refuses to explain, so `required`
  // travels with visibility.
  $('launch-cwd-field').hidden=!!picked
  $('launch-cwd').required=!picked
  $('launch-project').disabled=!!resumeSource || launchProjectsLoading || $('launch-submit').disabled
  $('launch-project-note').textContent=resumeSource ? 'Continuing where this conversation left off.'
    : picked ? picked.short
    : launchProjectsLoading ? 'Looking for your projects…'
    : launchProjects ? 'Type where this agent should work.'
    : 'Could not read your projects. Type a path instead.'
}
async function loadLaunchProjects() {
  if(launchProjects || launchProjectsLoading){syncLaunchProject();updateLaunchProject();return}
  launchProjectsLoading=true;updateLaunchProject()
  try {
    const data=await api('/api/projects')
    if(!Array.isArray(data.projects)) throw new Error('Invalid projects')
    launchProjects=data.projects
    $('launch-project').replaceChildren()
    for(const project of launchProjects) $('launch-project').add(new Option(projectLabel(project),project.path))
    $('launch-project').add(new Option('Another path…',OTHER_PROJECT))
    syncLaunchProject()
  } catch { launchProjects=null;$('launch-project').replaceChildren(new Option('Another path…',OTHER_PROJECT)) }
  finally {launchProjectsLoading=false;updateLaunchProject()}
}
$('launch-project').addEventListener('change',()=>{
  launchRequestId=null
  const picked=pickedProject()
  if(picked) $('launch-cwd').value=picked.path
  updateLaunchProject()
  if(!picked) $('launch-cwd').focus()
})
$('launch-cwd').addEventListener('input',()=>{syncLaunchProject();updateLaunchProject()})
function openLaunch(source=null) {
  resumeSource=source
  $('launch-title').textContent=source ? 'Continue this conversation in Fleet.' : 'Give your next task a home.'
  if(source){$('launch-cwd').value=source.cwd || '';$('launch-form').elements.name.value=source.title || source.name || ''}
  loadLaunchTeams()
  loadLaunchProjects()
  $('launch-cwd').readOnly=!!source
  openModal('launch-backdrop', '[name=prompt]')
}
$('new-session').addEventListener('click',()=>modalIsOpen('launch-backdrop') ? closeModal() : openLaunch())
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    if (modalIsOpen('launch-backdrop')) $('launch-form').elements.prompt.focus()
    else openLaunch()
  }
})
$('launch-form').addEventListener('input',()=>{launchRequestId=null})
$('launch-form').addEventListener('submit',async event=>{
  event.preventDefault()
  const button=$('launch-submit'); if(button.disabled)return
  button.disabled=true;button.textContent='Launching…';$('launch-error').hidden=true
  const form=event.currentTarget
  form.querySelectorAll('input,textarea,select').forEach(el=>el.disabled=true)
  launchRequestId ||= crypto.randomUUID()
  try{
    const data=await api('/api/managed',{...(form.elements.teamId?.value && !resumeSource ? {teamId:form.elements.teamId.value}: {}),cwd:form.elements.cwd.value,name:form.elements.name.value,prompt:form.elements.prompt.value,approvalMode:form.elements.approvalMode.value,model:form.elements.model.value,requestId:launchRequestId,...(resumeSource ? {resumeSessionId:resumeSource.sessionId}: {})})
    selected=data.session.id;filter='all'
    form.elements.prompt.value='';launchRequestId=null
    closeModal()
    await tick();toast(form.elements.teamId?.value && !resumeSource ? 'Initiative launched' : 'Agent launched')
    if(matchMedia('(max-width:720px)').matches)$('detail').scrollIntoView({block:'start',behavior:'instant'})
  }catch(error){$('launch-error').textContent=error.message;$('launch-error').hidden=false}
  finally{button.disabled=false;button.textContent='Launch agent ↗';form.querySelectorAll('input,textarea,select').forEach(el=>el.disabled=false);if($('launch-team'))updateLaunchTeam();updateLaunchProject()}
})
function selectControl(session) {
  const next=session?.managedId || null
  if(next===controlId && next) return
  controlId=next;controlSession=null;controlVersion++
  $('control-panel').innerHTML=''
  if(next){
    $('control-panel').innerHTML=`<div class="conversation-header"><h3 id="conversation-title">Conversation</h3><button type="button" id="close-agent" class="button close-agent" title="Remove this conversation from Fleet">Close</button><label class="mode-picker"><span class="sr-only">Model for this agent</span><select id="model-choice" title="Applies from your next message"></select></label><label class="mode-picker"><span class="sr-only">Approvals for this agent</span><select id="approval-mode"><option value="auto">Auto approvals</option><option value="ask">Ask every time</option><option value="all">Approve everything</option></select></label><span id="agent-context" class="subtle context-chip"></span><span id="agent-state" class="subtle">Connecting…</span></div><div id="conversation" class="conversation" role="log" aria-label="Agent conversation" aria-live="off"><p class="note">Loading conversation…</p></div><div id="agent-error" class="form-error" role="status" hidden></div><div id="approvals"></div><form id="composer" class="composer"><label class="sr-only" for="message-input">Message this agent</label><ul id="slash-picker" class="slash-picker" role="listbox" aria-label="Commands and skills" hidden></ul><div id="attach-tray" class="attach-tray" hidden></div><textarea id="message-input" rows="3" maxlength="16000" placeholder="What should this agent do next?  ·  press / for commands  ·  paste an image" role="combobox" aria-expanded="false" aria-controls="slash-picker" aria-autocomplete="list"></textarea><div class="composer-footer"><span id="composer-hint" class="note">Enter to send · Shift + Enter for a new line</span><button id="stop-agent" type="button" class="button stop" hidden>■ Stop</button><button id="send-message" class="button resume" type="submit">Send ↗</button></div><p id="send-error" class="form-error" role="alert" hidden></p></form>`
    window.FleetLayout?.watchConversation($('conversation'))
    catalog=[];catalogFor=null;closePicker();renderTray()
    window.FleetLayout?.syncDetails?.()
    $('message-input').value=drafts.get(next)?.text || ''
    $('message-input').addEventListener('input',()=>drafts.set(next,{text:$('message-input').value,requestId:crypto.randomUUID()}))
    $('message-input').addEventListener('keydown',event=>{
      composerKeydown(event)
      if(event.defaultPrevented) return
      if(event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();if(!$('send-message').disabled)$('composer').requestSubmit()}
    })
    $('message-input').addEventListener('input',composerInput)
    $('message-input').addEventListener('paste',event=>{
      const files=[...(event.clipboardData?.items || [])].filter(i=>i.kind==='file' && i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean)
      if(!files.length) return            // ordinary text paste proceeds untouched
      event.preventDefault(); attachImages(files)
    })
    $('composer').addEventListener('dragover',event=>{ if([...(event.dataTransfer?.types || [])].includes('Files')){ event.preventDefault(); $('composer').classList.add('is-dropping') } })
    $('composer').addEventListener('dragleave',()=>$('composer').classList.remove('is-dropping'))
    $('composer').addEventListener('drop',event=>{ event.preventDefault(); $('composer').classList.remove('is-dropping'); attachImages([...(event.dataTransfer?.files || [])].filter(f=>f.type.startsWith('image/'))) })
    $('attach-tray').addEventListener('click',event=>{ const b=event.target.closest('[data-remove]'); if(b){ removeImage(Number(b.dataset.remove)) } })
    renderTray()
    $('message-input').addEventListener('blur',()=>setTimeout(closePicker,120))
    $('slash-picker').addEventListener('mousedown',event=>{
      const item=event.target.closest('[data-index]')
      if(item){event.preventDefault();insertPick(Number(item.dataset.index))}
    })
    $('composer').addEventListener('submit',sendMessage)
    $('approval-mode').addEventListener('change',changeMode)
    fillModels($('model-choice')).then(()=>$('model-choice')?.addEventListener('change',changeModel))
    $('close-agent').addEventListener('click',closeAgent)
    $('stop-agent').addEventListener('click',stopAgent)
    refreshControl()
  }else if(session){
    $('control-panel').innerHTML=`<div class="external-note"><strong>Opened outside Fleet</strong><p>${session.alive ? 'This session is running in a terminal. Use its terminal to send messages, or launch a new Fleet-managed agent.' : 'This process has stopped. Continue its saved conversation here with a new message.'}</p>${!session.alive && session.sessionId && session.cwd ? '<button id="resume-in-fleet" class="button">Continue in Fleet ↗</button>' : ''}</div>`
    $('resume-in-fleet')?.addEventListener('click',()=>openLaunch(session))
    window.FleetLayout?.syncDetails?.()
  }
}
async function refreshControl() {
  const id=controlId,version=controlVersion
  if(!id)return
  if(controlFetch?.id===id){controlFetch.again=true;return}
  const task={id,again:false};controlFetch=task
  try{
    const data=await api(`/api/managed/${id}`)
    if(controlId!==id || controlVersion!==version)return
    controlSession=data.session;renderControl()
  }catch(error){if(controlId===id && $('agent-error')){$('agent-error').hidden=false;$('agent-error').textContent=error.message}}
  finally{if(controlFetch===task)controlFetch=null;if(task.again && controlId===id)refreshControl()}
}
function renderControl() {
  const s=controlSession;if(!s || s.id!==controlId || !$('composer'))return
  $('conversation-title').textContent=s.aiTitle || s.name
  $('agent-state').textContent=s.currentTool && s.status==='running' ? `Using ${s.currentTool}` : managedLabels[s.status]
  $('agent-state').className=`subtle ${s.status==='approval' ? 'stale' : ''}`
  const used=s.contextTokens, limit=s.contextLimit || 200000
  const share=used==null ? null : Math.min(100,Math.round(used/limit*100))
  $('agent-context').textContent=share==null ? '' : `${share}%`
  $('agent-context').className=`subtle context-chip ${share>=90 ? 'hot' : share>=75 ? 'warn' : ''}`
  $('agent-context').title=share==null ? '' : `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used`
  if($('model-choice')!==document.activeElement && $('model-choice').options.length) $('model-choice').value=s.selectedModel || ''
  if($('approval-mode')!==document.activeElement) $('approval-mode').value=s.approvalMode || 'auto'
  $('approval-mode').dataset.mode=s.approvalMode || 'auto'
  $('agent-error').hidden=!s.error
  $('agent-error').textContent=s.error || ''
  const log=$('conversation'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<60
  const last=s.messages[s.messages.length-1]
  const streamingId=isWorking(s) && last?.role==='assistant' ? last.id : null
  if(!s.messages.length){
    if(!log.querySelector('.note')) log.innerHTML='<p class="note">Send your first instruction below.</p>'
  }else if(window.FleetBlocks){
    log.querySelector('.note')?.remove()
    window.FleetBlocks.renderBlocks(log,s.messages,{streamingId,onCopy:toast})
  }else{
    // Console assets unavailable — usually a page loaded from an older running server.
    update('conversation',s.messages.map(m=>`<article class="block" data-role="${esc(m.role)}"><div class="block-head"><span class="block-tool">${m.role==='tool' ? esc(m.tool) : m.role==='user' ? 'YOU' : 'CLAUDE'}</span><span class="block-meta">${new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><pre class="block-plain">${esc(m.role==='tool' ? [m.target,m.result].filter(Boolean).join('\n\n') : m.text)}</pre></article>`).join(''))
    if(!fallbackWarned){fallbackWarned=true;toast('Console assets did not load. Restart Fleet, then reload this page.')}
  }
  if(atBottom)log.scrollTop=log.scrollHeight
  // Approval DOM is independent of the streamed response so answers keep their focus and values.
  const ids=s.approvals.map(p=>p.id).join(',')
  if($('approvals').dataset.ids!==ids){$('approvals').dataset.ids=ids;renderApprovals(s.approvals)}
  const working=isWorking(s)
  const held=s.openElsewhere
  const heldText=held ? `Open ${held.entrypoint==='cli' ? 'in a terminal' : 'in another program'}${held.name ? ' · '+held.name : ''}${held.startedAt ? ' · since '+new Date(held.startedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}. Close it there to continue here.` : null
  if(held){ $('agent-state').textContent=held.state==='busy' ? 'Working in a terminal' : 'Open in a terminal'; $('agent-state').className='subtle stale' }
  $('send-message').disabled=working || inFlight.has(s.id) || !!held
  $('stop-agent').hidden=!working
  $('stop-agent').disabled=s.status==='stopping' || inFlight.has(`stop:${s.id}`)
  $('composer-hint').textContent=heldText || (working ? 'You can draft your next message while Claude works.' : 'Enter to send · Shift + Enter for a new line')
  $('composer-hint').classList.toggle('is-held',!!held)
}
function renderApprovals(approvals) {
  $('approvals').innerHTML=approvals.map(p=>{
    const question=p.tool==='AskUserQuestion'
    // Inside an initiative, which role wants this is the whole question. "Approve rm?" with
    // no name attached is how an operator ends up approving something the developer asked
    // for while believing the manager did.
    const who=p.role ? ` · ${esc(p.role.toUpperCase())}` : ''
    return `<form class="approval" data-approval="${esc(p.id)}"><div class="eyebrow">${question?'CLAUDE HAS A QUESTION':'APPROVAL REQUIRED'}${who}</div><h4>${esc(p.description || p.tool)}</h4>${p.reason && !question ? `<p class="approval-reason">${esc(p.reason)}</p>` : ''}${question ? (p.input.questions || []).map((q,i)=>`<fieldset><legend>${esc(q.question)}</legend>${(q.options || []).map(o=>`<label class="answer-option"><input type="${q.multiSelect?'checkbox':'radio'}" name="q${i}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description?`<small>${esc(o.description)}</small>`:''}</span></label>`).join('')}<label class="other-answer">Your answer<input type="text" name="other${i}" placeholder="Or type your own answer" maxlength="4000"></label></fieldset>`).join('') : `<pre class="tool-input">${esc(JSON.stringify(p.input,null,2))}</pre>`}<div class="approval-actions"><button class="button" type="button" data-deny="${esc(p.id)}">${question?'Skip question':'Deny'}</button><button class="button resume" type="submit">${question?'Send answer':'Allow once'}</button></div><p class="form-error" role="alert" hidden></p></form>`
  }).join('')
  $('approvals').querySelectorAll('form').forEach(form=>{
    const approval=approvals.find(p=>p.id===form.dataset.approval)
    form.addEventListener('submit',event=>{
      event.preventDefault()
      const answers={}
      if(approval.tool==='AskUserQuestion')for(const [i,q] of (approval.input.questions || []).entries()){
        const other=form.elements[`other${i}`].value.trim()
        const chosen=[...form.querySelectorAll(`input[name="q${i}"]:checked`)].map(input=>input.value)
        answers[q.question]=other || chosen.join(', ')
        if(!answers[q.question]){const e=form.querySelector('.form-error');e.hidden=false;e.textContent='Answer each question before continuing.';return}
      }
      decide(form,'allow',answers)
    })
    form.querySelector('[data-deny]').addEventListener('click',()=>decide(form,'deny'))
  })
}
async function decide(form,decision,answers) {
  const id=controlId,approval=form.dataset.approval
  const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true)
  try{await api(`/api/managed/${id}/approvals/${approval}`,{decision,answers});await refreshControl();await tick()}
  catch(error){const e=form.querySelector('.form-error');e.hidden=false;e.textContent=error.message;buttons.forEach(b=>b.disabled=false)}
}
const pendingImages=new Map()
const MAX_IMAGES=6, MAX_IMAGE_BYTES=8*1024*1024
const IMAGE_OK=new Set(['image/png','image/jpeg','image/gif','image/webp'])
const attachedImages=()=>pendingImages.get(controlId) || []
async function attachImages(files) {
  const list=attachedImages()
  for(const file of files){
    if(!IMAGE_OK.has(file.type)){ toast('Only PNG, JPEG, GIF and WebP images can be attached.'); continue }
    if(file.size>MAX_IMAGE_BYTES){ toast(`${file.name || 'That image'} is over 8 MB.`); continue }
    if(list.length>=MAX_IMAGES){ toast(`Up to ${MAX_IMAGES} images per message.`); break }
    const dataUrl=await new Promise((resolve,reject)=>{ const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(file) })
    list.push({ mediaType:file.type, dataUrl, bytes:file.size, name:file.name || 'Pasted image' })
  }
  pendingImages.set(controlId,list)
  renderTray()
  $('message-input')?.focus()
}
function removeImage(index) {
  const list=attachedImages(); list.splice(index,1); pendingImages.set(controlId,list); renderTray()
}
function renderTray() {
  const tray=$('attach-tray'); if(!tray) return
  const list=attachedImages()
  tray.hidden=!list.length
  tray.innerHTML=list.map((img,i)=>`<figure class="attach-thumb"><img src="${img.dataUrl}" alt="${esc(img.name)}"><figcaption>${esc(img.name)} · ${Math.round(img.bytes/1024)} KB</figcaption><button type="button" class="attach-remove" data-remove="${i}" aria-label="Remove ${esc(img.name)}">×</button></figure>`).join('')
  const hint=$('composer-hint'); if(hint && list.length && !isWorking(controlSession || {})) hint.textContent=`${list.length} image${list.length===1?'':'s'} attached · Enter to send`
}
async function sendMessage(event) {
  event.preventDefault()
  const id=controlId
  if(!id || inFlight.has(id) || !controlSession || isWorking(controlSession))return
  const message=$('message-input').value.trim()
  const images=attachedImages().map(img=>({ mediaType:img.mediaType, data:img.dataUrl.slice(img.dataUrl.indexOf(',')+1) }))
  if(!message && !images.length)return
  const draft=drafts.get(id) || {text:message,requestId:crypto.randomUUID()};drafts.set(id,draft)
  inFlight.add(id);renderControl();$('send-error').hidden=true
  try{
    await api(`/api/managed/${id}/messages`,{message,...(images.length ? {images} : {}),requestId:draft.requestId})
    if(drafts.get(id)?.requestId===draft.requestId){drafts.delete(id);if(controlId===id)$('message-input').value=''}
    pendingImages.delete(id); if(controlId===id) renderTray()
    await refreshControl();await tick()
  }catch(error){if(controlId===id){$('send-error').hidden=false;$('send-error').textContent=error.message}}
  finally{inFlight.delete(id);renderControl()}
}
// The model list comes from the running Claude runtime once one has reported it.
let modelList=null
async function fillModels(select) {
  try{ modelList ||= (await api('/api/models')).models || [] }catch{ modelList=[] }
  if(!select.isConnected) return
  const current=controlSession?.selectedModel || ''
  select.innerHTML=modelList.map(m=>`<option value="${esc(m.value)}" title="${esc(m.description || '')}">${esc(m.displayName || m.value || 'Default')}</option>`).join('')
  select.value=current
  if($('launch-model')) $('launch-model').innerHTML=select.innerHTML
}
async function changeModel(event) {
  const id=controlId, model=event.target.value
  try{ await api(`/api/managed/${id}/model`,{model}); await refreshControl(); toast(model ? `Next message uses ${event.target.selectedOptions[0].textContent}` : 'Back to the project default') }
  catch(error){ toast(error.message); refreshControl() }
}
async function changeMode(event) {
  const id=controlId, mode=event.target.value
  try{ await api(`/api/managed/${id}/mode`,{mode}); await refreshControl(); toast(mode==='ask' ? 'Every tool will ask' : mode==='all' ? 'Approving everything, including destructive commands' : 'Auto approvals on') }
  catch(error){ toast(error.message); refreshControl() }
}
async function closeAgent(event) {
  const id=controlId, button=event.currentTarget
  if(button.dataset.armed!=='1'){
    button.dataset.armed='1'
    button.textContent=controlSession && isWorking(controlSession) ? 'Stop and close?' : 'Close for good?'
    setTimeout(()=>{if(button.isConnected){button.dataset.armed='';button.textContent='Close'}},4000)
    return
  }
  button.disabled=true;button.textContent='Closing…'
  try{
    await api(`/api/managed/${id}/close`,{})
    if(controlId===id){selected=null;selectControl(null);$('control-panel').innerHTML=''}
    await tick()
    toast('Closed. Claude still has its own transcript of it.')
  }catch(error){button.disabled=false;button.dataset.armed='';button.textContent='Close';toast(error.message)}
}
async function stopAgent() {
  const id=controlId;if(!id || inFlight.has(`stop:${id}`))return
  inFlight.add(`stop:${id}`);renderControl()
  try{await api(`/api/managed/${id}/stop`,{});await refreshControl();await tick()}
  catch(error){toast(error.message)}finally{inFlight.delete(`stop:${id}`);renderControl()}
}
window.addEventListener('fleet-libs-ready',()=>{
  const log=$('conversation')
  if(log) for(const block of log.children) delete block.dataset.sig
  renderControl()
})
;(async()=>{ try{ modelList=(await api('/api/models')).models || []; if($('launch-model')) $('launch-model').innerHTML=modelList.map(m=>`<option value="${esc(m.value)}">${esc(m.displayName || m.value || 'Default')}</option>`).join('') }catch{} })()
initializeControls().catch(error=>toast(error.message))
const events=new EventSource('/api/events')
events.addEventListener('sessions',event=>{try{if(JSON.parse(event.data).includes(controlId))refreshControl()}catch{}})
events.onopen=()=>{refreshControl();tick()}
// Polling also recovers from a dropped event stream or a server restart.
setInterval(()=>{if(!document.hidden)refreshControl()},2500)
window.addEventListener('beforeunload',()=>events.close())

// Slash picker: typing `/` at the start of a line offers this project's commands
// and skills. It only inserts text into the composer; nothing runs until you send.
let catalog = [], catalogFor = null, picked = 0, matches = []
const SCOPE_LABEL = { project: 'project', user: 'user', plugin: 'plugin' }

async function loadCatalog(id) {
  if (catalogFor === id) return
  catalogFor = id
  try { catalog = (await api(`/api/managed/${id}/commands`)).commands || [] }
  catch { catalog = [] }
}
// The token being typed, or null when the caret is not in a slash word.
function slashQuery(input) {
  if (input.selectionStart !== input.selectionEnd) return null
  const before = input.value.slice(0, input.selectionStart)
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const match = line.match(/^\/([\w:-]*)$/)
  return match ? match[1] : null
}
function closePicker() {
  matches = []
  const list = $('slash-picker')
  if (list) { list.hidden = true; list.innerHTML = '' }
  $('message-input')?.removeAttribute('aria-activedescendant')
}
function renderPicker(query) {
  const list = $('slash-picker')
  if (!list) return
  const needle = query.toLowerCase()
  matches = catalog
    .filter(entry => entry.name.toLowerCase().includes(needle))
    // Prefer a prefix match, then the project's own entries.
    .sort((a, b) => (b.name.toLowerCase().startsWith(needle) - a.name.toLowerCase().startsWith(needle)) || 0)
    .slice(0, 40)
  if (!matches.length) return closePicker()
  picked = Math.min(picked, matches.length - 1)
  list.hidden = false
  list.innerHTML = matches.map((entry, index) => `<li id="slash-${index}" role="option" aria-selected="${index === picked}" class="${index === picked ? 'is-picked' : ''}" data-index="${index}"><span class="slash-name">/${esc(entry.name)}</span><span class="slash-kind">${entry.kind === 'skill' ? '◆' : '›'} ${esc(SCOPE_LABEL[entry.scope] || '')}</span>${entry.hint ? `<span class="slash-hint">${esc(entry.hint)}</span>` : ''}<span class="slash-desc">${esc(entry.description)}</span></li>`).join('')
  list.querySelector('.is-picked')?.scrollIntoView({ block: 'nearest' })
  $('message-input').setAttribute('aria-activedescendant', `slash-${picked}`)
}
function insertPick(index) {
  const entry = matches[index]
  const input = $('message-input')
  if (!entry || !input) return
  const before = input.value.slice(0, input.selectionStart)
  const start = before.lastIndexOf('\n') + 1
  const after = input.value.slice(input.selectionStart)
  const insertion = `/${entry.name} `
  input.value = input.value.slice(0, start) + insertion + after
  input.selectionStart = input.selectionEnd = start + insertion.length
  closePicker()
  input.focus()
  drafts.set(controlId, { text: input.value, requestId: crypto.randomUUID() })
}
function composerInput() {
  const query = slashQuery($('message-input'))
  if (query === null) return closePicker()
  picked = 0
  loadCatalog(controlId).then(() => { if (slashQuery($('message-input')) !== null) renderPicker(slashQuery($('message-input'))) })
  if (catalog.length) renderPicker(query)
}
function composerKeydown(event) {
  if (!matches.length) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    picked = (picked + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length
    return renderPicker(slashQuery($('message-input')) ?? '')
  }
  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); return insertPick(picked) }
  if (event.key === 'Tab') { event.preventDefault(); return insertPick(picked) }
  if (event.key === 'Escape') { event.preventDefault(); return closePicker() }
}

// ---- Updates -------------------------------------------------------------
// The server asks npm whether a newer Fleet has been published; the pill only
// appears when there is one, and nothing installs without a click.
let fleetUpdate = null, fleetUpdateBusy = false

// Takes its state as arguments rather than reading the two globals, so the states
// can be exercised one by one from a test.
function renderUpdate(update = fleetUpdate, busy = fleetUpdateBusy) {
  const pill = $('update-pill')
  if (!update || !update.available) { pill.hidden = true; return }
  pill.hidden = false
  pill.disabled = busy || !update.canInstall
  if (busy) {
    pill.textContent = update.state === 'installed' ? 'Restarting…' : 'Installing…'
    pill.title = 'Fleet will reload itself when this finishes.'
    return
  }
  pill.textContent = `↑ v${update.latest}`
  // A checkout is the operator's to pull; only an npm install can replace itself.
  pill.title = update.canInstall
    ? `Claude Fleet v${update.latest} is available. Click to install it and reload.`
    : update.channel === 'source'
      ? `v${update.latest} is published. This Fleet runs from a git checkout — update it with git pull.`
      : `v${update.latest} is published. This Fleet was not installed with npm, so it cannot update itself.`
}
async function pollUpdate() {
  try {
    const response = await fetch('/api/update', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!response.ok) return
    fleetUpdate = (await response.json()).update
    renderUpdate()
  } catch {} // An older server, or no network. Either way there is nothing to show.
}
// The server hands the port to the new version, so wait for it to answer again
// rather than reloading into a closed socket.
async function waitForRestart(deadline = Date.now() + 60000) {
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 700))
    try {
      const response = await fetch('/api/control', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      if (response.ok) return location.reload()
    } catch {}
  }
  fleetUpdateBusy = false
  renderUpdate()
  toast('Fleet installed the update but did not come back. Start it again.')
}
$('update-pill').addEventListener('click', async () => {
  if (fleetUpdateBusy || !fleetUpdate || !fleetUpdate.canInstall) return
  fleetUpdateBusy = true
  renderUpdate()
  try {
    const data = await api('/api/update', {})
    fleetUpdate = data.update
    renderUpdate()
    if (data.update.restarting) return waitForRestart()
    fleetUpdateBusy = false
    renderUpdate()
    toast(`v${data.update.installed} installed. Restart Fleet to use it.`)
  } catch (error) {
    fleetUpdateBusy = false
    fleetUpdate = { ...fleetUpdate, state: 'failed' }
    renderUpdate()
    toast(error.message || 'The update could not be installed.')
  }
})
pollUpdate()
// The first check runs in the background on the server; ask again once it has had
// time to answer, then settle into a slow poll for long-lived windows.
setTimeout(pollUpdate, 9000)
setInterval(pollUpdate, 60 * 60 * 1000)
