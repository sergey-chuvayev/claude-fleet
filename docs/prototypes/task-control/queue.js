'use strict';
;(() => {
  const {esc,toast}=window.Fleet, demo=window.FleetDemo;
  const $=id=>document.getElementById('qp-'+id), money=n=>'$'+n.toFixed(2);
  const key='fleet-task-control-demo-v1';
  let state;try{state=demo.restore(localStorage.getItem(key));}catch{state=demo.initial();}
  let selected=state.tasks[0]?.id,filter='all',search='',mode='sessions',editor=null;
  const original=document.querySelector('main>.workspace');
  const labels={attention:'Needs you',review:'Ready to review',running:'Running',queued:'Queued',accepted:'Accepted'};
  const badges={attention:'stale',review:'idle',running:'busy',queued:'dead',accepted:'idle'};
  const count=status=>state.tasks.filter(t=>t.status===status).length;
  const selectedTask=()=>state.tasks.find(t=>t.id===selected);
  const activity=t=>t.status==='attention'?(t.budgetBlocked?'Task budget reached':'A decision is needed'):t.status==='queued'?(state.paused?'Queue paused':'Waiting for a free slot'):t.status==='review'?(t.integration===state.revision?'Integration current · ready to accept':'Reviewer passed · check integration'):t.status==='accepted'?'Accepted in demo':t.phase==='verify'?'Reviewer checking changes':t.phase==='integration'?'Checking integration with main':'Builder implementing';
  document.querySelector('.brand').insertAdjacentHTML('afterend',`<nav class="qp-tabs" aria-label="Fleet view"><button class="button" id="qp-sessions" aria-pressed="true">Sessions</button><button class="button" id="qp-queue" aria-pressed="false">Work queue <span id="qp-total"></span></button></nav>`);
  document.querySelector('main').insertAdjacentHTML('beforebegin',`<div class="qp-banner"><strong>INTERACTIVE PREVIEW</strong><span>Sample data · no agents run or tokens spent</span><div class="qp-demo-actions"><button class="button" id="qp-reset">Reset demo</button><button class="button" id="qp-advance">Advance demo →</button></div></div>`);
  original.insertAdjacentHTML('afterend',`<section id="qp-workspace" class="workspace" aria-label="Work queue" hidden><div class="sessions-pane"><div class="section-heading"><h2>Work queue <span id="qp-count"></span></h2><div class="qp-control-actions"><button class="button" id="qp-teams">Teams</button><button class="button resume" id="qp-add">＋ Add task</button></div></div><div class="qp-controls"><span id="qp-capacity"></span><div class="qp-control-actions"><label>Concurrent tasks<select id="qp-limit" aria-label="Concurrent tasks"><option>1</option><option>2</option><option>3</option><option>4</option></select></label><button class="button" id="qp-pause">Pause</button></div></div><div class="qp-filters"><div id="qp-filters"></div><input id="qp-search" class="qp-search" type="search" placeholder="Find a task…" aria-label="Find a task"></div><div class="list-head"><span>TASK / TEAM</span><span>DEMO USAGE</span></div><div class="session-list" id="qp-list"></div></div><div id="qp-splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize task details" aria-valuemin="25" aria-valuemax="75" aria-valuenow="58" tabindex="0"></div><aside class="detail" id="qp-detail" aria-label="Task details"></aside></section>`);
  function save(){try{localStorage.setItem(key,JSON.stringify(state));}catch{toast('Preview storage unavailable; changes will last until reload.');}}
  function update(message){save();render();if(message)toast(message);}
  function switchView(next){mode=next;original.hidden=next!=='sessions';$('workspace').hidden=next!=='queue';$('sessions').setAttribute('aria-pressed',String(next==='sessions'));$('queue').setAttribute('aria-pressed',String(next==='queue'));if(next==='queue')render();}
  function openDetail(){ $('workspace').dataset.detailOpen='true';const heading=$('detail').querySelector('h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
  function render(){
    $('total').textContent=state.tasks.filter(t=>t.status!=='accepted').length;
    $('count').textContent=state.tasks.length;
    $('capacity').textContent=(state.paused?'Paused · ':'')+count('running')+' running · '+count('queued')+' queued';
    $('limit').value=state.limit;$('pause').textContent=state.paused?'Resume':'Pause';
    $('filters').innerHTML=[['all','All'],['attention','Needs you'],['review','Review'],['running','Running'],['queued','Queued']].map(([id,label])=>`<button class="filter" data-qp-filter="${id}" aria-pressed="${filter===id}">${label}<span>${id==='all'?state.tasks.length:count(id)}</span></button>`).join('');
    renderList();renderDetail();
  }
  function renderList(){
    const visible=state.tasks.filter(t=>(filter==='all'||t.status===filter)&&[t.title,t.repo,t.team.name,t.id].join(' ').toLowerCase().includes(search));
    if(!visible.length){$('list').innerHTML='<div class="qp-empty">No matching tasks. Try another filter or add a task.</div>';return;}
    $('list').innerHTML=['attention','review','running','queued','accepted'].map(status=>{
      const tasks=visible.filter(t=>t.status===status);if(!tasks.length)return '';
      return `<section aria-label="${labels[status]}"><div class="qp-group" data-state="${status}">${labels[status]}<span>${tasks.length}</span></div>${tasks.map(t=>`<button class="session qp-row" data-qp-task="${t.id}" aria-pressed="${t.id===selected&&!editor}"><span><span class="session-top"><span class="badge ${badges[t.status]}"><span class="dot"></span>${labels[t.status]}</span><span class="session-name">FL-${t.id}</span></span><span class="session-title">${esc(t.title)}</span><span class="session-meta"><span>${esc(t.repo)}</span><span>· ${esc(t.team.name)}</span><span>· ${esc(t.team.builder)} / ${esc(t.team.reviewer)}</span></span><span class="qp-next ${status==='attention'?'is-attention':''}">${esc(activity(t))}</span></span><span class="session-context">${money(t.spend)}<span class="mini-bar"><i style="width:${Math.min(100,t.spend/t.team.cap*100)}%"></i></span><small>${money(t.team.cap)} cap</small></span></button>`).join('')}</section>`;
    }).join('');
  }
  const back='<button class="button qp-mobile-back" data-qp-action="back">← Back to tasks</button>';
  function renderDetail(){
    if(editor){renderEditor();return;}
    const t=selectedTask();if(!t){$('detail').innerHTML='<p class="qp-empty">Select a task to see its team and next action.</p>';return;}
    let action='';
    if(t.status==='attention')action=`<section class="qp-section is-decision"><h4>Your input is needed</h4><h3>${esc(t.question)}</h3>${t.budgetBlocked?`<form class="qp-form" data-qp-form="budget"><label>New task budget<input name="cap" type="number" min="${(t.spend+.18).toFixed(2)}" max="100" step="0.01" value="${Math.min(100,t.team.cap+1)}" required></label><button class="button resume">Update cap & queue</button></form>`:`<div class="qp-actions"><button class="button resume" data-qp-answer="Show an expired-link page with a request-new-invitation action.">Show a recovery page</button><button class="button" data-qp-answer="Redirect to sign-in with an expired-invitation message.">Redirect to sign-in</button></div><form class="qp-form composer" data-qp-form="answer"><label>Your direction<textarea name="answer" required maxlength="1000" placeholder="Or tell the team how to proceed…"></textarea></label><button class="button" type="submit">Send direction & queue</button></form>`}</section>`;
    else if(t.status==='review')action=`<section class="qp-section"><h4>Review evidence · simulated</h4><ul class="qp-checks">${t.checks.map(c=>`<li><span>✓</span>${esc(c)}</li>`).join('')}</ul><p class="qp-integration ${t.integration===state.revision?'is-current':''}">${t.integration===state.revision?'✓ Integration passed against current main':t.integration===null?'○ Integration has not been checked':'↻ Main changed since the last integration check'}</p><div class="qp-actions">${t.integration===state.revision?'<button class="button resume" data-qp-action="accept">Accept change</button>':'<button class="button resume" data-qp-action="integration">Check integration</button>'}</div><p class="note">Demo checks only. Accepting does not merge a real branch.</p></section><details><summary>Request changes</summary><form class="qp-form" data-qp-form="repair"><label>What should the builder fix?<textarea name="request" required maxlength="1000"></textarea></label><button class="button">Send to builder</button></form></details>`;
    else action=`<section class="qp-section"><h4>${labels[t.status]}</h4><h3>${esc(activity(t))}</h3><p>${t.status==='running'?'Advance the demo to simulate the next stage.':t.status==='queued'?'This task will start when dispatch is enabled and a slot is free.':'This change was accepted in the simulation.'}</p>${t.status==='queued'?'<button class="button" data-qp-action="prioritize">Move to front of queue ↑</button>':''}</section>`;
    $('detail').innerHTML=`<header class="qp-detail-head">${back}<h3>${esc(t.title)}</h3><span class="badge ${badges[t.status]}">${labels[t.status]}</span></header><div class="qp-team-strip"><strong>${esc(t.team.name)}</strong><span>Builder <small>${esc(t.team.builder)}</small></span><span>Reviewer <small>${esc(t.team.reviewer)}</small></span><span>${money(t.spend)} / ${money(t.team.cap)} <small>simulated usage</small></span></div><div class="qp-detail-scroll">${action}<div class="qp-section"><h4>Conversation & activity</h4><div class="qp-log conversation" id="qp-log"></div></div>${t.diff?`<details><summary>Illustrative diff · 1 file</summary>${window.FleetBlocks.codeHtml(t.diff,'diff')}</details>`:''}<details><summary>Task details</summary><p class="note">${esc(t.repo)} · task/fl-${t.id}<br>${esc(t.brief)}</p></details></div>`;
    const messages=[{id:'task-brief',role:'user',text:t.brief,at:1789981200000},...t.log.map((text,i)=>({id:'task-event-'+i,role:'assistant',text,at:1789981200000+(i+1)*60000}))];
    window.FleetBlocks.renderBlocks($('log'),messages,{onCopy:toast});
  }
  function renderEditor(){
    if(editor==='add') {
      $('detail').innerHTML=`<div class="qp-form-wrap">${back}<h3>Add a task</h3><p class="note">A separate workspace and team for each assignment.</p><form class="qp-form" data-qp-form="add"><label>Task title<input name="title" required maxlength="160" placeholder="What should be different?"></label><label>Repository<select name="repo"><option>web-app</option><option>service-api</option></select></label><label>Team<select name="teamId">${state.teams.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${money(t.cap)} cap</option>`).join('')}</select></label><label>What does done look like?<textarea name="brief" maxlength="2000" placeholder="Scope, acceptance criteria and checks…"></textarea></label><div class="qp-actions"><button class="button resume">Add task</button><button type="button" class="button" data-qp-action="cancel">Cancel</button></div></form></div>`;
    }else $('detail').innerHTML=`<div class="qp-form-wrap">${back}<h3>Team settings</h3><p class="note">Model and budget changes apply to future tasks. Existing assignments keep their team configuration.</p>${state.teams.map(t=>`<form class="qp-form" data-qp-form="team" data-qp-team="${esc(t.id)}"><label>Team name<input name="name" value="${esc(t.name)}" required maxlength="60"></label><div class="qp-two">${['builder','reviewer'].map(role=>`<label>${role==='builder'?'Builder':'Reviewer'} model<select name="${role}">${['sonnet','haiku','opus'].map(m=>`<option ${m===t[role]?'selected':''}>${m}</option>`).join('')}</select></label>`).join('')}</div><label>Demo budget per task<input name="cap" type="number" min="0.1" max="100" step="0.1" value="${t.cap}" required></label><button class="button">Save team</button></form>`).join('')}</div>`;
  }
  $('workspace').addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b)return;
    if(b.dataset.qpTask){selected=Number(b.dataset.qpTask);editor=null;render();openDetail();return;}
    if(b.dataset.qpFilter){filter=b.dataset.qpFilter;render();$('filters').querySelector(`[data-qp-filter="${filter}"]`).focus();return;}
    if(b.dataset.qpAnswer){if(demo.resolve(state,selected,b.dataset.qpAnswer)){update('Direction sent. Task queued to resume.');openDetail();}return;}
    switch(b.dataset.qpAction){
      case 'back':$('workspace').dataset.detailOpen='false';$('list').querySelector(`[data-qp-task="${selected}"]`)?.focus();break;
      case 'cancel':editor=null;render();$('add').focus();break;
      case 'integration':if(demo.checkIntegration(state,selected))update('Integration check queued. Advance the demo to continue.');openDetail();break;
      case 'accept':if(demo.accept(state,selected))update('Accepted in the demo. Other integration results may now be stale.');openDetail();break;
      case 'prioritize':{const t=selectedTask();state.tasks=state.tasks.filter(x=>x!==t);state.tasks.unshift(t);demo.schedule(state);update('Moved to the front of the queue.');break;}
    }
  });
  $('workspace').addEventListener('submit',event=>{
    event.preventDefault();const f=event.target,v=Object.fromEntries(new FormData(f));
    if(f.dataset.qpForm==='add'){
      if(state.tasks.length>=100){toast('Reset the demo to add more than 100 tasks.');return;}
      const t=demo.add(state,v);if(!t){toast('Enter a title and select a team.');return;}selected=t.id;filter='all';search='';$('search').value='';editor=null;update('Task added to the queue.');openDetail();
    }else if(f.dataset.qpForm==='answer'){if(demo.resolve(state,selected,v.answer)){update('Direction sent.');openDetail();}}
    else if(f.dataset.qpForm==='repair'){if(demo.repair(state,selected,v.request)){update('Changes requested. Old verification cleared.');openDetail();}}
    else if(f.dataset.qpForm==='budget'){
      const t=selectedTask(),cap=Number(v.cap);if(!t||cap<t.spend+.18||cap>100)return;t.team.cap=cap;t.budgetBlocked=false;t.status='queued';t.question=null;t.log.push('Task budget raised to '+money(cap));demo.schedule(state);update('Task budget updated.');openDetail();
    }else if(f.dataset.qpForm==='team'){
      const team=state.teams.find(t=>t.id===f.dataset.qpTeam);if(!v.name.trim())return;Object.assign(team,{name:v.name.trim(),builder:v.builder,reviewer:v.reviewer,cap:Number(v.cap)});update('Team saved for future assignments.');
    }
  });
  $('sessions').addEventListener('click',()=>switchView('sessions'));
  $('queue').addEventListener('click',()=>switchView('queue'));
  $('add').addEventListener('click',()=>{editor='add';renderDetail();openDetail();$('detail').querySelector('[name=title]').focus();});
  $('teams').addEventListener('click',()=>{editor='teams';renderDetail();openDetail();});
  $('advance').addEventListener('click',()=>{demo.advance(state);update('Demo advanced. No agents or tests ran.');switchView('queue');});
  $('reset').addEventListener('click',()=>{state=demo.initial();selected=101;filter='all';search='';editor=null;$('search').value='';$('workspace').dataset.detailOpen='false';update('Five sample tasks restored.');});
  $('pause').addEventListener('click',()=>{state.paused=!state.paused;demo.schedule(state);update(state.paused?'Dispatch paused; running work may finish.':'Queue resumed.');});
  $('limit').addEventListener('change',e=>{state.limit=Number(e.target.value);demo.schedule(state);update('New admission limit set. Running tasks will finish.');});
  $('search').addEventListener('input',e=>{search=e.target.value.trim().toLowerCase();renderList();});
  function setSplit(value){const n=Math.max(25,Math.min(75,value));$('workspace').style.setProperty('--split',n+'%');$('splitter').setAttribute('aria-valuenow',String(Math.round(n)));}
  $('splitter').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home'].includes(e.key)){e.preventDefault();setSplit(e.key==='Home'?58:Number($('splitter').getAttribute('aria-valuenow'))+(e.key==='ArrowLeft'?-2:2));}});
  $('splitter').addEventListener('pointerdown',e=>{e.preventDefault();$('splitter').setPointerCapture(e.pointerId);$('splitter').dataset.dragging='true';});
  $('splitter').addEventListener('pointermove',e=>{if(!$('splitter').hasPointerCapture(e.pointerId))return;const r=$('workspace').getBoundingClientRect();setSplit((e.clientX-r.left)/r.width*100);});
  $('splitter').addEventListener('lostpointercapture',()=>delete $('splitter').dataset.dragging);
  $('splitter').addEventListener('dblclick',()=>setSplit(58));
  render();
})();
