'use strict'
// Fetch something the page already holds most of (the session list, an open
// conversation), asking only for what changed. The server answers 304 when nothing
// did, and sends list items the page already has as their fingerprint alone; this
// puts the full answer back together from the previous one. A fingerprint it cannot
// place means the two copies drifted apart, so it asks again for everything: the page
// always ends up with the full, current answer, exactly as before.
window.FleetSync=(()=>{
  const held=new Map() // key -> {tag, value, items: Map(fingerprint -> item)}
  const at=(value,path)=>path.split('.').reduce((v,k)=>v?.[k],value)
  const put=(value,path,list)=>{const keys=path.split('.'),last=keys.pop(),parent=keys.reduce((v,k)=>v?.[k],value);if(parent && typeof parent==='object')parent[last]=list}
  async function get(url,{paths=[],key=url,timeout=8000}={}){
    const previous=held.get(key),headers={}
    if(previous){
      if(previous.tag)headers['if-none-match']=previous.tag
      if(previous.items.size)headers['x-fleet-known']=[...previous.items.keys()].join(',')
    }
    const response=await fetch(url,{cache:'no-store',headers,signal:AbortSignal.timeout(timeout)})
    if(response.status===304 && previous)return {value:previous.value,changed:false}
    let data=null
    try{data=await response.json()}catch{}
    if(!response.ok){const error=new Error(data?.error || `HTTP ${response.status}`);error.status=response.status;throw error}
    const items=new Map()
    let lost=false
    for(const path of paths){
      const list=at(data,path)
      if(!Array.isArray(list))continue
      put(data,path,list.map(item=>{
        if(item && item.h && Object.keys(item).length===1){
          const kept=previous?.items.get(item.h)
          if(!kept){lost=true;return item}
          items.set(item.h,kept);return kept
        }
        if(item?.h)items.set(item.h,item)
        return item
      }))
    }
    if(lost){held.delete(key);return get(url,{paths,key,timeout})}
    held.set(key,{tag:response.headers.get('etag'),value:data,items})
    return {value:data,changed:true}
  }
  // Drop what is held, so the next get asks for everything.
  const forget=key=>key===undefined ? held.clear() : held.delete(key)
  return {get,forget}
})()
