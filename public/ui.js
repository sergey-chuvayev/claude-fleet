'use strict'
// Fleet's building blocks. Every page (Today, Projects, Sessions) is built from these,
// so a header, a stat, a section label or a list row looks and behaves the same
// wherever it appears. Each helper returns an HTML string; arguments named for content
// (title, meta, body...) are HTML the caller has already escaped, and the helper only
// escapes what it builds itself (labels, tooltips). Loads before app.js and needs
// nothing from it.
window.FleetUI=(()=>{
  const esc=value=>String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch])
  const attr=(name,value)=>value==null || value==='' ? '' : ` ${name}="${esc(value)}"`

  // The head of a page: its title in the shared top band, actions on the right, and an
  // optional strip of stats underneath.
  const pageHead=({title,actions='',strip='',cls=''})=>`<header class="page-head${cls ? ` ${cls}`:''}"><div class="page-title"><h2>${title}</h2></div>${actions ? `<div class="page-actions">${actions}</div>`:''}${strip ? `<div class="page-strip">${strip}</div>`:''}</header>`

  // One figure in a stats strip: a small label over its value.
  const stat=(label,value,{tone,title,cls}={})=>`<span class="ui-stat${cls ? ` ${cls}`:''}"${attr('data-tone',tone)}${attr('title',title)}><b>${esc(label)}</b><span class="ui-stat-value">${value}</span></span>`
  const bar=(percent,tone)=>`<span class="mini-bar"${attr('data-tone',tone)}><i style="width:${Math.max(0,Math.min(100,Math.round(percent || 0)))}%"></i></span>`
  // Progress as a ring: done out of total.
  const ring=(done,total)=>{
    const c=2*Math.PI*7,share=total ? Math.min(1,done/total) : 0
    return `<svg class="ui-ring" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7"/><circle cx="9" cy="9" r="7" class="is-done" stroke-dasharray="${(share*c).toFixed(2)} ${c.toFixed(2)}"/></svg>`
  }

  // A section: an uppercase label with an optional count and something on its right.
  const label=(text,{count,aside}={})=>`<h4 class="ui-label">${esc(text)}${count!=null ? `<span class="ui-count">${esc(count)}</span>`:''}${aside ? `<span class="ui-label-aside">${aside}</span>`:''}</h4>`
  const section=(text,body,{count,aside,cls,attrs=''}={})=>`<section class="ui-section${cls ? ` ${cls}`:''}"${attrs ? ` ${attrs}`:''}>${label(text,{count,aside})}${body}</section>`

  // Small status words, and the dot that says where something is.
  const pill=(text,tone)=>`<span class="ui-pill"${attr('data-tone',tone)}>${text}</span>`
  const orb=(tone,title)=>`<span class="ui-orb"${attr('data-tone',tone || 'todo')}${attr('title',title)}></span>`
  const chevron='<span class="ui-chevron" aria-hidden="true"></span>'

  // A list row: a status orb, a title, one quiet line of meta, and what sits on the
  // right. With a detail it opens in place, keyed so a redraw can keep it open.
  function row({tone,orbTitle,title,meta='',side='',detail='',open=false,key,attrs=''}) {
    const head=`${orb(tone,orbTitle)}<span class="ui-row-body"><strong class="ui-row-title">${title}</strong>${meta ? `<span class="ui-row-meta">${meta}</span>`:''}</span><span class="ui-row-side">${side}${detail ? chevron:''}</span>`
    const li=`<li class="ui-row"${attr('data-tone',tone || 'todo')}${attrs ? ` ${attrs}`:''}>`
    if(!detail)return `${li}<div class="ui-row-head">${head}</div></li>`
    return `${li}<details${attr('data-evidence',key)}${open ? ' open':''}><summary class="ui-row-head">${head}</summary><div class="ui-row-detail">${detail}</div></details></li>`
  }
  const list=(rows,cls='')=>`<ol class="ui-list${cls ? ` ${cls}`:''}">${rows}</ol>`

  // A group inside a section (Must, Should, Could...): a coloured mark, its name, a
  // count, and a hairline to whatever sits at the end.
  const group=(text,{count,end,tone}={})=>`<h5 class="ui-group"${attr('data-tone',tone)}><i aria-hidden="true"></i>${esc(text)}${count!=null ? `<span>${esc(count)}</span>`:''}${end ? `<small>${end}</small>`:''}</h5>`
  // A folded section that opens in place: Later, Done, a form.
  const fold=({title,count,body,key,open=false,cls=''})=>`<details class="ui-fold${cls ? ` ${cls}`:''}"${attr('data-evidence',key)}${open ? ' open':''}><summary>${chevron}${title}${count!=null ? `<span class="ui-count">${esc(count)}</span>`:''}</summary>${body}</details>`
  // A question box: one line and its button.
  const ask=({key,placeholder,button,data=''})=>`<div class="ui-ask"><input data-keep="${esc(key)}" maxlength="2000" placeholder="${esc(placeholder)}"${data ? ` ${data}`:''}>${button}</div>`
  // A boxed note inside a page, for something the reader should know first.
  const callout=(title,body,{tone,actions=''}={})=>`<div class="ui-callout"${attr('data-tone',tone)}><strong>${title}</strong>${body ? `<p>${body}</p>`:''}${actions ? `<div class="ui-actions">${actions}</div>`:''}</div>`
  // What a page or pane says when there is nothing in it yet.
  const empty=({title,text='',action=''})=>`<div class="ui-empty"><h3>${title}</h3>${text ? `<p>${text}</p>`:''}${action}</div>`
  // A log: time, then what happened.
  const log=entries=>entries.length ? `<ol class="ui-log">${entries.map(([time,text])=>`<li><time>${esc(time)}</time>${text}</li>`).join('')}</ol>`:''

  return {esc,pageHead,stat,bar,ring,label,section,pill,orb,chevron,row,list,group,fold,ask,callout,empty,log}
})()
