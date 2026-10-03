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
      <header class="modal-head"><div class="modal-heading"><span class="modal-spark" aria-hidden="true">⌘</span><div><span class="modal-eyebrow">TOOLS WITHIN REACH</span><h2 id="connections-title">Your connections.</h2><p>Check what’s available. Get a blocked connection moving.</p></div></div><button type="button" class="modal-close" data-close-modal aria-label="Close connections"><i class="ico ico-close" aria-hidden="true"></i></button></header>
      <div class="modal-body"><form id="connections-form" class="connections-form"><label>Check connections for<select id="connections-session"><option value="">Project directory</option></select></label><label id="connections-project">Project directory<input id="connections-cwd" maxlength="4096" placeholder="~/projects/my-project" required></label><button class="button resume" id="connections-check" type="submit">Check connections</button></form>
      <p class="note" id="connections-context">Choose a project or session. Checking connects configured servers without sending an agent message.</p>
      <p id="connections-error" class="form-error" role="alert" hidden></p><div id="connections-results" aria-live="polite" aria-busy="false"><p class="connections-empty">Your configured MCP servers will appear here.</p></div>
      <details class="connections-help"><summary>Missing a connection?</summary><p>Sign in opens the server’s own sign-in page in your browser and Fleet picks the result up by itself. Claude.ai connectors you have not added yet are added in Claude’s settings; local servers are configured in Claude Code for this project.</p><a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">Open Claude connector settings <i class="ico ico-arrow" aria-hidden="true"></i></a><p>For a local server, open Claude Code in this project and run <code>/mcp</code> to authenticate or approve its configuration. Fleet does not add servers from this panel.</p></details></div>
      <footer class="modal-foot"><span>Connection changes never resend a task.</span><span><kbd>Esc</kbd> close</span></footer></section>`
    document.body.append(backdrop)
    $('connections-form').addEventListener('submit',event=>{event.preventDefault();check()})
    $('connections-backdrop').querySelector('[data-close-modal]').addEventListener('click',()=>clearTimeout(pollTimer))
    $('connections-session').addEventListener('change',reset)
    $('connections-cwd').addEventListener('input',reset)
    $('connections-results').addEventListener('click',event=>{
      const button=event.target.closest('[data-connection-action]')
      if(button)return check(button.dataset.connectionAction,button.dataset.server)
      const chip=event.target.closest('[data-connection-filter]')
      if(chip){filter=chip.dataset.connectionFilter;return render()}
      const cancel=event.target.closest('[data-cancel-sign-in]')
      if(cancel){pending.delete(cancel.dataset.cancelSignIn);render()}
    })
    $('connections-results').addEventListener('input',event=>{if(event.target.id==='connections-search'){search=event.target.value;render()}})
  }
  // What the panel is showing: the last result, a status filter, a search, and the
  // servers whose sign-in is under way (name -> {url, opened, since, claudeai}).
  let filter='all',search=''
  const pending=new Map()
  const SIGN_IN_TIMEOUT=5*60000,POLL_MS=4000
  let pollTimer=null
  function reset(){
    request++;result=null;busy=false;pending.clear();clearTimeout(pollTimer)
    $('connections-project').hidden=!!$('connections-session').value
    $('connections-cwd').required=!$('connections-session').value
    $('connections-results').innerHTML='<p class="connections-empty">Check this project’s connections to see their status.</p>'
    $('connections-error').hidden=true
    $('connections-context').textContent='Checking connects configured servers without sending an agent message.'
    setBusy(false)
  }
  function setBusy(value){
    busy=value
    for(const el of $('connections-form').querySelectorAll('input,select,button'))el.disabled=value
    for(const el of $('connections-results').querySelectorAll('[data-connection-action]'))el.disabled=value
    $('connections-check').textContent=value ? 'Checking…':'Check connections'
    $('connections-results').setAttribute('aria-busy',String(value))
  }
  // "claude.ai Google Calendar" reads as "Google Calendar" with a Claude.ai badge.
  const display=s=>s.scope==='claudeai' ? s.name.replace(/^claude\.ai\s+/i,'') : s.name
  // What is broken first, then what works, then what could: a long tail of connectors
  // never signed in to should not push the working ones off the screen.
  const ORDER=['failed','connected','pending','needs-auth','disabled']
  const GROUP={'needs-auth':'Needs sign-in',failed:'Failed',pending:'Connecting',connected:'Connected',disabled:'Off'}
  function rowHtml(s){
    const name=display(s),wait=pending.get(s.name),button=(action,label,primary)=>`<button type="button" class="button${primary ? ' resume':''}" data-connection-action="${action}" data-server="${esc(s.name)}" aria-label="${esc(label+' '+name)}">${label}</button>`
    let action=''
    if(wait){
      const late=Date.now()-wait.since>SIGN_IN_TIMEOUT
      action=late ? `<span class="connection-wait">Didn’t finish?</span>${button('authenticate','Try again',true)}`
        : `<span class="connection-wait"><span class="day-spinner" aria-hidden="true"></span>Waiting for you to finish signing in</span>${wait.url ? `<a class="button" href="${esc(wait.url)}" target="_blank" rel="noopener noreferrer">Open page again <i class="ico ico-arrow" aria-hidden="true"></i></a>`:''}<button type="button" class="button" data-cancel-sign-in="${esc(s.name)}">Cancel</button>`
    }
    else if(s.internal)action=''
    else if(s.status==='needs-auth')action=s.canAuthenticate===false ? `<span class="note">Run <code>/mcp</code> in Claude Code for this project to sign in.</span>` : button('authenticate','Sign in <i class="ico ico-arrow" aria-hidden="true"></i>',false)
    else if(s.status==='failed')action=button('reconnect','Reconnect',true)
    else if(s.status==='disabled' && s.canToggle)action=button('enable','Turn on',false)
    else if(s.status==='connected' && s.canToggle)action=button('disable','Turn off',false)
    const kind=s.internal ? 'Fleet' : s.scope==='claudeai' ? 'Claude.ai' : s.scope==='project' ? 'Project' : s.scope==='local' ? 'Local' : s.scope==='user' ? 'Your config' : s.scope
    const tools=s.tools.length ? `<details class="connection-tools"><summary>${s.tools.length} tool${s.tools.length===1 ? '':'s'}</summary><ul>${s.tools.map(t=>`<li><code>${esc(t)}</code></li>`).join('')}</ul></details>`:''
    return `<li class="connection-row" data-status="${esc(wait ? 'signing-in':s.status)}"><span class="connection-avatar" aria-hidden="true">${esc(name.replace(/[^\p{L}\p{N}]/gu,'').slice(0,1).toUpperCase() || '·')}</span><div class="connection-main"><div class="connection-name"><strong>${esc(name)}</strong><span class="connection-kind">${esc(kind)}</span></div><span class="connection-status" data-status="${esc(s.status)}"><span aria-hidden="true">●</span> ${esc(wait ? 'Signing in' : labels[s.status] || s.status)}</span>${s.error ? `<p class="note">${esc(s.error)}</p>`:''}${tools}</div><div class="connection-actions">${action}</div></li>`
  }
  function render(){
    if(!result)return
    const {servers,source,cwd}=result
    $('connections-context').textContent=source==='session' ? `Live session · ${cwd}. These are the servers visible to this agent now.` : `Project · ${cwd}. Changes here do not reconnect an agent that is already running.`
    if(!servers.length){$('connections-results').innerHTML='<p class="connections-empty">No MCP servers were reported for this project. Check the configuration or Claude connector settings below.</p>';return}
    const counts=Object.fromEntries(ORDER.map(k=>[k,servers.filter(s=>s.status===k).length]))
    if(filter!=='all' && !counts[filter])filter='all'
    const query=search.trim().toLowerCase()
    const shown=servers.filter(s=>(filter==='all' || s.status===filter) && (!query || display(s).toLowerCase().includes(query)))
    const chips=[['all','All',servers.length],...ORDER.filter(k=>counts[k]).map(k=>[k,GROUP[k],counts[k]])]
    const groups=ORDER.map(k=>[k,shown.filter(s=>s.status===k).sort((a,b)=>display(a).localeCompare(display(b)))]).filter(([,list])=>list.length)
    // Typing in the search box must not lose its focus to a redraw.
    const searching=document.activeElement?.id==='connections-search',caret=searching ? document.activeElement.selectionStart : null
    $('connections-results').innerHTML=`<div class="connections-toolbar"><div class="connections-filters" role="group" aria-label="Filter connections">${chips.map(([k,label,n])=>`<button type="button" class="filter" data-connection-filter="${k}" aria-pressed="${filter===k}">${label}<span>${n}</span></button>`).join('')}</div><input id="connections-search" type="search" placeholder="Find a connection" value="${esc(search)}" aria-label="Find a connection" autocomplete="off"></div><p class="connections-checked">${servers.filter(s=>s.status==='connected').length} of ${servers.length} connected · checked ${new Date(result.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>${groups.length ? groups.map(([k,list])=>`<section class="connections-group"><h3>${GROUP[k]} <span>${list.length}</span></h3><ul class="connections-list">${list.map(rowHtml).join('')}</ul></section>`).join('') : '<p class="connections-empty">No connection matches.</p>'}`
    if(searching){const el=$('connections-search');el.focus();el.setSelectionRange(caret,caret)}
    if(busy)setBusy(true)
  }
  // One path for every request. A quiet one (the sign-in poll) neither disables the
  // panel nor moves focus, so it can run while the operator reads or types.
  async function call(action='check',name,{quiet=false}={}){
    if(busy)return null
    const ticket=++request
    if(!quiet){setBusy(true);$('connections-error').hidden=true}
    const sessionId=$('connections-session').value
    try{
      const data=await api('/api/connections',{action,name,sessionId:sessionId || undefined,cwd:sessionId ? undefined:$('connections-cwd').value,connectionId:result?.connectionId,source:result?.source})
      if(ticket!==request || !modalIsOpen('connections-backdrop'))return null
      result=data.connections
      return result
    }catch(error){
      if(ticket===request && !quiet){$('connections-error').textContent=error.message;$('connections-error').hidden=false}
      // A stale connection id or a closed probe: start over from a fresh check.
      if(quiet && error.message && /Check connections again|expired/.test(error.message))result={...result,connectionId:undefined,source:undefined}
      return null
    }finally{
      if(ticket===request){if(!quiet)setBusy(false);render()}
      if(!quiet && name && modalIsOpen('connections-backdrop')){const buttons=[...$('connections-results').querySelectorAll('[data-server]')].filter(b=>b.dataset.server===name);(buttons.find(b=>b.dataset.connectionAction===action) || buttons[0])?.focus({preventScroll:true})}
    }
  }
  async function check(action,name){
    if(action==='authenticate')return signIn(name)
    const done=await call(action,name)
    if(!action && !name && done && document.activeElement===document.body)$('connections-session').focus()
    settle()
  }
  // Servers are often still starting when the first check returns. Look again quietly
  // a few times so "Connecting" turns into what it really is.
  let settleTimer=null
  function settle(round=0){
    clearTimeout(settleTimer)
    if(round>=8 || !result?.servers?.some(s=>s.status==='pending') || !modalIsOpen('connections-backdrop'))return
    settleTimer=setTimeout(async()=>{ if(!pending.size)await call('check',undefined,{quiet:true}); settle(round+1) },2500)
  }
  async function signIn(name){
    const done=await call('authenticate',name)
    const auth=done?.auth
    if(!auth)return
    const server=done.servers.find(s=>s.name===name)
    if(server?.status==='connected'){window.Fleet.toast(`${display(server)} is connected.`);return}
    if(!auth.url && !auth.needsAction){window.Fleet.toast('Signed in.');return}
    pending.set(name,{url:auth.url,opened:auth.opened,since:Date.now(),claudeai:server?.scope==='claudeai'})
    window.Fleet.toast(auth.opened ? 'Opened the sign-in page in your browser. Finish there; Fleet picks it up.' : 'Open the sign-in page to finish signing in.')
    if(!auth.opened && auth.url)window.open(auth.url,'_blank','noopener')
    render();poll()
  }
  // Until each sign-in finishes or times out: a claude.ai connector is reconnected so
  // Claude fetches the new authorization; an OAuth server finishes by itself once its
  // callback arrives, so a plain check is enough to see it.
  function poll(){
    clearTimeout(pollTimer)
    if(!pending.size || !modalIsOpen('connections-backdrop'))return
    pollTimer=setTimeout(async()=>{
      const live=[...pending].filter(([,w])=>Date.now()-w.since<=SIGN_IN_TIMEOUT)
      if(!live.length){render();return}
      const [name,wait]=live[Math.floor(Date.now()/POLL_MS)%live.length]
      const data=result?.connectionId ? await call(wait.claudeai ? 'reconnect':'check',wait.claudeai ? name:undefined,{quiet:true}) : await call('check',undefined,{quiet:true})
      for(const s of data?.servers || [])if(pending.has(s.name) && s.status==='connected'){pending.delete(s.name);window.Fleet.toast(`${display(s)} is connected.`)}
      render();poll()
    },POLL_MS)
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
