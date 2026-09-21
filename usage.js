'use strict'
// Plan usage is an account fact, not a session one: the five-hour and weekly windows
// are shared by every Claude process on this machine, including the terminal sessions
// Fleet only watches. Three sources feed this, none of them available all of the time:
//   - `rate_limit_event`, pushed by the SDK while a Fleet run is streaming
//   - the runtime's own /usage data, pulled once at the end of a turn
//   - a rejected `quotaLimits` record in any transcript, which is the only signal that
//     survives Fleet being idle and the only one that says "you are blocked right now"
// Nothing here spends a token to find out. A synthetic request would consume the very
// window it claims to measure.
const WINDOWS=['five_hour','seven_day','seven_day_opus','seven_day_sonnet','seven_day_oauth_apps']
const LABELS={five_hour:'5h',seven_day:'week',seven_day_opus:'opus wk',seven_day_sonnet:'sonnet wk',seven_day_oauth_apps:'apps wk'}
// A live reading only arrives while a run streams. Past this age the bar says "as of",
// because presenting an hour-old number as current is the one thing it must never do.
const STALE_MS=120000
// Utilisation is a whole percentage. A value outside the range is discarded rather than
// clamped: that far off is a change of shape, not a reading worth drawing.
const valid=n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=100
// `resetsAt` is unix seconds on the push event and an ISO string on the pull.
function resetTime(value) {
  if (typeof value==='number' && Number.isFinite(value) && value>0) return Math.round(value<1e12 ? value*1000 : value)
  if (typeof value==='string') {const parsed=Date.parse(value);return Number.isFinite(parsed) ? parsed:null}
  return null
}
// A block with no reset time cannot be shown honestly and cannot expire on its own, so
// it is dropped: a red bar that never clears is worse than no bar.
const live=(block,now)=>block && block.resetsAt && block.resetsAt>now ? block:null

class UsageTracker {
  constructor() {
    this.windows=new Map()
    this.observedAt=null
    this.subscription=null
    // null until something says either way. Unknown is not "no limits": the bar stays
    // empty rather than reporting a zero it never measured.
    this.available=null
    this.blocked=null
  }
  // The SDK's push event carries one window at a time and is the only source that
  // updates mid-turn.
  recordEvent(info,now=Date.now()) {
    if (!info || typeof info!=='object') return false
    const type=typeof info.rateLimitType==='string' ? info.rateLimitType:null
    let changed=false
    if (type && valid(info.utilization)) {
      this.windows.set(type,{utilization:info.utilization,resetsAt:resetTime(info.resetsAt)})
      this.observedAt=now
      this.available=true
      changed=true
    }
    if (info.status==='rejected' && type) {
      this.blocked={rateLimitType:type,resetsAt:resetTime(info.resetsAt),reason:info.overageDisabledReason || null,at:now,source:'run'}
      changed=true
    } else if (info.status && this.blocked) {this.blocked=null;changed=true}
    return changed
  }
  // The pull at turn end: every window at once, plus the plan behind them. Experimental
  // upstream, so absence and malformed shapes are ordinary outcomes, never errors.
  recordUsage(response,now=Date.now()) {
    if (!response || typeof response!=='object') return false
    if (response.rate_limits_available===false) {
      const had=this.available!==false
      this.available=false;this.windows.clear();this.observedAt=now
      return had
    }
    let changed=false
    const limits=response.rate_limits
    if (limits && typeof limits==='object') for (const name of WINDOWS) {
      const window=limits[name]
      if (!window || typeof window!=='object' || !valid(window.utilization)) continue
      this.windows.set(name,{utilization:window.utilization,resetsAt:resetTime(window.resets_at)})
      changed=true
    }
    if (typeof response.subscription_type==='string' && response.subscription_type!==this.subscription) {
      this.subscription=response.subscription_type
      changed=true
    }
    if (changed) {this.observedAt=now;this.available=true}
    return changed
  }
  // A rejection read out of a transcript. Any session on this machine can supply it,
  // which is what makes a block visible while Fleet itself is driving nothing.
  static rejection(record) {
    if (!record || typeof record!=='object') return null
    const resetsAt=resetTime(record.resetsAt)
    if (!resetsAt) return null
    return {rateLimitType:record.rateLimitType || null,resetsAt,reason:record.reason || null,at:record.at || null,source:'transcript'}
  }
  snapshot({now=Date.now(),rejection=null}={}) {
    // Whichever block is newer wins; both expire by themselves at their reset time.
    const blocks=[live(this.blocked,now),live(UsageTracker.rejection(rejection),now)].filter(Boolean)
    const blocked=blocks.sort((a,b)=>(b.at || 0)-(a.at || 0))[0] || null
    const windows=[...this.windows.entries()]
      .map(([name,w])=>({name,label:LABELS[name] || name,utilization:Math.round(w.utilization),resetsAt:w.resetsAt}))
      .sort((a,b)=>WINDOWS.indexOf(a.name)-WINDOWS.indexOf(b.name))
    // One bar on screen, drawn for whichever window is closest to stopping the fleet.
    const binding=windows.reduce((worst,w)=>!worst || w.utilization>worst.utilization ? w:worst,null)
    return {
      available:this.available!==false,
      known:windows.length>0 || !!blocked,
      windows,
      binding:binding ? binding.name:null,
      subscription:this.subscription,
      observedAt:this.observedAt,
      stale:this.observedAt ? now-this.observedAt>STALE_MS:true,
      blocked,
    }
  }
}

module.exports={UsageTracker,WINDOWS,LABELS,STALE_MS}
