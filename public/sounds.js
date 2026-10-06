'use strict'
// Small sounds for the moments worth looking up for: an agent finished its turn, something
// waits on you (an approval, a question on Today), an agent reported back on Today. They
// are synthesized here, a few soft sine notes each, so there is nothing to download. On by
// default; Settings turns them off for this browser.
window.FleetSounds=(()=>{
  const KEY='fleet.sounds'
  const enabled=()=>{try{return localStorage.getItem(KEY)!=='0'}catch{return true}}
  const setEnabled=on=>{try{localStorage.setItem(KEY,on ? '1':'0')}catch{}}
  // Notes in Hz with their start offset in seconds.
  const TUNES={
    done:[[659.25,0],[987.77,0.11]],
    ask:[[880,0],[880,0.16]],
    report:[[783.99,0],[987.77,0.09],[1174.66,0.18]],
  }
  let ctx=null,lastAt=0
  function context(){
    if(!ctx){const Audio=window.AudioContext || window.webkitAudioContext;if(!Audio)return null;ctx=new Audio()}
    if(ctx.state==='suspended')ctx.resume().catch(()=>{})
    return ctx
  }
  // Browsers only let a page make sound after the person has interacted with it.
  document.addEventListener('pointerdown',()=>context(),{once:true,capture:true})
  function note(audio,freq,at,length=0.32){
    const osc=audio.createOscillator(),gain=audio.createGain()
    osc.type='sine';osc.frequency.value=freq
    gain.gain.setValueAtTime(0,at)
    gain.gain.linearRampToValueAtTime(0.07,at+0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001,at+length)
    osc.connect(gain).connect(audio.destination)
    osc.start(at);osc.stop(at+length+0.02)
  }
  // One sound at a time: several events in one update play only the first, which callers
  // order by importance.
  function play(name,{force=false}={}){
    if(!force && !enabled())return false
    const tune=TUNES[name],now=Date.now()
    if(!tune || !force && now-lastAt<1200)return false
    const audio=context()
    if(!audio || audio.state!=='running')return false
    lastAt=now
    const t=audio.currentTime+0.01
    for(const [freq,offset] of tune)note(audio,freq,t+offset)
    return true
  }

  // What the session list says changed since the last update.
  const ACTIVE=new Set(['starting','running','stopping'])
  const COORDINATORS=new Set(['day','project','thread'])
  let seen=null
  function check(){
    const sessions=(window.Fleet?.snapshot?.()?.sessions || []).filter(s=>s.managed && s.managedId)
    const now=new Map(sessions.map(s=>[s.managedId,{status:s.managedStatus,kind:s.kind || 'agent',waiting:s.dayProgress?.waiting || 0}]))
    if(seen){
      let asks=false,finished=false
      for(const [id,cur] of now){
        const before=seen.get(id)
        if(!before)continue
        if(cur.status==='approval' && before.status!=='approval')asks=true
        if(cur.kind==='day' && cur.waiting>before.waiting)asks=true
        if(!COORDINATORS.has(cur.kind) && ACTIVE.has(before.status) && cur.status==='idle')finished=true
      }
      if(asks)play('ask')
      else if(finished)play('done')
    }
    seen=now
  }
  document.addEventListener('fleet-snapshot',check)
  return {play,enabled,setEnabled,TUNES}
})()
