'use strict'
// The Today panel: the Day board above a Day's conversation, and the button that starts
// one. An isolated scope, like teams.js.
window.FleetDay=(()=>{
  const { esc, toast } = window.Fleet
  const UI = window.FleetUI
  const control = () => window.FleetControl
  const api = (...args) => window.FleetControl.api(...args)
  const escape=value=>esc(String(value ?? ''))
  const SOURCE={slack:'Slack',linear:'Linear',granola:'Granola',github:'GitHub',calendar:'Calendar',me:'You'}
  const MODE={me:'I do it',draft:'Draft for me',agent:'Agent does it',ask:'Find out'}
  const PRIORITY={must:'Must',should:'Should',could:'Could'}
  const STATUS={today:'today',in_progress:'in progress',waiting_on_you:'waiting on you',done:'done',later:'later',dropped:'dropped',proposed:'proposed'}
  const open=item=>item.needs.filter(n=>n.answer===undefined)
  // Teams for a launch card. Fetched once; the launch dialog may have them already.
  let teams=null
  const teamList=()=>{
    if(!teams){teams=control().launchTeams?.() || [];api('/api/teams').then(data=>{teams=data.teams;const p=document.getElementById('day-board');if(p)p.fleetSignature=null;control().refresh()}).catch(()=>{})}
    return teams
  }
  const minutes=list=>list.reduce((sum,i)=>sum+(i.estimateMin || 0),0)
  const duration=n=>n>=60 ? `${Math.floor(n/60)}h${n%60 ? ` ${n%60}m`:''}` : `${n}m`
  const options=(map,value)=>Object.entries(map).map(([k,v])=>`<option value="${k}" ${k===value ? 'selected':''}>${v}</option>`).join('')
  const linksHtml=item=>item.links.length ? `<span class="day-links">${item.links.slice(0,4).map(url=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="${escape(url)}">${escape(label(url))} <i class="ico ico-arrow" aria-hidden="true"></i></a>`).join('')}</span>`:''
  const label=url=>UI.linkLabel(url)
  // An item's context. A short note reads in place; a long one (a project task's
  // hand-off) is formatted and folded, so the board stays a list of work.
  const contextHtml=item=>{
    const text=item.context || ''
    if(!text)return ''
    const prose=window.FleetBlocks?.proseHtml ? window.FleetBlocks.proseHtml(text) : `<p>${escape(text)}</p>`
    if(text.length<=400 && !/\n#{1,3} /.test(text))return `<div class="day-context">${prose}</div>`
    return UI.fold({title:item.deliverableId ? 'Hand-off from the project' : 'Context',body:`<div class="day-context">${prose}</div>`,key:`context:${item.id}`,cls:'day-context-fold'})
  }
  // The project an item belongs to, by name.
  const projectName=id=>(window.FleetProjects?.list() || []).find(p=>p.id===id)?.name
  // An item's project, as a tag that opens it.
  const projectHtml=item=>{const name=item.projectId && projectName(item.projectId);return name ? `<button type="button" class="day-project" data-open-project="${escape(item.projectId)}" title="Open the project: ${escape(name)}"><span aria-hidden="true">◆</span>${escape(name.length>24 ? name.slice(0,23)+'…' : name)}</button>`:''}
  // Work from an earlier Day says so, with the day it first came from.
  const carriedHtml=item=>{
    if(!item.carriedFrom)return ''
    const day=new Date(`${item.carriedFrom}T12:00:00`).toLocaleDateString([],{weekday:'short'})
    return `<span class="day-carried" title="Carried over from ${escape(item.carriedFrom)}">from ${escape(day)}</span>`
  }
  const head=item=>`<span class="day-source" data-source="${escape(item.source)}">${escape(SOURCE[item.source] || item.source)}</span>${carriedHtml(item)}${projectHtml(item)}<strong>${escape(item.title)}</strong>${item.estimateMin ? `<small>${duration(item.estimateMin)}</small>`:''}`
  // An answer is typed into the board while the board keeps refreshing under it. Every
  // field that holds the operator's words is keyed, read back before a render and put
  // back after, so a poll never eats a half-written reply.
  const keep=(key,value='',rows)=>rows ? `<textarea data-keep="${escape(key)}" rows="${rows}" maxlength="16000">${escape(value)}</textarea>` : `<input data-keep="${escape(key)}" value="${escape(value)}" maxlength="2000">`
  // Every question can also be answered in words: "not yet", "ask Thomas instead",
  // "shorten it". A reply goes to the agent as a message and never approves a send.
  const replyHtml=(id,data)=>`<div class="day-reply">${keep(`reply:${id}`)}<button type="button" class="button" data-answer="reply" ${data}>Reply</button></div>`
  function needHtml(item,n) {
    const id=`${item.id}:${n.id}`,data=`data-item="${escape(item.id)}" data-need="${escape(n.id)}"`
    if(n.kind==='approve') return `<div class="day-need" data-kind="approve"><p>${escape(n.question)}</p>${keep(`draft:${id}`,n.draft,Math.min(8,Math.max(3,String(n.draft).split('\n').length+1)))}<div class="ui-actions"><button type="button" class="button resume" data-answer="approve" ${data}>Approve</button><button type="button" class="button" data-answer="reject" ${data}>Reject</button><span class="note">Edit the text to approve your version, or reply to discuss it.</span></div>${replyHtml(id,data)}</div>`
    if(n.kind==='choose') return `<div class="day-need" data-kind="choose"><p>${escape(n.question)}</p><div class="ui-actions">${(n.options || []).map(o=>`<button type="button" class="button" data-answer-value="${escape(o)}" ${data}>${escape(o)}</button>`).join('')}</div>${replyHtml(id,data)}</div>`
    if(n.kind==='launch'){
      const plan=n.launch || {},teams=teamList()
      return `<div class="day-need" data-kind="launch"><p>${escape(n.question)}</p><label class="day-field">Brief the new session starts from${keep(`draft:${id}`,n.draft,Math.min(10,Math.max(4,String(n.draft).split('\n').length+1)))}</label><div class="day-launch-fields"><label class="day-field">Repository<input data-launch="cwd" value="${escape(plan.cwd || '')}" maxlength="4096"></label><label class="day-field">Who<select data-launch="teamId"><option value="">Single agent</option>${teams.map(t=>`<option value="${escape(t.id)}" ${t.id===plan.teamId ? 'selected':''}>${escape(t.name)}</option>`).join('')}${plan.teamId && !teams.some(t=>t.id===plan.teamId) ? `<option value="${escape(plan.teamId)}" selected>${escape(plan.teamId)}</option>`:''}</select></label></div><div class="ui-actions"><button type="button" class="button resume" data-answer="approve" ${data}>Launch <i class="ico ico-arrow" aria-hidden="true"></i></button><button type="button" class="button" data-answer="reject" ${data}>Not now</button><span class="note">Starts a Fleet session like the Work queue does. It shows up in Sessions.</span></div>${replyHtml(id,data)}</div>`
    }
    return `<div class="day-need" data-kind="info"><p>${escape(n.question)}</p><div class="ui-actions day-inline">${keep(`info:${id}`)}<button type="button" class="button resume" data-answer="info" ${data}>Answer</button></div></div>`
  }
  function waitingHtml(items) {
    const waiting=items.filter(i=>open(i).length).sort((a,b)=>open(a)[0].at-open(b)[0].at)
    if(!waiting.length) return ''
    // A question about work an agent did needs that work at hand: its session, the item's
    // full story further down the board, and the item's links.
    const foot=item=>`<div class="day-card-foot">${launchedHtml(item)}${item.thread?.sessionId && !item.thread.closed ? `<button type="button" class="day-launch-chip" data-open-session="${escape(item.thread.sessionId)}" data-state="idle" title="Open the conversation about this item"><span class="dot"></span>Thread <i class="ico ico-arrow" aria-hidden="true"></i></button>`:''}${linksHtml(item)}<button type="button" class="button ghost day-card-details" data-show-item="${escape(item.id)}" title="Open this item on the board: its context, log and actions">Details</button></div>`
    return UI.section('Waiting on you',waiting.map(item=>`<article class="ui-card" data-tone="needs"><div class="day-card-head">${head(item)}</div>${open(item).map(n=>needHtml(item,n)).join('')}${foot(item)}</article>`).join(''),{count:waiting.reduce((n,i)=>n+open(i).length,0),cls:'day-waiting'})
  }
  function triageHtml(items) {
    const proposed=items.filter(i=>i.status==='proposed')
    if(!proposed.length) return ''
    const order={must:0,should:1,could:2}
    proposed.sort((a,b)=>order[a.priority]-order[b.priority])
    return UI.section('To triage',proposed.map(item=>`<article class="ui-card" data-card="${escape(item.id)}" data-proposed><div class="day-card-head">${head(item)}</div>${contextHtml(item)}${linksHtml(item)}<div class="ui-actions"><select data-field="priority" aria-label="Priority">${options(PRIORITY,item.priority)}</select><select data-field="mode" aria-label="How">${options(MODE,item.mode)}</select><button type="button" class="button resume" data-triage="today">Today</button><button type="button" class="button" data-triage="later">Later</button><button type="button" class="button" data-triage="dropped">Drop</button></div></article>`).join(''),{count:proposed.length,aside:'<button type="button" class="button ghost" data-triage-all="must">Take all Must</button>'})
  }
  // Sessions an item launched, with their live state from the session list.
  const LAUNCH_STATE={starting:'starting',running:'working',approval:'needs you',stopping:'stopping',stopped:'stopped',error:'failed',idle:'ready',queued:'queued'}
  function launchedHtml(item) {
    if(!item.launched?.length)return ''
    const sessions=window.Fleet.snapshot()?.sessions || []
    return `<div class="day-launched">${item.launched.map(id=>{
      const x=sessions.find(x=>x.managedId===id)
      if(!x)return `<span class="day-launch-chip" data-state="closed">Session closed</span>`
      const p=x.taskProgress
      const name=x.teamName || x.title || x.name || 'Agent'
      return `<button type="button" class="day-launch-chip" data-open-session="${escape(id)}" data-state="${escape(x.managedStatus)}" title="Open in Sessions: ${escape(name)}"><span class="dot"></span>${escape(name.length>40 ? `${name.slice(0,39)}…` : name)} · ${escape(LAUNCH_STATE[x.managedStatus] || x.managedStatus)}${p?.total ? ` · ${p.verified}/${p.total} verified`:''} <i class="ico ico-arrow" aria-hidden="true"></i></button>`
    }).join('')}</div>`
  }
  // Today's items under their priority. A row says only what is unusual about it (it
  // needs you, it is moving, it launched something); "today" on every row said nothing.
  const STATE_ICON={waiting_on_you:['●','Needs you'],in_progress:['◐','In progress']}
  const MODE_SHORT={me:'You',draft:'Draft',agent:'Agent',ask:'Find out'}
  function capacityHtml(planned,b) {
    const free=b.capacity?.freeMinutes
    if(free==null)return planned ? `<span class="day-capacity">${duration(planned)} planned</span>`:''
    const over=planned>free,share=free ? Math.min(100,Math.round(planned/free*100)) : 100
    return `<span class="day-capacity ${over ? 'is-over':''}" title="Estimated time of today's open items against focus time left on your calendar"><span class="mini-bar"><i style="width:${share}%"></i></span>${duration(planned)} planned · ${duration(free)} free${over ? ' · over by '+duration(planned-free):''}</span>`
  }
  // The gist of the item's thread, and the way back into it.
  function threadHtml(item) {
    if(!item.thread && item.previousThread?.summary)return `<p class="day-thread-gist"><button type="button" class="day-launch-chip" data-open-session="${escape(item.previousThread.sessionId)}" title="Open that conversation in Sessions" data-state="idle"><span class="dot"></span>Earlier thread <i class="ico ico-arrow" aria-hidden="true"></i></button>${escape(item.previousThread.summary)}</p>`
    if(!item.thread || item.thread.closed)return ''
    return `<p class="day-thread-gist"><button type="button" class="day-launch-chip" data-open-thread="${escape(item.thread.sessionId)}" title="Open your conversation about this item"><span class="dot"></span>Thread <i class="ico ico-arrow" aria-hidden="true"></i></button>${item.thread.summary ? escape(item.thread.summary) : 'Starting…'}</p>`
  }
  // Where each item actually is, in words: being worked on now and by whom, running in
  // its own session, waiting for a launch, queued behind the Day's current work, or not
  // started. The plan alone ("today", "Agent does it") never said whether anything moved.
  let boardDay=null
  const since=at=>{const m=Math.max(1,Math.round((Date.now()-at)/60000));return m>=60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`}
  function liveStatus(item) {
    const s=boardDay
    if(!s || !['today','in_progress','waiting_on_you'].includes(item.status))return null
    const working=control().isWorking(s)
    const subs=(s.subagents || []).filter(d=>d.itemId===item.id && d.status==='running')
    if(subs.length)return ['working',`Working now · ${[...new Set(subs.map(d=>d.role))].join(', ')} · ${since(Math.min(...subs.map(d=>d.startedAt)))}`]
    if(working && s.dayBoard?.focus?.itemId===item.id)return ['working',`Working now · Day agent · ${since(s.dayBoard.focus.at)}`]
    const sessions=window.Fleet.snapshot()?.sessions || []
    const launched=(item.launched || []).map(id=>sessions.find(x=>x.managedId===id)).filter(Boolean)
    if(launched.some(x=>x.managedStatus==='approval'))return ['needs','Its session needs you']
    if(launched.some(x=>['starting','running','queued'].includes(x.managedStatus)))return ['running','Running in its own session']
    const asks=open(item)
    if(asks.some(n=>n.kind==='launch'))return ['needs','Launch brief ready · approve it above']
    if(asks.length)return ['needs','Waiting on you']
    if(launched.length)return null
    if(item.mode==='agent')return ['queued',working ? 'Launch brief coming' : 'Launch brief at the next run']
    if(item.mode==='me')return null
    return working ? ['queued','Queued for the Day'] : ['idle','Not started']
  }
  function todayHtml(items,opened,b) {
    const today=items.filter(i=>['today','in_progress','waiting_on_you'].includes(i.status))
    today.sort((a,b)=>a.createdAt-b.createdAt)
    const row=item=>{
      const latest=item.log.at(-1)?.text,live=liveStatus(item)
      const tone=['working','running','needs'].includes(live?.[0]) ? live[0] : item.status==='waiting_on_you' ? 'needs' : item.status==='in_progress' ? 'progress' : live?.[0] || 'todo'
      const icon=STATE_ICON[item.status]
      const meta=`<span class="day-source" data-source="${escape(item.source)}">${escape(SOURCE[item.source] || item.source)}</span>${carriedHtml(item)}${projectHtml(item)}${live ? UI.pill(escape(live[1]),live[0]):''}${latest ? `<span class="ui-row-latest" title="${escape(latest)}">${escape(latest)}</span>`:''}`
      const side=`${item.estimateMin ? `<small class="ui-row-figure">${duration(item.estimateMin)}</small>`:''}${UI.pill(escape(MODE_SHORT[item.mode] || MODE[item.mode]),item.mode==='agent' ? 'agent' : item.mode==='me' ? 'me' : 'outline')}`
      const projects=window.FleetProjects?.list() || []
      const detail=`${launchedHtml(item)}${threadHtml(item)}${contextHtml(item)}${linksHtml(item)}${UI.log(item.log.slice(-6).map(l=>[new Date(l.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),escape(l.text)]))}<div class="ui-ask">${keep(`ask:${item.id}`)}<button type="button" class="button" data-ask-item="${escape(item.id)}">${item.thread && !item.thread.closed ? 'Ask <i class="ico ico-arrow" aria-hidden="true"></i>' : 'Ask about this <i class="ico ico-arrow" aria-hidden="true"></i>'}</button></div><div class="ui-actions"><select data-field="mode" aria-label="How">${options(MODE,item.mode)}</select>${projects.length ? `<select data-field="projectId" aria-label="Project"><option value="">No project</option>${projects.map(p=>`<option value="${escape(p.id)}" ${p.id===item.projectId ? 'selected':''}>${escape(p.name)}</option>`).join('')}</select>`:''}<button type="button" class="button" data-triage="done" ${open(item).length ? 'disabled title="Answer its questions first"':''}>Done</button><button type="button" class="button" data-triage="later">Later</button></div>`
      return UI.row({tone,orbTitle:icon?.[1] || live?.[1] || 'Not started',title:escape(item.title),meta,side,detail,open:opened.has(item.id),key:item.id,attrs:`data-card="${escape(item.id)}"`})
    }
    const groups=Object.keys(PRIORITY).map(p=>[p,today.filter(i=>i.priority===p)]).filter(([,list])=>list.length)
    const body=today.length ? groups.map(([p,list])=>`<div class="ui-subgroup">${UI.group(PRIORITY[p],{count:list.length,end:minutes(list) ? duration(minutes(list)) : '',tone:p})}${UI.list(list.map(row).join(''))}</div>`).join('') : '<p class="note">Nothing on today yet. Triage the proposals, or add your own.</p>'
    return UI.section('Today',body,{count:today.length,aside:capacityHtml(minutes(today),b)})
  }
  function restHtml(items) {
    const later=items.filter(i=>i.status==='later'),done=items.filter(i=>i.status==='done')
    if(!later.length && !done.length) return ''
    const rows=(list,isDone)=>UI.list(list.map(i=>UI.row({tone:isDone ? 'done' : 'todo',orbTitle:isDone ? 'Done' : 'Later',title:escape(i.title),meta:`<span class="day-source" data-source="${escape(i.source)}">${escape(SOURCE[i.source] || i.source)}</span>${carriedHtml(i)}${projectHtml(i)}`,side:`${i.estimateMin ? `<small class="ui-row-figure">${duration(i.estimateMin)}</small>`:''}${isDone ? '' : '<button type="button" class="button ghost" data-triage="today">Today</button>'}`,attrs:`data-card="${escape(i.id)}"`})).join(''),'is-compact')
    const fold=(title,list,isDone)=>list.length ? UI.fold({title,count:list.length,body:rows(list,isDone),key:`rest-${title}`}):''
    return `<div class="ui-folds">${fold('Later',later,false)}${fold('Done',done,true)}</div>`
  }
  const addHtml=()=>`<details class="ui-add" data-evidence="add"><summary><span class="ui-add-plus" aria-hidden="true">+</span>Add something<span class="note">a task, a follow-up, a reminder</span></summary><div class="ui-add-fields">${keep('add:title')}<textarea data-keep="add:context" rows="3" maxlength="8000" placeholder="Context, links, who is waiting. The agent fills in the rest."></textarea><div class="ui-actions"><select data-add="priority" aria-label="Priority">${options(PRIORITY,'should')}</select><select data-add="mode" aria-label="How">${options(MODE,'me')}</select><button type="button" class="button resume" data-add-item>Add to today</button></div></div></details>`
  // The Today tab: the board in a pane of its own, beside the Day's console. The console
  // is the ordinary control panel, so talking to the Day works like any agent.
  const pane=()=>document.getElementById('today-pane')
  const active=()=>window.FleetViews?.view()==='today' && !!pane()
  // The console shows the Day agent, or one item's thread. The board always shows the Day,
  // so while a thread is open the Day's own detail is fetched beside it.
  let shownThread=null,dayDetail=null,dayFetchAt=0
  function current(days,live=[]) {
    const day=days.find(s=>s.dayDate===today()) || null
    if(shownThread){
      const t=live.find(x=>x.managedId===shownThread && x.threadOpen)
      if(t && day && t.parentDayId===day.managedId)return t
      shownThread=null
    }
    return day
  }
  function bindPanel(panel) {
    // Bound once for the panel's life; the session it shows is read from the dataset at
    // click time, for the same reason as the initiative board.
    panel.addEventListener('click',event=>act(panel.dataset.sessionId,event))
    // Enter sends a one-line reply or answer, as in the composer.
    panel.addEventListener('keydown',event=>{
      if(event.key!=='Enter' || event.shiftKey || event.isComposing || !event.target.matches('input[data-keep^="reply:"],input[data-keep^="info:"],input[data-keep^="ask:"]'))return
      event.preventDefault();event.target.parentElement.querySelector('button')?.click()
    })
    // On a proposal the choices travel with Today/Later/Drop; on a triaged item a new
    // mode is the instruction, so it goes at once.
    panel.addEventListener('change',event=>{const card=event.target.closest('[data-card]:not([data-proposed])'),field=event.target.dataset.field;if(card && ['mode','projectId'].includes(field))triage(panel.dataset.sessionId,card.dataset.card,{[field]:event.target.value},field==='projectId' ? (event.target.value ? 'Added to the project' : 'Removed from the project') : 'Updated')})
  }
  function board(s) {
    if(s.kind==='day')dayDetail=s
    // Set on every render: the board may be unchanged while the console switched sessions.
    const composer=document.getElementById('message-input')
    if(composer && ['day','thread'].includes(s.kind))composer.placeholder=s.kind==='thread' ? 'Ask about this item…' : 'Ask your day agent…'
    agents(s)
    const d=s.kind==='day' ? s : s.kind==='thread' && dayDetail?.id===s.parentDayId ? dayDetail : null
    if(!d){if(s.kind!=='thread')document.getElementById('day-board')?.remove();return}
    renderBoard(d)
  }
  function renderBoard(s) {
    boardDay=s
    let panel=document.getElementById('day-board')
    if(!pane()){panel?.remove();return}
    pane().querySelector('.today-empty')?.remove()
    if(!panel){panel=document.createElement('section');panel.id='day-board';panel.setAttribute('aria-label','Day board');pane().append(panel);bindPanel(panel)}
    panel.dataset.sessionId=s.id
    const b=s.dayBoard || {items:[],cursors:{}}
    const launchedState=b.items.flatMap(i=>i.launched || []).map(id=>(window.Fleet.snapshot()?.sessions || []).find(x=>x.managedId===id)).map(x=>x ? [x.managedStatus,x.taskProgress] : null)
    const moving=(s.subagents || []).filter(d=>d.status==='running').map(d=>[d.id,d.itemId])
    // Project names too: the board can draw before the project list arrives, and its tags
    // need redrawing once it does.
    const names=(window.FleetProjects?.list() || []).map(p=>[p.id,p.name])
    const signature=JSON.stringify([s.id,b,s.status,launchedState,s.dayChecks,moving,names,Math.floor(Date.now()/60000)])
    if(panel.fleetSignature===signature)return
    // Redrawing would replace the select under an open dropdown; the next refresh catches up.
    if(window.FleetSelect?.isOpen(panel))return
    // Keep what the operator is in the middle of: open disclosures, typed text, focus.
    const opened=new Set([...panel.querySelectorAll('details[open][data-evidence]')].map(el=>el.dataset.evidence))
    const typed=new Map([...panel.querySelectorAll('[data-keep]')].map(el=>[el.dataset.keep,el.value]))
    const focused=document.activeElement?.closest?.('#day-board [data-keep]')?.dataset.keep
    const scrollTop=panel.querySelector('.today-body')?.scrollTop || 0
    panel.fleetSignature=signature
    const items=b.items.filter(i=>i.status!=='dropped')
    const done=items.filter(i=>i.status==='done').length,triaged=items.filter(i=>i.status!=='proposed').length
    const waiting=items.reduce((n,i)=>n+open(i).length,0)
    const when=new Date(`${b.date}T12:00:00`).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})
    const gathering=!items.length && control().isWorking(s) ? '<p class="note today-gathering">Gathering your day from Slack, Linear, Granola, GitHub and your calendar…</p>':''
    panel.innerHTML=`${UI.pageHead({title:escape(when),actions:`${waiting ? UI.pill(`${waiting} waiting on you`,'needs'):''}${checkHtml(s)}`,strip:`${UI.stat('Done',`${UI.ring(done,triaged)}${done} <small>of ${triaged}</small>`,{title:`${done} of ${triaged} triaged items done`})}<div class="page-strip-group" id="today-usage">${usageHtml(s)}</div>`})}<div class="page-body today-body">${gathering}${waitingHtml(items)}${triageHtml(items)}${todayHtml(items,opened,b)}${addHtml()}${restHtml(items)}</div>`
    for(const el of panel.querySelectorAll('details[data-evidence]'))if(opened.has(el.dataset.evidence))el.open=true
    for(const el of panel.querySelectorAll('[data-keep]'))if(typed.has(el.dataset.keep))el.value=typed.get(el.dataset.keep)
    panel.querySelector('[data-keep="add:title"]').placeholder='What needs doing?'
    for(const el of panel.querySelectorAll('[data-keep^="reply:"]'))el.placeholder='Reply to your day agent…'
    for(const el of panel.querySelectorAll('[data-keep^="ask:"]'))el.placeholder='Ask about this item: why, what if, change the plan…'
    panel.querySelector('.today-body').scrollTop=scrollTop
    if(focused)panel.querySelector(`[data-keep="${CSS.escape(focused)}"]`)?.focus({preventScroll:true})
  }
  // When the Day last looked at your sources and when it will next, so a greyed-out
  // button is never the only clue that something is (or is not) happening.
  const clock=ms=>new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
  function checkHtml(s) {
    const c=s.dayChecks,working=control().isWorking(s)
    const last=[...s.messages].reverse().find(m=>m.role==='user')
    if(working){
      const items=s.dayBoard?.items || [],title=id=>items.find(i=>i.id===id)?.title
      const subs=(s.subagents || []).filter(d=>d.status==='running')
      const on=[...new Set([s.dayBoard?.focus?.itemId,...subs.map(d=>d.itemId)].filter(Boolean))].map(title).filter(Boolean)
      const what=on.length ? `Working on ${on[0].length>40 ? on[0].slice(0,39)+'…' : on[0]}${on.length>1 ? ` +${on.length-1}`:''}` : last?.runPrompt ? AUTO_RUN[last.text] || 'Checking' : 'Working'
      return `<span class="day-check-state is-running" title="${escape(on.join('\n'))}"><span class="day-spinner" aria-hidden="true"></span>${escape(what)}${subs.length ? ` · ${subs.length} subagent${subs.length===1 ? '':'s'}`:''}…</span>`
    }
    let when=''
    if(c?.lastAt){
      const next=new Date(c.lastAt+c.everyMin*60000),[from,to]=c.hours || [8,20]
      const later=next.getHours()>=to || next.toDateString()!==new Date().toDateString()
      const morning=new Date();morning.setDate(morning.getDate()+1);morning.setHours(from,0,0,0)
      when=`Checked ${clock(c.lastAt)} · next ${later ? `tomorrow ${clock(morning)}` : next.getHours()<from ? clock(new Date(next).setHours(from,0,0,0)) : clock(next)}`
    }
    return `<span class="day-check-state">${when}</span><button type="button" class="button ghost" data-sweep ${working ? 'disabled title="The Day agent is busy"':''}><i class="ico ico-refresh" aria-hidden="true"></i> Check now</button>`
  }
  // What today has used: this Day's own tokens and context, then the account's plan
  // windows, which every session on the machine draws from, the Day included.
  const compactTokens=n=>n>=1e6 ? `${(n/1e6).toFixed(1)}M` : n>=1e3 ? `${Math.round(n/1e3)}k` : String(n)
  const WINDOW={five_hour:'Current session',seven_day:'Weekly',seven_day_opus:'Weekly Opus',seven_day_sonnet:'Weekly Sonnet'}
  function usageHtml(s) {
    const t=s.tokenUsage,parts=[]
    if(t){
      const total=t.input+t.output+t.cacheRead+t.cacheCreation
      parts.push(UI.stat('This Day',`${compactTokens(total)} <small>tokens</small>`,{title:`Input ${t.input.toLocaleString()} · output ${t.output.toLocaleString()} · cache read ${t.cacheRead.toLocaleString()} · cache write ${t.cacheCreation.toLocaleString()}. All models, scouts included.`}))
    }
    const heat=n=>n>=90 ? 'hot' : n>=75 ? 'warn' : undefined
    if(s.contextTokens){const share=Math.round(s.contextTokens/(s.contextLimit || 200000)*100);parts.push(UI.stat('Context',`${UI.bar(share)}${share}%`,{tone:heat(share),title:`${s.contextTokens.toLocaleString()} tokens in the Day's conversation`}))}
    const usage=window.Fleet.snapshot()?.usage
    if(usage?.available && usage.known)for(const w of usage.windows.filter(w=>WINDOW[w.name])){
      const reset=w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString([],w.name==='five_hour' ? {hour:'2-digit',minute:'2-digit'}:{weekday:'short',hour:'2-digit',minute:'2-digit'})}`:''
      parts.push(UI.stat(WINDOW[w.name],`${UI.bar(w.utilization)}${w.utilization}%<small>${reset}</small>`,{tone:heat(w.utilization)}))
    }
    else parts.push(UI.stat('Plan limits','After the next run',{tone:'quiet'}))
    return parts.join('')
  }
  // An agent launched from Today reported back: say so once, wherever you are in Fleet,
  // and from macOS too when that is switched on. The first snapshot only sets the mark,
  // so opening Fleet does not replay old reports.
  let reportSeen=null
  function announce(report){
    if(reportSeen===null){reportSeen=report?.at || 0;return}
    if(!report || report.at<=reportSeen)return
    reportSeen=report.at
    window.Fleet.toast(`${report.title}: ${report.question}`.slice(0,220))
    window.FleetSounds?.play('report')
    if(!window.FleetSettings?.notifyOn?.())return
    try{
      const note=new Notification(report.title,{body:report.question.slice(0,300),tag:`fleet-report-${report.itemId}`})
      note.onclick=()=>{window.focus();showItem(report.itemId);note.close()}
    }catch{}
  }
  // Called on every snapshot: the tab's badge, and the pane's state before a Day exists.
  function render(days) {
    const day=days.find(s=>s.dayDate===today()) || null,badge=document.getElementById('today-count')
    // Before the Day starts its console would be blank; say what goes there.
    const panel=document.getElementById('control-panel')
    if(active() && !day && panel && !panel.children.length)panel.innerHTML='<div class="console-empty"><strong>Your Day agent</strong><span>Its conversation appears here once you start your day.</span></div>'
    if(active() && day && control().session()?.kind==='thread' && Date.now()-dayFetchAt>2000){
      dayFetchAt=Date.now()
      api(`/api/managed/${day.managedId}`).then(data=>{dayDetail=data.session;renderBoard(dayDetail);const t=control().session();if(t?.kind==='thread')agents(t)}).catch(()=>{})
    }
    if(day && document.getElementById('today-usage'))window.Fleet.update('today-usage',usageHtml(day))
    const waiting=day?.dayProgress?.waiting || 0,proposed=day?.dayProgress?.proposed || 0
    if(badge){badge.textContent=waiting || proposed || '';badge.dataset.alert=String(!!waiting);badge.title=waiting ? `${waiting} waiting on you` : proposed ? `${proposed} to triage` : ''}
    announce(day?.dayProgress?.report)
    if(!pane())return
    if(day){if(!document.getElementById('day-board'))pane().querySelector('.today-empty')?.remove();return}
    document.getElementById('day-board')?.remove()
    if(pane().querySelector('.today-empty'))return
    pane().insertAdjacentHTML('beforeend',`<div class="today-empty ui-empty"><h3>Good morning.</h3><p>One agent reads your Slack, Linear, Granola, GitHub and calendar, proposes a plan, and works through it with you all day. Nothing is sent without your approval.</p><textarea id="today-note" rows="3" maxlength="8000" placeholder="Anything to add before it starts? Optional."></textarea><button type="button" class="button resume" id="start-day">Start my day <i class="ico ico-arrow" aria-hidden="true"></i></button>${days.length ? '<p class="note">Unfinished items from your last Day carry over, with their open questions.</p>':''}</div>`)
    document.getElementById('start-day').addEventListener('click',start)
  }
  // The Day's console, told in its own terms. An automatic run is a marker, not a
  // message from the operator; back-to-back board calls are one "Board" block that says
  // what changed, instead of six identical rows of mcp__fleet__day.
  const AUTO_RUN={'Start my day':'Morning intake','Sweep':'Auto check','Pick up answers':'Picked up your answers'}
  const BOARD_VERB={add:'added',update:'updated',ask:'asked',list:'read the board',inspect:'looked up',cursor:'moved cursors',teams:'listed teams',capacity:'noted free time'}
  function messages(list) {
    const out=[],groups=[]
    let group=null
    for(const m of list){
      if(m.role==='user' && m.runPrompt && (m.background || AUTO_RUN[m.text])){out.push({id:m.id,role:'event',text:AUTO_RUN[m.text] || m.text,at:m.at});group=null;continue}
      if(m.role==='tool' && m.tool==='mcp__fleet__day'){
        if(!group){group={id:`${m.id}~board`,role:'tool',tool:m.tool,label:'Board',approval:'auto',at:m.at,calls:[]};out.push(group);groups.push(group)}
        group.calls.push(m);continue
      }
      group=null;out.push(m)
    }
    for(const g of groups){
      const counts={}
      for(const c of g.calls){const a=c.input?.action || 'call';counts[a]=(counts[a] || 0)+1}
      g.status=g.calls.some(c=>c.status==='running') ? 'running' : g.calls.some(c=>c.status==='error') ? 'error' : 'done'
      g.ms=g.calls.every(c=>c.ms!=null) ? g.calls.reduce((n,c)=>n+c.ms,0) : null
      g.target=Object.entries(counts).map(([a,n])=>['add','update','ask'].includes(a) ? `${BOARD_VERB[a]} ${n}` : BOARD_VERB[a] || a).join(' · ')
      g.lines=g.calls.map(c=>{
        const i=c.input || {},what=i.title || i.question || i.note || i.source || ''
        return {text:`${BOARD_VERB[i.action] || i.action || 'call'}${what ? `: ${String(what).slice(0,140)}`:''}${c.status==='error' && c.result ? ` (failed: ${String(c.result).slice(0,160)})`:''}`,error:c.status==='error'}
      })
      delete g.calls
    }
    return out
  }
  // The Day's subagents, as tabs above its console. "Day agent" is the conversation;
  // a subagent tab swaps it for that subagent's assignment, steps and report. Read-only:
  // a subagent answers to the Day, not to you.
  let shownAgent=null
  const AGENT_STATE={running:'busy',completed:'idle',failed:'hot',interrupted:'stale'}
  const elapsed=ms=>ms<60000 ? `${Math.max(1,Math.round(ms/1000))}s` : `${Math.floor(ms/60000)}m ${String(Math.round(ms%60000/1000)).padStart(2,'0')}s`
  // Switching to a thread changes which session the console holds, so it goes through
  // the app's selection; switching between the Day and its subagents does not.
  function showThread(id) {shownThread=id || null;shownAgent=null;window.Fleet.render()}
  // Every check sends the same scouts out again, so the strip shows one tab per scout,
  // holding its latest run; its earlier runs today are listed inside it.
  const SCOUT_ORDER=['slack-scout','linear-scout','github-scout','granola-scout','calendar-scout']
  const scoutName=role=>({'slack-scout':'Slack','linear-scout':'Linear','github-scout':'GitHub','granola-scout':'Granola','calendar-scout':'Calendar'})[role] || role
  function byRole(list) {
    const groups=new Map()
    for(const d of [...list].sort((a,b)=>(a.startedAt || 0)-(b.startedAt || 0))){if(!groups.has(d.role))groups.set(d.role,[]);groups.get(d.role).push(d)}
    const rank=role=>{const i=SCOUT_ORDER.indexOf(role);return i<0 ? SCOUT_ORDER.length : i}
    return [...groups.entries()].map(([role,runs])=>({role,runs,latest:runs[runs.length-1]})).sort((a,b)=>rank(a.role)-rank(b.role) || (b.latest.startedAt || 0)-(a.latest.startedAt || 0))
  }
  function agents(s) {
    const conversation=document.getElementById('conversation')
    let strip=document.getElementById('day-agents'),view=document.getElementById('day-agent-view')
    const base=s.kind==='day' ? s : s.kind==='thread' && dayDetail?.id===s.parentDayId ? dayDetail : null
    if(!base || !conversation){strip?.remove();view?.remove();if(conversation)conversation.hidden=false;return}
    const list=base.subagents || []
    const threads=(base.dayBoard?.items || []).filter(i=>i.thread && !i.thread.closed)
    if(shownAgent && !list.some(d=>d.id===shownAgent))shownAgent=null
    if(s.kind==='thread')shownAgent=null
    if(!strip){
      strip=document.createElement('nav');strip.id='day-agents';strip.setAttribute('aria-label','Day agent, item threads and subagents')
      conversation.before(strip)
      strip.addEventListener('click',event=>{
        const thread=event.target.closest('[data-thread]')
        if(thread)return showThread(thread.dataset.thread)
        const tab=event.target.closest('[data-agent]');if(!tab)return
        const next=tab.dataset.agent || null
        if(control().session()?.kind==='thread'){shownAgent=next;shownThread=null;return window.Fleet.render()}
        shownAgent=next;strip.fleetSignature=null;agents(control().session())
      })
    }
    if(!view){
      view=document.createElement('section');view.id='day-agent-view';view.className='day-agent-view';conversation.after(view)
      // An earlier run, picked from the list inside a scout's tab.
      view.addEventListener('click',event=>{const run=event.target.closest('[data-agent]');if(!run)return;shownAgent=run.dataset.agent;strip.fleetSignature=null;agents(control().session())})
    }
    // Tabs earn their row only once there is something to switch to.
    strip.hidden=!list.length && !threads.length
    const running=list.filter(d=>d.status==='running').length
    const sessions=window.Fleet.snapshot()?.sessions || []
    const threadState=id=>sessions.find(x=>x.managedId===id)?.managedStatus
    const signature=JSON.stringify([s.id,shownAgent,list.map(d=>[d.id,d.status,d.steps.length,d.report?.length,d.output?.length]),threads.map(i=>[i.thread.sessionId,threadState(i.thread.sessionId)])])
    if(strip.fleetSignature!==signature){
      strip.fleetSignature=signature
      const groups=byRole(list),shownRole=list.find(d=>d.id===shownAgent)?.role
      const tab=g=>{
        const live=g.latest.status==='running'
        const mark=live && window.FleetUI ? window.FleetUI.running(`${scoutName(g.role)} is running`) : `<span class="dot ${AGENT_STATE[g.latest.status] || ''}"></span>`
        return `<button type="button" class="day-agent-tab${live ? ' is-live' : ''}" data-agent="${escape(g.latest.id)}" aria-pressed="${shownRole===g.role}" title="${escape(`${g.latest.description || g.role} · ${g.runs.length} run${g.runs.length===1 ? '':'s'} today`)}">${mark}${escape(scoutName(g.role))}${g.runs.length>1 ? `<span class="ui-count">${g.runs.length}</span>`:''}</button>`
      }
      const THREAD_DOT={starting:'busy',running:'busy',approval:'stale',error:'hot'}
      strip.innerHTML=`<button type="button" class="day-agent-tab" data-agent="" aria-pressed="${s.kind==='day' && !shownAgent}">Day agent</button>${threads.map(i=>`<button type="button" class="day-agent-tab is-thread" data-thread="${escape(i.thread.sessionId)}" aria-pressed="${s.id===i.thread.sessionId}" title="Your conversation about: ${escape(i.title)}"><span class="dot ${THREAD_DOT[threadState(i.thread.sessionId)] || 'idle'}"></span>${escape(i.title.length>28 ? i.title.slice(0,27)+'…' : i.title)}</button>`).join('')}${groups.map(tab).join('')}${running ? `<span class="note day-agents-running">${running} running</span>`:''}`
    }
    conversation.hidden=!!shownAgent && s.kind==='day';view.hidden=!shownAgent || s.kind!=='day'
    if(!shownAgent || s.kind!=='day')return
    const d=list.find(d=>d.id===shownAgent)
    const opened=new Set([...view.querySelectorAll('details[open][data-step]')].map(el=>el.dataset.step))
    const steps=d.steps.length ? `<ol class="child-steps">${d.steps.map(step=>`<li class="child-step" data-status="${escape(step.status)}"><span class="child-step-tool">${escape(step.tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/,''))}</span>${step.target ? `<span class="child-step-target">${escape(step.target)}</span>`:''}<span class="child-step-state">${escape(step.status)}</span><span class="child-step-time">${step.ms!=null ? elapsed(step.ms) : step.status==='running' ? 'running…':''}</span><details class="child-step-detail" data-step="${escape(step.id)}" ${opened.has(step.id) ? 'open':''}><summary>Input and output</summary><h4>Input</h4><pre>${escape(typeof step.input==='string' ? step.input : JSON.stringify(step.input,null,2))}</pre><h4>Output${step.truncated ? ' · truncated':''}</h4><pre>${escape(step.result ?? 'No result yet.')}</pre></details></li>`).join('')}</ol>` : '<p class="note">No tool steps yet.</p>'
    const runs=list.filter(x=>x.role===d.role).sort((a,b)=>(b.startedAt || 0)-(a.startedAt || 0))
    const clockOf=at=>at ? new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''
    const gist=x=>x.status==='running' ? 'running now' : String(x.report || '').replace(/\s+/g,' ').trim().slice(0,90) || (x.status==='failed' ? 'failed' : 'no report')
    const history=runs.length>1 ? `<section class="detail-section"><h3>Runs today <span>${runs.length}</span></h3><ol class="scout-runs">${runs.map(x=>`<li><button type="button" class="scout-run" data-agent="${escape(x.id)}" aria-current="${x.id===d.id}"><span class="dot ${AGENT_STATE[x.status] || ''}"></span><time>${escape(clockOf(x.startedAt))}</time><span class="scout-run-gist">${escape(gist(x))}</span><small>${x.steps.length} step${x.steps.length===1 ? '':'s'}</small></button></li>`).join('')}</ol></section>` : ''
    const html=`<header class="day-agent-head"><span class="badge ${AGENT_STATE[d.status] || ''}"><span class="dot"></span>${escape(d.status)}</span><h3>${escape(d.role)}</h3><span class="note">${escape(d.model ? d.model.replace('claude-','') : '')}${d.startedAt ? ` · ${elapsed((d.finishedAt || Date.now())-d.startedAt)}`:''}${d.description ? ` · ${escape(d.description)}`:''}</span></header>${history}<section class="detail-section"><h3>Assignment</h3><div class="response">${escape(d.prompt || 'Not recorded.')}</div></section><section class="detail-section"><h3>Steps</h3>${steps}</section>${d.output && d.status==='running' ? `<section class="detail-section"><h3>Latest output</h3><div class="response">${escape(d.output)}</div></section>`:''}<section class="detail-section"><h3>Report to the Day</h3><div class="response ${d.report ? '':'missing'}">${escape(d.report || (d.status==='running' ? 'Still working…' : 'No report.'))}</div></section>`
    if(view.fleetHtml!==html){const top=view.scrollTop;view.innerHTML=html;view.fleetHtml=html;view.scrollTop=top}
  }
  async function post(id,body,done) {
    try{await api(`/api/managed/${id}/day`,body);if(done)toast(done);control().refresh()}
    catch(error){toast(error.message)}
  }
  const triage=(id,itemId,changes,done)=>post(id,{op:'triage',itemId,...changes},done)
  function act(id,event) {
    const panel=document.getElementById('day-board'),target=event.target
    if(target.closest('[data-sweep]')){event.preventDefault();return post(id,{op:'sweep'},'Checking your sources')}
    // Inside a row's summary, so it must not also open or close the row.
    const project=target.closest('[data-open-project]')
    if(project){event.preventDefault();return window.FleetProjects?.show(project.dataset.openProject)}
    const openThread=target.closest('[data-open-thread]')
    if(openThread){event.preventDefault();return showThread(openThread.dataset.openThread)}
    const askItem=target.closest('[data-ask-item]')
    if(askItem){
      const field=panel.querySelector(`[data-keep="${CSS.escape(`ask:${askItem.dataset.askItem}`)}"]`),message=field?.value.trim()
      if(!message)return toast('Type your question first.')
      askItem.disabled=true
      return api(`/api/managed/${id}/day`,{op:'thread',itemId:askItem.dataset.askItem,message,requestId:crypto.randomUUID()})
        .then(async ({result})=>{field.value='';await window.Fleet.tick();showThread(result.threadId)})
        .catch(error=>{toast(error.message);askItem.disabled=false})
    }
    const details=target.closest('[data-show-item]')
    if(details){event.preventDefault();return showItem(details.dataset.showItem)}
    const opener=target.closest('[data-open-session]')
    if(opener){event.preventDefault();window.FleetViews?.switchView('sessions');return window.Fleet.select(opener.dataset.openSession)}
    const answer=target.closest('[data-answer],[data-answer-value]')
    if(answer){
      const {item,need}=answer.dataset,key=`${item}:${need}`
      let value=answer.dataset.answerValue
      if(answer.dataset.answer==='reject')value='reject'
      if(answer.dataset.answer==='approve'){
        const field=panel.querySelector(`[data-keep="${CSS.escape(`draft:${key}`)}"]`)
        const original=control().session()?.dayBoard?.items.find(i=>i.id===item)?.needs.find(n=>n.id===need)?.draft
        value=field && field.value.trim() && field.value!==original ? field.value : 'approve'
      }
      if(answer.dataset.answer==='info'){value=panel.querySelector(`[data-keep="${CSS.escape(`info:${key}`)}"]`)?.value.trim();if(!value)return toast('Type an answer first.')}
      const reply=answer.dataset.answer==='reply'
      if(reply){value=panel.querySelector(`[data-keep="${CSS.escape(`reply:${key}`)}"]`)?.value.trim();if(!value)return toast('Type a reply first.')}
      answer.disabled=true
      const launch=answer.closest('[data-kind="launch"]')
      const plan=launch && !reply && value!=='reject' ? {cwd:launch.querySelector('[data-launch="cwd"]').value.trim(),teamId:launch.querySelector('[data-launch="teamId"]').value} : {}
      return post(id,{op:'answer',itemId:item,needId:need,answer:value,...plan,...(reply ? {decision:'reply'}:{})},launch && plan.cwd ? 'Launched. It is in Sessions now.' : reply ? 'Sent to your day agent' : value==='reject' ? 'Rejected' : 'Answered')
    }
    const all=target.closest('[data-triage-all]')
    if(all){
      const items=(control().session()?.dayBoard?.items || []).filter(i=>i.status==='proposed' && i.priority===all.dataset.triageAll)
      return Promise.all(items.map(i=>triage(id,i.id,{status:'today'}))).then(()=>toast(`${items.length} on today`))
    }
    const button=target.closest('[data-triage]')
    if(button){
      const card=button.closest('[data-card]'),changes={status:button.dataset.triage}
      if(card.hasAttribute('data-proposed'))for(const el of card.querySelectorAll('select[data-field]'))changes[el.dataset.field]=el.value
      button.disabled=true
      return triage(id,card.dataset.card,changes)
    }
    if(target.closest('[data-add-item]')){
      const title=panel.querySelector('[data-keep="add:title"]'),context=panel.querySelector('[data-keep="add:context"]')
      if(!title.value.trim())return toast('Give it a title.')
      const links=[...new Set(context.value.match(/https?:\/\/[^\s<>)"']+/g) || [])].slice(0,20)
      const item={title:title.value.trim().slice(0,200),source:'me',context:context.value.trim() || undefined,links,priority:panel.querySelector('[data-add="priority"]').value,mode:panel.querySelector('[data-add="mode"]').value}
      title.value='';context.value=''
      return post(id,{op:'add',item},'Added to today')
    }
  }
  // The server refuses a second Day for a date, so this can only ever lead to one.
  async function start() {
    const button=document.getElementById('start-day');button.disabled=true
    try{
      const prompt=document.getElementById('today-note')?.value.trim()
      await api('/api/managed',{kind:'day',...(prompt ? {prompt}:{}),requestId:crypto.randomUUID()})
      await window.Fleet.tick()
      toast('Good morning. Gathering your day.')
    }catch(error){toast(error.message);button.disabled=false}
  }
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  // Mounted before views.js runs, which owns switching between the views.
  function mount() {
    const tabs=document.querySelector('.work-tabs'),sessions=document.getElementById('sessions-pane')
    if(!tabs || !sessions || document.getElementById('view-today'))return
    tabs.insertAdjacentHTML('afterbegin','<button type="button" class="button" id="view-today" aria-pressed="false" title="Your day: what needs you, in one plan">Today <span id="today-count"></span></button>')
    sessions.insertAdjacentHTML('afterend','<section class="sessions-pane today-pane" id="today-pane" aria-label="Today" hidden></section>')
  }
  mount()
  // Show one item on the board, opened (from a project's deliverable).
  function showItem(itemId) {
    window.FleetViews?.switchView('today')
    let tries=0
    const reveal=()=>{
      const row=document.querySelector(`#day-board [data-card="${CSS.escape(itemId)}"]`)
      if(!row){if(++tries<20)setTimeout(reveal,100);return}
      const details=row.querySelector('details');if(details)details.open=true
      // Scroll the board's own list; scrollIntoView would move the whole window too.
      const scroller=row.closest('.page-body')
      if(scroller){const r=row.getBoundingClientRect(),box=scroller.getBoundingClientRect();scroller.scrollBy({top:r.top-box.top-(box.height-r.height)/2,behavior:'smooth'})}
      row.classList.add('is-flash');setTimeout(()=>row.classList.remove('is-flash'),1600)
    }
    reveal()
  }
  return {board,render,active,current,start,messages,showItem}
})()
