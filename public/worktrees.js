'use strict'
// The Worktrees tab: every checkout a session has worked in, with its branch, whether that
// branch is merged, whether a pull request is open, and whether anything in it exists only
// there. Merged and clean ones can be cleared. Like Progress it is a page to read, full width.
//
// The page only decides what to show. Whether a worktree may go is decided again by the
// server, from git, when the operator confirms.
window.FleetWorktrees=(()=>{
  const {$,esc,store,toast,openModal,closeModal}=window.Fleet
  const UI=window.FleetUI
  const escape=value=>esc(String(value ?? ''))
  const api=(...args)=>window.FleetControl.api(...args)
  const FILTERS={all:'All checkouts',clearable:'Safe to clear',merged:'Merged',pr:'Open pull request',care:'Uncommitted or unpushed'}
  const MATCH={all:()=>true,clearable:c=>c.clearable,merged:c=>c.merged,pr:c=>c.pr?.state==='OPEN',care:c=>c.dirty>0 || c.unpushed>0}
  const FILTER_KEY='fleet:worktrees-filter'
  const MODAL='worktree-clear-backdrop'
  let data=null,fetchedAt=0,loading=null,failed=false,stale=false,pending=null,busy=false
  let filter=FILTERS[store.get(FILTER_KEY)] ? store.get(FILTER_KEY) : 'all'
  const opened=new Set()
  const pane=()=>document.getElementById('worktrees-pane')
  const active=()=>window.FleetViews?.view()==='worktrees' && !!pane()
  const plural=(n,word)=>`${n} ${word}${n===1 ? '' : 's'}`
  const link=url=>/^https:\/\//.test(url || '') ? url : null

  function prPill(c) {
    if(!c.pr)return ''
    const href=link(c.pr.url),label=`PR #${c.pr.number}${c.pr.state==='OPEN' ? ' open' : c.pr.state==='MERGED' ? ' merged' : ' closed'}`
    const inner=href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : escape(label)
    return UI.pill(inner,c.pr.state==='OPEN' ? 'working' : 'outline')
  }
  function pills(c) {
    const out=[]
    if(c.isMain)out.push(UI.pill('Main checkout','outline'))
    else if(c.merged)out.push(UI.pill('Merged','done'))
    else if(c.empty)out.push(UI.pill('No commits yet','idle'))
    else if(c.trunk && c.branch)out.push(UI.pill(`Not merged into ${escape(c.trunk)}`,'idle'))
    out.push(prPill(c))
    if(c.dirty>0)out.push(UI.pill(`${c.dirty} uncommitted`,'needs'))
    if(c.unpushed>0)out.push(UI.pill(`${c.unpushed} unpushed`,'needs'))
    if(c.running)out.push(UI.pill('Session running','working'))
    if(c.locked)out.push(UI.pill('Locked','outline'))
    return out.filter(Boolean).join('')
  }
  const toneOf=c=>c.running ? 'working' : c.clearable ? 'done' : c.dirty>0 || c.unpushed>0 ? 'needs' : c.pr?.state==='OPEN' ? 'progress' : c.isMain ? 'idle' : 'queued'

  function detailHtml(c) {
    const why=c.clearable
      ? '<p class="note">Merged, nothing uncommitted, nothing unpushed. Safe to remove.</p>'
      : `<p class="note">Kept because:</p><ul class="worktree-why">${c.blockers.map(b=>`<li>${escape(b.text)}</li>`).join('')}</ul>`
    const sessions=c.sessions.map(s=>`<li><strong>${escape(s.name || 'Untitled session')}</strong> <span class="note">${escape(s.engine==='codex' ? 'Codex' : 'Claude')}${s.alive ? ' · running' : ''} · <code>${escape(s.cwd)}</code></span></li>`).join('')
    return `<div class="worktree-detail">${why}<p class="note">Worktree <code>${escape(c.pathShort)}</code>${c.tip ? ` at <code>${escape(c.tip.slice(0,7))}</code>` : ''}</p><h5 class="ui-label">${escape(plural(c.sessions.length,'session'))}</h5><ul class="worktree-sessions">${sessions}</ul></div>`
  }
  function rowHtml(c) {
    const title=c.branch ? escape(c.branch) : 'Detached HEAD'
    const side=c.clearable ? `<button type="button" class="button ghost" data-clear-worktree="${escape(c.path)}" aria-label="Clear ${escape(c.branch)}">Clear…</button>` : ''
    return UI.row({tone:toneOf(c),orbTitle:c.clearable ? 'Safe to clear' : 'Keep',title,
      meta:`${pills(c)}<span class="ui-row-latest" title="${escape(c.path)}">${escape(c.repo.name)} · ${escape(c.pathShort)}</span>`,
      side,detail:detailHtml(c),open:opened.has(c.path),key:c.path})
  }
  function listHtml(shown) {
    if(!data.checkouts.length)return UI.empty({title:'No worktrees yet.',text:'Sessions that ran inside a git checkout show up here, with the branch they worked on.'})
    if(!shown.length)return UI.empty({title:'Nothing matches.',text:`No checkout is under “${escape(FILTERS[filter])}”.`})
    return UI.list(shown.map(rowHtml).join(''))
  }
  function draw() {
    const el=pane();if(!el)return
    // A redraw would pull the open dropdown out from under the cursor; the change event draws.
    if(window.FleetSelect?.isOpen(el)){stale=true;return}
    stale=false
    const options=Object.entries(FILTERS).map(([value,label])=>`<option value="${value}"${value===filter ? ' selected' : ''}>${escape(label)}</option>`).join('')
    const controls=`<select id="worktree-filter" aria-label="Show">${options}</select><button type="button" class="button ghost" data-refresh-worktrees title="Read the checkouts again"><i class="ico ico-refresh" aria-hidden="true"></i> Refresh</button>`
    if(!data){
      el.innerHTML=`${UI.pageHead({title:'Worktrees',actions:controls})}<div class="page-body">${failed ? UI.callout('Could not load worktrees','Try again in a moment.',{tone:'hot'}) : '<p class="note">Reading your checkouts…</p>'}</div>`
      return
    }
    const all=data.checkouts,shown=all.filter(MATCH[filter])
    const count=test=>all.filter(test).length
    const care=count(MATCH.care)
    const strip=[UI.stat('Checkouts',String(all.length)),UI.stat('Safe to clear',String(count(MATCH.clearable)),{tone:count(MATCH.clearable) ? undefined : 'quiet'}),UI.stat('Open PR',String(count(MATCH.pr))),UI.stat('Needs care',String(care),{tone:care ? 'warn' : 'quiet',title:'Uncommitted changes or commits that exist nowhere else'})].join('')
    const outside=data.outside ? `<p class="note">${escape(plural(data.outside,'session'))} ran outside a git checkout, or in a folder that is gone, and ${data.outside===1 ? 'is' : 'are'} not listed.</p>` : ''
    el.innerHTML=`${UI.pageHead({title:'Worktrees',actions:controls,strip})}
      <div class="page-body">
        ${UI.section('Checkouts',listHtml(shown),{count:shown.length,aside:'<span class="note">Merged is measured against the trunk as last fetched; pull requests come from <code>gh</code> when it is signed in</span>'})}
        ${outside}
      </div>`
  }
  function load(force=false) {
    if(loading || (!force && Date.now()-fetchedAt<15000))return loading
    loading=api('/api/worktrees').then(result=>{data=result;failed=false;fetchedAt=Date.now();draw()}).catch(()=>{failed=true;fetchedAt=Date.now();if(!data)draw()}).finally(()=>{loading=null})
    return loading
  }
  function render() {
    if(!pane() || !active())return
    // The first visit draws at once; the data follows.
    if(!pane().innerHTML || stale)draw()
    load()
  }

  // What the confirmation says: everything that will go, and what is deliberately left.
  function planHtml(c) {
    const trunk=escape(c.trunk || 'the trunk')
    const why=c.mergedBy==='pr' ? `pull request #${escape(c.pr?.number)} merged at this commit, so the work is on GitHub` : `every commit is already in ${trunk}`
    const tip=escape(c.tip.slice(0,7))
    return `<p class="worktree-lead">Fleet checked just now: <strong>${escape(c.branch)}</strong> is merged, has nothing uncommitted and nothing unpushed. It checks again when you confirm, and git refuses if anything has changed.</p>
      <h4 class="ui-label">Will be removed</h4>
      <ul class="worktree-plan">
        <li><strong>The folder</strong><code>${escape(c.path)}</code><small>Clean: no uncommitted or untracked files.</small></li>
        <li><strong>The local branch</strong><span><code>${escape(c.branch)}</code> at <code>${tip}</code></span><small>Kept in history because ${why}. To get it back: <code>git branch ${escape(c.branch)} ${tip}</code></small></li>
      </ul>
      <h4 class="ui-label">Left alone</h4>
      <ul class="worktree-plan">
        <li><strong>The main checkout</strong><code>${escape(c.repo.root)}</code></li>
        <li><strong>The remote branch and its pull request</strong></li>
        <li><strong>Every other worktree and branch</strong></li>
        <li><strong>${escape(plural(c.sessions.length,'session'))} that used this folder</strong><small>Their transcripts stay readable. Resuming one needs the folder back.</small></li>
      </ul>`
  }
  function mount() {
    const tabs=document.querySelector('.work-tabs'),sessions=document.getElementById('sessions-pane')
    if(!tabs || !sessions || document.getElementById('view-worktrees'))return
    // Last in the row: after Progress when it is there, otherwise after Sessions.
    const button='<button type="button" class="button" id="view-worktrees" aria-pressed="false" title="Every session\'s branch and worktree, and which ones can be cleared">Worktrees</button>'
    const after=document.getElementById('view-progress') || document.getElementById('view-sessions')
    if(after)after.insertAdjacentHTML('afterend',button);else tabs.insertAdjacentHTML('beforeend',button)
    const anchor=document.getElementById('progress-pane') || sessions
    anchor.insertAdjacentHTML('afterend','<section class="sessions-pane today-pane worktrees-pane" id="worktrees-pane" aria-label="Worktrees" hidden></section>')
    const el=pane()
    el.addEventListener('click',event=>{
      if(event.target.closest('[data-refresh-worktrees]'))return load(true)
      const clear=event.target.closest('[data-clear-worktree]')
      if(clear){
        // The button sits inside the row's summary; it must not also open the row.
        event.preventDefault()
        const c=data?.checkouts.find(x=>x.path===clear.dataset.clearWorktree)
        if(c)confirm(c)
      }
    })
    el.addEventListener('change',event=>{
      if(event.target.id!=='worktree-filter')return
      filter=FILTERS[event.target.value] ? event.target.value : 'all'
      store.set(FILTER_KEY,filter)
      draw()
    })
    // Open rows stay open across a redraw. `toggle` does not bubble, so listen on capture.
    el.addEventListener('toggle',event=>{
      const key=event.target.dataset?.evidence
      if(key)event.target.open ? opened.add(key) : opened.delete(key)
    },true)

    const backdrop=document.createElement('div')
    backdrop.id=MODAL;backdrop.className='modal-backdrop';backdrop.hidden=true
    backdrop.innerHTML=`<section class="modal modal-worktree" role="dialog" aria-modal="true" aria-labelledby="worktree-title">
      <header class="modal-head"><div class="modal-heading"><span class="modal-spark" aria-hidden="true">⑂</span><div><span class="modal-eyebrow">CLEAR A WORKTREE</span><h2 id="worktree-title">Remove this worktree?</h2></div></div><button type="button" class="modal-close" data-close-modal aria-label="Close"><i class="ico ico-close" aria-hidden="true"></i></button></header>
      <div class="modal-body"><div id="worktree-plan"></div><p id="worktree-error" class="form-error" role="alert" hidden></p>
      <div class="worktree-actions"><button type="button" class="button" data-close-modal data-worktree-cancel>Cancel</button><button type="button" class="button resume" id="worktree-go">Remove worktree</button></div></div>
      <footer class="modal-foot"><span>Nothing is removed until you confirm.</span><span><kbd>Esc</kbd> close</span></footer></section>`
    document.body.append(backdrop)
    $('worktree-go').addEventListener('click',remove)
  }
  function confirm(c) {
    pending=c
    $('worktree-plan').innerHTML=planHtml(c)
    $('worktree-error').hidden=true
    $('worktree-go').disabled=false
    openModal(MODAL,'[data-worktree-cancel]')
  }
  async function remove() {
    if(!pending || busy)return
    busy=true
    const go=$('worktree-go'),error=$('worktree-error')
    go.disabled=true;go.textContent='Removing…';error.hidden=true
    try{
      const {cleared}=await api('/api/worktrees/clear',{path:pending.path})
      opened.delete(pending.path);pending=null
      closeModal()
      toast(cleared.branchDeleted ? 'Worktree and branch removed' : 'Worktree removed. The branch could not be deleted and is still there.')
    }catch(e){
      // Refused: say why, and let the list catch up with whatever changed.
      error.textContent=e.message;error.hidden=false
    }finally{
      busy=false;go.disabled=false;go.textContent='Remove worktree'
    }
    await load(true)
  }
  // Mounted before views.js runs, which owns switching between the views.
  mount()
  return {render,active}
})()
