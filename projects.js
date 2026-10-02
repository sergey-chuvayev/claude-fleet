'use strict'
// Projects: the outcomes the operator owns, defined here rather than synced from a
// roadmap tool. A project is a brief in the operator's own words, a deadline, the
// deliverables that make it done, and where its work lives. Sessions, Day items and the
// project's own manager agent all point at it by id.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const bad = message => { throw Object.assign(new Error(message), {status:400}) }
const STATES = ['todo','doing','review','done']
const MAX_PROJECTS = 30, MAX_DELIVERABLES = 30, MAX_LOG = 60
function string(value, label, max, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`${label} must contain 1-${max} characters.`)
  return value.trim()
}
function list(value, label, max, each) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : String(value).split('\n')
  const clean = items.map(v => String(v).trim()).filter(Boolean)
  if (clean.length > max) bad(`${label}: at most ${max}.`)
  return [...new Set(clean.map(v => { if (v.length > each) bad(`${label}: each at most ${each} characters.`); return v }))]
}
const date = value => {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) bad('Deadline must be a date (YYYY-MM-DD).')
  return value
}

class ProjectStore {
  constructor(directory) {
    this.file = path.join(directory, 'projects.json')
    this.projects = new Map()
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.projects)) throw new Error('Unsupported project store')
      for (const p of saved.projects) if (p?.id && p.name) this.projects.set(p.id, p)
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read Fleet projects: ${error.message}`) }
  }
  persist() {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({version:1, projects:[...this.projects.values()]}), {mode:0o600})
    fs.renameSync(tmp, this.file)
  }
  list({ archived = false } = {}) {
    return [...this.projects.values()].filter(p => archived || !p.archived).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.createdAt - b.createdAt)
  }
  get(id) { return this.projects.get(id) || null }
  require(id) { const p = this.get(id); if (!p) throw Object.assign(new Error('Project not found.'), {status:404}); return p }
  // Create, or update an existing project's definition. Deliverables arrive as titles
  // (one per line is enough); ones already known keep their state.
  save(input) {
    if (!input || typeof input !== 'object') bad('A project is required.')
    const existing = input.id ? this.require(input.id) : null
    if (!existing && this.projects.size >= MAX_PROJECTS) bad(`Fleet keeps up to ${MAX_PROJECTS} projects. Archive one first.`)
    const titles = list(input.deliverables?.map?.(d => typeof d === 'string' ? d : d?.title) ?? input.deliverables, 'Deliverables', MAX_DELIVERABLES, 300)
    const deliverables = titles.map(title => existing?.deliverables.find(d => d.title === title) || {id:randomUUID(), title, state:'todo', note:'', at:Date.now()})
    const project = {
      ...(existing || {id:randomUUID(), createdAt:Date.now(), log:[], archived:false}),
      name:string(input.name,'Project name',100),
      brief:string(input.brief,'Brief',16000,true),
      deadline:date(input.deadline),
      repos:list(input.repos,'Repositories',10,4096),
      links:list(input.links,'Links',20,2000).filter(l => /^https?:\/\//.test(l)),
      deliverables,
      updatedAt:Date.now(),
    }
    this.projects.set(project.id, project)
    this.persist()
    return project
  }
  archive(id, archived = true) { const p = this.require(id); p.archived = !!archived; p.updatedAt = Date.now(); this.persist(); return p }
  // The manager's and the operator's view of progress: one deliverable's state and note.
  deliverable(id, deliverableId, { state, note } = {}) {
    const p = this.require(id), d = p.deliverables.find(x => x.id === deliverableId)
    if (!d) bad('Deliverable not found. Read the project first.')
    if (state !== undefined) { if (!STATES.includes(state)) bad(`State must be one of: ${STATES.join(', ')}.`); d.state = state }
    if (note !== undefined) d.note = String(note).slice(0, 1000)
    d.at = Date.now(); p.updatedAt = Date.now()
    this.persist()
    return d
  }
  note(id, text) {
    const p = this.require(id)
    p.log = [...(p.log || []), {at:Date.now(), text:string(text,'Note',2000)}].slice(-MAX_LOG)
    p.updatedAt = Date.now()
    this.persist()
    return p.log.at(-1)
  }
}
const progress = p => ({total:p.deliverables.length, done:p.deliverables.filter(d => d.state === 'done').length, doing:p.deliverables.filter(d => ['doing','review'].includes(d.state)).length})
module.exports = { ProjectStore, STATES, progress }
