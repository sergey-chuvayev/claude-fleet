'use strict'
// Projects: the outcomes the operator owns. Each one is a single Markdown file, the source
// of truth for that project: a small header (name, deadline, repositories, links), then
// the brief, the deliverables as a checklist, any sections the manager or the operator
// write (sources, decisions, risks), and a log. Fleet reads the file every time it is
// asked, so an edit by hand is picked up as readily as one through Fleet.
//
//   ---
//   id: 6f1c...
//   name: Queue in the ring node
//   deadline: 2026-10-30
//   repos:
//     - ~/projects/api-allo
//   links:
//     - https://github.com/acme/api-allo/pull/3796
//   ---
//
//   ## Brief
//   ...
//
//   ## Deliverables
//   - [~] Queue as a ring option · #3796 rebasing <!-- id:3f9a1c2b7d4e -->
//     Move the queue into the ring node so a call can wait for a free agent.
//     Done when: a queued call rings the next free agent.
//     - https://github.com/acme/api-allo/pull/3796
//   - [ ] Waiting music and announcements <!-- id:b81e04c95a17 -->
//
// The comment at the end of a deliverable's line is its id: Markdown viewers hide it, and
// a title edited by hand keeps it, so the deliverable stays the same one (a Day item
// tied to it, an agent's PR landing on it). A line without one, written by hand or by
// 0.54.0 and before, which knew a deliverable by its title, gets one the first time
// Fleet reads the file. `stripIds` takes them out again, for going back to such a version.
//
// A deliverable's indented lines are its brief (what, why, what done looks like) and
// its links (an indented bullet holding only a URL): the context an agent needs to
// start on it without asking again.
//
//   ## Sources
//   ...
//
//   ## Log
//   - 2026-10-02 17:56 Agreed scope with Franco.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const bad = (message, status = 400) => { throw Object.assign(new Error(message), {status}) }
const STATES = ['todo','doing','review','done']
const MARK = {todo:' ', doing:'~', review:'?', done:'x'}
const FROM_MARK = {' ':'todo', '~':'doing', '?':'review', x:'done', X:'done'}
const MAX_PROJECTS = 30, MAX_DELIVERABLES = 40, MAX_LOG = 80, MAX_TASK_BRIEF = 4000, MAX_TASK_LINKS = 12
// Sections Fleet reads into fields; every other section is kept as written.
const KNOWN = ['brief','deliverables','log']

function string(value, label, max, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`${label} must contain 1-${max} characters.`)
  return value.trim()
}
function list(value, label, max, each) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : String(value).split('\n')
  const clean = [...new Set(items.map(v => String(v).trim()).filter(Boolean))]
  if (clean.length > max) bad(`${label}: at most ${max}.`)
  for (const v of clean) if (v.length > each) bad(`${label}: each at most ${each} characters.`)
  return clean
}
// Links are web addresses, kept once each.
const urls = (value, label, max) => list(value, label, 100, 2000).filter(l => /^https?:\/\/\S+$/.test(l)).slice(0, max)
// A task brief is kept as written, minus blank lines: in the file it is indented under
// its deliverable, and a blank line there would end the list item for a reader.
const taskBrief = value => {
  const text = String(value ?? '').replace(/\r\n/g,'\n').split('\n').map(l => l.replace(/\s+$/,'')).filter(l => l.trim()).join('\n')
  if (text.length > MAX_TASK_BRIEF) bad(`A task brief is at most ${MAX_TASK_BRIEF} characters.`)
  return text
}
const date = value => {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) bad('Deadline must be a date (YYYY-MM-DD).')
  return value
}
// One line per thing in the file, so titles and notes cannot carry line breaks.
const line = value => String(value).replace(/\s+/g,' ').trim()
const slug = text => line(text).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'project'
// What 0.54.0 and before used as a deliverable's id: its title cut down to a slug, so
// "Fix #1" and "Fix #1!" were one deliverable, and a title edited by hand was another.
const legacyId = title => slug(title)
const newId = (taken = new Set()) => { let id; do id = randomUUID().replace(/-/g,'').slice(0,12); while (taken.has(id)); return id }
const TASK_LINE = /^ ?[-*]\s+\[([ ~?xX])\]\s+(.+)$/
const ID_TAG = /\s<!-- id:([\w-]{1,64}) -->\s*$/
const idTag = id => id ? ` <!-- id:${id} -->` : ''
// The file is read by people, so its times are local, as on the operator's clock.
const pad = n => String(n).padStart(2,'0')
const stamp = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }

function render(p) {
  const header = ['---',`id: ${p.id}`,`name: ${line(p.name)}`,...(p.deadline ? [`deadline: ${p.deadline}`] : []),...(p.archived ? ['archived: true'] : []),
    ...(p.repos.length ? ['repos:',...p.repos.map(r => `  - ${line(r)}`)] : []),...(p.links.length ? ['links:',...p.links.map(l => `  - ${line(l)}`)] : []),'---']
  const sections = [
    ['Brief', p.brief || '_Not written yet. Ask the project manager to fill it in._'],
    ['Deliverables', p.deliverables.length ? p.deliverables.map(d => [`- [${MARK[d.state]}] ${line(d.title)}${d.note ? ` · ${line(d.note)}` : ''}${idTag(d.id)}`,
      ...(d.brief ? d.brief.split('\n').map(l => `  ${l}`) : []), ...(d.links || []).map(l => `  - ${line(l)}`)].join('\n')).join('\n') : '_None yet._'],
    ...p.sections.map(s => [s.heading, s.body]),
    ['Log', p.log.length ? p.log.map(l => `- ${stamp(l.at)} ${line(l.text)}`).join('\n') : '_Nothing yet._'],
  ]
  return `${header.join('\n')}\n\n${sections.map(([h,b]) => `## ${h}\n\n${String(b).trim()}\n`).join('\n')}`
}
function parse(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g,'\n'))
  if (!match) throw new Error(`${path.basename(file)} has no header`)
  const meta = {}, lists = {}
  let key = null
  for (const raw of match[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item && key) { (lists[key] ||= []).push(item[1].trim()); continue }
    const pair = /^([\w-]+):\s*(.*)$/.exec(raw)
    if (pair) { key = pair[1]; if (pair[2]) meta[key] = pair[2].trim() }
  }
  const sections = []
  let current = null
  for (const raw of match[2].split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(raw)
    if (h) { current = {heading:h[1], lines:[]}; sections.push(current); continue }
    if (current) current.lines.push(raw)
  }
  const body = heading => sections.find(s => s.heading.toLowerCase() === heading)?.lines.join('\n').trim() || ''
  const placeholder = text => /^_.*_$/.test(text) ? '' : text
  const deliverables = []
  let task = null
  for (const raw of body('deliverables').split('\n')) {
    const d = TASK_LINE.exec(raw)
    if (d) {
      const tag = ID_TAG.exec(d[2]), [title, ...note] = (tag ? d[2].slice(0, tag.index) : d[2]).split(' · ')
      task = {id:tag ? tag[1] : null, title:title.trim(), state:FROM_MARK[d[1]], note:note.join(' · ').trim(), brief:'', links:[]}
      deliverables.push(task)
      continue
    }
    // Indented under a deliverable: a lone URL bullet is a link, anything else its brief.
    if (!task || !/^\s{2,}\S/.test(raw)) { if (raw.trim()) task = null; continue }
    const link = /^\s+[-*]\s+(https?:\/\/\S+)\s*$/.exec(raw)
    if (link) { if (task.links.length < MAX_TASK_LINKS && !task.links.includes(link[1])) task.links.push(link[1]) }
    else task.brief = task.brief ? `${task.brief}\n${raw.replace(/^ {2}/,'')}` : raw.replace(/^ {2}/,'')
  }
  const log = []
  for (const raw of body('log').split('\n')) {
    const l = /^\s*-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+)$/.exec(raw)
    if (l) log.push({at:new Date(`${l[1].replace(' ','T')}:00`).getTime(), text:l[2]})
  }
  return {
    id:meta.id, name:meta.name, deadline:meta.deadline || null, archived:meta.archived === 'true',
    repos:lists.repos || [], links:lists.links || [],
    brief:placeholder(body('brief')), deliverables, log,
    sections:sections.filter(s => !KNOWN.includes(s.heading.toLowerCase())).map(s => ({heading:s.heading, body:s.lines.join('\n').trim()})),
  }
}
// The file with an id on every deliverable that lacks one, or shares one with an earlier
// deliverable (a line copied by hand). Only those lines change, each by the comment added
// to its end, so everything else in the file stays exactly as it was written. `assigned`
// says which old title slug each new id replaced, to carry Day items over.
function assignIds(text) {
  const lines = text.split('\n'), plain = l => l.replace(/\r$/,'')
  const end = lines.findIndex((l, i) => i > 0 && plain(l).startsWith('---'))
  if (plain(lines[0]) !== '---' || end < 0) return {text, assigned:[]}
  // The lines parse() reads as deliverables: those of the first Deliverables section,
  // the first of them with its indent trimmed, as parse() trims the section's body.
  const rows = []
  let inside = false, done = false, first = true
  for (let i = end+1; i < lines.length; i++) {
    const h = /^##\s+(.+?)\s*$/.exec(plain(lines[i]))
    if (h) { if (inside) done = true; inside = !done && h[1].toLowerCase() === 'deliverables'; continue }
    if (!inside || (first && !lines[i].trim())) continue
    const raw = first ? plain(lines[i]).trimStart() : plain(lines[i])
    first = false
    const d = TASK_LINE.exec(raw)
    if (d) rows.push({i, d, tag:ID_TAG.exec(d[2])})
  }
  const taken = new Set(rows.filter(r => r.tag).map(r => r.tag[1])), kept = new Set(), assigned = []
  for (const r of rows) {
    if (r.tag && !kept.has(r.tag[1])) { kept.add(r.tag[1]); continue }
    const id = newId(taken), body = plain(lines[r.i]), cr = lines[r.i].endsWith('\r') ? '\r' : ''
    taken.add(id); kept.add(id)
    if (r.tag) lines[r.i] = `${body.slice(0, body.length - r.d[2].length)}${r.d[2].slice(0, r.tag.index)}${idTag(id)}${cr}`
    else { lines[r.i] = `${body}${idTag(id)}${cr}`; assigned.push({slug:legacyId(r.d[2].split(' · ')[0]), id}) }
  }
  return {text:lines.join('\n'), assigned}
}
// The way back: the file as a version without ids reads it. A file Fleet gave its ids
// to and nobody changed since comes back byte for byte.
const stripIds = text => text.replace(/^( ?[-*]\s+\[[ ~?xX]\]\s+.+?) <!-- id:[\w-]{1,64} -->(?=[ \t]*\r?$)/gm, '$1')

class ProjectStore {
  constructor(directory) {
    this.dir = path.join(directory, 'projects')
    fs.mkdirSync(this.dir, {recursive:true, mode:0o700})
    this.cache = new Map()
    this.legacyFile = path.join(this.dir, '.legacy-ids.json')
    this.migrate(path.join(directory, 'projects.json'))
  }
  // Old title slug to new id, per project, as each file got its ids: null where two of a
  // project's deliverables shared the slug. Kept on disk so a Day saved before the ids
  // came still finds its deliverables after a restart in between.
  legacy() { try { return JSON.parse(fs.readFileSync(this.legacyFile, 'utf8')).projects || {} } catch { return {} } }
  remember(projectId, assigned) {
    if (!assigned.length) return
    const all = this.legacy(), known = all[projectId] ||= {}, count = {}
    for (const a of assigned) count[a.slug] = (count[a.slug] || 0)+1
    for (const a of assigned) if (!Object.hasOwn(known, a.slug)) known[a.slug] = count[a.slug] > 1 ? null : a.id
    const tmp = `${this.legacyFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({version:1, projects:all}), {mode:0o600})
    fs.renameSync(tmp, this.legacyFile)
  }
  // A file read with deliverables lacking an id is given them, once, and written back.
  read(file) {
    let text = fs.readFileSync(file, 'utf8'), project = parse(text, file)
    const ids = project.deliverables.map(d => d.id)
    if (project.id && project.name && ids.some((id, i) => !id || ids.indexOf(id) !== i)) {
      const fixed = assignIds(text)
      // The map first: with the file written and the map not, the old slugs would be lost.
      this.remember(project.id, fixed.assigned)
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, fixed.text, {mode:fs.statSync(file).mode & 0o777})
      fs.renameSync(tmp, file)
      text = fixed.text; project = parse(text, file)
    }
    return project
  }
  // Day items made before ids named their deliverable by its title's slug. Each follows
  // its deliverable to the id it was given. Where two of the project's deliverables had
  // that slug there is no telling which one was meant, so the item is untied and says
  // so, rather than picking one. Returns how many items changed.
  relinkDay(items = []) {
    const projects = new Map(this.all().map(p => [p.id, p])), legacy = this.legacy()
    let changed = 0
    for (const item of items) {
      const p = item?.deliverableId && projects.get(item.projectId), known = p && legacy[p.id]
      if (!known || p.deliverables.some(d => d.id === item.deliverableId) || !Object.hasOwn(known, item.deliverableId)) continue
      const to = known[item.deliverableId]
      if (to === null) {
        item.unlinkedDeliverable = item.deliverableId
        delete item.deliverableId
        if (Array.isArray(item.log)) item.log.push({at:Date.now(), text:'No longer tied to a project task: two tasks in the project had titles too alike to tell which this was. Put the right one on Today again from the project.'})
        changed++
      } else if (p.deliverables.some(d => d.id === to)) { item.deliverableId = to; changed++ }
    }
    return changed
  }
  // 0.28.0 kept projects in one JSON file. Each becomes its own Markdown file, once.
  migrate(legacy) {
    let saved
    try { saved = JSON.parse(fs.readFileSync(legacy, 'utf8')) } catch { return }
    for (const p of saved.projects || []) if (p?.id && p.name) this.write({id:p.id, name:p.name, deadline:p.deadline || null, archived:!!p.archived, repos:p.repos || [], links:p.links || [], brief:p.brief || '', deliverables:(p.deliverables || []).map(d => ({id:null, title:d.title, state:d.state, note:d.note || '', brief:'', links:[]})), sections:[], log:p.log || []})
    fs.renameSync(legacy, `${legacy}.migrated`)
  }
  // Every file in the folder, re-read when it changed on disk.
  all() {
    const seen = new Set(), out = []
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.md')) continue
      const file = path.join(this.dir, name)
      try {
        const {mtimeMs} = fs.statSync(file)
        let hit = this.cache.get(file)
        if (!hit || hit.mtime !== mtimeMs) {
          const project = this.read(file), mtime = fs.statSync(file).mtimeMs
          hit = {mtime, project:{...project, file, updatedAt:mtime}}; this.cache.set(file, hit)
        }
        if (hit.project.id && hit.project.name && !seen.has(hit.project.id)) { seen.add(hit.project.id); out.push(hit.project) }
      } catch {}
    }
    return out
  }
  list({ archived = false } = {}) {
    return this.all().filter(p => archived || !p.archived).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.name.localeCompare(b.name))
  }
  get(id) { return this.all().find(p => p.id === id) || null }
  require(id) { const p = this.get(id); if (!p) throw Object.assign(new Error('Project not found.'), {status:404}); return p }
  write(p) {
    const file = p.file || path.join(this.dir, `${slug(p.name)}${fs.existsSync(path.join(this.dir, `${slug(p.name)}.md`)) ? `-${p.id.slice(0,6)}` : ''}.md`)
    const {file:_, updatedAt:__, ...clean} = p
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, render(clean), {mode:0o600})
    fs.renameSync(tmp, file)
    this.cache.delete(file)
    return this.get(p.id)
  }
  // A project starts from a title; its manager fills in the rest.
  create({ name } = {}) {
    if (this.active() >= MAX_PROJECTS) bad(`Fleet keeps up to ${MAX_PROJECTS} active projects. Archive one first.`)
    return this.write({id:randomUUID(), name:string(name,'Project name',100), deadline:null, archived:false, repos:[], links:[], brief:'', deliverables:[], sections:[], log:[{at:Date.now(), text:'Project created.'}]})
  }
  // The manager's way of setting the project up or changing what it is. Any field left
  // out is kept. Deliverables arrive as titles, or as {title, brief, links}; a known one
  // keeps its state and note, and keeps its brief and links unless new ones are given.
  define(id, input = {}) {
    const p = this.require(id)
    if (input.name !== undefined) p.name = string(input.name,'Project name',100)
    if (input.deadline !== undefined) p.deadline = date(input.deadline)
    if (input.brief !== undefined) p.brief = string(input.brief,'Brief',20000,true)
    if (input.repos !== undefined) p.repos = list(input.repos,'Repositories',10,4096)
    if (input.links !== undefined) p.links = list(input.links,'Links',30,2000).filter(l => /^https?:\/\//.test(l))
    if (input.deliverables !== undefined) {
      const given = (Array.isArray(input.deliverables) ? input.deliverables : list(input.deliverables,'Deliverables',MAX_DELIVERABLES,300))
        .map(d => typeof d === 'string' ? {title:d} : d && typeof d === 'object' ? d : bad('Each deliverable is a title or {title, brief, links}.'))
      if (given.length > MAX_DELIVERABLES) bad(`Deliverables: at most ${MAX_DELIVERABLES}.`)
      const seen = new Set(), used = new Set(), taken = new Set(p.deliverables.map(d => d.id))
      p.deliverables = given.map(g => {
        // A title copied from the file may bring its id: that deliverable, renamed.
        const raw = line(string(g.title,'Deliverable title',300)), tag = ID_TAG.exec(raw)
        const title = tag ? line(raw.slice(0, tag.index)) : raw
        if (seen.has(title)) return null
        seen.add(title)
        const byId = tag && !used.has(tag[1]) && p.deliverables.find(d => d.id === tag[1])
        const known = (byId ? {...byId, title} : p.deliverables.find(d => d.title === title && !used.has(d.id))) || {id:newId(taken), title, state:'todo', note:'', brief:'', links:[]}
        used.add(known.id)
        taken.add(known.id)
        return {...known, ...(g.brief !== undefined ? {brief:taskBrief(g.brief)} : {}), ...(g.links !== undefined ? {links:urls(g.links,'Task links',MAX_TASK_LINKS)} : {})}
      }).filter(Boolean)
    }
    return this.write(p)
  }
  // Any other part of the file: sources, decisions, risks, whatever the project needs.
  section(id, heading, body) {
    const p = this.require(id), h = string(heading,'Heading',80).replace(/^#+\s*/,'')
    if (KNOWN.includes(h.toLowerCase())) bad(`${h} has its own action.`)
    const text = String(body ?? '').trim()
    if (text.length > 20000) bad('A section is at most 20000 characters.')
    const at = p.sections.findIndex(s => s.heading.toLowerCase() === h.toLowerCase())
    if (!text) { if (at >= 0) p.sections.splice(at, 1) }
    else if (at >= 0) p.sections[at] = {heading:h, body:text}
    else p.sections.push({heading:h, body:text})
    return this.write(p)
  }
  // Only active projects count against the cap: archiving one frees its place, and
  // bringing one back needs a free place, or it stays archived.
  active() { return this.all().filter(p => !p.archived).length }
  archive(id, archived = true) {
    const p = this.require(id)
    if (!archived && p.archived && this.active() >= MAX_PROJECTS) bad(`Fleet keeps up to ${MAX_PROJECTS} active projects. Archive one before restoring this one.`, 409)
    p.archived = !!archived
    return this.write(p)
  }
  // One deliverable: its state and note, its brief, and its links. `links` replaces the
  // list; `addLinks` adds to it (what an agent's pull request does).
  deliverable(id, deliverableId, { state, note, brief, links, addLinks } = {}) {
    const p = this.require(id), d = p.deliverables.find(x => x.id === deliverableId)
    if (!d) bad('Deliverable not found. Read the project first.')
    if (state !== undefined) { if (!STATES.includes(state)) bad(`State must be one of: ${STATES.join(', ')}.`); d.state = state }
    if (note !== undefined) d.note = line(String(note).slice(0, 300))
    if (brief !== undefined) d.brief = taskBrief(brief)
    if (links !== undefined) d.links = urls(links,'Task links',MAX_TASK_LINKS)
    if (addLinks !== undefined) d.links = [...new Set([...(d.links || []), ...urls(addLinks,'Task links',MAX_TASK_LINKS)])].slice(0, MAX_TASK_LINKS)
    this.write(p)
    return d
  }
  note(id, text) {
    const p = this.require(id)
    p.log = [...p.log, {at:Date.now(), text:line(string(text,'Note',1000))}].slice(-MAX_LOG)
    this.write(p)
    return p.log.at(-1)
  }
  markdown(id) { return fs.readFileSync(this.require(id).file, 'utf8') }
}
const progress = p => ({total:p.deliverables.length, done:p.deliverables.filter(d => d.state === 'done').length, doing:p.deliverables.filter(d => ['doing','review'].includes(d.state)).length})
// Going back to 0.54.0 or before, which reads the id comments as part of a title or note:
// with Fleet stopped, every project file loses its ids and every Day item goes back to
// naming its deliverable by title slug, as that version does.
//   node projects.js strip-ids [state directory]
function rollback(directory) {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(path.join(directory, 'server.lock'), 'utf8')).pid)
    process.kill(pid, 0)
    throw Object.assign(new Error(`Fleet is running (PID ${pid}). Stop it first.`), {running:true})
  } catch (error) { if (error.running) throw error }
  const dir = path.join(directory, 'projects'), slugs = {}
  let files = 0, items = 0
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.md')) continue
    const file = path.join(dir, name), text = fs.readFileSync(file, 'utf8')
    try { const p = parse(text, file); slugs[p.id] = Object.fromEntries(p.deliverables.filter(d => d.id).map(d => [d.id, legacyId(d.title)])) } catch {}
    const stripped = stripIds(text)
    if (stripped !== text) { fs.writeFileSync(`${file}.tmp`, stripped, {mode:fs.statSync(file).mode & 0o777}); fs.renameSync(`${file}.tmp`, file); files++ }
  }
  const store = path.join(directory, 'sessions.json')
  if (fs.existsSync(store)) {
    const data = JSON.parse(fs.readFileSync(store, 'utf8'))
    for (const s of data.sessions || []) for (const item of s.dayBoard?.items || []) {
      const to = slugs[item.projectId]?.[item.deliverableId]
      if (to) { item.deliverableId = to; items++ }
    }
    if (items) { fs.writeFileSync(`${store}.tmp`, JSON.stringify(data), {mode:0o600}); fs.renameSync(`${store}.tmp`, store) }
  }
  fs.rmSync(path.join(dir, '.legacy-ids.json'), {force:true})
  return {files, items}
}
module.exports = { ProjectStore, STATES, progress, render, parse, stamp, assignIds, stripIds, rollback }
if (require.main === module && process.argv[2] === 'strip-ids') {
  const {files, items} = rollback(process.argv[3] || require('./paths').stateDir())
  console.log(`Removed deliverable ids from ${files} project file(s) and relinked ${items} Day item(s) by title.`)
}
