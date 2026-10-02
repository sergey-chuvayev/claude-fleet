'use strict'
// The Day board: what the operator should care about today, and what each item is
// waiting on them for.
//
// The board, not the agent's context, is the source of truth. A day runs for hours and
// its agent is compacted, restarted and swept by short runs that never see the main
// conversation, so everything worth keeping lives here and every run reads it back.
//
// An item never blocks the day. When the agent needs the operator it records a `need`
// on that item and moves on; answering it hands the item back.
const {randomUUID}=require('node:crypto')
const fail=message=>{throw new Error(message)}
const SOURCES=['slack','linear','granola','github','calendar','me']
const PRIORITIES=['must','should','could']
const STATUSES=['proposed','today','in_progress','waiting_on_you','done','later','dropped']
const MODES=['me','draft','agent','ask']
// launch: approve a brief that Fleet then starts as its own session (an agent or a team).
const NEED_KINDS=['approve','choose','info','launch']
// How the operator settled a question. A reply is a message about the item and never
// licenses sending anything; only approve and edit do.
const DECISIONS=['approve','reject','edit','reply','choose','info']
const MAX_ITEMS=200,MAX_NEEDS=20,MAX_LOG=50,MAX_LINKS=20
const dateOf=(at=Date.now())=>{const d=new Date(at);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function ledger(s) {return s.dayBoard ||= {date:dateOf(),items:[],cursors:{}}}
function itemFor(s,id) {const item=ledger(s).items.find(i=>i.id===id);if(!item)fail('Item not found. Read the Day board.');return item}
const str=(value,name,max,optional=false)=>{
  if (value===undefined && optional) return undefined
  if (typeof value!=='string' || !value.trim() || value.length>max) fail(`${name} must contain 1-${max} characters.`)
  return value.trim()
}
const oneOf=(value,list,name,optional=false)=>{
  if (value===undefined && optional) return undefined
  if (!list.includes(value)) fail(`${name} must be one of: ${list.join(', ')}.`)
  return value
}
// Two sources talking about the same thing share a link: a Slack thread pastes the PR,
// Linear attaches it. Comparing normalised URLs is what makes them one item, not three.
const normal=url=>String(url).trim().replace(/[?#].*$/,'').replace(/\/+$/,'').toLowerCase()
function links(value) {
  if (value===undefined) return []
  if (!Array.isArray(value) || value.length>MAX_LINKS || value.some(l=>typeof l!=='string' || !/^https?:\/\//.test(l) || l.length>2000)) fail(`Links must be up to ${MAX_LINKS} http(s) URLs.`)
  return [...new Set(value)]
}
const open=item=>item.needs.filter(n=>n.answer===undefined)
function log(item,text) {item.log.push({at:Date.now(),text:String(text).slice(0,2000)});if(item.log.length>MAX_LOG)item.log=item.log.slice(-MAX_LOG)}
// What a run reads on every call: enough to plan from, without the log of everything
// done so far, which only the inspector and `inspect` need.
const compact=(item,ctx={})=>({...(item.projectId ? {projectId:item.projectId} : {}),...(item.carriedFrom ? {carriedFrom:item.carriedFrom} : {}),...(item.launched?.length && ctx.launched ? {launched:item.launched.map(id=>ctx.launched(id))} : {}),...(item.thread?.summary ? {thread:item.thread.summary} : {}),id:item.id,title:item.title,source:item.source,priority:item.priority,status:item.status,mode:item.mode,estimateMin:item.estimateMin,links:item.links,needs:open(item).map(n=>({id:n.id,kind:n.kind,question:n.question})),answered:item.needs.filter(n=>n.answer!==undefined && !n.seen).map(n=>({id:n.id,question:n.question,decision:n.decision,answer:n.answer}))})
function add(s,input,by) {
  const board=ledger(s),urls=links(input.links)
  const twin=urls.length ? board.items.find(i=>i.links.some(l=>urls.some(u=>normal(u)===normal(l)))) : null
  if (twin) {
    twin.links=[...new Set([...twin.links,...urls])].slice(0,MAX_LINKS)
    if (input.context) twin.context=[twin.context,str(input.context,'Context',8000)].filter(Boolean).join('\n\n').slice(-8000)
    log(twin,`Merged from ${input.source || 'another source'}: ${String(input.title || '').slice(0,200)}`)
    return {merged:true,item:twin}
  }
  if (board.items.length>=MAX_ITEMS) fail(`The Day board has reached its ${MAX_ITEMS}-item limit.`)
  const item={id:randomUUID(),title:str(input.title,'Title',200),source:oneOf(input.source,SOURCES,'Source'),links:urls,context:str(input.context,'Context',8000,true) || '',
    priority:oneOf(input.priority ?? 'should',PRIORITIES,'Priority'),
    // The operator's own items are already decided; the agent's are proposals until triaged.
    status:by==='operator' ? 'today' : 'proposed',
    mode:oneOf(input.mode ?? 'me',MODES,'Mode'),estimateMin:minutes(input.estimateMin),...(input.projectId ? {projectId:str(input.projectId,'Project',100)} : {}),needs:[],log:[],createdAt:Date.now(),by}
  board.items.push(item);return {merged:false,item}
}
function minutes(value) {
  if (value===undefined || value===null) return null
  const n=Math.trunc(Number(value))
  if (!Number.isFinite(n) || n<1 || n>600) fail('Estimate must be 1-600 minutes.')
  return n
}
function update(s,input,by) {
  const item=itemFor(s,input.itemId),status=oneOf(input.status,STATUSES,'Status',true)
  if (status==='waiting_on_you' && !open(item).length) fail('Record what you need with ask; an item waits on the operator only for an open question.')
  if (status==='done' && open(item).some(n=>['approve','launch'].includes(n.kind))) fail('This item has an unanswered approval. It cannot be done before the operator decides.')
  // Triage is the operator's call: the agent proposes, it never promotes its own items.
  if (by==='agent' && item.status==='proposed' && status && !['proposed','dropped'].includes(status)) fail('Proposed items are triaged by the operator. Use ask if you need a decision.')
  if (input.title!==undefined) item.title=str(input.title,'Title',200)
  if (input.context!==undefined) item.context=String(input.context).slice(0,8000)
  if (input.priority!==undefined) item.priority=oneOf(input.priority,PRIORITIES,'Priority')
  if (input.mode!==undefined) item.mode=oneOf(input.mode,MODES,'Mode')
  if (input.estimateMin!==undefined) item.estimateMin=minutes(input.estimateMin)
  if (input.projectId!==undefined) item.projectId=input.projectId ? str(input.projectId,'Project',100) : undefined
  if (input.links!==undefined) item.links=[...new Set([...item.links,...links(input.links)])].slice(0,MAX_LINKS)
  if (status) item.status=status
  if (input.note) log(item,input.note)
  return item
}
function ask(s,input,ctx={}) {
  const item=itemFor(s,input.itemId),kind=oneOf(input.kind,NEED_KINDS,'Kind')
  if (open(item).length>=MAX_NEEDS) fail('This item already has too many open questions. Wait for answers.')
  const options=input.options===undefined ? undefined : input.options
  if (kind==='choose' && (!Array.isArray(options) || options.length<2 || options.length>6 || options.some(o=>typeof o!=='string' || !o.trim() || o.length>200))) fail('A choice needs 2-6 options.')
  // An approval is only meaningful if the operator sees exactly what will go out.
  if (kind==='approve' && typeof input.draft!=='string') fail('An approval needs the exact draft that will be sent or applied.')
  let launch
  if (kind==='launch') {
    if (typeof input.draft!=='string' || !input.draft.trim()) fail('A launch needs the brief the new session starts from, in draft.')
    const cwd=str(input.cwd,'Repository path (cwd)',4096)
    if (!cwd.startsWith('/') && cwd!=='~' && !cwd.startsWith('~/')) fail('Give the repository as an absolute path or ~/path.')
    const teamId=input.teamId ? str(input.teamId,'Team',60) : null
    if (teamId && ctx.teams && !ctx.teams().some(t=>t.id===teamId)) fail('Unknown team. Use the teams action to list them, or omit teamId for a single agent.')
    launch={cwd,teamId,...(input.name ? {name:str(input.name,'Name',100)} : {})}
  }
  const need={id:randomUUID(),kind,question:str(input.question,'Question',1000),...(kind==='choose' ? {options} : {}),...(input.draft!==undefined ? {draft:String(input.draft).slice(0,16000)} : {}),...(launch ? {launch} : {}),at:Date.now()}
  item.needs.push(need);item.status='waiting_on_you'
  return need
}
// The operator's side. `value` is the chosen option, the info asked for, an approval's
// 'approve' or 'reject' or edited draft, or, with decision 'reply', a message about the
// item for any kind of question: "not yet, ask Thomas first".
function answer(s,itemId,needId,value,decision) {
  const item=itemFor(s,itemId),need=item.needs.find(n=>n.id===needId)
  if (!need) fail('Question not found.')
  if (need.answer!==undefined) fail('This question is already answered.')
  const text=str(value,'Answer',16000)
  if (decision!==undefined) oneOf(decision,DECISIONS,'Decision')
  const settled=decision==='reply' ? 'reply'
    : ['approve','launch'].includes(need.kind) ? (text==='approve' ? 'approve' : text==='reject' ? 'reject' : 'edit')
    : need.kind
  if (settled==='choose' && !need.options.includes(text)) fail('Choose one of the offered options, or reply instead.')
  need.answer=text;need.decision=settled;need.answeredAt=Date.now()
  if (settled==='reply') log(item,`You: ${text}`)
  if (!open(item).length && item.status==='waiting_on_you') item.status='in_progress'
  return {item,need}
}
// The operator's triage of proposed items, in one call from the UI.
function triage(s,itemId,{status,priority,mode,projectId}={}) {
  const item=itemFor(s,itemId)
  if (projectId!==undefined) item.projectId=projectId ? str(projectId,'Project',100) : undefined
  if (status!==undefined) {
    oneOf(status,['today','later','dropped','proposed','done'],'Triage')
    // Done by hand still respects an approval the agent is waiting on: closing the item
    // would leave a draft approved for nothing, or a question nobody will read.
    if (status==='done' && open(item).length) fail('Answer the open questions on this item first.')
    item.status=status
  }
  if (priority!==undefined) item.priority=oneOf(priority,PRIORITIES,'Priority')
  if (mode!==undefined) item.mode=oneOf(mode,MODES,'Mode')
  return item
}
// Per-source "last seen" points, so a sweep fetches what changed instead of the day again.
function cursor(s,input) {
  const board=ledger(s),source=oneOf(input.source,SOURCES.filter(x=>x!=='me'),'Source')
  if (input.value!==undefined) board.cursors[source]=str(input.value,'Cursor',200)
  return {source,value:board.cursors[source] ?? null}
}
// ctx lets the server answer what the board alone cannot: the state of sessions an item
// launched, and which teams exist.
function act(s,input,by='agent',ctx={}) {
  const board=ledger(s)
  if (input.action==='list') {
    // Answers are delivered once: the next list after an answer carries it, then it is
    // marked seen so the agent does not act on the same approval twice.
    const items=board.items.filter(i=>input.includeClosed || !['done','dropped'].includes(i.status)).map(i=>compact(i,ctx))
    if (by==='agent') for (const i of board.items) for (const n of i.needs) if (n.answer!==undefined) n.seen=true
    return {date:board.date,cursors:board.cursors,items,closed:board.items.filter(i=>['done','dropped'].includes(i.status)).length}
  }
  if (input.action==='inspect') {const item=itemFor(s,input.itemId);return item}
  if ((input.action==='add' || input.action==='update') && input.projectId && ctx.projects && !ctx.projects().some(p=>p.id===input.projectId)) fail('Unknown project. Use the projects action to list them.')
  if (input.action==='add') return add(s,input,by)
  if (input.action==='update') return update(s,input,by)
  if (input.action==='ask') return ask(s,input,ctx)
  if (input.action==='teams') return ctx.teams ? ctx.teams() : []
  if (input.action==='projects') return ctx.projects ? ctx.projects() : []
  // What the Day is working on itself right now, so the board can say so. Cleared when
  // the run ends; subagents are linked to their item separately, by their prompt.
  if (input.action==='focus') {
    const item=itemFor(s,input.itemId)
    board.focus={itemId:item.id,at:Date.now()}
    if (item.status==='today') item.status='in_progress'
    return board.focus
  }
  // Focus time left today, from the calendar scout, so the board can weigh the plan
  // against the hours there actually are.
  if (input.action==='capacity') {
    const n=Math.trunc(Number(input.freeMinutes))
    if (!Number.isFinite(n) || n<0 || n>960) fail('freeMinutes must be 0-960.')
    board.capacity={freeMinutes:n,at:Date.now()}
    return board.capacity
  }
  if (input.action==='cursor') return cursor(s,input)
  fail('Unknown Day board action.')
}
// Everything waiting on the operator, oldest first, for the strip at the top of Today.
function waiting(s) {
  if (!s.dayBoard) return []
  return s.dayBoard.items.flatMap(item=>open(item).map(n=>({itemId:item.id,title:item.title,priority:item.priority,...n}))).sort((a,b)=>a.at-b.at)
}
function progress(s) {
  if (!s.dayBoard) return null
  const items=s.dayBoard.items.filter(i=>!['dropped'].includes(i.status))
  return {total:items.filter(i=>i.status!=='proposed').length,done:items.filter(i=>i.status==='done').length,proposed:items.filter(i=>i.status==='proposed').length,waiting:waiting(s).length}
}
// A new day keeps what was unfinished and forgets what was settled. Open questions carry
// over with their item: the operator still owes them an answer.
// Proposals carry too: the scouts' cursors have moved past them, so an untriaged item
// left behind would never be found again. An item keeps the date it was first carried
// from, so "from Tue" stays true on Thursday.
// A thread belongs to the Day it was opened in. The new board keeps only the gist of it,
// as previousThread, and the next question starts a fresh thread on today's board.
function carryOver(previous,date=dateOf()) {
  const items=(previous?.items || []).filter(i=>['proposed','today','in_progress','waiting_on_you','later'].includes(i.status)).map(i=>{
    const {thread,...rest}=structuredClone(i)
    const status=['proposed','later','waiting_on_you'].includes(i.status) ? i.status : 'today'
    return {...rest,status,carriedFrom:i.carriedFrom || previous.date,...(thread?.summary ? {previousThread:{summary:thread.summary,at:thread.at,sessionId:thread.sessionId}} : {})}
  })
  return {date,items,cursors:{...(previous?.cursors || {})}}
}
// A connector call that only reads. Everything else a Day agent does through a connector
// reaches other people (a Slack message, a Linear status, a PR comment) and is outward.
const READS=/^(get|list|search|read|query|fetch|extract)_|^slack_(search|read|get|list)_|^slack_send_message_draft$|^(issue|pull_request)_read$/
function outward(tool) {
  const match=/^mcp__(.+?)__(.+)$/.exec(tool)
  if (!match) return false
  if (match[1]==='fleet') return false
  return !READS.test(match[2])
}
// An outward call goes ahead on its own only when the operator already approved this
// exact content on the board. Matching on the draft text, not on "some approval exists",
// is what stops one approved reply from licensing a different message. Each approval is
// spent once.
function approvedFor(s,input) {
  const payload=JSON.stringify(input || {})
  for (const item of s.dayBoard?.items || []) for (const n of item.needs) {
    if (n.kind!=='approve' || n.spent || n.answer===undefined || n.answer==='reject') continue
    // Only an approval or the operator's own edit licenses a send; a reply or a question
    // the agent withdrew never does, whatever its text.
    if (n.decision!==undefined && !['approve','edit'].includes(n.decision)) continue
    const text=n.answer==='approve' ? n.draft : n.answer
    if (text && text.trim().length>=8 && payload.includes(JSON.stringify(text.trim()).slice(1,-1))) {n.spent=Date.now();return {item,need:n}}
  }
  return null
}
// A thread is a conversation about one item. Its tool reaches that item and nothing
// else: it can read it, log what it found, ask the operator, or take back a question of
// its own that the conversation made moot. Status and triage stay with the operator and
// the Day.
const THREAD_ACTIONS=['inspect','note','ask','withdraw']
function threadAct(s,itemId,input) {
  if (!THREAD_ACTIONS.includes(input.action)) fail(`A thread can only ${THREAD_ACTIONS.join(', ')} its own item.`)
  const item=itemFor(s,itemId)
  if (input.action==='inspect') return item
  if (input.action==='note') {
    if (input.links!==undefined) item.links=[...new Set([...item.links,...links(input.links)])].slice(0,MAX_LINKS)
    log(item,`Thread: ${str(input.note,'Note',2000)}`)
    return item
  }
  if (input.action==='withdraw') {
    const need=item.needs.find(n=>n.id===input.needId)
    if (!need || need.answer!==undefined) fail('No open question with that id on this item.')
    need.answer='withdrawn';need.decision='withdrawn';need.answeredAt=Date.now();need.seen=true
    if (!open(item).length && item.status==='waiting_on_you') item.status='in_progress'
    log(item,`Thread withdrew: ${need.question.slice(0,200)}`)
    return {withdrawn:need.id}
  }
  return ask(s,{...input,itemId})
}
async function threadServer(s,itemId,changed) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('item','The Day board item this conversation is about, and only that item. inspect: its full card, log and questions. note: log a short finding (and optionally add links). ask: put a question to the operator on this item (approve needs the exact draft; choose needs options); anything that reaches other people goes out only after they approve that exact text. withdraw: take back one of this item\'s open questions by needId when the conversation made it moot.',{
    action:z.enum(THREAD_ACTIONS),note:z.string().optional(),links:z.array(z.string()).optional(),kind:z.enum(NEED_KINDS.filter(k=>k!=='launch')).optional(),question:z.string().optional(),options:z.array(z.string()).optional(),draft:z.string().optional(),needId:z.string().optional(),
  },async input=>{
    const before=structuredClone(s.dayBoard)
    try {const result=threadAct(s,itemId,input);changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){s.dayBoard=before;return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
async function sdkServer(s,changed,ctx={}) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('day','The operator\'s Day board. list: compact open items, their open questions and any new answers (read this first, every run). inspect: one item with its full context and log. add: a new item (deduplicated by link). update: change status/priority/mode/estimate, append links, or log a note of what you did. ask: record a question the operator must answer on an item (approve needs the exact draft; choose needs options; launch needs the brief in draft plus cwd and optional teamId, and Fleet starts that session itself once approved), then move on to other items. teams: the teams a launch can use. capacity: record freeMinutes of focus time left today, from the calendar. focus: say which item you are working on yourself now (call it before you start on an item). projects: the operator\'s projects; tag items that clearly belong to one with projectId on add or update. cursor: get or set the last-seen point for a source.',{
    action:z.enum(['list','inspect','add','update','ask','cursor','teams','capacity','focus','projects']),projectId:z.string().optional(),freeMinutes:z.number().optional(),cwd:z.string().optional(),teamId:z.string().optional(),name:z.string().optional(),itemId:z.string().optional(),title:z.string().optional(),source:z.enum(SOURCES).optional(),links:z.array(z.string()).optional(),context:z.string().optional(),
    priority:z.enum(PRIORITIES).optional(),status:z.enum(STATUSES).optional(),mode:z.enum(MODES).optional(),estimateMin:z.number().optional(),note:z.string().optional(),
    kind:z.enum(NEED_KINDS).optional(),question:z.string().optional(),options:z.array(z.string()).optional(),draft:z.string().optional(),value:z.string().optional(),includeClosed:z.boolean().optional(),
  },async input=>{
    const before=structuredClone(s.dayBoard)
    try {const result=act(s,input,'agent',ctx);changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){s.dayBoard=before;return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
module.exports={threadAct,threadServer,itemFor,SOURCES,PRIORITIES,STATUSES,MODES,dateOf,ledger,act,answer,triage,waiting,progress,carryOver,outward,approvedFor,sdkServer}
