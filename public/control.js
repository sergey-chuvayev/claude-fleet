'use strict'
// An isolated scope, matching teams.js and blocks.js. What this file borrows from
// app.js is destructured once, here, instead of being picked out of a global scope
// the two files happened to share.
;(() => {
const { $, esc, update, toast, tick, store } = window.Fleet
let controlToken=null, controlSession=null, controlId=null, controlFetch=null, controlVersion=0, refreshedAt=0
const drafts=new Map()
const inFlight=new Set()
const LAST_CWD='fleet:launch-cwd'
let launchRequestId=null, resumeSource=null, fallbackWarned=false, referencesAvailable=false
const managedLabels={starting:'Starting Claude…',running:'Working on your task',approval:'Your input is needed',stopping:'Stopping the agent…',stopped:'Stopped · ready to continue',error:'Turn failed',idle:'Ready for your next message',queued:'Queued · waiting for a free slot'}
const isWorking=s=>['starting','running','approval','stopping'].includes(s.status)

async function api(url,body) {
  if(!controlToken) await initializeControls()
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
  referencesAvailable=data.supportsSessionReferences===true
  if(data.defaultApprovalMode) $('launch-mode').value=data.defaultApprovalMode
  if(!$('launch-cwd').value) $('launch-cwd').value=store.get(LAST_CWD) || data.defaultCwd
}
let launchTeams=null, launchTeamsLoading=false
// The terminal session the console is showing, if it is one.
let outsideSession=null
function updateLaunchTeam() {
  const team=resumeSource ? null : launchTeams?.find(t=>t.id===$('launch-team')?.value)
  const ownerReview=team?.mode==='owner-review'
  const heading=resumeSource ? 'Continue this conversation in Fleet.' : ownerReview ? 'Give your owner a task.' : team ? 'Give your team a brief.' : 'What are we working on?'
  $('draft-title').textContent=heading
  $('launch-prompt-label').textContent=ownerReview ? 'Task for the owner' : team ? 'Brief for the manager' : 'What are we working on?'
  $('draft-lead').textContent=resumeSource ? 'Your next message picks up where it left off.' : ownerReview ? 'Your owner implements, tests and finishes the request. One independent reviewer checks the changes.' : team ? `You talk to the ${team.manager || 'manager'}. They delegate to the team and bring the reports back here.` : 'One agent, one task. Pick a team to hand it to a manager instead.'
  $('launch-prompt').placeholder=resumeSource ? 'Pick up where you left off…' : ownerReview ? 'Describe the task, the expected behavior, and any constraints. Your owner will implement it and request independent review.' : team ? 'Describe what you want to accomplish. Your manager will work out the tasks and bring back any questions.' : 'Describe the task and what a good result looks like…'
  if(!$('launch-submit').disabled) $('launch-submit').textContent=team ? 'Launch initiative ↗' : 'Launch agent ↗'
  $('customize-team').disabled=!!resumeSource || launchTeamsLoading || $('launch-submit').disabled
  $('customize-team').hidden=!!resumeSource
  $('launch-team').disabled=!!resumeSource || launchTeamsLoading || $('launch-submit').disabled
  $('launch-team').closest('label').hidden=!!resumeSource
  $('launch-team-note').textContent=team ? [team.description, `Roles: ${team.roles.map(r=>r.name).join(', ')}.`].filter(Boolean).join(' ') : launchTeamsLoading ? 'Loading teams…' : launchTeams ? '' : 'Teams unavailable. Reopen New agent to retry; single agents still work.'
  $('launch-model-note').hidden=$('launch-model').value!=='auto-jev'
}
async function loadLaunchTeams() {
  if(!$('customize-team').dataset.wired) {
    $('customize-team').dataset.wired='1'
    $('customize-team').addEventListener('click',()=>window.FleetTeams.open())
    $('launch-team').addEventListener('change',()=>{launchRequestId=null;updateLaunchTeam()})
    $('launch-model').addEventListener('change',updateLaunchTeam)
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
// A new agent is a draft row, not a dialog. Opening it again keeps whatever was typed;
// only continuing an existing conversation starts the form over, because that one is
// pinned to a directory and a transcript.
function openLaunch(source=null) {
  const views=window.FleetViews
  if(views && views.view()!=='sessions') views.switchView('sessions')
  if(!window.Fleet.draft() || source) {
    window.FleetTeams?.reset()
    resumeSource=source
    const form=$('launch-form'), cwd=form.elements.cwd.value
    form.reset()
    form.elements.cwd.value=source ? source.cwd || '' : cwd || store.get(LAST_CWD) || ''
    $('launch-error').hidden=true
    launchRequestId=null
    $('launch-cwd').readOnly=!!source
  }
  window.Fleet.setDraft(true)
  loadLaunchTeams()
  fillLaunchModels()
  if(matchMedia('(max-width:720px)').matches)$('detail').scrollIntoView({block:'start',behavior:'instant'})
  $('launch-prompt').focus()
}
function discardDraft() {
  window.FleetTeams?.reset()
  $('launch-form').reset()
  resumeSource=null;launchRequestId=null
  $('launch-error').hidden=true
  window.Fleet.setDraft(false)
}
// ── What the rest of the page may use ───────────────────────────────────────
// Published before the boot wiring below, for the same reason app.js does it there:
// teams.js destructures this at load, and an element missing from the wiring must
// not cost it the whole namespace. The two values teams.js has to change are handed
// out as setters rather than as variables it reaches in and assigns.
window.FleetControl = {
  selectControl, isWorking, updateLaunchTeam, renderUpdate, openLaunch,
  // teams.js posts to the same endpoints through the same helper, and app.js and
  // ask.js borrow it back: this file owns the token every write is signed with.
  api,
  // The conversation this file is currently showing. Handed out through a function,
  // never as a live binding, so a caller cannot hold one and read a stale session after
  // the next refresh. teams.js needs it to know which initiative a board action is for.
  session: () => controlSession,
  // day.js redraws its board after an answer without waiting for the next poll.
  refresh: () => refreshControl(),
  launchTeams: () => launchTeams,
  setLaunchTeams(teams) { launchTeams = teams },
  setLaunchRequestId(id) { launchRequestId = id },
}

// ── Boot ────────────────────────────────────────────────────────────────────
$('new-session')?.addEventListener('click',()=>openLaunch())
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    openLaunch()
  }
})
$('draft-discard')?.addEventListener('click',discardDraft)
$('launch-form')?.addEventListener('input',()=>{launchRequestId=null})
// Enter launches, as it sends in a conversation; Shift + Enter and IME composition do not.
$('launch-prompt')?.addEventListener('keydown',event=>{
  if(event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();$('launch-form').requestSubmit()}
})
$('launch-form')?.addEventListener('submit',async event=>{
  event.preventDefault()
  if(window.FleetTeams?.isEditing()){window.FleetTeams.save();return}
  const button=$('launch-submit'); if(button.disabled)return
  const form=event.currentTarget
  if(!form.elements.prompt.value.trim()){form.elements.prompt.focus();return}
  if(!form.elements.cwd.value.trim()){$('launch-error').textContent='Choose the directory this agent works in.';$('launch-error').hidden=false;form.elements.cwd.focus();return}
  button.disabled=true;button.textContent='Launching…';$('launch-error').hidden=true
  form.querySelectorAll('input,textarea,select').forEach(el=>el.disabled=true)
  launchRequestId ||= crypto.randomUUID()
  try{
    const data=await api('/api/managed',{...(form.elements.teamId?.value && !resumeSource ? {teamId:form.elements.teamId.value}: {}),cwd:form.elements.cwd.value,name:resumeSource ? resumeSource.title || resumeSource.name || '' : '',prompt:form.elements.prompt.value,approvalMode:form.elements.approvalMode.value,model:form.elements.model.value,requestId:launchRequestId,...(resumeSource ? {resumeSessionId:resumeSource.sessionId}: {})})
    const team=form.elements.teamId?.value && !resumeSource
    if(!resumeSource)store.set(LAST_CWD,form.elements.cwd.value.trim())
    form.elements.prompt.value='';launchRequestId=null;resumeSource=null
    await tick()
    window.Fleet.setDraft(false)
    window.Fleet.setFilter('all')
    // A new agent lives in Sessions; launched from Today or Projects, go there to see it.
    window.FleetViews?.switchView('sessions')
    window.Fleet.select(data.session.id)
    toast(data.session.status==='queued' ? 'Task queued' : team ? 'Initiative launched' : 'Agent launched')
    if(matchMedia('(max-width:720px)').matches)$('detail').scrollIntoView({block:'start',behavior:'instant'})
  }catch(error){$('launch-error').textContent=error.message;$('launch-error').hidden=false}
  finally{button.disabled=false;button.textContent='Launch agent ↗';form.querySelectorAll('input,textarea,select').forEach(el=>el.disabled=!!el.closest('#team-editor'));$('launch-cwd').readOnly=!!resumeSource;updateLaunchTeam()}
})
function selectControl(session) {
  const next=session?.managedId || null
  if(next===controlId && next) return
  // A terminal session already on screen only refreshes its conversation.
  if(!next && session && session.sessionId && session.sessionId===outsideSession?.sessionId && $('outside-console')){outsideSession=session;return refreshOutside()}
  controlId=next;controlSession=null;controlVersion++;outsideSession=null;outsideSeen=null
  window.Fleet.watchConversation(null)
  $('control-panel').innerHTML=''
  if(next){
    $('control-panel').innerHTML=`<div class="conversation-header"><div class="header-title"><h3 id="conversation-title">Conversation</h3><span id="agent-context" class="subtle context-chip"></span><span id="agent-state" class="subtle">Connecting…</span></div><div class="header-controls"><label class="mode-picker"><span class="sr-only">Model for this agent</span><select id="model-choice" title="Applies from your next message"></select></label><label class="mode-picker"><span class="sr-only">Approvals for this agent</span><select id="approval-mode"><option value="auto" data-description="Asks only for destructive or networked shell commands">Auto approvals</option><option value="ask" data-description="Every tool waits for you">Ask every time</option><option value="all" data-description="Nothing waits, destructive commands included">Approve everything</option></select></label><button type="button" id="agent-connections" class="button">Connections</button><button type="button" id="close-agent" class="button close-agent" title="Remove this conversation from Fleet">Close</button></div></div><p id="model-routing" class="model-routing note" role="status" hidden></p><div id="conversation" class="conversation" role="log" aria-label="Agent conversation" aria-live="off"><p class="note">Loading conversation…</p></div><div id="now-line" class="now-line" role="status" hidden></div><ul id="queued-messages" class="queued-messages" aria-label="Messages waiting to send" hidden></ul><div id="agent-error" class="form-error" role="status" hidden></div><div id="approvals"></div><form id="composer" class="composer"><label class="sr-only" for="message-input">Message this agent</label><ul id="slash-picker" class="slash-picker" role="listbox" aria-label="Commands and skills" hidden></ul><div id="reference-tray" class="reference-tray" aria-label="Referenced sessions" hidden></div><div id="attach-tray" class="attach-tray" hidden></div><textarea id="message-input" rows="3" maxlength="16000" placeholder="Message your agent…  @ references · / commands" role="combobox" aria-expanded="false" aria-controls="slash-picker" aria-autocomplete="list"></textarea><div class="composer-footer"><span id="composer-hint" class="note">Enter to send · Shift + Enter for a new line</span><button id="stop-agent" type="button" class="button stop" hidden>■ Stop</button><button id="send-message" class="button resume" type="submit">Send ↗</button></div><p id="send-error" class="form-error" role="alert" hidden></p></form>`
    window.Fleet.watchConversation($('conversation'))
    catalog=[];catalogFor=null;closePicker();renderTray();renderReferences()
    window.Fleet.syncDetails()
    $('message-input').value=drafts.get(next)?.text || ''
    $('message-input').addEventListener('input',()=>drafts.set(next,{text:$('message-input').value,requestId:crypto.randomUUID()}))
    $('message-input').addEventListener('keydown',event=>{
      if(event.isComposing) return
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
    $('composer').addEventListener('dragover',event=>{ if([...(event.dataTransfer?.types || [])].some(t=>t==='Files' || t==='application/x-fleet-session')){ event.preventDefault(); $('composer').classList.add('is-dropping') } })
    $('composer').addEventListener('dragleave',()=>$('composer').classList.remove('is-dropping'))
    $('composer').addEventListener('drop',event=>{ event.preventDefault(); $('composer').classList.remove('is-dropping'); const reference=event.dataTransfer?.getData('application/x-fleet-session'); if(reference){addReference(reference);return} attachImages([...(event.dataTransfer?.files || [])].filter(f=>f.type.startsWith('image/'))) })
    $('attach-tray').addEventListener('click',event=>{ const b=event.target.closest('[data-remove]'); if(b){ removeImage(Number(b.dataset.remove)) } })
    renderTray()
    $('reference-tray').addEventListener('click',event=>{
      const remove=event.target.closest('[data-remove-reference]')
      if(remove) return removeReference(remove.dataset.removeReference)
      const open=event.target.closest('[data-open-reference]')
      if(open) openReferencedSession(open.dataset.openReference)
    })
    $('message-input').addEventListener('blur',()=>setTimeout(closePicker,120))
    $('slash-picker').addEventListener('mousedown',event=>{
      const item=event.target.closest('[data-index]')
      if(item){event.preventDefault();insertPick(Number(item.dataset.index))}
    })
    $('composer').addEventListener('submit',sendMessage)
    $('approval-mode').addEventListener('change',changeMode)
    $('conversation-title').addEventListener('click',startRename)
    $('conversation-title').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();startRename()}})
    fillModels($('model-choice')).then(()=>$('model-choice')?.addEventListener('change',changeModel))
    $('agent-connections').addEventListener('click',()=>window.FleetConnections.open(controlId))
    $('close-agent').addEventListener('click',closeAgent)
    $('stop-agent').addEventListener('click',stopAgent)
    refreshControl()
  }else if(session){
    outsideSession=session
    openOutside()
  }
}
// A session started in a terminal opens in the same console as a Fleet one: its
// conversation read from the transcript, and a composer. A stopped session is taken
// over by the first message; one still open in its terminal is continued as a copy,
// since two programs writing one conversation would corrupt it.
function openOutside() {
  const s=outsideSession
  const title=s.title || s.name || 'Untitled session'
  const able=!!(s.sessionId && s.cwd)
  $('control-panel').innerHTML=`<div class="conversation-header" id="outside-console"><div class="header-title"><h3>${esc(title)}</h3><span id="outside-state" class="subtle"></span></div></div><div id="conversation" class="conversation" role="log" aria-label="Conversation from the terminal" aria-live="off"><p class="note">Loading the conversation…</p></div><div id="now-line" class="now-line" role="status" hidden></div><form id="composer" class="composer outside-composer"><label class="sr-only" for="message-input">Continue this conversation</label><textarea id="message-input" rows="3" maxlength="16000" ${able ? '' : 'disabled'}></textarea><div class="composer-footer"><span id="composer-hint" class="note"></span><button id="send-message" class="button resume" type="submit" ${able ? '' : 'disabled'}></button></div><p id="send-error" class="form-error" role="alert" hidden></p></form>`
  window.Fleet.watchConversation($('conversation'))
  $('message-input').addEventListener('keydown',event=>{if(event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();if(!$('send-message').disabled)$('composer').requestSubmit()}})
  $('composer').addEventListener('submit',continueOutside)
  window.Fleet.syncDetails()
  refreshOutside()
}
let outsideSeen=null,outsideLoading=null
function refreshOutside() {
  const s=outsideSession
  if(!s || !$('outside-state'))return
  const busy=s.state==='busy'
  $('outside-state').textContent=s.alive ? (busy ? 'Working in a terminal' : 'Open in a terminal') : 'From a terminal · stopped'
  const step=busy && s.turn?.current
  setNow(step ? `Running ${toolName(step.t)}${step.target ? ` · ${step.target}` : ''}` : busy ? 'Working in the terminal' : '',{since:step?.at || s.turn?.turnStartedAt || null})
  $('send-message').textContent=s.alive ? 'Continue a copy here ↗' : 'Continue here ↗'
  $('composer-hint').textContent=!(s.sessionId && s.cwd) ? 'This session has no saved conversation to continue.' : s.alive ? 'Sends to a copy in Fleet. The terminal keeps the original.' : 'Your message continues this conversation in Fleet.'
  $('message-input').placeholder=s.alive ? 'Continue a copy of this conversation…' : 'Continue this conversation…'
  // Read the transcript again only when the session has moved.
  const mark=`${s.sessionId}:${s.lastActivity}:${s.alive}`
  if(mark===outsideSeen || outsideLoading || !s.sessionId)return
  outsideSeen=mark
  const id=s.sessionId
  outsideLoading=window.FleetSync.get(`/api/sessions/history?sessionId=${encodeURIComponent(id)}`,{paths:['messages'],key:`history:${id}`}).then(({value:data})=>{
    if(outsideSession?.sessionId!==id || !$('conversation'))return
    const log=$('conversation')
    if(log.querySelector(':scope > p.note'))log.innerHTML=''
    if(data.truncated && !log.querySelector('.outside-earlier'))log.insertAdjacentHTML('afterbegin','<p class="note outside-earlier">Earlier messages are in the transcript; this shows the most recent part.</p>')
    window.FleetBlocks.renderBlocks(log,data.messages,{onCopy:toast})
    if(!data.messages.length && !log.querySelector('.block'))log.innerHTML='<p class="note">No messages in this conversation yet.</p>'
  }).catch(error=>{if(outsideSession?.sessionId===id && $('conversation'))$('conversation').innerHTML=`<p class="note">${esc(error.message)}</p>`;outsideSeen=null}).finally(()=>{outsideLoading=null})
}
async function continueOutside(event) {
  event.preventDefault()
  const s=outsideSession,text=$('message-input').value.trim()
  if(!s || !text)return
  const button=$('send-message');button.disabled=true;$('send-error').hidden=true
  try{
    const data=await api('/api/managed',{cwd:s.cwd,name:s.title || s.name || '',prompt:text,requestId:crypto.randomUUID(),resumeSessionId:s.sessionId,...(s.alive ? {fork:true}:{})})
    $('message-input').value=''
    await tick()
    window.Fleet.setFilter('all')
    window.Fleet.select(data.session.id)
    toast(s.alive ? 'Continuing a copy in Fleet. The terminal keeps the original.' : 'Continuing in Fleet')
  }catch(error){if($('send-error')){$('send-error').textContent=error.message;$('send-error').hidden=false};button.disabled=false}
}
// What is happening this second, under the conversation, in the avatars' pixel style:
// the step that is running and for how long, or thinking, writing, waiting for you.
const toolName=tool=>window.FleetBlocks?.toolLabel(tool) || tool
const shortElapsed=ms=>{const t=Math.max(0,Math.round(ms/1000));return t<60 ? `${t}s` : `${Math.floor(t/60)}m ${String(t%60).padStart(2,'0')}s`}
function setNow(text,{since=null,tone=''}={}) {
  const line=$('now-line')
  if(!line)return
  if(!text){line.hidden=true;line.dataset.key='';return}
  const key=`${text}|${since || ''}|${tone}`
  if(line.dataset.key!==key){
    line.dataset.key=key;line.dataset.tone=tone
    line.innerHTML=`${window.FleetUI ? window.FleetUI.running(text) : ''}<span class="now-text">${esc(text)}</span>${since ? `<span class="now-time" data-since="${Number(since)}"></span>` : ''}`
  }
  line.hidden=false
  tickNow()
}
function tickNow() {const time=document.querySelector('#now-line:not([hidden]) .now-time');if(time)time.textContent=shortElapsed(Date.now()-Number(time.dataset.since))}
setInterval(tickNow,1000)
function managedNow(s) {
  if(s.openElsewhere || !isWorking(s))return setNow('')
  if(s.status==='approval')return setNow('Waiting for your approval',{tone:'needs'})
  if(s.status==='starting')return setNow('Starting Claude')
  if(s.status==='stopping')return setNow('Stopping')
  const tool=[...s.messages].reverse().find(m=>m.role==='tool' && m.status==='running')
  if(tool){
    const what=['Agent','Task'].includes(tool.tool) ? `Delegating to ${tool.input?.subagent_type || 'a sub-agent'}` : `Running ${toolName(tool.tool)}`
    return setNow(`${what}${tool.target ? ` · ${tool.target}` : ''}`,{since:tool.at})
  }
  const last=s.messages[s.messages.length-1]
  if(last?.role==='assistant')return setNow('Writing a reply',{since:last.at})
  return setNow('Thinking',{since:last?.at || null})
}
async function refreshControl() {
  const id=controlId,version=controlVersion
  if(!id)return
  if(controlFetch?.id===id){controlFetch.again=true;return}
  const task={id,again:false};controlFetch=task
  try{
    // Unchanged, this is a 304; changed, only new or edited messages and sub-agents travel.
    const {value:data}=await window.FleetSync.get(`/api/managed/${id}`,{paths:['session.messages','session.subagents'],key:`managed:${id}`})
    refreshedAt=Date.now()
    if(controlId!==id || controlVersion!==version)return
    controlSession=data.session;renderControl()
  }catch(error){if(controlId===id && $('agent-error')){$('agent-error').hidden=false;$('agent-error').textContent=error.message}}
  finally{if(controlFetch===task)controlFetch=null;if(task.again && controlId===id)refreshControl()}
}
function renderControl() {
  const s=controlSession;if(!s || s.id!==controlId || !$('composer'))return
  window.FleetTeams?.board(s)
  window.FleetDay?.board(s)
  // A thread is held to the Day's outward gate too, so it reads the same way.
  const day=s.kind==='day',thread=s.kind==='thread',pm=s.kind==='project',gated=day || thread || pm
  $('conversation-title').textContent=day ? 'Day agent' : thread ? `About: ${s.name}` : pm ? `Project manager · ${s.name}` : s.renamed ? s.name : s.aiTitle || s.name
  // Agents and initiatives can be renamed; a name you chose outranks Claude's own title.
  const title=$('conversation-title'),renameable=['agent','initiative'].includes(s.kind || 'agent')
  title.classList.toggle('is-renameable',renameable)
  if(renameable){title.tabIndex=0;title.setAttribute('role','button');title.title='Rename this agent'}
  const queueNote=s.queue?.length ? ` · ${s.queue.length} queued` : ''
  const tool=s.currentTool && (window.FleetBlocks?.toolLabel(s.currentTool) || s.currentTool)
  $('agent-state').textContent=(tool && s.status==='running' ? (day && tool==='Board' ? 'Updating the board…' : `Using ${tool}`) : managedLabels[s.status])+queueNote
  // In a Day the outward gate decides what needs you, whatever this is set to, so the
  // picker would only suggest a choice that is not really there.
  $('approval-mode').closest('.mode-picker').hidden=gated
  let gate=$('day-gate-note')
  if(gated && !gate){gate=document.createElement('span');gate.id='day-gate-note';gate.className='subtle day-gate-note';$('approval-mode').closest('.mode-picker').after(gate)}
  if(gate){
    gate.hidden=!gated
    gate.textContent=pm ? 'Sends nothing outside Fleet' : 'Sends need your approval'
    gate.title=pm ? 'A project manager reads and reports. Next steps go to your Day as proposals.' : 'Slack messages, Linear changes and GitHub reviews go out only after you approve the exact text on the board.'
  }
  projectPicker(s)
  if(pm && $('message-input'))$('message-input').placeholder='Ask about this project: status, blockers, are we on track…'
  const routing=$('model-routing'),decision=s.modelRouting
  routing.hidden=s.selectedModel!=='auto-jev'
  routing.textContent=decision ? `Jev → ${decision.model} · Pinned for this session. ${decision.description}${decision.signals ? ` Complexity: ${decision.signals.complexity} (${Math.round(decision.signals.probability*100)}% choice probability).`:''}` : 'Jev will select a model from this task’s brief. If unavailable, Fleet uses the preset.'
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
    window.FleetBlocks.renderBlocks(log,gated && window.FleetDay?.messages ? window.FleetDay.messages(s.messages) : s.messages,{streamingId,onCopy:toast})
  }else{
    // Console assets unavailable — usually a page loaded from an older running server.
    update('conversation',s.messages.map(m=>`<article class="block" data-role="${esc(m.role)}"><div class="block-head"><span class="block-tool">${m.role==='tool' ? esc(m.tool) : m.role==='user' ? 'YOU' : 'CLAUDE'}</span><span class="block-meta">${new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><pre class="block-plain">${esc(m.role==='tool' ? [m.target,m.result].filter(Boolean).join('\n\n') : m.text)}</pre></article>`).join(''))
    if(!fallbackWarned){fallbackWarned=true;toast('Console assets did not load. Restart Fleet, then reload this page.')}
  }
  if(atBottom)log.scrollTop=log.scrollHeight
  // Approval DOM is independent of the streamed response so answers keep their focus and values.
  const ids=s.approvals.map(p=>p.id).join(',')
  if($('approvals').dataset.ids!==ids){$('approvals').dataset.ids=ids;renderApprovals(s.approvals)}
  managedNow(s)
  const working=isWorking(s)
  const held=s.openElsewhere
  const heldText=held ? `Open ${held.entrypoint==='cli' ? 'in a terminal' : 'in another program'}${held.name ? ' · '+held.name : ''}${held.startedAt ? ' · since '+new Date(held.startedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}. Close it there to continue here.` : null
  if(held){ $('agent-state').textContent=held.state==='busy' ? 'Working in a terminal' : 'Open in a terminal'; $('agent-state').className='subtle stale' }
  // Sending no longer waits on idle: mid-turn, a message joins the queue and the run's
  // own completion starts it. Only another live process on this session still blocks it.
  $('send-message').disabled=inFlight.has(s.id) || !!held
  $('send-message').textContent=working ? 'Queue ↗' : 'Send ↗'
  $('stop-agent').hidden=!working && s.status!=='queued'
  $('stop-agent').textContent=s.status==='queued' ? 'Cancel queued task' : '■ Stop'
  $('stop-agent').disabled=s.status==='stopping' || inFlight.has(`stop:${s.id}`)
  $('composer-hint').textContent=heldText || (working ? 'Claude is still working — this joins the queue and sends the moment it’s free.' : 'Enter to send · Shift + Enter for a new line')
  $('composer-hint').classList.toggle('is-held',!!held)
  const queue=$('queued-messages')
  queue.hidden=!s.queue?.length
  if(s.queue?.length) queue.innerHTML=s.queue.map((q,i)=>`<li class="queued-message"><span class="queued-index">#${i+1}</span><span class="queued-text">${esc(q.message || `${q.attachments?.length || 0} image${q.attachments?.length===1 ? '':'s'}`)}</span><span class="queued-label">Queued</span></li>`).join('')
}
// An agent or initiative can belong to one of the operator's projects; the picker tags it.
function projectPicker(s) {
  let picker=$('project-choice')
  const taggable=['agent','initiative'].includes(s.kind || 'agent'),projects=window.FleetProjects?.list() || []
  if(!taggable || (!projects.length && !s.projectId)){picker?.closest('label')?.remove();return}
  if(!picker){
    $('approval-mode').closest('.mode-picker').insertAdjacentHTML('beforebegin','<label class="mode-picker"><span class="sr-only">Project</span><select id="project-choice" title="Which of your projects this work belongs to"></select></label>')
    picker=$('project-choice')
    picker.addEventListener('change',async event=>{
      const id=controlId
      try{await api(`/api/managed/${id}/project`,{projectId:event.target.value || null});await refreshControl();window.FleetProjects?.load(true);toast(event.target.value ? 'Added to the project' : 'Removed from the project')}
      catch(error){toast(error.message);refreshControl()}
    })
  }
  const options=`<option value="">No project</option>${projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`
  if(picker.dataset.options!==options){picker.innerHTML=options;picker.dataset.options=options}
  if(picker!==document.activeElement)picker.value=s.projectId || ''
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
  if(!id || inFlight.has(id) || !controlSession)return
  const message=$('message-input').value.trim()
  const references=(pendingReferences.get(id) || []).map(r=>r.id)
  const images=attachedImages().map(img=>({ mediaType:img.mediaType, data:img.dataUrl.slice(img.dataUrl.indexOf(',')+1) }))
  if(!message && !images.length)return
  const draft=drafts.get(id) || {text:message,requestId:crypto.randomUUID()};drafts.set(id,draft)
  inFlight.add(id);renderControl();$('send-error').hidden=true
  try{
    await api(`/api/managed/${id}/messages`,{message,...(images.length ? {images} : {}),...(references.length ? {references} : {}),requestId:draft.requestId})
    if(drafts.get(id)?.requestId===draft.requestId){drafts.delete(id);pendingReferences.delete(id);if(controlId===id){$('message-input').value='';renderReferences()}}
    pendingImages.delete(id); if(controlId===id) renderTray()
    await refreshControl();await tick()
  }catch(error){if(controlId===id){$('send-error').hidden=false;$('send-error').textContent=error.message}}
  finally{inFlight.delete(id);renderControl()}
}
// The model list comes from the runtime. Keep standard choices usable even when
// the initial request fails, and retry each time the launch dialog opens.
const STANDARD_MODELS=[
  {value:'',displayName:'Fleet default'},
  {value:'opus',displayName:'Opus'},
  {value:'sonnet',displayName:'Sonnet'},
  {value:'haiku',displayName:'Haiku'},
  {value:'auto-jev',displayName:'Auto · Jev'},
]
let modelList=null,modelsLoading=null,modelsFailed=false
function populateModels(select,list,current=select?.value || '') {
  if(!select?.isConnected)return
  const choices=list.some(m=>m.value===current) ? list:[...list,{value:current,displayName:current}]
  // The description shows under the option in Fleet's dropdown, and as a tooltip natively.
  select.innerHTML=choices.map(m=>`<option value="${esc(m.value)}" title="${esc(m.description || '')}"${m.description ? ` data-description="${esc(m.description)}"`:''}>${esc(m.displayName || m.value || 'Default')}</option>`).join('')
  select.value=current
}
async function loadModels(refresh=false) {
  if(modelsLoading)return modelsLoading
  if(modelList && !refresh)return modelList
  modelsLoading=(async()=>{
    try {
      const data=await api('/api/models')
      if(!Array.isArray(data.models) || !data.models.length || data.models.some(m=>!m || typeof m.value!=='string'))throw Error('Invalid model list')
      modelList=data.models;modelsFailed=false
    }catch{modelsFailed=true}
    return modelList || STANDARD_MODELS
  })()
  try{return await modelsLoading}finally{modelsLoading=null}
}
async function fillModels(select) {
  populateModels(select,modelList || STANDARD_MODELS,controlSession?.selectedModel || '')
  const list=await loadModels()
  populateModels(select,list,select?.value)
}
async function fillLaunchModels() {
  const select=$('launch-model'),status=$('launch-model-status')
  populateModels(select,modelList || STANDARD_MODELS)
  if(status){status.hidden=false;status.textContent='Refreshing available models…'}
  const list=await loadModels(true)
  // Read the choice now, not before the request: the operator may have changed it.
  populateModels(select,list)
  if(status){status.hidden=!modelsFailed;status.textContent=modelsFailed ? 'Could not refresh models. The choices above still work; reopen New agent to retry.':''}
}
function startRename() {
  const heading=$('conversation-title'),id=controlId
  if(!heading?.classList.contains('is-renameable') || $('rename-input'))return
  const input=document.createElement('input')
  input.id='rename-input';input.className='rename-input';input.maxLength=100;input.value=heading.textContent;input.setAttribute('aria-label','Name this agent')
  heading.hidden=true;heading.after(input);input.focus();input.select()
  let done=false
  const finish=async save=>{
    if(done)return;done=true
    const value=input.value.trim(),unchanged=value===heading.textContent
    input.remove();heading.hidden=false
    if(!save || !value || unchanged)return
    try{await api(`/api/managed/${id}/name`,{name:value});await refreshControl();await tick()}
    catch(error){toast(error.message)}
  }
  input.addEventListener('keydown',event=>{
    if(event.isComposing)return
    if(event.key==='Enter'){event.preventDefault();finish(true);heading.focus()}
    else if(event.key==='Escape'){event.preventDefault();finish(false);heading.focus()}
  })
  input.addEventListener('blur',()=>finish(true))
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
    if(controlId===id){selectControl(null);$('control-panel').innerHTML=''}
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
fillLaunchModels()
initializeControls().catch(error=>toast(error.message))
const events=new EventSource('/api/events')
events.addEventListener('sessions',event=>{try{const ids=JSON.parse(event.data);if(ids.includes(controlId))refreshControl();if(ids.includes('projects'))window.FleetProjects?.load(true)}catch{}})
// The list changed: fetch it, and the open conversation too, since a terminal driving
// a Fleet session changes it without Fleet hearing about it.
events.addEventListener('list',()=>{window.Fleet.requestTick?.();if(controlId && !document.hidden)refreshControl()})
// A new stream may follow a server restart: start from scratch rather than from a copy
// the new server never saw.
events.onopen=()=>{window.FleetSync.forget();refreshControl();tick()}
// A slow safety net for a dropped stream. While the agent works it checks every 2.5s,
// which is a 304 when nothing moved, so anything drawn from the clock keeps moving.
setInterval(()=>{
  if(document.hidden || !controlId)return
  const working=['starting','running','queued','stopping','approval'].includes(controlSession?.status)
  if(working || Date.now()-refreshedAt>30000)refreshControl()
},2500)
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
  $('message-input')?.setAttribute('aria-expanded','false')
}
function renderPicker(query) {
  const list = $('slash-picker')
  if (!list) return
  if (mentionQuery($('message-input')) !== null) return renderReferencePicker(query)
  list.setAttribute('aria-label','Commands and skills')
  const needle = query.toLowerCase()
  matches = catalog
    .filter(entry => entry.name.toLowerCase().includes(needle))
    // Prefer a prefix match, then the project's own entries.
    .sort((a, b) => (b.name.toLowerCase().startsWith(needle) - a.name.toLowerCase().startsWith(needle)) || 0)
    .slice(0, 40)
  if (!matches.length) return closePicker()
  picked = Math.min(picked, matches.length - 1)
  list.hidden = false
  $('message-input').setAttribute('aria-expanded','true')
  list.innerHTML = matches.map((entry, index) => `<li id="slash-${index}" role="option" aria-selected="${index === picked}" class="${index === picked ? 'is-picked' : ''}" data-index="${index}"><span class="slash-name">/${esc(entry.name)}</span><span class="slash-kind">${entry.kind === 'skill' ? '◆' : '›'} ${esc(SCOPE_LABEL[entry.scope] || '')}</span>${entry.hint ? `<span class="slash-hint">${esc(entry.hint)}</span>` : ''}<span class="slash-desc">${esc(entry.description)}</span></li>`).join('')
  list.querySelector('.is-picked')?.scrollIntoView({ block: 'nearest' })
  $('message-input').setAttribute('aria-activedescendant', `slash-${picked}`)
}
function insertPick(index) {
  const entry = matches[index]
  const input = $('message-input')
  if (!entry || !input) return
  if (entry.referenceId) {
    if (!addReference(entry.referenceId)) return
    const start=input.value.slice(0,input.selectionStart).lastIndexOf('@')
    input.setRangeText('',start,input.selectionStart,'end')
    drafts.set(controlId,{text:input.value,requestId:crypto.randomUUID()})
    closePicker();input.focus();return
  }
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
  const mention = mentionQuery($('message-input'))
  if (mention !== null) {picked=0;return renderReferencePicker(mention)}
  const query = slashQuery($('message-input'))
  if (query === null) return closePicker()
  picked = 0
  const id=controlId
  loadCatalog(id).then(() => { if (controlId===id && $('message-input') && mentionQuery($('message-input')) === null && slashQuery($('message-input')) !== null) renderPicker(slashQuery($('message-input'))) })
  if (catalog.length) renderPicker(query)
}
function composerKeydown(event) {
  if (event.key === 'Escape' && !$('slash-picker').hidden) {event.preventDefault();return closePicker()}
  if (!matches.length) {
    if (!$('slash-picker').hidden && event.key === 'Enter') event.preventDefault()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    picked = (picked + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length
    return renderPicker(mentionQuery($('message-input')) ?? slashQuery($('message-input')) ?? '')
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
  toast('Fleet installed the update but did not come back. Start it again with claude-fleet or the Claude Fleet app; the reason is in ~/Library/Logs/claude-fleet.log.')
}
$('update-pill')?.addEventListener('click', async () => {
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

// ---- References ----------------------------------------------------------
// References are snapshots attached to a message, never messages sent to the source.
const pendingReferences = new Map()
const referenceIdFor = session => session.managedId || session.sessionId
const referenceTitle = session => session.title || session.name || session.lastPrompt || session.shortId || 'Untitled session'
function mentionQuery(input) {
  if (!input || input.selectionStart !== input.selectionEnd) return null
  const match=input.value.slice(0,input.selectionStart).match(/(?:^|\s)@([^@\n]*)$/)
  return match ? match[1] : null
}
function referenceCandidates() {
  return (snapshot?.sessions || []).filter(s=>referenceIdFor(s) && s.managedId!==controlId && (!controlSession?.sessionId || s.sessionId!==controlSession.sessionId) && !s.background)
}
function renderReferencePicker(query) {
  const list=$('slash-picker');if(!list)return
  if(!referencesAvailable){
    matches=[];list.hidden=false;list.setAttribute('aria-label','Reference a session')
    list.innerHTML='<li class="reference-empty" role="presentation">Restart Fleet after your current agents finish to enable session references.</li>'
    $('message-input').setAttribute('aria-expanded','true');$('message-input').removeAttribute('aria-activedescendant');return
  }
  const attached=new Set((pendingReferences.get(controlId) || []).map(r=>r.id))
  const needle=query.toLowerCase()
  matches=referenceCandidates().filter(s=>!attached.has(referenceIdFor(s)) && `${referenceTitle(s)} ${s.cwd || ''} ${s.lastPrompt || ''}`.toLowerCase().includes(needle))
    .slice(0,30).map(s=>({referenceId:referenceIdFor(s),session:s}))
  picked=Math.max(0,Math.min(picked,matches.length-1))
  list.hidden=false;list.setAttribute('aria-label','Reference a session')
  $('message-input').setAttribute('aria-expanded','true')
  list.innerHTML=matches.length ? matches.map((entry,index)=>`<li id="slash-${index}" role="option" aria-selected="${index===picked}" class="${index===picked?'is-picked':''}" data-index="${index}"><span class="slash-name">✳ ${esc(referenceTitle(entry.session))}</span><span class="slash-kind">${esc(entry.session.managedStatus || LABELS[entry.session.state] || '')}</span><span class="slash-desc">${esc(entry.session.cwd?.split('/').pop() || 'No project')} · ${esc(entry.session.lastPrompt || 'Include recent conversation and activity')}</span></li>`).join('') : '<li class="reference-empty" role="presentation">No matching sessions. Try another name or project.</li>'
  if(matches.length){$('message-input').setAttribute('aria-activedescendant',`slash-${picked}`);list.querySelector('.is-picked')?.scrollIntoView({block:'nearest'})}
  else $('message-input').removeAttribute('aria-activedescendant')
}
function addReference(id) {
  if(!referencesAvailable){toast('Restart Fleet after your current agents finish to enable references.');return false}
  if(inFlight.has(controlId))return false
  const session=referenceCandidates().find(s=>referenceIdFor(s)===id)
  if(!session){toast('Choose another available session.');return false}
  const list=pendingReferences.get(controlId) || []
  if(list.some(r=>r.id===id))return true
  if(list.length>=4){toast('You can reference up to 4 sessions per message.');return false}
  pendingReferences.set(controlId,[...list,{id,title:referenceTitle(session),state:session.managedStatus || LABELS[session.state] || ''}])
  drafts.set(controlId,{text:$('message-input').value,requestId:crypto.randomUUID()})
  renderReferences();$('message-input').focus();return true
}
function removeReference(id) {
  if(inFlight.has(controlId))return
  pendingReferences.set(controlId,(pendingReferences.get(controlId) || []).filter(r=>r.id!==id))
  drafts.set(controlId,{text:$('message-input').value,requestId:crypto.randomUUID()})
  renderReferences();$('message-input').focus()
}
function renderReferences() {
  const tray=$('reference-tray');if(!tray)return
  const list=pendingReferences.get(controlId) || []
  tray.hidden=!list.length
  tray.innerHTML=list.map(r=>`<span class="reference-chip"><button type="button" data-open-reference="${esc(r.id)}" title="Open ${esc(r.title)}">✳ ${esc(r.title)} <span class="reference-state">· ${esc(r.state)}</span></button><button type="button" data-remove-reference="${esc(r.id)}" aria-label="Remove reference to ${esc(r.title)}">×</button></span>`).join('') + '<span class="reference-note">Recent context included when you send</span>'
}
function openReferencedSession(id) {
  const source=(snapshot?.sessions || []).find(s=>referenceIdFor(s)===id)
  if(!source){toast('This session is no longer available.');return}
  selected=key(source);filter=source.background?'background':'all';render()
}
document.addEventListener('dragstart',event=>{
  const row=event.target.closest('.session[data-session]')
  if(!row || !event.dataTransfer)return
  const session=(snapshot?.sessions || []).find(s=>key(s)===row.dataset.session)
  if(!session || !referenceIdFor(session))return
  event.dataTransfer.setData('application/x-fleet-session',referenceIdFor(session))
  event.dataTransfer.effectAllowed='copy'
})
})()
