'use strict'
// Which view the workspace shows: Today, Projects or Sessions, and the one place that
// switches between them. Today's and Projects' panes and tabs are mounted by day.js and
// projects.js before this runs; a view whose pane is missing falls back to Sessions, and
// so does a view that no longer exists (the Work queue, remembered from an older Fleet).
window.FleetViews=(()=>{
  const VIEWS=['today','projects','sessions']
  const LABEL={today:'Today',projects:'Projects',sessions:'Sessions'}
  const {$,store}=window.Fleet
  const saved=store.get('fleet:view')
  let mode=VIEWS.includes(saved) ? saved : 'sessions'
  const pane=view=>view==='sessions' ? $('sessions-pane') : $(`${view}-pane`)
  function switchView(next) {
    if (!VIEWS.includes(next) || !pane(next)) next='sessions'
    mode=next
    store.set('fleet:view',mode)
    for (const view of VIEWS) {
      const el=pane(view)
      if (el) el.hidden=view!==mode
      $(`view-${view}`)?.setAttribute('aria-pressed',String(view===mode))
    }
    const workspace=document.querySelector('.workspace')
    if (workspace) { workspace.dataset.view=mode; workspace.setAttribute('aria-label',LABEL[mode]) }
    // Each view keeps its own divider position.
    window.Fleet.syncSplit?.()
    window.Fleet.render()
  }
  for (const view of VIEWS) $(`view-${view}`)?.addEventListener('click',()=>switchView(view))
  if ($('sessions-pane')) switchView(mode)
  return {view:()=>mode,switchView}
})()
