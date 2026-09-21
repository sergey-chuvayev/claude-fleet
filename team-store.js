'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { TEAMS, boundedModel, roleLimits } = require('./teams')

const TOOL_OPTIONS = ['Read','Glob','Grep','Bash','Write','Edit','MultiEdit','NotebookEdit','WebSearch','WebFetch']
const bad = message => { throw Object.assign(new Error(message), {status:400}) }
function string(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`${label} must contain 1–${max} characters.`)
  return value.trim()
}
function validateTeam(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('A team is required.')
  const id=string(input.id,'Team ID',60)
  if (!/^[a-z][a-z0-9-]*$/.test(id) || ['constructor','prototype','__proto__'].includes(id)) bad('Use a lowercase team ID with letters, numbers and hyphens.')
  const name=string(input.name,'Team name',80), description=string(input.description,'Team description',500)
  if (!input.roles || typeof input.roles!=='object' || Array.isArray(input.roles)) bad('Roles must be an object.')
  const entries=Object.entries(input.roles)
  if (entries.length<3 || entries.length>8) bad('A team needs 3–8 roles, including its manager.')
  const manager=string(input.manager,'Manager role',40), roles={}
  for (const [key,role] of entries) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) bad('Role IDs must use lowercase letters, numbers and hyphens.')
    if (!role || typeof role!=='object') bad(`Invalid role: ${key}`)
    const model=string(role.model || 'inherit',`${key} model`,80)
    if (!/^[\w.:[\]-]+$/.test(model)) bad(`Invalid model for ${key}.`)
    if (!Array.isArray(role.tools) || role.tools.some(t=>!TOOL_OPTIONS.includes(t))) bad(`Choose supported tools for ${key}.`)
    const defaults=roleLimits(key,key===manager)
    const maxTurns=role.maxTurns ?? defaults.maxTurns,effort=role.effort ?? defaults.effort
    if (!Number.isInteger(maxTurns) || maxTurns<1 || maxTurns>100) bad(`${key} turn limit must be between 1 and 100.`)
    if (!['low','medium','high','xhigh','max'].includes(effort)) bad(`Choose a supported effort for ${key}.`)
    roles[key]={description:string(role.description,`${key} purpose`,500),prompt:string(role.prompt,`${key} instructions`,12000),model:boundedModel(model,'inherit'),maxTurns,effort,tools:[...new Set(role.tools)]}
  }
  if (!Object.hasOwn(roles,manager)) bad('Choose an existing role as manager.')
  if (!Array.isArray(input.workflow?.reviewers) || !input.workflow.reviewers.length) bad('Choose at least one independent verification role.')
  const reviewers=[...new Set(input.workflow.reviewers)]
  if (reviewers.some(r=>typeof r!=='string' || !Object.hasOwn(roles,r) || r===manager)) bad('Verification roles must exist and cannot be the manager.')
  if (!entries.some(([r])=>r!==manager && !reviewers.includes(r))) bad('Include a worker role separate from the verification roles.')
  const maxAttempts=input.workflow.maxAttempts ?? 3, budgetUsd=input.workflow.budgetUsd ?? 10
  if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>10) bad('Attempts must be between 1 and 10.')
  if (typeof budgetUsd!=='number' || !Number.isFinite(budgetUsd) || budgetUsd<0.1 || budgetUsd>1000) bad('Usage cap must be between $0.10 and $1,000.')
  // Manager is a coordinator. Verification can run commands but cannot use edit tools.
  roles[manager].tools=roles[manager].tools.filter(t=>['Read','Glob','Grep','WebSearch','WebFetch'].includes(t))
  for (const key of reviewers) roles[key].tools=roles[key].tools.filter(t=>!['Write','Edit','MultiEdit','NotebookEdit'].includes(t))
  return {id,name,description,manager,roles,workflow:{reviewers,maxAttempts,budgetUsd}}
}
function summary(team) {
  return {id:team.id,name:team.name,description:team.description,manager:team.manager,custom:!!team.custom,roles:Object.entries(team.roles).map(([name,r])=>({name,description:r.description,model:r.model || null}))}
}
class TeamStore {
  constructor(directory) {
    this.file=path.join(directory,'teams.json')
    this.custom=new Map()
    try {
      const saved=JSON.parse(fs.readFileSync(this.file,'utf8'))
      if (saved.version!==1 || !Array.isArray(saved.teams) || saved.teams.length>50) throw new Error('Unsupported team store')
      for (const raw of saved.teams) { const team=validateTeam(raw); if (Object.hasOwn(TEAMS,team.id) || this.custom.has(team.id)) throw new Error('Duplicate team ID'); this.custom.set(team.id,team) }
    } catch (error) { if (error.code!=='ENOENT') throw new Error(`Cannot read Fleet teams: ${error.message}`) }
  }
  get(id) { const team=this.custom.get(id) || (Object.hasOwn(TEAMS,id) ? TEAMS[id] : null); return team ? structuredClone(team) : null }
  list() { return [...Object.values(TEAMS),...[...this.custom.values()].map(t=>({...t,custom:true}))].map(summary) }
  save(input) {
    const team=validateTeam(input)
    if (Object.hasOwn(TEAMS,team.id)) bad('Built-in teams are read-only. Save a copy with a new ID.')
    if (!this.custom.has(team.id) && this.custom.size>=50) bad('Keep at most 50 custom teams.')
    const next=new Map(this.custom);next.set(team.id,team)
    const tmp=`${this.file}.${randomUUID()}.tmp`
    try {fs.writeFileSync(tmp,JSON.stringify({version:1,teams:[...next.values()]}),{mode:0o600});fs.renameSync(tmp,this.file)}
    finally {try{fs.unlinkSync(tmp)}catch{}}
    this.custom=next
    return structuredClone(team)
  }
}
module.exports={TeamStore,validateTeam,TOOL_OPTIONS}
