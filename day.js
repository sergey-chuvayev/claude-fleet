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
const NEED_KINDS=['approve','choose','info']
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
const compact=item=>({id:item.id,title:item.title,source:item.source,priority:item.priority,status:item.status,mode:item.mode,estimateMin:item.estimateMin,links:item.links,needs:open(item).map(n=>({id:n.id,kind:n.kind,question:n.question})),answered:item.needs.filter(n=>n.answer!==undefined && !n.seen).map(n=>({id:n.id,question:n.question,answer:n.answer}))})
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
    mode:oneOf(input.mode ?? 'me',MODES,'Mode'),estimateMin:minutes(input.estimateMin),needs:[],log:[],createdAt:Date.now(),by}
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
  if (status==='done' && open(item).some(n=>n.kind==='approve')) fail('This item has an unanswered approval. It cannot be done before the operator decides.')
  // Triage is the operator's call: the agent proposes, it never promotes its own items.
  if (by==='agent' && item.status==='proposed' && status && !['proposed','dropped'].includes(status)) fail('Proposed items are triaged by the operator. Use ask if you need a decision.')
  if (input.title!==undefined) item.title=str(input.title,'Title',200)
  if (input.context!==undefined) item.context=String(input.context).slice(0,8000)
  if (input.priority!==undefined) item.priority=oneOf(input.priority,PRIORITIES,'Priority')
  if (input.mode!==undefined) item.mode=oneOf(input.mode,MODES,'Mode')
  if (input.estimateMin!==undefined) item.estimateMin=minutes(input.estimateMin)
  if (input.links!==undefined) item.links=[...new Set([...item.links,...links(input.links)])].slice(0,MAX_LINKS)
  if (status) item.status=status
  if (input.note) log(item,input.note)
  return item
}
function ask(s,input) {
  const item=itemFor(s,input.itemId),kind=oneOf(input.kind,NEED_KINDS,'Kind')
  if (open(item).length>=MAX_NEEDS) fail('This item already has too many open questions. Wait for answers.')
  const options=input.options===undefined ? undefined : input.options
  if (kind==='choose' && (!Array.isArray(options) || options.length<2 || options.length>6 || options.some(o=>typeof o!=='string' || !o.trim() || o.length>200))) fail('A choice needs 2-6 options.')
  // An approval is only meaningful if the operator sees exactly what will go out.
  if (kind==='approve' && typeof input.draft!=='string') fail('An approval needs the exact draft that will be sent or applied.')
  const need={id:randomUUID(),kind,question:str(input.question,'Question',1000),...(kind==='choose' ? {options} : {}),...(input.draft!==undefined ? {draft:String(input.draft).slice(0,16000)} : {}),at:Date.now()}
  item.needs.push(need);item.status='waiting_on_you'
  return need
}
// The operator's side. `answer` is a string: the chosen option, the info asked for, or
// for an approval 'approve', 'reject', or an edited draft to send instead.
function answer(s,itemId,needId,value) {
  const item=itemFor(s,itemId),need=item.needs.find(n=>n.id===needId)
  if (!need) fail('Question not found.')
  if (need.answer!==undefined) fail('This question is already answered.')
  const text=str(value,'Answer',16000)
  if (need.kind==='choose' && !need.options.includes(text)) fail('Choose one of the offered options.')
  need.answer=text;need.answeredAt=Date.now()
  if (!open(item).length && item.status==='waiting_on_you') item.status='in_progress'
  return {item,need}
}
// The operator's triage of proposed items, in one call from the UI.
function triage(s,itemId,{status,priority,mode}={}) {
  const item=itemFor(s,itemId)
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
function act(s,input,by='agent') {
  const board=ledger(s)
  if (input.action==='list') {
    // Answers are delivered once: the next list after an answer carries it, then it is
    // marked seen so the agent does not act on the same approval twice.
    const items=board.items.filter(i=>input.includeClosed || !['done','dropped'].includes(i.status)).map(compact)
    if (by==='agent') for (const i of board.items) for (const n of i.needs) if (n.answer!==undefined) n.seen=true
    return {date:board.date,cursors:board.cursors,items,closed:board.items.filter(i=>['done','dropped'].includes(i.status)).length}
  }
  if (input.action==='inspect') {const item=itemFor(s,input.itemId);return item}
  if (input.action==='add') return add(s,input,by)
  if (input.action==='update') return update(s,input,by)
  if (input.action==='ask') return ask(s,input)
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
function carryOver(previous,date=dateOf()) {
  const items=(previous?.items || []).filter(i=>['today','in_progress','waiting_on_you','later'].includes(i.status)).map(i=>({...structuredClone(i),status:i.status==='later' ? 'later' : i.status==='waiting_on_you' ? 'waiting_on_you' : 'today',carriedFrom:previous.date}))
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
    const text=n.answer==='approve' ? n.draft : n.answer
    if (text && text.trim().length>=8 && payload.includes(JSON.stringify(text.trim()).slice(1,-1))) {n.spent=Date.now();return {item,need:n}}
  }
  return null
}
async function sdkServer(s,changed) {
  const {createSdkMcpServer,tool}=await import('@anthropic-ai/claude-agent-sdk')
  const {z}=require('zod/v4')
  return createSdkMcpServer({name:'fleet',version:'1.0.0',tools:[tool('day','The operator\'s Day board. list: compact open items, their open questions and any new answers (read this first, every run). inspect: one item with its full context and log. add: a new item (deduplicated by link). update: change status/priority/mode/estimate, append links, or log a note of what you did. ask: record a question the operator must answer on an item (approve needs the exact draft; choose needs options), then move on to other items. cursor: get or set the last-seen point for a source.',{
    action:z.enum(['list','inspect','add','update','ask','cursor']),itemId:z.string().optional(),title:z.string().optional(),source:z.enum(SOURCES).optional(),links:z.array(z.string()).optional(),context:z.string().optional(),
    priority:z.enum(PRIORITIES).optional(),status:z.enum(STATUSES).optional(),mode:z.enum(MODES).optional(),estimateMin:z.number().optional(),note:z.string().optional(),
    kind:z.enum(NEED_KINDS).optional(),question:z.string().optional(),options:z.array(z.string()).optional(),draft:z.string().optional(),value:z.string().optional(),includeClosed:z.boolean().optional(),
  },async input=>{
    const before=structuredClone(s.dayBoard)
    try {const result=act(s,input,'agent');changed();return {content:[{type:'text',text:JSON.stringify(result)}]}}
    catch(error){s.dayBoard=before;return {isError:true,content:[{type:'text',text:error.message}]}}
  })]})
}
module.exports={SOURCES,PRIORITIES,STATUSES,MODES,dateOf,ledger,act,answer,triage,waiting,progress,carryOver,outward,approvedFor,sdkServer}
