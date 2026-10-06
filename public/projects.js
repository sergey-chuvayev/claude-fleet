'use strict'
// The Projects tab: the outcomes the operator owns, each with its deliverables, the
// sessions tagged to it, and a project manager to ask. Like Today, it is a pane beside
// the console, and the console holds the selected project's manager. An isolated scope.
window.FleetProjects=(()=>{
  const { esc, toast } = window.Fleet
  const UI = window.FleetUI
  const control = () => window.FleetControl
  const api = (...args) => window.FleetControl.api(...args)
  const escape=value=>esc(String(value ?? ''))
  const STATE={todo:'To do',doing:'Doing',review:'In review',done:'Done'}
  const STATE_TONE={todo:'todo',doing:'progress',review:'review',done:'done'}
  const DAY_STATUS={today:'planned',in_progress:'in progress',waiting_on_you:'waiting on you',done:'done',later:'later',proposed:'proposed'}
  const SESSION_TONE={starting:'working',running:'working',approval:'needs',stopping:'idle',stopped:'idle',error:'hot',idle:'idle',queued:'queued'}
  const SESSION_STATE={starting:'starting',running:'working',approval:'needs you',stopping:'stopping',stopped:'stopped',error:'failed',idle:'ready',queued:'queued'}
  const store=window.Fleet.store
  let projects=[],selected=null,editing=null,fetchedAt=0,loading=null
  const pane=()=>document.getElementById('projects-pane')
  const active=()=>window.FleetViews?.view()==='projects' && !!pane()
  const current=live=>{
    const p=projects.find(p=>p.id===selected)
    return p?.managerId ? live.find(s=>s.managedId===p.managerId) || null : null
  }
  function load(force=false) {
    if(loading || (!force && Date.now()-fetchedAt<4000))return loading
    loading=api('/api/projects').then(data=>{
      projects=data.projects;fetchedAt=Date.now()
      if(!projects.some(p=>p.id===selected))selected=projects[0]?.id || null
      draw()
      // The console follows the project: its manager, once there is one.
      if(active())window.Fleet.render()
    }).catch(()=>{}).finally(()=>{loading=null})
    return loading
  }
  const daysLeft=deadline=>{
    if(!deadline)return null
    const end=new Date(`${deadline}T23:59:59`),now=new Date()
    let n=0
    for(const d=new Date(now);d<end;d.setDate(d.getDate()+1))if(![0,6].includes(d.getDay()))n++
    return n
  }
  const lines=list=>escape((list || []).join('\n'))
  // A project starts from a title. Everything else is the manager's job, by chat.
  // The header every project view shares: the title, a switcher between projects, and
  // what can be done to the one shown.
  function switcher() {
    if(!projects.length)return ''
    return `<select data-project-switch aria-label="Switch project">${projects.map(x=>`<option value="${escape(x.id)}" ${x.id===selected && editing!=='new' ? 'selected':''}>${escape(x.name)}</option>`).join('')}${editing==='new' ? '<option value="" selected>New project</option>':''}</select>`
  }
  const newButton='<button type="button" class="button ghost" data-new><i class="ico ico-plus" aria-hidden="true"></i> New project</button>'
  const newHtml=()=>`${UI.pageHead({title:'New project',actions:switcher()})}<div class="page-body"><form class="ui-form project-new-form" data-project-new><h3>What are you working towards?</h3><p class="note">Just a title. The project manager looks it up in Linear, GitHub, Slack, Notion and your meetings, writes the brief, deadline and deliverables into the project's file, and asks you what it could not find.</p><input data-keep="new:name" name="name" required maxlength="100" placeholder="Queue in the ring node" autocomplete="off"><textarea data-keep="new:note" name="note" rows="3" maxlength="8000" placeholder="Anything to start from? A link, a deadline, who asked. Optional."></textarea><div class="ui-actions"><button type="submit" class="button resume">Create and set up <i class="ico ico-arrow" aria-hidden="true"></i></button><button type="button" class="button" data-cancel>Cancel</button></div></form></div>`
  function projectHtml(p,live) {
    const left=daysLeft(p.deadline),members=live.filter(s=>s.projectId===p.id && s.kind!=='project')
    // Each open deliverable can go on today's Day; once there, it says so and leads there.
    const onToday=p.onToday || {}
    const todayButton=d=>onToday[d.id] ? `<button type="button" class="button ghost is-on-today" data-open-today="${escape(onToday[d.id].itemId)}" title="On today's Day: ${escape(DAY_STATUS[onToday[d.id].status] || onToday[d.id].status)}">${onToday[d.id].status==='done' ? 'Done today' : 'On Today'} <i class="ico ico-arrow" aria-hidden="true"></i></button>` : d.state==='done' ? '' : `<button type="button" class="button ghost" data-plan-today="${escape(d.id)}" title="Put this on today's Day. The Day agent prepares a launch brief for you to approve."><i class="ico ico-plus" aria-hidden="true"></i> Today</button>`
    // A task shows its sources as chips; its brief, the context an agent starts from,
    // opens in place.
    // Every task opens: its brief and sources, and a comment box. A comment goes to the
    // project manager, which updates the task, and into the project log.
    const taskDetail=d=>`<div class="task-detail">${d.brief ? `<div class="project-md">${md(d.brief)}</div>`:'<p class="note">No brief yet. Comment below to give it one, or ask the project manager.</p>'}${d.links?.length ? `<div class="task-sources"><span class="task-sources-label">Sources</span>${UI.links(d.links)}</div>`:''}<div class="ui-ask task-comment"><textarea data-keep="comment:${escape(p.id)}:${escape(d.id)}" data-task-comment="${escape(d.id)}" rows="1" maxlength="8000" placeholder="Comment on this task: a decision, new info, what changed…"></textarea><button type="button" class="button" data-send-comment="${escape(d.id)}">Comment <i class="ico ico-arrow" aria-hidden="true"></i></button></div></div>`
    const deliverables=UI.list(p.deliverables.map(d=>UI.row({tone:STATE_TONE[d.state],orbTitle:STATE[d.state],title:escape(d.title),key:`task:${d.id}`,detail:taskDetail(d),meta:`${UI.links(d.links,{limit:3,cls:'is-quiet'})}${d.note ? `<span class="ui-row-latest" title="${escape(d.note)}">${escape(d.note)}</span>`:''}`,side:`${todayButton(d)}<select data-deliverable="${escape(d.id)}" aria-label="State of ${escape(d.title)}">${Object.entries(STATE).map(([k,v])=>`<option value="${k}" ${k===d.state ? 'selected':''}>${v}</option>`).join('')}</select>`})).join(''))
    const sessions=members.length ? UI.list(members.map(s=>UI.row({tone:SESSION_TONE[s.managedStatus],orbTitle:SESSION_STATE[s.managedStatus] || s.managedStatus,title:escape((s.title || s.name || 'Session').slice(0,80)),meta:UI.pill(escape(SESSION_STATE[s.managedStatus] || s.managedStatus),SESSION_TONE[s.managedStatus]),side:`<button type="button" class="button ghost" data-open-session="${escape(s.managedId)}">Open <i class="ico ico-arrow" aria-hidden="true"></i></button>`})).join(''),'is-compact') : '<p class="note">No sessions yet. Tag one from its console, or launch from your Day.</p>'
    const log=(p.log || []).slice(-5).reverse()
    const strip=[
      p.deadline ? UI.stat('Deadline',escape(new Date(`${p.deadline}T12:00:00`).toLocaleDateString([],{day:'numeric',month:'short'}))):'',
      left!=null ? UI.stat('Left',`${left} <small>working day${left===1 ? '':'s'}</small>`,{tone:left<=2 ? 'hot' : left<=5 ? 'warn' : undefined}):'',
      UI.stat('Done',`${UI.ring(p.progress.done,p.progress.total)}${p.progress.done} <small>of ${p.progress.total}</small>`),
      UI.stat('Sessions',String(members.length)),
    ].join('')
    const actions=`${switcher()}${newButton}<button type="button" class="button ghost" data-copy-path="${escape(p.file)}" title="${escape(p.file)}">Copy file path</button><button type="button" class="button ghost" data-archive="${escape(p.id)}">Archive</button>`
    return `${UI.pageHead({title:escape(p.name),actions,strip})}
      <div class="page-body">
        ${setting(p,live)}
        ${p.managerId ? '' : UI.section('Project manager',`<p class="note">One agent that follows this project: its sessions, PRs and tickets, and the deliverables below. Ask it where things stand; it can put next steps on your Day.</p>${UI.ask({key:`ask:${p.id}`,placeholder:'Where are we? What is blocking? Are we on track for the deadline?',data:'data-project-ask',button:`<button type="button" class="button resume" data-ask-project="${escape(p.id)}">Ask <i class="ico ico-arrow" aria-hidden="true"></i></button>`})}`)}
        ${UI.section('Deliverables',p.deliverables.length ? deliverables : '<p class="note">No deliverables yet. The project manager adds them as it learns what has to ship, or tell it.</p>',{count:`${p.progress.done}/${p.progress.total}`})}
        ${UI.section('Sessions',sessions,{count:members.length})}
        ${log.length ? UI.section('Log',UI.log(log.map(l=>[new Date(l.at).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'}),escape(l.text)]))):''}
        ${p.brief ? UI.section('Brief',`<div class="project-md">${md(p.brief)}</div>`):''}
        ${p.sections.length ? `<div class="ui-folds">${p.sections.map(x=>`<details class="ui-fold" data-keep-open="${escape(x.heading)}"><summary>${UI.chevron}${escape(x.heading)}</summary><div class="project-md">${md(x.body)}</div></details>`).join('')}</div>`:''}
        ${p.links.length ? UI.section('Links',`<span class="day-links">${p.links.map(u=>`<a href="${escape(u)}" target="_blank" rel="noopener noreferrer">${escape(u.replace(/^https?:\/\/(www\.)?/,'').slice(0,60))} <i class="ico ico-arrow" aria-hidden="true"></i></a>`).join('')}</span>`):''}
      </div>`
  }
  // Markdown from the project file, rendered the way the console renders replies.
  const md=text=>window.FleetBlocks?.proseHtml ? window.FleetBlocks.proseHtml(String(text || '')) : `<p class="day-context">${escape(text)}</p>`
  // While the manager's first run is under way, the empty parts of the project say why.
  function setting(p,live) {
    const pm=live.find(s=>s.managedId===p.managerId),busy=pm && ['starting','running','approval','queued'].includes(pm.managedStatus)
    if(p.brief && p.deliverables.length)return ''
    return busy ? UI.callout('<span class="day-spinner" aria-hidden="true"></span> Setting up','The project manager is filling in the brief, deadline, deliverables and sources. Watch it on the right.',{tone:'working'}) : UI.callout('Not set up yet','Tell the project manager on the right what this project is, or ask it to look it up.')
  }
  function draw(force=false) {
    if(!pane())return
    const live=window.Fleet.snapshot()?.sessions || []
    const p=projects.find(p=>p.id===selected)
    const signature=JSON.stringify([projects,selected,editing,live.filter(s=>s.projectId).map(s=>[s.managedId,s.managedStatus,s.title])])
    if(!force && pane().fleetSignature===signature)return
    // Redrawing would replace the select under an open dropdown; the next refresh catches up.
    if(!force && window.FleetSelect?.isOpen(pane()))return
    // What the operator is in the middle of survives a redraw: typed text, focus, open
    // sections. Polling used to rebuild the pane every few seconds and wipe the form.
    const typed=new Map([...pane().querySelectorAll('[data-keep]')].map(el=>[el.dataset.keep,el.value]))
    const focused=document.activeElement?.closest?.('#projects-pane [data-keep]')?.dataset.keep
    const opened=new Set([...pane().querySelectorAll('details[open][data-keep-open], details[open][data-evidence]')].map(el=>el.dataset.keepOpen || el.dataset.evidence))
    pane().fleetSignature=signature
    const body=editing==='new' || !projects.length && editing!=='closed' ? newHtml() : p ? projectHtml(p,live) : `${UI.pageHead({title:'Projects'})}${UI.empty({title:'Group your work by outcome.',text:'A project holds a goal, a deadline and its deliverables. Sessions you tag to it, and items on your Day, roll up here, and its manager can tell you where things stand.',action:'<button type="button" class="button resume" data-new>Create a project <i class="ico ico-arrow" aria-hidden="true"></i></button>'})}`
    const top=pane().querySelector('.page-body')?.scrollTop || 0
    pane().innerHTML=body
    for(const el of pane().querySelectorAll('[data-keep]'))if(typed.has(el.dataset.keep))el.value=typed.get(el.dataset.keep)
    for(const el of pane().querySelectorAll('details[data-keep-open], details[data-evidence]'))if(opened.has(el.dataset.keepOpen || el.dataset.evidence))el.open=true
    if(focused){const el=pane().querySelector(`[data-keep="${CSS.escape(focused)}"]`);if(el){el.focus({preventScroll:true});const end=el.value.length;el.setSelectionRange?.(end,end)}}
    const scroller=pane().querySelector('.page-body');if(scroller)scroller.scrollTop=top
  }
  // Before a project has a manager the console beside it would be blank; say what goes there.
  function emptyConsole() {
    const panel=document.getElementById('control-panel')
    if(!active() || !panel || panel.children.length)return
    const p=projects.find(p=>p.id===selected)
    panel.innerHTML=`<div class="console-empty"><strong>${p ? 'No project manager yet' : 'No project selected'}</strong><span>${p ? 'Ask it something on the left. Its conversation appears here.' : 'Create a project to give it a manager.'}</span></div>`
  }
  function render(live) {
    if(!pane())return
    emptyConsole()
    // Other tabs need the list too (the console's project picker, Day item tags), just
    // not as fresh.
    if(active())load();else if(Date.now()-fetchedAt>30000)load()
    if(active())draw()
  }
  async function act(event) {
    const t=event.target
    if(t.closest('[data-new]')){editing='new';return draw(true)}
    if(t.closest('[data-cancel]')){editing=projects.length ? null : 'closed';return draw(true)}
    const copy=t.closest('[data-copy-path]')
    if(copy){navigator.clipboard?.writeText(copy.dataset.copyPath).then(()=>toast('Path copied. Edit the file by hand any time; Fleet reads it.'),()=>toast(copy.dataset.copyPath));return}
    const archive=t.closest('[data-archive]')
    if(archive){if(!confirmArchive(archive))return;await api(`/api/projects/${archive.dataset.archive}/archive`,{archived:true}).catch(e=>toast(e.message));editing=null;selected=null;return load(true)}
    const plan=t.closest('[data-plan-today]')
    if(plan){
      plan.disabled=true
      try{
        const result=await api(`/api/projects/${selected}/today`,{deliverableId:plan.dataset.planToday})
        toast(result.existing ? 'Already on today.' : 'On today. The Day agent is preparing a launch brief.')
        await window.Fleet.tick();await load(true)
      }catch(error){toast(error.message);plan.disabled=false}
      return
    }
    const onDay=t.closest('[data-open-today]')
    if(onDay)return window.FleetDay?.showItem?.(onDay.dataset.openToday)
    const opener=t.closest('[data-open-session]')
    if(opener){window.FleetViews?.switchView('sessions');return window.Fleet.select(opener.dataset.openSession)}
    const send=t.closest('[data-send-comment]')
    if(send){
      const field=pane().querySelector(`[data-task-comment="${CSS.escape(send.dataset.sendComment)}"]`),message=field?.value.trim()
      if(!message)return toast('Write your comment first.')
      send.disabled=true
      try{
        await api(`/api/projects/${selected}/comment`,{deliverableId:send.dataset.sendComment,message,requestId:crypto.randomUUID()})
        field.value='';field.dispatchEvent(new Event('input',{bubbles:true}))
        toast('Comment sent. The project manager is updating the task.')
        await window.Fleet.tick();await load(true)
      }catch(error){toast(error.message);send.disabled=false}
      return
    }
    const ask=t.closest('[data-ask-project]')
    if(ask){
      const field=pane().querySelector('[data-project-ask]'),message=field?.value.trim()
      if(!message)return toast('Type your question first.')
      ask.disabled=true
      try{await api(`/api/projects/${ask.dataset.askProject}/ask`,{message,requestId:crypto.randomUUID()});field.value='';await window.Fleet.tick();await load(true)}
      catch(error){toast(error.message);ask.disabled=false}
    }
  }
  // Archiving takes two clicks, the second within a few seconds, like closing an agent.
  function confirmArchive(button) {
    if(button.dataset.armed)return true
    button.dataset.armed='1';button.textContent='Archive for good?'
    setTimeout(()=>{if(button.isConnected){delete button.dataset.armed;button.textContent='Archive'}},4000)
    return false
  }
  async function submit(event) {
    const form=event.target.closest('[data-project-new]');if(!form)return
    event.preventDefault()
    const name=form.elements.name.value.trim(),note=form.elements.note.value.trim()
    if(!name)return toast('Give it a title.')
    const button=form.querySelector('[type=submit]');button.disabled=true
    try{
      const {project}=await api('/api/projects',{name,...(note ? {note}:{}),requestId:crypto.randomUUID()})
      selected=project.id;editing=null;store.set('fleet:project',selected)
      for(const el of form.querySelectorAll('[data-keep]'))el.value=''
      toast('Project created. Its manager is setting it up.')
      await window.Fleet.tick();await load(true);window.Fleet.render()
    }catch(error){toast(error.message);button.disabled=false}
  }
  async function change(event) {
    const pick=event.target.closest('[data-project-switch]')
    if(pick){if(!pick.value)return;selected=pick.value;editing=null;store.set('fleet:project',selected);draw(true);return window.Fleet.render()}
    const select=event.target.closest('[data-deliverable]');if(!select)return
    try{await api(`/api/projects/${selected}/deliverable`,{deliverableId:select.dataset.deliverable,state:select.value});await load(true)}
    catch(error){toast(error.message)}
  }
  // Mounted before views.js runs, which owns switching between the views.
  function mount() {
    const tabs=document.querySelector('.work-tabs'),sessions=document.getElementById('sessions-pane')
    if(!tabs || !sessions || document.getElementById('view-projects'))return
    const today=document.getElementById('view-today')
    const button='<button type="button" class="button" id="view-projects" aria-pressed="false" title="Your projects: deliverables, sessions and a manager to ask">Projects</button>'
    if(today)today.insertAdjacentHTML('afterend',button);else tabs.insertAdjacentHTML('afterbegin',button)
    sessions.insertAdjacentHTML('afterend','<section class="sessions-pane today-pane projects-pane" id="projects-pane" aria-label="Projects" hidden></section>')
    selected=store.get('fleet:project')
    pane().addEventListener('click',act)
    pane().addEventListener('submit',submit)
    pane().addEventListener('change',change)
    pane().addEventListener('keydown',event=>{
      if(event.key!=='Enter' || event.shiftKey)return
      if(event.target.matches('[data-project-ask]')){event.preventDefault();pane().querySelector('[data-ask-project]')?.click()}
      if(event.target.matches('[data-task-comment]')){event.preventDefault();pane().querySelector(`[data-send-comment="${CSS.escape(event.target.dataset.taskComment)}"]`)?.click()}
    })
  }
  mount()
  // The console's own controls use this to offer a project to tag a session with.
  // Open one project, from anywhere (a Today item's project tag).
  function show(id) {
    if(!projects.some(p=>p.id===id) && fetchedAt)return toast('That project is archived or gone.')
    selected=id;editing=null;store.set('fleet:project',selected)
    window.FleetViews?.switchView('projects')
    draw(true);load(true)
  }
  return {active,current,render,list:()=>projects,load,show}
})()
