'use strict'
window.FleetConnections=(()=>{
  const {$,esc,openModal,modalIsOpen}=window.Fleet
  const api=(...args)=>window.FleetControl.api(...args)
  let result=null,request=0,busy=false
  const labels={connected:'Connected',failed:'Failed','needs-auth':'Needs sign-in',pending:'Connecting',disabled:'Disabled'}
  function mount(){
    if($('connections-backdrop'))return
    const backdrop=document.createElement('div')
    backdrop.id='connections-backdrop';backdrop.className='modal-backdrop';backdrop.hidden=true
    backdrop.innerHTML=`<section class="modal modal-connections" role="dialog" aria-modal="true" aria-labelledby="connections-title">
      <header class="modal-head"><div class="modal-heading"><span class="modal-spark" aria-hidden="true">⌘</span><div><span class="modal-eyebrow">TOOLS WITHIN REACH</span><h2 id="connections-title">Your connections.</h2><p>Check what’s available. Get a blocked connection moving.</p></div></div><button type="button" class="modal-close" data-close-modal aria-label="Close connections">✕</button></header>
      <div class="modal-body"><form id="connections-form" class="connections-form"><label>Check connections for<select id="connections-session"><option value="">Project directory</option></select></label><label id="connections-project">Project directory<input id="connections-cwd" maxlength="4096" placeholder="~/projects/my-project" required></label><button class="button resume" id="connections-check" type="submit">Check connections</button></form>
      <p class="note" id="connections-context">Choose a project or session. Checking connects configured servers without sending an agent message.</p>
      <p id="connections-error" class="form-error" role="alert" hidden></p><div id="connections-results" aria-live="polite" aria-busy="false"><p class="connections-empty">Your configured MCP servers will appear here.</p></div>
      <details class="connections-help"><summary>Missing a connection?</summary><p>Claude.ai connectors must be enabled for the Claude account Fleet uses. Local servers must be configured in Claude Code for this project. After authorizing, check again and reconnect.</p><a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">Open Claude connector settings ↗</a><p>For a local server, open Claude Code in this project and run <code>/mcp</code> to authenticate or approve its configuration. Fleet does not add servers from this panel.</p></details></div>
      <footer class="modal-foot"><span>Connection changes never resend a task.</span><span><kbd>Esc</kbd> close</span></footer></section>`
    document.body.append(backdrop)
    $('connections-form').addEventListener('submit',event=>{event.preventDefault();check()})
    $('connections-session').addEventListener('change',reset)
    $('connections-cwd').addEventListener('input',reset)
    $('connections-results').addEventListener('click',event=>{
      const button=event.target.closest('[data-connection-action]')
      if(button)check(button.dataset.connectionAction,button.dataset.server)
    })
  }
  function reset(){
    request++;result=null;busy=false
    $('connections-project').hidden=!!$('connections-session').value
    $('connections-cwd').required=!$('connections-session').value
    $('connections-results').innerHTML='<p class="connections-empty">Check this project’s connections to see their status.</p>'
    $('connections-error').hidden=true
    $('connections-context').textContent='Checking connects configured servers without sending an agent message.'
    setBusy(false)
  }
  function setBusy(value){
    busy=value
    for(const el of $('connections-backdrop').querySelectorAll('input,select,button:not([data-close-modal])'))el.disabled=value
    $('connections-check').textContent=value ? 'Checking…':'Check connections'
    $('connections-results').setAttribute('aria-busy',String(value))
  }
  function render(){
    const {servers,source,cwd}=result
    $('connections-context').textContent=source==='session' ? `Live session · ${cwd}. These are the servers visible to this agent now.` : `Project check · ${cwd}. A separate connection check; resume your agent after fixing access. Changes here do not reconnect an already-running agent.`
    $('connections-results').innerHTML=servers.length ? `<div class="connections-summary"><strong>${servers.filter(s=>s.status==='connected').length} of ${servers.length} connected</strong><span>Checked ${new Date(result.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><ul class="connections-list">${servers.map(s=>{
      const button=(action,label)=>`<button type="button" class="button" data-connection-action="${action}" data-server="${esc(s.name)}" aria-label="${esc(label+' '+s.name)}">${label}</button>`
      const auth=s.auth==='claudeai' ? '<a class="button" href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">Authorize in Claude ↗</a>' : '<p class="note">In Claude Code, run <code>/mcp</code> in this project and select this server to sign in. Then reconnect here.</p>'
      return `<li class="connection-row"><div class="connection-heading"><div><strong>${esc(s.name)}</strong><small>${esc(s.internal ? 'Fleet task tools':s.scope==='claudeai' ? 'Claude.ai connector':s.scope+' configuration')}</small></div><span class="connection-status" data-status="${esc(s.status)}"><span aria-hidden="true">●</span> ${esc(labels[s.status] || s.status)}</span></div>${s.error ? `<p class="note">${esc(s.error)}</p>`:''}${s.status==='needs-auth' ? `<div class="connection-auth">${auth}</div>`:''}<div class="connection-actions">${s.canReconnect && s.status!=='disabled' ? button('reconnect','Reconnect'):''}${s.canToggle ? button(s.status==='disabled' ? 'enable':'disable',s.status==='disabled' ? 'Enable':'Disable'):''}</div>${s.tools.length ? `<details class="connection-tools"><summary>${s.tools.length} available tools</summary><ul>${s.tools.map(t=>`<li><code>${esc(t)}</code></li>`).join('')}</ul></details>`:s.status==='connected' ? '<p class="note">Connected; no tool list reported yet.</p>':''}</li>`
    }).join('')}</ul>` : '<p class="connections-empty">No MCP servers were reported for this project. Check the configuration or Claude connector settings below.</p>'
  }
  async function check(action='check',name){
    if(busy)return
    const ticket=++request
    setBusy(true);$('connections-error').hidden=true
    const sessionId=$('connections-session').value
    try{
      const data=await api('/api/connections',{action,name,sessionId:sessionId || undefined,cwd:sessionId ? undefined:$('connections-cwd').value,connectionId:result?.connectionId,source:result?.source})
      if(ticket!==request || !modalIsOpen('connections-backdrop'))return
      result=data.connections;render()
    }catch(error){if(ticket===request){$('connections-error').textContent=error.message;$('connections-error').hidden=false}}
    finally{if(ticket===request){setBusy(false);if(!name && modalIsOpen('connections-backdrop') && document.activeElement===document.body)$('connections-session').focus();if(name && modalIsOpen('connections-backdrop')){const buttons=[...$('connections-results').querySelectorAll('[data-server]')].filter(b=>b.dataset.server===name);(buttons.find(b=>b.dataset.connectionAction===action) || buttons[0])?.focus({preventScroll:true})}}}
  }
  async function open(sessionId){
    mount();request++;result=null
    const sessions=window.Fleet.snapshot()?.sessions?.filter(s=>s.managed) || []
    $('connections-session').innerHTML='<option value="">Project directory</option>'+sessions.map(s=>`<option value="${esc(s.managedId)}">${esc(s.title || s.name || s.cwd)}</option>`).join('')
    $('connections-session').value=sessionId || window.FleetControl.session()?.id || ''
    $('connections-cwd').value=$('launch-cwd')?.value || ''
    reset();openModal('connections-backdrop','#connections-session')
    $('open-connections')?.setAttribute('aria-expanded','true')
    if($('connections-session').value || $('connections-cwd').value)check()
  }
  $('open-connections')?.addEventListener('click',()=>open())
  return {open}
})()
