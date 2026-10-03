'use strict'
// Switching between Today, Projects and Sessions, against a stub DOM.
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
function load(saved,panes=['sessions-pane','today-pane','projects-pane','progress-pane']) {
  const elements=new Map(),stored={'fleet:view':saved},renders=[]
  const element=id=>{
    if (!elements.has(id)) elements.set(id,{id,hidden:false,attrs:{},handlers:{},addEventListener(type,fn){this.handlers[type]=fn},setAttribute(name,value){this.attrs[name]=value}})
    return elements.get(id)
  }
  for (const id of [...panes,'view-today','view-projects','view-progress','view-sessions']) element(id)
  const workspace={dataset:{},setAttribute(){}}
  const context=vm.createContext({document:{querySelector:()=>workspace},console})
  context.window=context
  context.Fleet={$:id=>elements.has(id) ? elements.get(id) : null,store:{get:k=>stored[k],set:(k,v)=>{stored[k]=v}},render:()=>renders.push(1),syncSplit(){}}
  new vm.Script(fs.readFileSync(path.join(__dirname,'public/views.js'),'utf8')).runInContext(context)
  return {views:context.FleetViews,element,workspace,stored,renders}
}
test('one view shows at a time, its tab is pressed, and the choice is remembered',()=>{
  const {views,element,workspace,stored}=load('sessions')
  element('view-today').handlers.click()
  assert.equal(views.view(),'today')
  assert.deepEqual(['sessions-pane','today-pane','projects-pane'].map(id=>element(id).hidden),[true,false,true])
  assert.equal(element('view-today').attrs['aria-pressed'],'true')
  assert.equal(element('view-sessions').attrs['aria-pressed'],'false')
  assert.equal(workspace.dataset.view,'today')
  assert.equal(stored['fleet:view'],'today')
})
test('Progress is a view of its own and shows only its pane',()=>{
  const {views,element}=load('sessions')
  element('view-progress').handlers.click()
  assert.equal(views.view(),'progress')
  assert.deepEqual(['sessions-pane','today-pane','projects-pane','progress-pane'].map(id=>element(id).hidden),[true,true,true,false])
  assert.equal(load('progress',['sessions-pane']).views.view(),'sessions','Progress without its pane falls back')
})
test('a remembered Work queue, or a view without its pane, falls back to Sessions',()=>{
  assert.equal(load('queue').views.view(),'sessions','the retired Work queue view opens Sessions')
  const {views}=load('projects',['sessions-pane'])
  assert.equal(views.view(),'sessions','Projects without its pane falls back')
  views.switchView('nope')
  assert.equal(views.view(),'sessions')
})
