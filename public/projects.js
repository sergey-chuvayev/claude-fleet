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
  const active=()=>window.FleetQueue?.view?.()==='projects' && !!pane()
  const current=live=>{
    const p=projects.find(p=>p.id===selected)
    return p?.managerId ? live.find(s=>s.managedId===p.managerId) || null : null
  }
  function load(force=false) {
    if(loading || (!force && Date.now()-fetchedAt<4000))return loading
    loading=api('/api/projects').then(data=>{
      projects=data.projects;fetchedAt=Date.now()
      if(!projects.some(p=>p.id===selected))selected=projects[0]?.id || null
      draw(true)
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
  function formHtml(p) {
    return `<form class="project-form" data-project-form="${escape(p?.id || '')}"><h3>${p ? 'Edit project' : 'New project'}</h3>
      <label class="day-field">Name<input name="name" required maxlength="100" value="${escape(p?.name)}" placeholder="Queue in the ring node"></label>
      <label class="day-field">Deadline<input name="deadline" type="date" value="${escape(p?.deadline || '')}"></label>
      <label class="day-field">Brief: the goal, who it is for, constraints, anything the manager should know<textarea name="brief" rows="6" maxlength="16000" placeholder="Paste the roadmap section or write it in your own words.">${escape(p?.brief)}</textarea></label>
      <label class="day-field">Deliverables, one per line<textarea name="deliverables" rows="5" maxlength="9000" placeholder="Queue as a ring option&#10;Waiting music and announcements">${lines(p?.deliverables.map(d=>d.title))}</textarea></label>
      <label class="day-field">Repositories, one per line<textarea name="repos" rows="2" maxlength="4000" placeholder="~/projects/api-allo">${lines(p?.repos)}</textarea></label>
      <label class="day-field">Links: PRs, tickets, docs, one per line<textarea name="links" rows="3" maxlength="8000">${lines(p?.links)}</textarea></label>
      <div class="day-actions"><button type="submit" class="button resume">${p ? 'Save' : 'Create project'}</button><button type="button" class="button" data-cancel>Cancel</button>${p ? `<button type="button" class="button" data-archive="${escape(p.id)}">Archive</button>`:''}</div></form>`
  }
  function projectHtml(p,live) {
    const left=daysLeft(p.deadline),members=live.filter(s=>s.projectId===p.id && s.kind!=='project')
    const deliverables=p.deliverables.map(d=>`<li class="project-deliverable" data-state="${escape(d.state)}"><select data-deliverable="${escape(d.id)}" aria-label="State of ${escape(d.title)}">${Object.entries(STATE).map(([k,v])=>`<option value="${k}" ${k===d.state ? 'selected':''}>${v}</option>`).join('')}</select><span><strong>${escape(d.title)}</strong>${d.note ? `<small>${escape(d.note)}</small>`:''}</span></li>`).join('')
    const sessions=members.length ? `<div class="day-launched">${members.map(s=>`<button type="button" class="day-launch-chip" data-open-session="${escape(s.managedId)}" data-state="${escape(s.managedStatus)}" title="Open in Sessions"><span class="dot"></span>${escape((s.title || s.name || 'Session').slice(0,48))} · ${escape(SESSION_STATE[s.managedStatus] || s.managedStatus)} ↗</button>`).join('')}</div>` : '<p class="note">No sessions yet. Tag one from its console, or launch from your Day.</p>'
    const log=(p.log || []).slice(-5).reverse()
    return `<header class="today-head"><div><span class="modal-eyebrow">PROJECT</span><h2>${escape(p.name)}</h2></div><div class="today-stats">${p.deadline ? `<span>${escape(new Date(`${p.deadline}T12:00:00`).toLocaleDateString([],{day:'numeric',month:'short'}))}${left!=null ? ` · ${left} working day${left===1 ? '':'s'} left`:''}</span>`:''}<span>${p.progress.done}/${p.progress.total} done</span><button type="button" class="button day-small" data-edit="${escape(p.id)}">Edit</button></div></header>
      <div class="today-body">
        ${p.managerId ? '' : `<section class="day-section project-ask"><h4>Project manager</h4><p class="note">One agent that follows this project: its sessions, PRs and tickets, and the deliverables below. Ask it where things stand; it can put next steps on your Day.</p><div class="day-ask">${'<input data-project-ask maxlength="2000" placeholder="Where are we? What is blocking? Are we on track for the deadline?">'}<button type="button" class="button resume" data-ask-project="${escape(p.id)}">Ask ↗</button></div></section>`}
        <section class="day-section"><h4>Deliverables <span>${p.progress.done}/${p.progress.total}</span></h4>${p.deliverables.length ? `<ol class="project-deliverables">${deliverables}</ol>` : '<p class="note">No deliverables yet. Edit the project to add them.</p>'}</section>
        <section class="day-section"><h4>Sessions <span>${members.length}</span></h4>${sessions}</section>
        ${log.length ? `<section class="day-section"><h4>Log</h4><ol class="day-log">${log.map(l=>`<li><time>${new Date(l.at).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'})}</time> ${escape(l.text)}</li>`).join('')}</ol></section>`:''}
        ${p.brief ? `<details class="day-section project-brief"><summary>Brief</summary><p class="day-context">${escape(p.brief)}</p>${p.links.length ? `<span class="day-links">${p.links.map(u=>`<a href="${escape(u)}" target="_blank" rel="noopener noreferrer">${escape(u.replace(/^https?:\/\/(www\.)?/,'').slice(0,60))} ↗</a>`).join('')}</span>`:''}</details>`:''}
      </div>`
  }
  function draw(force=false) {
    if(!pane())return
    const live=window.Fleet.snapshot()?.sessions || []
    const p=projects.find(p=>p.id===selected)
    const signature=JSON.stringify([projects,selected,editing,live.filter(s=>s.projectId).map(s=>[s.managedId,s.managedStatus,s.title])])
    if(!force && pane().fleetSignature===signature)return
    // A half-typed question or form survives a redraw, as on the Day board.
    const typed=[...pane().querySelectorAll('input,textarea')].filter(el=>el.value && el.name!=='').map(el=>[el.name || el.dataset.projectAsk,el.value])
    pane().fleetSignature=signature
    const list=`<nav class="project-list" aria-label="Projects">${projects.map(x=>`<button type="button" class="project-tab" data-project="${escape(x.id)}" aria-pressed="${x.id===selected && editing!=='new'}"><strong>${escape(x.name)}</strong><span class="mini-bar"><i style="width:${x.progress.total ? Math.round(x.progress.done/x.progress.total*100) : 0}%"></i></span><small>${x.progress.done}/${x.progress.total}${x.deadline ? ` · ${daysLeft(x.deadline)}d`:''}${x.sessions ? ` · ${x.sessions} session${x.sessions===1 ? '':'s'}`:''}</small></button>`).join('')}<button type="button" class="project-tab project-new" data-new aria-pressed="${editing==='new'}">＋ New project</button></nav>`
    const body=editing==='new' ? `<div class="today-body">${formHtml(null)}</div>` : editing && p ? `<div class="today-body">${formHtml(p)}</div>` : p ? projectHtml(p,live) : `<div class="today-empty"><span class="modal-eyebrow">PROJECTS</span><h2>Group your work by outcome.</h2><p class="note">A project holds a goal, a deadline and its deliverables. Sessions you tag to it, and items on your Day, roll up here, and its manager can tell you where things stand.</p><button type="button" class="button resume" data-new>Create a project ↗</button></div>`
    const top=pane().querySelector('.today-body')?.scrollTop || 0
    pane().innerHTML=list+body
    for(const [key,value] of typed){const el=pane().querySelector(`[name="${CSS.escape(key)}"]`) || (key && pane().querySelector('[data-project-ask]'));if(el && !el.value)el.value=value}
    const scroller=pane().querySelector('.today-body');if(scroller)scroller.scrollTop=top
  }
  function render(live) {
    if(!pane())return
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
    if(t.closest('[data-cancel]')){editing=null;return draw(true)}
    const edit=t.closest('[data-edit]');if(edit){editing=edit.dataset.edit;return draw(true)}
    const archive=t.closest('[data-archive]')
    if(archive){await api(`/api/projects/${archive.dataset.archive}/archive`,{archived:true}).catch(e=>toast(e.message));editing=null;selected=null;return load(true)}
    const opener=t.closest('[data-open-session]')
    if(opener){window.FleetQueue?.switchView('sessions');return window.Fleet.select(opener.dataset.openSession)}
    const ask=t.closest('[data-ask-project]')
    if(ask){
      const field=pane().querySelector('[data-project-ask]'),message=field?.value.trim()
      if(!message)return toast('Type your question first.')
      ask.disabled=true
      try{await api(`/api/projects/${ask.dataset.askProject}/ask`,{message,requestId:crypto.randomUUID()});field.value='';await window.Fleet.tick();await load(true)}
      catch(error){toast(error.message);ask.disabled=false}
    }
  }
  async function submit(event) {
    const form=event.target.closest('[data-project-form]');if(!form)return
    event.preventDefault()
    const data=Object.fromEntries(new FormData(form))
    try{
      const {project}=await api('/api/projects',{...data,...(form.dataset.projectForm ? {id:form.dataset.projectForm}:{})})
      selected=project.id;editing=null;store.set('fleet:project',selected)
      toast('Project saved');await load(true)
    }catch(error){toast(error.message)}
  }
  async function change(event) {
    const select=event.target.closest('[data-deliverable]');if(!select)return
    try{await api(`/api/projects/${selected}/deliverable`,{deliverableId:select.dataset.deliverable,state:select.value});await load(true)}
    catch(error){toast(error.message)}
  }
  // Mounted before work-queue.js runs, which owns switching between the views.
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
