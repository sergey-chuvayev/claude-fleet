'use strict'
// The Progress tab: a weekly look at what shipped, what stalled and what ran, read from
// the Day boards and sessions Fleet already keeps. Like Today and Projects it is a pane
// beside the other views, but it has no console: it is a page to read, full width.
window.FleetProgress=(()=>{
  const {esc}=window.Fleet
  const UI=window.FleetUI
  const escape=value=>esc(String(value ?? ''))
  const TONE={failed:'hot','needs you':'needs',running:'working',queued:'queued',stopped:'idle',finished:'done'}
  const STATUS={proposed:'proposed',today:'planned',in_progress:'in progress',waiting_on_you:'waiting on you',starting:'starting',running:'running',approval:'needs you',stopping:'stopping',queued:'queued'}
  let data=null,fetchedAt=0,loading=null,failed=false
  const pane=()=>document.getElementById('progress-pane')
  const active=()=>window.FleetViews?.view()==='progress' && !!pane()
  const when=at=>new Date(at).toLocaleDateString([],{weekday:'short',day:'numeric',month:'short'})
  const ago=at=>{const d=Math.floor((Date.now()-at)/86400000);return d<1 ? 'today' : `${d} day${d===1 ? '':'s'} ago`}
  const prLabel=url=>{const m=/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url);return m ? `${m[1]}#${m[2]}` : url}
  const prLinks=urls=>urls.map(u=>`<a href="${escape(u)}" target="_blank" rel="noopener noreferrer">${escape(prLabel(u))} ↗</a>`).join(' ')
  function shippedHtml(s) {
    if(!s.items.length)return UI.empty({title:'Nothing shipped yet.',text:'Items marked done on your Day show up here, with the pull requests linked on them.'})
    return UI.list(s.items.map(i=>UI.row({tone:'done',orbTitle:'Done',title:escape(i.title),meta:`${escape(when(`${i.date}T12:00:00`))}${i.prs.length ? ` · ${prLinks(i.prs)}`:''}`})).join(''))
  }
  function stalledHtml(s,days) {
    if(!s.items.length)return UI.empty({title:'Nothing stalled.',text:`No open item or running session has gone ${days} days without moving.`})
    return UI.list(s.items.map(i=>UI.row({tone:'needs',orbTitle:'Stalled',title:escape(i.title),meta:`${i.kind==='session' ? 'Session' : 'Item'} · ${escape(STATUS[i.status] || i.status)} · no movement ${escape(ago(i.lastMoved))}`})).join(''))
  }
  function ranHtml(r) {
    if(!r.sessions.length)return UI.empty({title:'No sessions ran.',text:'Agents you launch from Fleet show up here with how they ended.'})
    return UI.list(r.sessions.map(x=>UI.row({tone:TONE[x.outcome] || 'idle',orbTitle:x.outcome,title:escape(x.name.slice(0,80)),meta:`${UI.pill(escape(x.outcome),TONE[x.outcome])} ${escape(when(x.at))}${x.teamName ? ` · ${escape(x.teamName)}`:''}`})).join(''),'is-compact')
  }
  function draw() {
    const el=pane();if(!el)return
    const head=UI.pageHead({title:'Progress',actions:'<button type="button" class="button ghost" data-refresh-progress title="Read this week again">↻ Refresh</button>'})
    if(!data){
      el.innerHTML=`${head}<div class="page-body">${failed ? UI.callout('Could not load progress','Try again in a moment.',{tone:'hot'}) : '<p class="note">Reading your week…</p>'}</div>`
      return
    }
    const outcomes=Object.entries(data.ran.outcomes).map(([k,v])=>`${v} ${escape(k)}`).join(' · ')
    const strip=[UI.stat('Shipped',String(data.shipped.count),{tone:data.shipped.count ? 'done':undefined}),UI.stat('PRs',String(data.shipped.prs)),UI.stat('Stalled',String(data.stalled.count),{tone:data.stalled.count ? 'warn':undefined}),UI.stat('Ran',String(data.ran.count))].join('')
    el.innerHTML=`${UI.pageHead({title:'Progress',actions:`<span class="note">Last ${data.days} days, since ${escape(when(data.since))}</span><button type="button" class="button ghost" data-refresh-progress>↻ Refresh</button>`,strip})}
      <div class="page-body">
        ${UI.section('Shipped',shippedHtml(data.shipped),{count:data.shipped.count,aside:'<span class="note">Done on your Day; Fleet does not check GitHub for merges</span>'})}
        ${UI.section('Stalled',stalledHtml(data.stalled,data.staleDays),{count:data.stalled.count,aside:`<span class="note">Open with no update in ${data.staleDays} days</span>`})}
        ${UI.section('Ran',ranHtml(data.ran),{count:data.ran.count,aside:outcomes ? `<span class="note">${outcomes}</span>`:''})}
      </div>`
  }
  function load(force=false) {
    if(loading || (!force && Date.now()-fetchedAt<15000))return loading
    loading=window.FleetControl.api('/api/progress').then(result=>{data=result;failed=false;fetchedAt=Date.now();draw()}).catch(()=>{failed=true;fetchedAt=Date.now();if(!data)draw()}).finally(()=>{loading=null})
    return loading
  }
  function render() {
    if(!pane() || !active())return
    // The first visit draws at once; the data follows.
    if(!pane().innerHTML)draw()
    load()
  }
  // Mounted before views.js runs, which owns switching between the views.
  function mount() {
    const tabs=document.querySelector('.work-tabs'),sessions=document.getElementById('sessions-pane')
    if(!tabs || !sessions || document.getElementById('view-progress'))return
    const after=document.getElementById('view-projects') || document.getElementById('view-today')
    const button='<button type="button" class="button" id="view-progress" aria-pressed="false" title="This week: what shipped, what stalled, what ran">Progress</button>'
    if(after)after.insertAdjacentHTML('afterend',button);else tabs.insertAdjacentHTML('afterbegin',button)
    sessions.insertAdjacentHTML('afterend','<section class="sessions-pane today-pane progress-pane" id="progress-pane" aria-label="Progress" hidden></section>')
    pane().addEventListener('click',event=>{if(event.target.closest('[data-refresh-progress]'))load(true)})
  }
  mount()
  return {render,active}
})()
