'use strict'
// The Today panel: the Day board above a Day's conversation, and the button that starts
// one. An isolated scope, like teams.js.
window.FleetDay=(()=>{
  const { esc, toast } = window.Fleet
  const control = () => window.FleetControl
  const api = (...args) => window.FleetControl.api(...args)
  const escape=value=>esc(String(value ?? ''))
  const SOURCE={slack:'Slack',linear:'Linear',granola:'Granola',github:'GitHub',calendar:'Calendar',me:'You'}
  const MODE={me:'I do it',draft:'Draft for me',agent:'Agent does it',ask:'Find out'}
  const PRIORITY={must:'Must',should:'Should',could:'Could'}
  const STATUS={today:'today',in_progress:'in progress',waiting_on_you:'waiting on you',done:'done',later:'later',dropped:'dropped',proposed:'proposed'}
  const open=item=>item.needs.filter(n=>n.answer===undefined)
  const minutes=list=>list.reduce((sum,i)=>sum+(i.estimateMin || 0),0)
  const duration=n=>n>=60 ? `${Math.floor(n/60)}h${n%60 ? ` ${n%60}m`:''}` : `${n}m`
  const options=(map,value)=>Object.entries(map).map(([k,v])=>`<option value="${k}" ${k===value ? 'selected':''}>${v}</option>`).join('')
  const linksHtml=item=>item.links.length ? `<span class="day-links">${item.links.slice(0,4).map(url=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="${escape(url)}">${escape(label(url))} ↗</a>`).join('')}</span>`:''
  function label(url) {
    const linear=url.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/);if(linear)return linear[1].toUpperCase()
    const pr=url.match(/github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/);if(pr)return `${pr[1]}#${pr[2]}`
    if(/slack\.com/.test(url))return 'Slack'
    try{return new URL(url).hostname.replace(/^www\./,'')}catch{return 'Link'}
  }
  const head=item=>`<span class="day-source" data-source="${escape(item.source)}">${escape(SOURCE[item.source] || item.source)}</span><strong>${escape(item.title)}</strong>${item.estimateMin ? `<small>${duration(item.estimateMin)}</small>`:''}`
  // An answer is typed into the board while the board keeps refreshing under it. Every
  // field that holds the operator's words is keyed, read back before a render and put
  // back after, so a poll never eats a half-written reply.
  const keep=(key,value='',rows)=>rows ? `<textarea data-keep="${escape(key)}" rows="${rows}" maxlength="16000">${escape(value)}</textarea>` : `<input data-keep="${escape(key)}" value="${escape(value)}" maxlength="2000">`
  function needHtml(item,n) {
    const id=`${item.id}:${n.id}`,data=`data-item="${escape(item.id)}" data-need="${escape(n.id)}"`
    if(n.kind==='approve') return `<div class="day-need" data-kind="approve"><p>${escape(n.question)}</p>${keep(`draft:${id}`,n.draft,Math.min(8,Math.max(3,String(n.draft).split('\n').length+1)))}<div class="day-actions"><button type="button" class="button resume" data-answer="approve" ${data}>Approve</button><button type="button" class="button" data-answer="reject" ${data}>Reject</button><span class="note">Edit the text above to approve your version instead.</span></div></div>`
    if(n.kind==='choose') return `<div class="day-need" data-kind="choose"><p>${escape(n.question)}</p><div class="day-actions">${(n.options || []).map(o=>`<button type="button" class="button" data-answer-value="${escape(o)}" ${data}>${escape(o)}</button>`).join('')}</div></div>`
    return `<div class="day-need" data-kind="info"><p>${escape(n.question)}</p><div class="day-actions day-inline">${keep(`info:${id}`)}<button type="button" class="button resume" data-answer="info" ${data}>Answer</button></div></div>`
  }
  function waitingHtml(items) {
    const waiting=items.filter(i=>open(i).length).sort((a,b)=>open(a)[0].at-open(b)[0].at)
    if(!waiting.length) return ''
    return `<section class="day-section day-waiting"><h4>Waiting on you <span>${waiting.reduce((n,i)=>n+open(i).length,0)}</span></h4>${waiting.map(item=>`<article class="day-card">${`<div class="day-card-head">${head(item)}</div>`}${open(item).map(n=>needHtml(item,n)).join('')}${linksHtml(item)}</article>`).join('')}</section>`
  }
  function triageHtml(items) {
    const proposed=items.filter(i=>i.status==='proposed')
    if(!proposed.length) return ''
    const order={must:0,should:1,could:2}
    proposed.sort((a,b)=>order[a.priority]-order[b.priority])
    return `<section class="day-section"><h4>To triage <span>${proposed.length}</span><button type="button" class="button day-small" data-triage-all="must">Take all Must</button></h4>${proposed.map(item=>`<article class="day-card" data-card="${escape(item.id)}" data-proposed><div class="day-card-head">${head(item)}</div>${item.context ? `<p class="day-context">${escape(item.context)}</p>`:''}${linksHtml(item)}<div class="day-actions"><select data-field="priority" aria-label="Priority">${options(PRIORITY,item.priority)}</select><select data-field="mode" aria-label="How">${options(MODE,item.mode)}</select><button type="button" class="button resume" data-triage="today">Today</button><button type="button" class="button" data-triage="later">Later</button><button type="button" class="button" data-triage="dropped">Drop</button></div></article>`).join('')}</section>`
  }
  function todayHtml(items,opened) {
    const today=items.filter(i=>['today','in_progress','waiting_on_you'].includes(i.status))
    const order={must:0,should:1,could:2}
    today.sort((a,b)=>order[a.priority]-order[b.priority] || a.createdAt-b.createdAt)
    const row=item=>`<li data-card="${escape(item.id)}"><details data-evidence="${escape(item.id)}" ${opened.has(item.id) ? 'open':''}><summary><span class="task-state" data-state="${escape(item.status)}">${escape(STATUS[item.status])}</span><span class="day-priority" data-priority="${escape(item.priority)}">${PRIORITY[item.priority]}</span>${head(item)}<small class="day-mode">${escape(MODE[item.mode])}</small></summary>${item.context ? `<p class="day-context">${escape(item.context)}</p>`:''}${linksHtml(item)}${item.log.length ? `<ol class="day-log">${item.log.slice(-6).map(l=>`<li><time>${new Date(l.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time> ${escape(l.text)}</li>`).join('')}</ol>`:''}<div class="day-actions"><select data-field="mode" aria-label="How">${options(MODE,item.mode)}</select><button type="button" class="button" data-triage="done" ${open(item).length ? 'disabled title="Answer its questions first"':''}>Done</button><button type="button" class="button" data-triage="later">Later</button></div></details></li>`
    return `<section class="day-section"><h4>Today <span>${today.length}${minutes(today) ? ` · ${duration(minutes(today))} estimated`:''}</span></h4>${today.length ? `<ol class="initiative-tasks day-list">${today.map(row).join('')}</ol>` : '<p class="note">Nothing on today yet. Triage the proposals, or add your own.</p>'}</section>`
  }
  function restHtml(items) {
    const later=items.filter(i=>i.status==='later'),done=items.filter(i=>i.status==='done')
    if(!later.length && !done.length) return ''
    const list=(title,list,action)=>list.length ? `<details class="day-rest" data-evidence="rest-${title}"><summary>${title} <span>${list.length}</span></summary><ul>${list.map(i=>`<li data-card="${escape(i.id)}">${head(i)}${action ? `<button type="button" class="button day-small" data-triage="today">Today</button>`:''}</li>`).join('')}</ul></details>`:''
    return `<section class="day-section">${list('Later',later,true)}${list('Done',done,false)}</section>`
  }
  const addHtml=()=>`<details class="day-add" data-evidence="add"><summary>＋ Add something</summary><div class="day-add-fields">${keep('add:title')}<textarea data-keep="add:context" rows="3" maxlength="8000" placeholder="Context, links, who is waiting. The agent fills in the rest."></textarea><div class="day-actions"><select data-add="priority" aria-label="Priority">${options(PRIORITY,'should')}</select><select data-add="mode" aria-label="How">${options(MODE,'me')}</select><button type="button" class="button resume" data-add-item>Add to today</button></div></div></details>`
  function board(s) {
    let panel=document.getElementById('day-board')
    if(s.kind!=='day'){panel?.remove();return}
    if(!panel){
      panel=document.createElement('details');panel.id='day-board';panel.open=true
      document.getElementById('conversation').before(panel)
      // Bound once for the panel's life; the session it shows is read from the dataset
      // at click time, for the same reason as the initiative board.
      panel.addEventListener('click',event=>act(panel.dataset.sessionId,event))
      // On a proposal the choices travel with Today/Later/Drop; on a triaged item a new
      // mode is the instruction, so it goes at once.
      panel.addEventListener('change',event=>{const card=event.target.closest('[data-card]:not([data-proposed])');if(card && event.target.dataset.field==='mode')triage(panel.dataset.sessionId,card.dataset.card,{mode:event.target.value},'Updated')})
    }
    panel.dataset.sessionId=s.id
    const b=s.dayBoard || {items:[],cursors:{}}
    const signature=JSON.stringify([s.id,b,s.status,s.costUsd,s.limits])
    if(panel.fleetSignature===signature)return
    // Keep what the operator is in the middle of: open disclosures, typed text, focus.
    const opened=new Set([...panel.querySelectorAll('details[open][data-evidence]')].map(el=>el.dataset.evidence))
    const typed=new Map([...panel.querySelectorAll('[data-keep]')].map(el=>[el.dataset.keep,el.value]))
    const focused=document.activeElement?.closest?.('#day-board [data-keep]')?.dataset.keep
    const scrollTop=panel.querySelector('.initiative-body')?.scrollTop || 0
    panel.fleetSignature=signature
    const items=b.items.filter(i=>i.status!=='dropped')
    const done=items.filter(i=>i.status==='done').length,triaged=items.filter(i=>i.status!=='proposed').length
    const waiting=items.reduce((n,i)=>n+open(i).length,0)
    const when=new Date(`${b.date}T12:00:00`).toLocaleDateString([],{weekday:'long',month:'short',day:'numeric'})
    panel.innerHTML=`<summary><strong>${escape(when)}</strong>${waiting ? `<span class="day-alert">${waiting} waiting on you</span>`:''}<span>${done}/${triaged} done</span><span title="API-rate equivalent the SDK reports. Not billed on a Claude subscription; the Day still stops here.">$${(s.costUsd || 0).toFixed(2)} / $${s.limits?.budgetUsd ?? 15}</span><button type="button" class="button day-small" data-sweep ${control().isWorking(s) ? 'disabled':''}>Check now</button></summary><div class="initiative-body">${waitingHtml(items)}${triageHtml(items)}${todayHtml(items,opened)}${addHtml()}${restHtml(items)}</div>`
    for(const el of panel.querySelectorAll('details[data-evidence]'))if(opened.has(el.dataset.evidence))el.open=true
    for(const el of panel.querySelectorAll('[data-keep]'))if(typed.has(el.dataset.keep))el.value=typed.get(el.dataset.keep)
    panel.querySelector('[data-keep="add:title"]').placeholder='What needs doing?'
    panel.querySelector('.initiative-body').scrollTop=scrollTop
    if(focused)panel.querySelector(`[data-keep="${CSS.escape(focused)}"]`)?.focus({preventScroll:true})
    document.getElementById('message-input').placeholder='Ask your day agent…'
  }
  async function post(id,body,done) {
    try{await api(`/api/managed/${id}/day`,body);if(done)toast(done);control().refresh()}
    catch(error){toast(error.message)}
  }
  const triage=(id,itemId,changes,done)=>post(id,{op:'triage',itemId,...changes},done)
  function act(id,event) {
    const panel=document.getElementById('day-board'),target=event.target
    if(target.closest('[data-sweep]')){event.preventDefault();return post(id,{op:'sweep'},'Checking your sources')}
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
      answer.disabled=true
      return post(id,{op:'answer',itemId:item,needId:need,answer:value},value==='reject' ? 'Rejected' : 'Answered')
    }
    const all=target.closest('[data-triage-all]')
    if(all){
      const items=(control().session()?.dayBoard?.items || []).filter(i=>i.status==='proposed' && i.priority===all.dataset.triageAll)
      return Promise.all(items.map(i=>triage(id,i.id,{status:'today'}))).then(()=>toast(`${items.length} on today`))
    }
    const button=target.closest('[data-triage]')
    if(button){
      const card=button.closest('[data-card]'),changes={status:button.dataset.triage}
      if(card.hasAttribute('data-proposed'))for(const el of card.querySelectorAll('[data-field]'))changes[el.dataset.field]=el.value
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
  // Opens today's Day, or starts it. The server refuses a second Day for a date, so the
  // button can only ever lead to one.
  async function start() {
    const existing=(window.Fleet.snapshot()?.sessions || []).find(s=>s.kind==='day' && s.dayDate===today())
    if(existing){window.Fleet.setFilter('all');return window.Fleet.select(existing.managedId)}
    const button=document.getElementById('start-day');button.disabled=true
    try{
      const data=await api('/api/managed',{kind:'day',requestId:crypto.randomUUID()})
      await window.Fleet.tick();window.Fleet.setFilter('all');window.Fleet.select(data.session.id)
      toast('Good morning. Gathering your day.')
    }catch(error){toast(error.message)}finally{button.disabled=false}
  }
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  function mount() {
    if(document.getElementById('start-day'))return
    const button=document.createElement('button')
    button.id='start-day';button.className='button';button.type='button';button.textContent='☀ Today'
    button.title='Open today’s Day, or start one: your Slack, Linear, meetings and PRs in one plan'
    document.getElementById('new-session').before(button)
    button.addEventListener('click',start)
  }
  mount()
  return {board,start}
})()
