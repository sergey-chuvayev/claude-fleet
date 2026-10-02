'use strict'
window.FleetSettings=(()=>{
  const {$,openModal,modalIsOpen}=window.Fleet
  let busy=false,request=0
  function mount(){
    if($('settings-backdrop'))return
    const backdrop=document.createElement('div')
    backdrop.id='settings-backdrop';backdrop.className='modal-backdrop';backdrop.hidden=true
    backdrop.innerHTML=`<section class="modal modal-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="modal-head"><div class="modal-heading"><div><span class="modal-eyebrow">FLEET SETTINGS</span><h2 id="settings-title">Settings</h2><p>How many agents run at once, and the key for automatic model selection.</p></div></div><button type="button" class="modal-close" data-close-modal aria-label="Close settings">✕</button></header>
      <div class="modal-body">
      <section class="settings-section" aria-labelledby="queue-title"><h3 id="queue-title">Agents</h3><p class="note">With queuing on, a task over the limit waits for a free slot instead of being refused.</p>
      <div class="settings-row"><label class="settings-toggle"><input type="checkbox" id="queue-enabled"> Queue tasks over the limit</label><label class="settings-field">Concurrent agents<select id="queue-limit">${Array.from({length:8},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label><button class="button" id="queue-pause" type="button">Pause queue</button></div>
      <p class="note" id="queue-status" role="status"></p><p class="form-error" id="queue-error" role="alert" hidden></p></section>
      <section class="settings-section" aria-labelledby="gateway-title"><h3 id="gateway-title">AI Gateway</h3><p id="gateway-status" role="status">Loading…</p><form id="gateway-form"><label for="gateway-key">Vercel AI Gateway API key</label><input id="gateway-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="Paste your key" aria-describedby="gateway-help" required><p class="note" id="gateway-help">Stored in a private file on this Mac, outside your projects. Fleet never sends the saved key back to this page.</p><div class="gateway-actions"><button class="button resume" type="submit">Save key</button><button class="button" id="gateway-test" type="button">Test connection</button><button class="button" id="gateway-remove" type="button">Remove saved key</button></div></form><p id="gateway-result" role="status" aria-live="polite"></p><p class="note">Select <strong>Auto · Jev</strong> when creating a session. New sessions use your saved key immediately; existing model decisions stay pinned.</p><p class="note">Testing sends a short sample to Jev and may incur a small AI Gateway charge. Routing is billed separately from your Claude subscription.</p></section></div><footer class="modal-foot"><span>No restart needed.</span><span><kbd>Esc</kbd> close</span></footer></section>`
    document.body.append(backdrop)
    $('gateway-form').addEventListener('submit',event=>{event.preventDefault();act('save')})
    $('gateway-test').addEventListener('click',()=>act('test'))
    $('gateway-remove').addEventListener('click',()=>act('remove'))
    $('queue-enabled').addEventListener('change',event=>queue({enabled:event.target.checked}))
    $('queue-limit').addEventListener('change',event=>queue({limit:Number(event.target.value)}))
    $('queue-pause').addEventListener('click',()=>queue({paused:!state?.paused}))
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
  return {open}
})()
