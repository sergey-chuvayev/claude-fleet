'use strict'
;(() => {
  const groups=[['attention','Needs you'],['review','Ready to review'],['running','Running'],['queued','Queued'],['idle','Ready']]
  const labels=Object.fromEntries(groups)
  function state(s) {
    if (s.openElsewhere) return s.openElsewhere.state==='busy' ? 'running':'attention'
    if (s.managedStatus==='approval' || s.approvals>0) return 'attention'
    if (s.managedStatus==='queued') return 'queued'
    if (['starting','running','stopping'].includes(s.managedStatus)) return 'running'
    if (['error','stopped'].includes(s.managedStatus) || s.error || s.taskProgress?.blocked>0) return 'attention'
    const p=s.taskProgress
    return p?.total>0 && p.verified===p.total ? 'review':'idle'
  }
  function visible(sessions,filter='all',search='') {
    const query=search.trim().toLowerCase()
    return sessions.filter(s=>s.managed && !s.archived && !s.background && (filter==='all' || state(s)===filter) &&
      [s.title,s.name,s.cwd,s.teamName,s.worktreeBranch].filter(Boolean).join(' ').toLowerCase().includes(query))
      .sort((a,b)=>groups.findIndex(([id])=>id===state(a))-groups.findIndex(([id])=>id===state(b)) ||
        (state(a)==='queued' ? (a.queuePosition || 0)-(b.queuePosition || 0) : (b.lastActivity || 0)-(a.lastActivity || 0)))
  }
  function nextAction(s,queue={}) {
    if (s.openElsewhere) return 'Open in another program · continue there or close it to resume here'
    if (s.managedStatus==='approval' || s.approvals>0) return 'Answer the pending question or approval in the conversation'
    if (state(s)==='queued') return `${queue.paused ? 'Dispatch paused' : 'Waiting for a free slot'}${s.queuePosition ? ` · position ${s.queuePosition}`:''}`
    if (state(s)==='running') return s.currentTool ? `Using ${s.currentTool}` : s.managedStatus==='stopping' ? 'Stopping the current run' : 'Working on the request'
    if (s.error) return s.error
    if (s.taskProgress?.blocked) return 'Inspect the blocker or review findings and continue this session'
    if (s.managedStatus==='stopped') return 'Stopped · send a message to continue'
    if (state(s)==='review') return 'Independent checks passed · inspect evidence and the delivery report'
    return 'Turn finished · inspect the result or send a follow-up'
  }
  // The grouping rules are shared with Node tests; no browser dependency is needed.
  if (typeof module!=='undefined' && module.exports) {module.exports={state,visible,nextAction};return}
  const { $,esc,update,store,toast,key,money }=window.Fleet
  let mode=store.get('fleet:view')==='queue' ? 'queue':'sessions',filter='all',search='',busy=false
  const mounted=()=>!!$('work-pane')
  function active() {return mode==='queue' && mounted()}
  function switchView(next) {
    mode=next;store.set('fleet:view',mode)
    $('sessions-pane').hidden=mode==='queue';$('work-pane').hidden=mode!=='queue'
    $('view-sessions').setAttribute('aria-pressed',String(mode==='sessions'))
    $('view-queue').setAttribute('aria-pressed',String(mode==='queue'))
    document.querySelector('.workspace').setAttribute('aria-label',mode==='queue' ? 'Work queue':'Sessions')
    window.Fleet.render()
  }
  function reveal() {
    filter='all';search=''
    if ($('work-search')) $('work-search').value=''
  }
  async function changeQueue(body) {
    if (busy) return
    busy=true;render(window.Fleet.snapshot())
    $('work-error').hidden=true
    try {
      await window.FleetControl.api('/api/queue',body)
      await window.Fleet.tick()
      toast(body.enabled ? 'Queue enabled. Tasks wait when all slots are busy.' : body.paused===true ? 'Dispatch paused. Running tasks continue.' : body.paused===false ? 'Queue resumed.' : 'Concurrency updated.')
    } catch(error) {
      $('work-error').textContent=error.message;$('work-error').hidden=false
    } finally {busy=false;render(window.Fleet.snapshot())}
  }
  function render(snapshot,selected) {
    if (!mounted() || !snapshot) return
    const all=visible(snapshot.sessions || []),queue=snapshot.queue
    $('work-total').textContent=all.length || ''
    $('work-count').textContent=all.length
    $('work-enable').hidden=!!queue?.enabled
    $('work-enable').disabled=busy || !queue
    $('work-pause').hidden=!queue?.enabled
    $('work-pause').disabled=busy
    $('work-pause').textContent=queue?.paused ? 'Resume queue':'Pause queue'
    $('work-pause').setAttribute('aria-pressed',String(!!queue?.paused))
    $('work-limit').disabled=busy || !queue
    if ($('work-limit')!==document.activeElement) $('work-limit').value=String(queue?.limit || 4)
    $('work-capacity').textContent=queue ? `${queue.running}/${queue.limit} slots in use · ${queue.waiting} queued${queue.paused ? ' · paused':''}` : 'Connecting to queue…'
    $('work-note').textContent=queue?.enabled ? 'Pausing holds new work; running tasks continue.' : 'Enable queuing to hold new tasks when all slots are busy.'
    if (!active()) return
    const counts=Object.fromEntries(groups.map(([id])=>[id,all.filter(s=>state(s)===id).length]))
    update('work-filters',[['all','All'],...groups].map(([id,label])=>`<button class="filter" type="button" data-filter="${id}" aria-pressed="${filter===id}">${label}<span>${id==='all' ? all.length:counts[id]}</span></button>`).join(''))
    const rows=visible(all,filter,search)
    if (!rows.length) {
      update('work-list',`<div class="empty">${all.length ? 'No matching tasks. Try another filter or search.' : 'Your work queue is empty.<br>Add a task to start a single agent, or choose Owner + review.'}</div>`)
      return
    }
    // When updating controls alone, retain the selected row rather than briefly clearing it.
    const current=selected ?? $('work-list').querySelector('[aria-pressed="true"]')?.dataset.session
    update('work-list',groups.map(([id,label])=>{
      const members=rows.filter(s=>state(s)===id)
      if (!members.length) return ''
      return `<section aria-label="${label}"><h3 class="work-group" data-state="${id}">${label}<span>${members.length}</span></h3>${members.map(s=>`<button type="button" class="session work-row" data-session="${esc(key(s))}" aria-pressed="${current===key(s)}"><span><span class="session-top"><span class="badge ${id==='attention' ? 'stale':id==='running' ? 'busy':'idle'}"><span class="dot"></span>${label}</span><span class="session-name">${esc(s.teamName || 'Single agent')}</span></span><span class="session-title">${esc(s.title || s.name || 'Untitled task')}</span><span class="session-meta">${esc(s.cwdShort || s.cwd)}${s.worktreeBranch ? ' · '+esc(s.worktreeBranch):''}</span><span class="work-next">${esc(nextAction(s,queue))}</span></span><span class="session-context" title="Reported API-rate equivalent usage">${esc(money(s.costUsd) || '$0.00')}</span></button>`).join('')}</section>`
    }).join(''))
  }
  window.FleetQueue={active,visible:sessions=>visible(sessions,filter,search),render,reveal,switchView}
  const original=$('sessions-pane')
  if (!original || !$('view-queue')) return
  original.insertAdjacentHTML('afterend',`<section class="sessions-pane work-pane" id="work-pane" aria-label="Managed tasks" hidden><div class="section-heading"><h2>Work queue <span id="work-count">0</span></h2><button type="button" class="button resume" id="work-add">＋ Add task</button></div><div class="work-controls"><span id="work-capacity" role="status">Connecting to queue…</span><label>Concurrent tasks<select id="work-limit" aria-label="Concurrent tasks">${Array.from({length:8},(_,i)=>`<option value="${i+1}"${i===3 ? ' selected':''}>${i+1}</option>`).join('')}</select></label><button type="button" class="button" id="work-enable">Enable queue</button><button type="button" class="button" id="work-pause" hidden>Pause queue</button><p class="note" id="work-note"></p><p class="form-error" id="work-error" role="alert" hidden></p></div><div class="work-filters" id="work-filters" aria-label="Filter tasks"></div><label class="work-search"><span class="sr-only">Find a task</span><input id="work-search" type="search" placeholder="Find a task or project…"></label><div class="list-head"><span>TASK / SESSION</span><span>USAGE</span></div><div id="work-list" class="session-list"></div></section>`)
  $('view-sessions').addEventListener('click',()=>switchView('sessions'))
  $('view-queue').addEventListener('click',()=>switchView('queue'))
  $('work-add').addEventListener('click',()=>window.FleetControl.openLaunch())
  $('work-enable').addEventListener('click',()=>changeQueue({enabled:true}))
  $('work-pause').addEventListener('click',()=>changeQueue({paused:!window.Fleet.snapshot()?.queue?.paused}))
  $('work-limit').addEventListener('change',event=>changeQueue({limit:Number(event.target.value)}))
  $('work-search').addEventListener('input',event=>{search=event.target.value;window.Fleet.render()})
  $('work-filters').addEventListener('click',event=>{
    const button=event.target.closest('[data-filter]');if(!button)return
    filter=button.dataset.filter;window.Fleet.render()
  })
  $('work-list').addEventListener('click',event=>{
    const row=event.target.closest('[data-session]');if(!row)return
    window.Fleet.select(row.dataset.session)
    if (matchMedia('(max-width:720px)').matches) $('detail').scrollIntoView({block:'start',behavior:'instant'})
  })
  switchView(mode)
})()
