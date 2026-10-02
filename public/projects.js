'use strict'
// The Projects tab: the outcomes the operator owns, each with its deliverables, the
// sessions tagged to it, and a project manager to ask. Like Today, it is a pane beside
// the console, and the console holds the selected project's manager. An isolated scope.
window.FleetProjects=(()=>{
  const { esc, toast } = window.Fleet
  const control = () => window.FleetControl
  const api = (...args) => window.FleetControl.api(...args)
  const escape=value=>esc(String(value ?? ''))
  const STATE={todo:'To do',doing:'Doing',review:'In review',done:'Done'}
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
  const newHtml=()=>`<div class="today-body"><form class="project-new-form" data-project-new><span class="modal-eyebrow">NEW PROJECT</span><h2>What are you working towards?</h2><p class="note">Just a title. The project manager looks it up in Linear, GitHub, Slack, Notion and your meetings, writes the brief, deadline and deliverables into the project's file, and asks you what it could not find.</p><input data-keep="new:name" name="name" required maxlength="100" placeholder="Queue in the ring node" autocomplete="off"><textarea data-keep="new:note" name="note" rows="3" maxlength="8000" placeholder="Anything to start from? A link, a deadline, who asked. Optional."></textarea><div class="day-actions"><button type="submit" class="button resume">Create and set up ↗</button><button type="button" class="button" data-cancel>Cancel</button></div></form></div>`
  function projectHtml(p,live) {
    const left=daysLeft(p.deadline),members=live.filter(s=>s.projectId===p.id && s.kind!=='project')
    const deliverables=p.deliverables.map(d=>`<li class="project-deliverable" data-state="${escape(d.state)}"><select data-deliverable="${escape(d.id)}" aria-label="State of ${escape(d.title)}">${Object.entries(STATE).map(([k,v])=>`<option value="${k}" ${k===d.state ? 'selected':''}>${v}</option>`).join('')}</select><span><strong>${escape(d.title)}</strong>${d.note ? `<small>${escape(d.note)}</small>`:''}</span></li>`).join('')
    const sessions=members.length ? `<div class="day-launched">${members.map(s=>`<button type="button" class="day-launch-chip" data-open-session="${escape(s.managedId)}" data-state="${escape(s.managedStatus)}" title="Open in Sessions"><span class="dot"></span>${escape((s.title || s.name || 'Session').slice(0,48))} · ${escape(SESSION_STATE[s.managedStatus] || s.managedStatus)} ↗</button>`).join('')}</div>` : '<p class="note">No sessions yet. Tag one from its console, or launch from your Day.</p>'
    const log=(p.log || []).slice(-5).reverse()
    return `<header class="today-head"><div><span class="modal-eyebrow">PROJECT</span><h2>${escape(p.name)}</h2></div><div class="today-stats">${p.deadline ? `<span>${escape(new Date(`${p.deadline}T12:00:00`).toLocaleDateString([],{day:'numeric',month:'short'}))}${left!=null ? ` · ${left} working day${left===1 ? '':'s'} left`:''}</span>`:''}<span>${p.progress.done}/${p.progress.total} done</span><button type="button" class="button day-small" data-copy-path="${escape(p.file)}" title="${escape(p.file)}">Copy file path</button><button type="button" class="button day-small" data-archive="${escape(p.id)}">Archive</button></div></header>
      <div class="today-body">
        ${setting(p,live)}
        ${p.managerId ? '' : `<section class="day-section project-ask"><h4>Project manager</h4><p class="note">One agent that follows this project: its sessions, PRs and tickets, and the deliverables below. Ask it where things stand; it can put next steps on your Day.</p><div class="day-ask">${`<input data-project-ask data-keep="ask:${escape(p.id)}" maxlength="2000" placeholder="Where are we? What is blocking? Are we on track for the deadline?">`}<button type="button" class="button resume" data-ask-project="${escape(p.id)}">Ask ↗</button></div></section>`}
        <section class="day-section"><h4>Deliverables <span>${p.progress.done}/${p.progress.total}</span></h4>${p.deliverables.length ? `<ol class="project-deliverables">${deliverables}</ol>` : '<p class="note">No deliverables yet. The project manager adds them as it learns what has to ship, or tell it.</p>'}</section>
        <section class="day-section"><h4>Sessions <span>${members.length}</span></h4>${sessions}</section>
        ${log.length ? `<section class="day-section"><h4>Log</h4><ol class="day-log">${log.map(l=>`<li><time>${new Date(l.at).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'})}</time> ${escape(l.text)}</li>`).join('')}</ol></section>`:''}
        ${p.brief ? `<section class="day-section project-brief"><h4>Brief</h4><div class="project-md">${md(p.brief)}</div></section>`:''}
        ${p.sections.map(x=>`<details class="day-section project-brief" data-keep-open="${escape(x.heading)}"><summary>${escape(x.heading)}</summary><div class="project-md">${md(x.body)}</div></details>`).join('')}
        ${p.links.length ? `<section class="day-section"><h4>Links</h4><span class="day-links">${p.links.map(u=>`<a href="${escape(u)}" target="_blank" rel="noopener noreferrer">${escape(u.replace(/^https?:\/\/(www\.)?/,'').slice(0,60))} ↗</a>`).join('')}</span></section>`:''}
      </div>`
  }
  // Markdown from the project file, rendered the way the console renders replies.
  const md=text=>window.FleetBlocks?.proseHtml ? window.FleetBlocks.proseHtml(String(text || '')) : `<p class="day-context">${escape(text)}</p>`
  // While the manager's first run is under way, the empty parts of the project say why.
  function setting(p,live) {
    const pm=live.find(s=>s.managedId===p.managerId),busy=pm && ['starting','running','approval','queued'].includes(pm.managedStatus)
    if(p.brief && p.deliverables.length)return ''
    return `<p class="note project-setting">${busy ? '<span class="day-spinner" aria-hidden="true"></span> The project manager is setting this up: brief, deadline, deliverables, sources. Watch it on the right.' : 'Not set up yet. Tell the project manager on the right what this project is, or ask it to look it up.'}</p>`
  }
  function draw(force=false) {
    if(!pane())return
    const live=window.Fleet.snapshot()?.sessions || []
    const p=projects.find(p=>p.id===selected)
    const signature=JSON.stringify([projects,selected,editing,live.filter(s=>s.projectId).map(s=>[s.managedId,s.managedStatus,s.title])])
    if(!force && pane().fleetSignature===signature)return
    // What the operator is in the middle of survives a redraw: typed text, focus, open
    // sections. Polling used to rebuild the pane every few seconds and wipe the form.
    const typed=new Map([...pane().querySelectorAll('[data-keep]')].map(el=>[el.dataset.keep,el.value]))
    const focused=document.activeElement?.closest?.('#projects-pane [data-keep]')?.dataset.keep
    const opened=new Set([...pane().querySelectorAll('details[open][data-keep-open]')].map(el=>el.dataset.keepOpen))
    pane().fleetSignature=signature
    const list=`<nav class="project-list" aria-label="Projects">${projects.map(x=>`<button type="button" class="project-tab" data-project="${escape(x.id)}" aria-pressed="${x.id===selected && editing!=='new'}"><strong>${escape(x.name)}</strong><span class="mini-bar"><i style="width:${x.progress.total ? Math.round(x.progress.done/x.progress.total*100) : 0}%"></i></span><small>${x.progress.done}/${x.progress.total}${x.deadline ? ` · ${daysLeft(x.deadline)}d`:''}${x.sessions ? ` · ${x.sessions} session${x.sessions===1 ? '':'s'}`:''}</small></button>`).join('')}<button type="button" class="project-tab project-new" data-new aria-pressed="${editing==='new'}">＋ New project</button></nav>`
    const body=editing==='new' || !projects.length && editing!=='closed' ? newHtml() : p ? projectHtml(p,live) : `<div class="today-empty"><span class="modal-eyebrow">PROJECTS</span><h2>Group your work by outcome.</h2><p class="note">A project holds a goal, a deadline and its deliverables. Sessions you tag to it, and items on your Day, roll up here, and its manager can tell you where things stand.</p><button type="button" class="button resume" data-new>Create a project ↗</button></div>`
    const top=pane().querySelector('.today-body')?.scrollTop || 0
    pane().innerHTML=list+body
    for(const el of pane().querySelectorAll('[data-keep]'))if(typed.has(el.dataset.keep))el.value=typed.get(el.dataset.keep)
    for(const el of pane().querySelectorAll('details[data-keep-open]'))if(opened.has(el.dataset.keepOpen))el.open=true
    if(focused){const el=pane().querySelector(`[data-keep="${CSS.escape(focused)}"]`);if(el){el.focus({preventScroll:true});const end=el.value.length;el.setSelectionRange?.(end,end)}}
    const scroller=pane().querySelector('.today-body');if(scroller)scroller.scrollTop=top
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
    const tab=t.closest('[data-project]')
    if(tab){selected=tab.dataset.project;editing=null;store.set('fleet:project',selected);draw(true);return window.Fleet.render()}
    if(t.closest('[data-new]')){editing='new';return draw(true)}
    if(t.closest('[data-cancel]')){editing=projects.length ? null : 'closed';return draw(true)}
    const copy=t.closest('[data-copy-path]')
    if(copy){navigator.clipboard?.writeText(copy.dataset.copyPath).then(()=>toast('Path copied. Edit the file by hand any time; Fleet reads it.'),()=>toast(copy.dataset.copyPath));return}
    const archive=t.closest('[data-archive]')
    if(archive){if(!confirmArchive(archive))return;await api(`/api/projects/${archive.dataset.archive}/archive`,{archived:true}).catch(e=>toast(e.message));editing=null;selected=null;return load(true)}
    const opener=t.closest('[data-open-session]')
    if(opener){window.FleetViews?.switchView('sessions');return window.Fleet.select(opener.dataset.openSession)}
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
    pane().addEventListener('keydown',event=>{if(event.key==='Enter' && !event.shiftKey && event.target.matches('[data-project-ask]')){event.preventDefault();pane().querySelector('[data-ask-project]')?.click()}})
  }
  mount()
  // The console's own controls use this to offer a project to tag a session with.
  return {active,current,render,list:()=>projects,load}
})()
