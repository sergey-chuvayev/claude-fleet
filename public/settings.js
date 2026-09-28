'use strict'
window.FleetSettings=(()=>{
  const {$,openModal,modalIsOpen}=window.Fleet
  let busy=false,request=0
  function mount(){
    if($('settings-backdrop'))return
    const backdrop=document.createElement('div')
    backdrop.id='settings-backdrop';backdrop.className='modal-backdrop';backdrop.hidden=true
    backdrop.innerHTML=`<section class="modal modal-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="modal-head"><div class="modal-heading"><div><span class="modal-eyebrow">FLEET SETTINGS</span><h2 id="settings-title">AI Gateway</h2><p>A key for automatic model selection with Jev.</p></div></div><button type="button" class="modal-close" data-close-modal aria-label="Close settings">✕</button></header>
      <div class="modal-body"><p id="gateway-status" role="status">Loading…</p><form id="gateway-form"><label for="gateway-key">Vercel AI Gateway API key</label><input id="gateway-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="Paste your key" aria-describedby="gateway-help" required><p class="note" id="gateway-help">Stored in a private file on this Mac, outside your projects. Fleet never sends the saved key back to this page.</p><div class="gateway-actions"><button class="button resume" type="submit">Save key</button><button class="button" id="gateway-test" type="button">Test connection</button><button class="button" id="gateway-remove" type="button">Remove saved key</button></div></form><p id="gateway-result" role="status" aria-live="polite"></p><p class="note">Select <strong>Auto · Jev</strong> when creating a session. New sessions use your saved key immediately; existing model decisions stay pinned.</p><p class="note">Testing sends a short sample to Jev and may incur a small AI Gateway charge. Routing is billed separately from your Claude subscription.</p></div><footer class="modal-foot"><span>No restart needed.</span><span><kbd>Esc</kbd> close</span></footer></section>`
    document.body.append(backdrop)
    $('gateway-form').addEventListener('submit',event=>{event.preventDefault();act('save')})
    $('gateway-test').addEventListener('click',()=>act('test'))
    $('gateway-remove').addEventListener('click',()=>act('remove'))
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
