'use strict'
// The weekly look: what shipped, what stalled, what ran. Read from what Fleet already
// keeps (Day boards, managed sessions, the links on Day items); nothing is fetched.
//
// Two honest limits. Fleet never asks GitHub whether a PR merged, so "shipped" means the
// operator or the Day marked the item done, with the PRs linked on it shown alongside.
// And an item has no completion time, so a done item counts on the date of the Day it
// was closed on.
const {dateOf}=require('./day')
const DAY=86400000
const WINDOW_DAYS=7,STALE_DAYS=3,MAX_ROWS=50
const OPEN=['proposed','today','in_progress','waiting_on_you']
// A session Fleet is still driving but that has not moved. Idle and stopped sessions are
// at rest, not stalled.
const IN_FLIGHT=['starting','running','approval','stopping','queued']
const PR=/^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i
const prs=item=>[...new Set((item.links || []).map(l=>(PR.exec(l) || [])[0]).filter(Boolean))]
// The last time anything happened on an item: a note, a question, an answer.
const lastMoved=item=>Math.max(item.createdAt || 0,...(item.log || []).map(l=>l.at || 0),...(item.needs || []).flatMap(n=>[n.at || 0,n.answeredAt || 0]))
// What a session's status means for the week: how it ended, or that it has not.
const OUTCOME={error:'failed',approval:'needs you',starting:'running',running:'running',stopping:'running',queued:'queued',stopped:'stopped',idle:'finished'}
function summarize(sessions,{now=Date.now(),days=WINDOW_DAYS,staleDays=STALE_DAYS}={}) {
  const all=[...sessions],from=new Date(now);from.setHours(0,0,0,0);from.setDate(from.getDate()-(days-1))
  const since=from.getTime(),firstDate=dateOf(since)
  const boards=all.filter(s=>s.kind==='day' && s.dayBoard?.date).map(s=>s.dayBoard).sort((a,b)=>a.date<b.date ? -1 : 1)
  const shipped=new Map()
  for (const board of boards) {
    if (board.date<firstDate) continue
    for (const item of board.items) {
      if (item.status==='done') shipped.set(item.id,{id:item.id,title:item.title,projectId:item.projectId || null,date:board.date,prs:prs(item)})
      else shipped.delete(item.id)
    }
  }
  const shippedList=[...shipped.values()].sort((a,b)=>a.date<b.date ? 1 : -1).slice(0,MAX_ROWS)
  const latest=boards.at(-1),limit=now-staleDays*DAY
  const items=(latest?.items || []).filter(i=>OPEN.includes(i.status) && lastMoved(i)<=limit).map(i=>({kind:'item',id:i.id,title:i.title,status:i.status,projectId:i.projectId || null,lastMoved:lastMoved(i)}))
  const stuck=all.filter(s=>!['day','thread'].includes(s.kind) && IN_FLIGHT.includes(s.status) && (s.updatedAt || 0)<=limit).map(s=>({kind:'session',id:s.id,title:s.name || 'Session',status:s.status,projectId:s.projectId || null,lastMoved:s.updatedAt || 0}))
  const stalled=[...items,...stuck].sort((a,b)=>a.lastMoved-b.lastMoved).slice(0,MAX_ROWS)
  const ran=all.filter(s=>!['day','thread'].includes(s.kind) && (s.updatedAt || s.createdAt || 0)>=since).sort((a,b)=>(b.updatedAt || 0)-(a.updatedAt || 0))
  const outcomes={}
  for (const s of ran) {const o=OUTCOME[s.status] || s.status;outcomes[o]=(outcomes[o] || 0)+1}
  return {
    since,days,staleDays,
    shipped:{items:shippedList,count:shipped.size,prs:new Set([...shipped.values()].flatMap(i=>i.prs)).size},
    stalled:{items:stalled,count:items.length+stuck.length},
    ran:{count:ran.length,outcomes,sessions:ran.slice(0,MAX_ROWS).map(s=>({id:s.id,name:s.name || 'Session',outcome:OUTCOME[s.status] || s.status,projectId:s.projectId || null,at:s.updatedAt || s.createdAt,teamName:s.teamName || null}))},
  }
}
module.exports={summarize,lastMoved,prs,WINDOW_DAYS,STALE_DAYS}
