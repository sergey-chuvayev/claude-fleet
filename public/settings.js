'use strict'
window.FleetSettings=(()=>{
  const {$,openModal,modalIsOpen}=window.Fleet
  let busy=false,request=0
  function mount(){
    if($('settings-backdrop'))return
    const backdrop=document.createElement('div')
    backdrop.id='settings-backdrop';backdrop.className='modal-backdrop';backdrop.hidden=true
    backdrop.innerHTML=`<section class="modal modal-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="modal-head"><div class="modal-heading"><span class="modal-spark" aria-hidden="true">⚙&#xFE0E;</span><div><span class="modal-eyebrow">FLEET SETTINGS</span><h2 id="settings-title">How Fleet runs.</h2><p>How many agents run at once, when Fleet starts, and the key for automatic model selection.</p></div></div><button type="button" class="modal-close" data-close-modal aria-label="Close settings"><i class="ico ico-close" aria-hidden="true"></i></button></header>
      <div class="modal-body">
      <section class="settings-section" aria-labelledby="queue-title"><h3 id="queue-title">Agents</h3><p class="note">With queuing on, a task over the limit waits for a free slot instead of being refused.</p>
      <div class="settings-row"><label class="settings-toggle"><input type="checkbox" id="queue-enabled"> Queue tasks over the limit</label><label class="settings-field">Concurrent agents<select id="queue-limit">${Array.from({length:8},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label><button class="button" id="queue-pause" type="button">Pause queue</button></div>
      <p class="note" id="queue-status" role="status"></p><p class="form-error" id="queue-error" role="alert" hidden></p>
      <div class="settings-row"><label class="settings-field">Default approval mode for new agents<select id="default-approval-mode"><option value="all">Approve everything</option><option value="auto">Auto · ask for risky commands</option><option value="ask">Ask every time</option></select></label></div>
      <p class="note" id="approval-status" role="status">Applies to agents you create from now on. Existing agents keep their mode, and you can still pick another when you launch one.</p><p class="form-error" id="approval-error" role="alert" hidden></p>
      </section>
      <section class="settings-section" aria-labelledby="startup-title"><h3 id="startup-title">Startup</h3><p class="note">Run Fleet in the background, without a terminal: it starts when you log in, comes back if it ever stops, and updates from the Update button.</p>
      <div class="settings-row"><label class="settings-toggle"><input type="checkbox" id="service-enabled"> Start Fleet at login and keep it running</label></div>
      <p class="note" id="service-status" role="status"></p><p class="form-error" id="service-error" role="alert" hidden></p></section>
      <section class="settings-section" aria-labelledby="notify-title"><h3 id="notify-title">Notifications</h3><p class="note">When an agent you launched from Today finishes or stops, it reports on its item and the item waits on you. Fleet always shows a note on the page; this adds one from macOS too.</p>
      <div class="settings-row"><label class="settings-toggle"><input type="checkbox" id="notify-enabled"> Desktop notification when an agent reports back</label></div><p class="note" id="notify-status" role="status"></p></section>
      <section class="settings-section" aria-labelledby="gateway-title"><h3 id="gateway-title">AI Gateway</h3><p id="gateway-status" role="status">Loading…</p><form id="gateway-form"><label for="gateway-key">Vercel AI Gateway API key</label><input id="gateway-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="Paste your key" aria-describedby="gateway-help" required><p class="note" id="gateway-help">Stored in a private file on this Mac, outside your projects. Fleet never sends the saved key back to this page.</p><div class="gateway-actions"><button class="button resume" type="submit">Save key</button><button class="button" id="gateway-test" type="button">Test connection</button><button class="button" id="gateway-remove" type="button">Remove saved key</button></div></form><p id="gateway-result" role="status" aria-live="polite"></p><p class="note">Select <strong>Auto · Jev</strong> when creating a session. New sessions use your saved key immediately; existing model decisions stay pinned.</p><p class="note">Testing sends a short sample to Jev and may incur a small AI Gateway charge. Routing is billed separately from your Claude subscription.</p></section></div><footer class="modal-foot"><span>No restart needed.</span><span><kbd>Esc</kbd> close</span></footer></section>`
    document.body.append(backdrop)
    $('gateway-form').addEventListener('submit',event=>{event.preventDefault();act('save')})
    $('gateway-test').addEventListener('click',()=>act('test'))
    $('gateway-remove').addEventListener('click',()=>act('remove'))
    $('queue-enabled').addEventListener('change',event=>queue({enabled:event.target.checked}))
    $('queue-limit').addEventListener('change',event=>queue({limit:Number(event.target.value)}))
    $('queue-pause').addEventListener('click',()=>queue({paused:!state?.paused}))
    $('default-approval-mode').addEventListener('change',event=>saveApprovalMode(event.target.value))
    $('service-enabled').addEventListener('change',event=>toggleService(event.target.checked))
  }
  // Start at login (/api/service). Turning it on hands this server to macOS, which
  // starts it again at once, so the page waits for it and reloads.
  let service=null,serviceBusy=false
  function renderService(next) {
    service=next || service
    if(!$('service-enabled'))return
    const box=$('service-enabled')
    if(!service){box.disabled=true;$('service-status').textContent='Checking…';return}
    if(!service.supported){box.disabled=true;box.checked=false;$('service-status').textContent='Available on macOS. Elsewhere, keep claude-fleet running in a terminal or your own service manager.';return}
    box.disabled=serviceBusy;box.checked=!!service.enabled
    $('service-status').textContent=serviceBusy ? 'Handing Fleet over to macOS…' : !service.enabled ? 'Off. Fleet runs while the app or a terminal keeps it running.' : service.managed ? 'On. Fleet is running as a background service.' : 'On. Fleet starts as a service at your next login.'
  }
  async function toggleService(enabled) {
    if(serviceBusy)return
    serviceBusy=true;$('service-error').hidden=true;renderService()
    try{
      const result=await window.FleetControl.api('/api/service',{enabled})
      renderService(result.service)
      if(result.restarting)return waitForServer()
      serviceBusy=false;renderService()
    }catch(error){serviceBusy=false;$('service-error').textContent=error.message;$('service-error').hidden=false;renderService()}
  }
  async function waitForServer(deadline=Date.now()+45000) {
    const up=async()=>{try{return (await fetch('/api/control',{cache:'no-store',signal:AbortSignal.timeout(3000)})).ok}catch{return false}}
    // First see this server go away, so the reload lands on the one macOS started.
    for(const gone=Date.now()+15000;Date.now()<gone && await up();)await new Promise(resolve=>setTimeout(resolve,300))
    while(Date.now()<deadline){
      try{const response=await fetch('/api/control',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(response.ok)return location.reload()}catch{}
      await new Promise(resolve=>setTimeout(resolve,700))
    }
    serviceBusy=false;renderService()
    $('service-error').textContent=`Fleet did not come back. Open the Claude Fleet app, or see ~/Library/Logs/claude-fleet.log.`;$('service-error').hidden=false
  }
  // The mode a new agent starts with (/api/settings/approval-mode). The launch form
  // preselects it; the server applies it when a create request names no mode.
  let approvalMode=null
  function renderApprovalMode(mode) {
    approvalMode=mode || approvalMode
    if(approvalMode && $('default-approval-mode'))$('default-approval-mode').value=approvalMode
  }
  async function saveApprovalMode(mode) {
    $('approval-error').hidden=true
    try{
      const result=await window.FleetControl.api('/api/settings/approval-mode',{mode})
      renderApprovalMode(result.defaultApprovalMode)
      if($('launch-mode'))$('launch-mode').value=result.defaultApprovalMode
    }catch(error){$('approval-error').textContent=error.message;$('approval-error').hidden=false;renderApprovalMode()}
  }
  // The agent queue, formerly its own Work queue tab. The server owns it (/api/queue);
  // this shows what it says and sends one change at a time.
  let state=null,queueBusy=false
  function renderQueue(next) {
    state=next || window.Fleet.snapshot()?.queue || state
    if(!state || !$('queue-enabled'))return
    $('queue-enabled').checked=!!state.enabled
    if($('queue-limit')!==document.activeElement)$('queue-limit').value=String(state.limit || 4)
    $('queue-pause').hidden=!state.enabled
    $('queue-pause').textContent=state.paused ? 'Resume queue':'Pause queue'
    $('queue-status').textContent=`${state.running}/${state.limit} running · ${state.waiting} waiting${state.paused ? ' · paused: running agents continue, new ones wait':''}`
    for(const id of ['queue-enabled','queue-limit','queue-pause'])$(id).disabled=queueBusy
  }
  async function queue(change) {
    if(queueBusy)return
    queueBusy=true;$('queue-error').hidden=true;renderQueue()
    try{const result=await window.FleetControl.api('/api/queue',change);queueBusy=false;renderQueue(result.queue);window.Fleet.tick?.()}
    catch(error){queueBusy=false;$('queue-error').textContent=error.message;$('queue-error').hidden=false;renderQueue()}
  }
  function render(gateway){
    $('gateway-status').textContent=gateway.source==='saved' ? 'Configured · saved on this Mac. Overrides the environment key.':gateway.source==='environment' ? 'Configured · using AI_GATEWAY_API_KEY from the server environment.':'No key configured. Auto · Jev will use the Fleet preset.'
    $('gateway-test').disabled=!gateway.configured
    $('gateway-remove').disabled=gateway.source!=='saved'
  }
  async function act(action){
    if(busy)return
    busy=true
    const ticket=++request
    const data=action==='save' ? {action,apiKey:$('gateway-key').value}:{action}
    $('gateway-key').value=''
    $('gateway-result').textContent=action==='test' ? 'Testing…':'Saving changes…'
    for(const el of $('gateway-form').elements)el.disabled=true
    try{
      const result=await window.FleetControl.api('/api/settings/gateway',data)
      if(ticket!==request || !modalIsOpen('settings-backdrop'))return
      for(const el of $('gateway-form').elements)el.disabled=false
      render(result.gateway)
      $('gateway-result').textContent=result.test?.message || (action==='save' ? 'Key saved. Ready for new Auto sessions.':'Saved key removed.' )
    }catch(error){if(ticket===request && modalIsOpen('settings-backdrop')){for(const el of $('gateway-form').elements)el.disabled=false;$('gateway-result').textContent=error.message}}
    finally{data.apiKey=undefined;if(ticket===request)busy=false}
  }
  async function open(){
    mount();const ticket=++request;busy=true
    $('gateway-key').value='';$('gateway-result').textContent='';$('gateway-status').textContent='Loading…'
    for(const el of $('gateway-form').elements)el.disabled=true
    renderQueue()
    renderService()
    renderApprovalMode()
    window.FleetControl.api('/api/settings/approval-mode').then(result=>renderApprovalMode(result.defaultApprovalMode)).catch(()=>{})
    window.FleetControl.api('/api/service').then(result=>renderService(result.service)).catch(()=>{})
    openModal('settings-backdrop','.modal-close')
    $('open-settings')?.setAttribute('aria-expanded','true')
    try{
      const result=await window.FleetControl.api('/api/settings/gateway')
      if(ticket!==request || !modalIsOpen('settings-backdrop'))return
      for(const el of $('gateway-form').elements)el.disabled=false
      render(result.gateway);$('gateway-key').focus()
    }catch(error){if(ticket===request && modalIsOpen('settings-backdrop'))$('gateway-result').textContent=error.message}
    finally{if(ticket===request)busy=false}
  }
  $('open-settings')?.addEventListener('click',open)
  // Desktop notifications are this browser's choice, so they live in this browser.
  const NOTIFY_KEY='fleet.notify'
  const notifyOn=()=>{try{return localStorage.getItem(NOTIFY_KEY)==='1' && 'Notification' in window && Notification.permission==='granted'}catch{return false}}
  function renderNotify(){
    const box=$('notify-enabled'),status=$('notify-status')
    if(!box)return
    box.checked=notifyOn()
    status.textContent=!('Notification' in window) ? 'This browser has no desktop notifications.' : Notification.permission==='denied' ? 'Notifications are blocked for this page. Allow them in the browser settings.' : ''
  }
  document.addEventListener('change',async event=>{
    if(event.target.id!=='notify-enabled')return
    const wanted=event.target.checked
    if(wanted && 'Notification' in window && Notification.permission==='default')await Notification.requestPermission().catch(()=>{})
    try{localStorage.setItem(NOTIFY_KEY,wanted && Notification.permission==='granted' ? '1':'0')}catch{}
    renderNotify()
  })
  $('open-settings')?.addEventListener('click',renderNotify)
  return {open,notifyOn}
})()
