'use strict';
// Pure demo state. No timers, network access, model calls, or repository mutations.
((root) => {
  const stages = ['queued', 'running', 'attention', 'review', 'accepted'];
  const models = ['sonnet', 'haiku', 'opus'];
  const clone = value => JSON.parse(JSON.stringify(value));
  function initial() {
    const state = {version:1, limit:2, paused:false, revision:8, sequence:105, teams:[
      {id:'quick', name:'Quick fix', description:'Small changes, one builder, one independent check.', builder:'sonnet', reviewer:'haiku', cap:3},
      {id:'careful', name:'Careful change', description:'Deeper implementation and review for riskier work.', builder:'sonnet', reviewer:'sonnet', cap:8},
    ], tasks:[]};
    const task = (id,title,repo,status,extra={}) => ({id,title,repo,status,team:clone(state.teams[0]),phase:'implement',spend:0,brief:title,log:['Assigned an isolated workspace.'],checks:[],integration:null,...extra});
    state.tasks = [
      task(101,'Handle expired invitation links','web-app','attention',{spend:.32,question:'Where should an expired invitation send the user?',brief:'Replace the blank page shown when someone follows an expired invitation link. Keep valid invitation behavior unchanged.',log:['Builder found two possible recovery paths.','Waiting for your decision before changing navigation.']}),
      task(102,'Keep table filters after refresh','web-app','review',{spend:.84,phase:'verify',checks:['Filter selection survives a page refresh','Clearing filters resets the URL','Existing table tests pass'],integration:7,brief:'Persist the table filters in the URL so refreshing or sharing the page preserves the view.',log:['Builder updated filter serialization.','Reviewer returned PASS for the task checks.'],diff:'--- a/src/table/filters.ts\n+++ b/src/table/filters.ts\n-const filters = defaults;\n+const filters = readFilters(location.search) ?? defaults;\n+syncFiltersToUrl(filters);'}),
      task(103,'Reject duplicate webhook events','service-api','running',{team:clone(state.teams[1]),spend:.65,brief:'Handle repeated delivery of the same event without applying the update twice.',log:['Builder isolated the event handler.','Adding an idempotency check.']}),
      task(104,'Improve empty search results','web-app','running',{phase:'verify',spend:.46,brief:'Explain when no results match and provide an action to clear the filters.',log:['Builder completed the empty state.','Reviewer is checking the clear-filters action.']}),
      task(105,'Document local database setup','service-api','queued',{brief:'Add reproducible local database setup instructions to the contributor guide.'}),
    ];
    return state;
  }
  function schedule(state) {
    if(state.paused) return;
    let available = state.limit-state.tasks.filter(t=>t.status==='running').length;
    for(const task of state.tasks) if(available>0 && task.status==='queued') {
      task.status='running';task.log.push('Dispatched to '+task.team.name+'.');available--;
    }
  }
  function advance(state) {
    // Snapshot active work so newly admitted tasks do not finish in the same step.
    for(const task of state.tasks.filter(t=>t.status==='running')) {
      if(task.spend+.18>task.team.cap) {task.status='attention';task.question='This task reached its demo budget. Increase the cap or leave it paused.';task.budgetBlocked=true;task.log.push('Paused at the task budget.');continue;}
      task.spend=Math.round((task.spend+.18)*100)/100;
      if(task.phase==='implement') {task.phase='verify';task.log.push('Implementation handed to the independent reviewer.');}
      else if(task.phase==='integration') {task.integration=state.revision;task.status='review';task.log.push('Integration check passed against main revision '+state.revision+'.');}
      else {task.status='review';task.checks=['Acceptance criteria checked by reviewer','Relevant regression checks passed'];task.integration=null;task.log.push('Reviewer returned PASS. Ready for your review.');}
    }
    schedule(state);
  }
  function resolve(state,id,answer) {
    const task=state.tasks.find(t=>t.id===id);
    if(!task || task.status!=='attention' || !answer.trim() || task.budgetBlocked) return false;
    task.log.push('Your decision: '+answer.trim());task.question=null;task.status='queued';schedule(state);return true;
  }
  function checkIntegration(state,id) {
    const task=state.tasks.find(t=>t.id===id);
    if(!task || task.status!=='review') return false;
    task.phase='integration';task.status='queued';task.integration=null;task.log.push('Queued integration check against current main.');schedule(state);return true;
  }
  function accept(state,id) {
    const task=state.tasks.find(t=>t.id===id);
    if(!task || task.status!=='review' || task.integration!==state.revision) return false;
    task.status='accepted';task.log.push('Accepted in the demo. No real merge was performed.');state.revision++;schedule(state);return true;
  }
  function repair(state,id,request) {
    const task=state.tasks.find(t=>t.id===id);
    if(!task || task.status!=='review' || !request.trim()) return false;
    task.log.push('Changes requested: '+request.trim());task.phase='implement';task.status='queued';task.checks=[];task.integration=null;schedule(state);return true;
  }
  function add(state,{title,repo,teamId,brief}) {
    const team=state.teams.find(t=>t.id===teamId);
    if(!title.trim() || !repo.trim() || !team) return null;
    const task={id:++state.sequence,title:title.trim(),repo:repo.trim(),team:clone(team),brief:brief.trim() || title.trim(),status:'queued',phase:'implement',spend:0,checks:[],integration:null,log:['Added to queue with '+team.name+'.']};
    state.tasks.push(task);schedule(state);return task;
  }
  function restore(raw) {
    try {
      const s=JSON.parse(raw);
      const teamOK=t=>t && typeof t.id==='string' && typeof t.name==='string' && typeof t.description==='string' && models.includes(t.builder) && models.includes(t.reviewer) && Number.isFinite(t.cap) && t.cap>=.1 && t.cap<=100;
      if(s.version!==1 || !Number.isInteger(s.limit) || s.limit<1 || s.limit>4 || typeof s.paused!=='boolean' || !Number.isInteger(s.revision) || !Number.isInteger(s.sequence) || !Array.isArray(s.teams) || s.teams.length!==2 || !s.teams.every(teamOK) || !Array.isArray(s.tasks) || s.tasks.length>100) return initial();
      if(!s.tasks.every(t=>Number.isInteger(t.id) && t.id<=s.sequence && ['title','repo','brief'].every(k=>typeof t[k]==='string') && teamOK(t.team) && stages.includes(t.status) && ['implement','verify','integration'].includes(t.phase) && Number.isFinite(t.spend) && t.spend>=0 && (t.integration===null || Number.isInteger(t.integration)) && [t.log,t.checks].every(a=>Array.isArray(a) && a.every(v=>typeof v==='string')))) return initial();
      if(new Set(s.tasks.map(t=>t.id)).size!==s.tasks.length) return initial();
      return s;
    } catch {return initial();}
  }
  const api={initial,schedule,advance,resolve,checkIntegration,accept,repair,add,restore};
  if(typeof module!=='undefined') module.exports=api;
  else root.FleetDemo=api;
})(globalThis);
