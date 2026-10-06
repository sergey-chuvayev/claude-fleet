'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { gitBranch, turnSummary, toolTarget, transcriptFor, transcriptFile } = require('./fleet')
const { history, clampInput, resultText, MAX_TOOL_RESULT, QUIET_RESULT } = require('./history')
const codexEngine = require('./codex')
const { askReason, normaliseMode, MODES, DEFAULT_MODE, DEFAULT_NEW_MODE } = require('./permissions')
const { stateDir, defaultCwd } = require('./paths')
const { getTeam, compile, boundedModel } = require('./teams')
const { TeamStore } = require('./team-store')
const { UsageTracker } = require('./usage')
const { Dispatcher } = require('./dispatch')
const routing = require('./routing')
const tasks = require('./tasks')
const ownerReview = require('./owner-review')
const day = require('./day')
const { ProjectStore, progress: projectProgress, stamp } = require('./projects')
const projectAgent = require('./project-agent')
const dayAgent = require('./day-agent')
const worktrees = require('./worktree')

const { resolveReferences, referencePrompt } = require('./references')

const ACTIVE = new Set(['starting', 'running', 'approval', 'stopping'])
// Used until a live run reports the runtime's own list, which replaces it.
// What a single agent runs on when the operator picks "Fleet default".
const DEFAULT_AGENT_MODEL = 'claude-opus-5-5'
const FALLBACK_MODELS = [
  { value: '', displayName: 'Fleet default', description: 'Team manager model, or Opus 5.5 for a single agent; without [1m]' },
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
]
const MAX_MESSAGES = 200
// Sweeps run only inside working hours: an empty office does not need checking every
// 45 minutes, and the operator is not there to answer what a sweep would find.
const DAY_SWEEP_MINUTES = Math.max(10, Number(process.env.CLAUDE_FLEET_DAY_SWEEP_MIN) || 45)
const DAY_HOURS = [8, 20]
// Answers and triage come in bursts. Waiting this long after the last one turns ten
// clicks into one run instead of ten.
const DAY_RESUME_DELAY_MS = 20000
const DAY_ANSWER_DELAY_MS = 4000
const HELD_CHECK_MS = 3000
const MAX_DAY_SUBAGENTS = 40
const DAY_MAX_FAILURES = 3
// Pasted images: a handful per message, bounded in size, only the formats the API
// accepts, and sniffed by magic bytes because the client's declared type is a claim.
const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
function sniffImage(buffer) {
  if (buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
// A delegation can run a sub-agent through an unbounded number of tool calls; capped here
// so a long-running one cannot grow the session file without limit.
const MAX_DELEGATION_STEPS = 200
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error }
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must contain 1–${max} characters.`)
  return value.trim()
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[\w-]{8,80}$/.test(value)) fail('A valid request ID is required.')
  return value
}

class ManagedSessions extends EventEmitter {
  constructor({ directory = stateDir(), queryFactory, externalSessions = () => [], queue, modelRouter = routing.route, findTranscript = transcriptFile, codex = codexEngine } = {}) {
    super()
    this.findTranscript = findTranscript
    // Codex, the other engine: its saved sessions and how to run a turn.
    this.codex = codex
    this.directory = directory
    this.queryFactory = queryFactory || (async args => (await import('@anthropic-ai/claude-agent-sdk')).query(args))
    this.modelRouter = modelRouter
    this.gatewaySettings = new (require('./settings').GatewaySettings)({directory})
    this.externalSessions = externalSessions
    this.sessions = new Map()
    this.runs = new Map()
    this.pending = new Map()
    this.closed = false
    // Admission control. Off by default: with the queue disabled, a turn over the limit
    // is refused exactly as it always was, so an existing install behaves identically
    // until the operator opts in with CLAUDE_FLEET_QUEUE=1.
    this.queueing = queue ?? process.env.CLAUDE_FLEET_QUEUE === '1'
    this.dispatch = new Dispatcher({ limit: process.env.CLAUDE_FLEET_CONCURRENCY })
    this.models = null
    this.defaultApprovalMode = DEFAULT_NEW_MODE
    this.saveTimer = null
    // Plan windows belong to the account, so one tracker serves every session and
    // outlives all of them. It is deliberately not persisted: a utilisation figure from
    // before a restart describes a window that has probably already turned over.
    this.usage = new UsageTracker()
    this.dayTimers = new Map()
    this.sweepTimer = setInterval(() => this.sweepDays(), DAY_SWEEP_MINUTES * 60000)
    this.heldTimer = setInterval(() => this.releaseHeld(), HELD_CHECK_MS)
    this.heldTimer.unref?.()
    this.sweepTimer.unref?.()
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = path.join(directory, 'sessions.json')
    this.attachmentsDir = path.join(directory, 'attachments')
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 })
    this.lock = path.join(directory, 'server.lock')
    this.acquireLock()
    try {
      this.teams = new TeamStore(directory)
      this.projects = new ProjectStore(directory)
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Unsupported session store format')
        if (data.queueSettings) {
          if (queue===undefined && process.env.CLAUDE_FLEET_QUEUE===undefined) this.queueing=data.queueSettings.enabled===true
          if (process.env.CLAUDE_FLEET_CONCURRENCY===undefined) this.dispatch.setLimit(data.queueSettings.limit)
          this.dispatch.setPaused(this.queueing && data.queueSettings.paused===true)
        }
        if (MODES.includes(data.defaultApprovalMode)) this.defaultApprovalMode = data.defaultApprovalMode
        for (const s of data.sessions) {
          if (!s.id || !Array.isArray(s.messages)) throw new Error('Invalid saved session')
          if (ACTIVE.has(s.status)) { s.status = 'stopped'; s.error = 'Fleet restarted. Send a message to continue this conversation.' }
          // The order sessions were waiting in lives in memory and does not survive a
          // restart, so a reloaded session cannot be left claiming a place it no longer
          // holds. It says so rather than sitting at "queued" forever, waiting for a
          // turn that nothing will ever hand it.
          if (s.status === 'queued') { s.status = 'stopped'; s.error = 'Fleet restarted while this was waiting for a free agent. Send a message to start it.' }
          tasks.interrupt(s)
          interruptSubagents(s)
          s.approvals = []
          s.currentTool = null
          for (const m of s.messages) if (m.role === 'tool' && m.status === 'running') m.status = 'interrupted'
          s.approvalMode = normaliseMode(s.approvalMode)
          this.sessions.set(s.id, s)
        }
      }
    } catch (error) { this.releaseLock(); throw new Error(`Cannot read Fleet session store: ${error.message}`) }
  }
  // The lock used to hold a bare PID. It now holds {pid, port} so that a second
  // `claude-fleet` can put the running dashboard on screen instead of only naming the
  // process that beat it to the lock. A bare PID is still read: the file outlives an
  // upgrade, and a stale one must not read as corrupt.
  readLock() {
    const raw = fs.readFileSync(this.lock, 'utf8').trim()
    try {
      const parsed = JSON.parse(raw)
      if (Number.isInteger(parsed?.pid) && parsed.pid > 0) return { pid: parsed.pid, port: Number(parsed.port) || null }
    } catch {}
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? { pid, port: null } : null
  }
  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        const held = this.readLock()
        if (!held) throw new Error(`Invalid Fleet lock file; inspect ${this.lock}.`)
        try { process.kill(held.pid, 0) }
        catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(this.lock); continue } }
        // Carries the holder so main() can open it rather than print and exit 1. Being
        // already running is the normal case, not a failure.
        const conflict = new Error(`Fleet controls are already running (PID ${held.pid})`)
        conflict.code = 'FLEET_ALREADY_RUNNING'
        conflict.holder = held
        throw conflict
      }
    }
    throw new Error('Cannot acquire Fleet session lock')
  }
  // Called once the server knows which port it actually got, which is not always the
  // one it asked for: the listen path walks upwards past anything already bound.
  recordPort(port) {
    try { fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, port }), { mode: 0o600 }) } catch {}
  }
  releaseLock() {
    try { if (this.readLock()?.pid === process.pid) fs.unlinkSync(this.lock) } catch {}
  }
  save() {
    clearTimeout(this.saveTimer); this.saveTimer = null
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({version:1,queueSettings:{enabled:this.queueing,limit:this.dispatch.limit,paused:this.dispatch.paused},defaultApprovalMode:this.defaultApprovalMode,sessions:[...this.sessions.values()].map(s => ({...s,approvals:[]}))}), {mode:0o600})
    fs.renameSync(tmp, this.file)
  }
  changed(s, immediate = false) {
    s.updatedAt = Date.now()
    if (immediate) this.save()
    else if (!this.saveTimer) this.saveTimer = setTimeout(() => {
      try { this.save() } catch (error) { this.emit('storage-error', error) }
    }, 750)
    this.emit('change', s.id)
  }
  get(id) { const s = this.sessions.get(id); if (!s) fail('Session not found.',404); return s }
  detail(id) {
    const s=this.get(id)
    if (ownerReview.refresh(s)) this.changed(s,true)
    return structuredClone(s)
  }
  summaries() {
    return [...this.sessions.values()].map(s => ({
      managedId:s.id, sessionId:s.sessionId, shortId:(s.sessionId || s.id).slice(0,8), engine:s.engine || 'claude',
      name:s.name, title:s.name, branch:gitBranch(s.cwd), cwd:s.cwd, cwdShort:s.cwd.replace(os.homedir(),'~'),
      state:ACTIVE.has(s.status) && s.status !== 'approval' ? 'busy' : 'idle',
      managedStatus:s.status, managed:true, alive:ACTIVE.has(s.status), pid:null,
      lastActivity:s.updatedAt, startedAt:s.createdAt, lastPrompt:s.lastPrompt,
      latestResponse:[...s.messages].reverse().find(m => m.role === 'assistant')?.text || null,
      model:s.model, contextTokens:s.contextTokens || null, contextLimit:s.contextLimit || 200000,
      permissionMode:'default', approvalMode:s.approvalMode || DEFAULT_MODE, selectedModel:s.selectedModel || '', messages:s.messages.filter(m=>m.role!=='tool').length, links:linksFromMessages(s.messages), approvals:s.approvals.length,
      turn:turnSummary(managedEvents(s.messages), { working: ACTIVE.has(s.status) && s.status !== 'approval' }),
      error:s.error, currentTool:s.currentTool, resumeCmd:s.sessionId ? (s.engine === 'codex' ? `codex resume ${s.sessionId}` : `claude --resume ${s.sessionId}`) : null, forkPending:!!s.forkPending, waitingForRelease:!!s.waitingForRelease, continuedFrom:s.continuedFrom || null,
      kind:s.kind || 'agent', teamId:s.teamId || null, teamName:s.teamName || null, taskProgress:tasks.progress(s), dayProgress:day.progress(s), dayDate:s.dayBoard?.date || null, projectId:s.projectId || null, parentDayId:s.parentDayId || null, itemId:s.itemId || null, threadOpen:s.kind === 'thread' ? !this.dayFor(s)?.dayBoard?.items.find(i => i.id === s.itemId)?.thread?.closed && !!this.dayFor(s) : null, tokenUsage:s.tokenUsage || null,
      worktreeBranch:s.worktree?.branch || null, costUsd:s.costUsd || 0,
      // 0 unless this session is waiting for an agent slot, so a row can say "3rd in
      // line" rather than the bare "queued" that tells the operator nothing.
      queuePosition:this.dispatch.position(s.id),
    }))
  }
  // The queue as the dashboard needs it: what it is set to, and what is waiting.
  queueState() {
    const { limit, paused, waiting } = this.dispatch.snapshot()
    return { enabled:this.queueing, limit, paused, running:this.runs.size, waiting:waiting.length }
  }
  // Raising the limit or resuming can release work immediately, so both dispatch.
  setQueue({ limit, paused, enabled } = {}) {
    if (enabled!==undefined && typeof enabled!=='boolean') fail('Queue enabled must be true or false.')
    if (paused!==undefined && typeof paused!=='boolean') fail('Queue paused must be true or false.')
    if (limit!==undefined && (!Number.isInteger(limit) || limit<1 || limit>8)) fail('Choose 1–8 concurrent tasks.')
    if (enabled===false && this.dispatch.waiting.length) fail('Stop queued tasks before disabling the queue.',409)
    if (paused===true && !(enabled ?? this.queueing)) fail('Enable the queue before pausing dispatch.')
    const previous={enabled:this.queueing,limit:this.dispatch.limit,paused:this.dispatch.paused}
    if (enabled!==undefined) this.queueing=enabled
    if (limit !== undefined) this.dispatch.setLimit(limit)
    if (paused !== undefined) this.dispatch.setPaused(paused)
    if (!this.queueing) this.dispatch.setPaused(false)
    try {this.save()} catch(error) {
      this.queueing=previous.enabled;this.dispatch.setLimit(previous.limit);this.dispatch.setPaused(previous.paused)
      throw error
    }
    this.dispatchNext()
    this.emit('change','queue')
    return this.queueState()
  }
  // What a new agent starts with when the operator does not pick a mode at launch.
  // Agents that already exist keep the mode they have.
  setDefaultApprovalMode({ mode } = {}) {
    if (!MODES.includes(mode)) fail('Choose ask, auto, or all.')
    const previous = this.defaultApprovalMode
    this.defaultApprovalMode = mode
    try {this.save()} catch(error) {this.defaultApprovalMode = previous; throw error}
    return this.defaultApprovalMode
  }
  create(body) {
    const rid = requestId(body.requestId)
    const previous = [...this.sessions.values()].find(s => s.createRequestId === rid)
    if (previous) return previous
    if (this.closed) fail('Fleet is shutting down.',503)
    if (this.sessions.size >= 100) fail('Fleet has reached its 100-session limit.',409)
    // A Day is not about a project, but its directory decides which project-scoped
    // connectors it can reach, so it stays where the operator's last Day ran.
    if (body.kind === 'day' && !body.cwd) body = {...body,cwd:process.env.CLAUDE_FLEET_DAY_CWD || [...this.sessions.values()].filter(s => s.kind === 'day').sort((a,b) => b.createdAt-a.createdAt)[0]?.cwd || defaultCwd()}
    let cwd = text(body.cwd,'Project directory',4096)
    if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1))
    if (!path.isAbsolute(cwd)) fail('Use an absolute project path or ~/path.')
    try { cwd = fs.realpathSync(cwd); if (!fs.statSync(cwd).isDirectory()) fail('Project path must be a directory.') }
    catch { fail('Project directory does not exist or is not accessible.') }
    if (body.kind === 'day') return this.createDay(body, {rid, cwd, resume:body.resumeSessionId || null})
    const hasImages = Array.isArray(body.images) && body.images.length > 0
    const prompt = hasImages && !(body.prompt || '').trim() ? '' : text(body.prompt,'Message',16000)
    const name = body.name?.trim() ? text(body.name,'Session name',100) : (prompt || 'Image').slice(0,70)
    // A conversation started in a terminal. A stopped one Fleet takes over as it is; one
    // still open in its terminal is forked, so Fleet continues an identical copy while
    // the terminal keeps its own. Either way the console starts with the conversation
    // so far, read from the transcript.
    let resume = null, fork = false, earlier = []
    // Which agent runs it: Claude, or Codex where it is installed. Codex runs single
    // agents; teams, Days and project managers are built on Claude's own features.
    const engine = body.engine === 'codex' ? 'codex' : 'claude'
    if (engine === 'codex') {
      if (!this.codex.available()) fail('Codex is not installed on this machine. Install it with npm install -g @openai/codex, then sign in with codex login.',409)
      if (body.teamId) fail('Teams run on Claude. Start a Codex agent without a team.',409)
    }
    if (body.resumeSessionId && engine === 'codex') {
      const source = this.codex.sessions().find(x => x.sessionId === body.resumeSessionId)
      if (!source) fail('That Codex session is not on this machine.',409)
      if (source.alive) fail('Codex is still working on that session. Continue it here once it finishes.',409)
      const real = dir => { try { return fs.realpathSync(dir) } catch { return dir } }
      if (real(source.cwd || '') !== cwd) fail('That session is not in this project.',409)
      if ([...this.sessions.values()].some(x => x.sessionId === source.sessionId)) fail('This conversation is already managed by Fleet.',409)
      resume = source.sessionId
      try { earlier = this.codex.history(source.transcript,{limit:MAX_MESSAGES-20}).messages } catch {}
    } else if (body.resumeSessionId) {
      const source = this.externalSessions().find(s => s.sessionId === body.resumeSessionId)
      fork = body.fork === true
      if (!source) fail('That session is not on this machine.',409)
      if (source.alive && !fork) fail('That session is still open in its terminal. Continue a copy of it instead, or close it there first.',409)
      // The transcript records the folder as Claude saw it; compare real paths, so a
      // symlinked project (or macOS's /var and /private/var) is the same place.
      const real = dir => { try { return fs.realpathSync(dir) } catch { return dir } }
      if (real(source.cwd || '') !== cwd) fail('That session is not in this project.',409)
      if (!fork && [...this.sessions.values()].some(s => s.sessionId === source.sessionId)) fail('This conversation is already managed by Fleet.',409)
      resume = source.sessionId
      const file = this.findTranscript(resume)
      if (file) try { earlier = history(file,{alive:false,limit:MAX_MESSAGES-20}).messages } catch {}
    }
    this.checkCapacity()
    // A team turns this conversation into an initiative: the manager takes the main thread
    // and the work happens on a branch of its own rather than in the operator's checkout.
    const team = body.teamId ? this.teams.get(text(body.teamId,'Team',60)) : null
    if (body.teamId && !team) fail('That team does not exist.')
    if (team && resume) fail('A resumed conversation cannot be given a team.',409)
    const id = randomUUID()
    const worktree = team ? worktrees.create({cwd,id,name}) : null
    const projectId = body.projectId ? this.projects.require(text(body.projectId,'Project',100)).id : null
    const s = {id,projectId,sessionId:resume,...(engine === 'codex' ? {engine} : {}),...(fork ? {forkPending:true,forkedFrom:resume} : {}),...(resume ? {continuedFrom:resume} : {}),name,cwd:worktree ? worktree.path : cwd,createRequestId:rid,createdAt:Date.now(),updatedAt:Date.now(),status:'idle',approvalMode:body.approvalMode===undefined ? this.defaultApprovalMode : normaliseMode(body.approvalMode),selectedModel:modelChoice(body.model),messages:[],approvals:[],model:null,contextTokens:null,error:null,currentTool:null,requestIds:[],queue:[],kind:team ? 'initiative' : 'agent',teamId:team?.id || null,teamName:team?.name || null,teamSnapshot:team ? structuredClone(team) : null,taskBoard:team?.workflow ? {tasks:[],delegations:[]} : null,worktree}
    if (ownerReview.enabled(s)) {
      try {s.reviewBaseCommit=ownerReview.snapshot(s).commit;s.ownerRequest=prompt || 'Implement the request in the attached images.'}
      catch(error) {worktrees.remove(worktree);throw error}
    }
    s.messages = earlier
    this.sessions.set(s.id,s)
    try { this.send(s.id,{message:prompt,images:body.images,requestId:rid}) }
    catch (error) { this.sessions.delete(s.id); if (worktree) worktrees.remove(worktree); throw error }
    return s
  }
  // One Day per date. Starting a new one carries yesterday's unfinished items and their
  // open questions forward; the old session stays as the record of that day.
  createDay(body, {rid, cwd, resume}) {
    if (resume) fail('A Day starts fresh; it cannot resume another conversation.',409)
    if (body.teamId) fail('A Day does not take a team.')
    const date = day.dateOf()
    const days = [...this.sessions.values()].filter(s => s.kind === 'day').sort((a,b) => b.createdAt-a.createdAt)
    if (days.some(s => s.dayBoard?.date === date)) fail('Today already has a Day. Open it from the list.',409)
    this.checkCapacity()
    const id = randomUUID()
    const s = {id,sessionId:null,name:body.name?.trim() ? text(body.name,'Session name',100) : `Day ${date}`,cwd,createRequestId:rid,createdAt:Date.now(),updatedAt:Date.now(),status:'idle',approvalMode:body.approvalMode===undefined ? this.defaultApprovalMode : normaliseMode(body.approvalMode),selectedModel:modelChoice(body.model),messages:[],approvals:[],model:null,contextTokens:null,error:null,currentTool:null,requestIds:[],queue:[],kind:'day',teamId:null,teamName:null,teamSnapshot:null,taskBoard:null,dayBoard:days[0]?.dayBoard ? day.carryOver(days[0].dayBoard,date) : {date,items:[],cursors:{}},worktree:null}
    this.sessions.set(s.id,s)
    const note = (body.prompt || '').trim() ? `\n\nThe operator adds: ${text(body.prompt,'Message',8000)}` : ''
    // Yesterday's threads stay with yesterday's board: close the ones on carried items so
    // nothing they do lands on a board that is no longer in use, and so they show up in
    // Sessions as finished conversations.
    if (days[0]?.dayBoard) {
      for (const item of days[0].dayBoard.items) if (item.thread && !item.thread.closed) {
        item.thread.closed = Date.now()
        if (this.runs.has(item.thread.sessionId)) { try { this.stop(item.thread.sessionId) } catch {} }
      }
      this.changed(days[0])
    }
    s.dayChecks = {lastAt:Date.now(),everyMin:DAY_SWEEP_MINUTES,hours:DAY_HOURS}
    try { this.send(s.id,{message:'Start my day',runPrompt:dayAgent.promptFor('intake')+note,requestId:rid}) }
    catch (error) { this.sessions.delete(s.id); throw error }
    return s
  }
  // The operator's side of the board: their own items, triage, and answers. Each change
  // hands the board back to the agent, debounced, as a run that starts from the board.
  dayAction(id, body) {
    const s = this.get(id)
    if (s.kind !== 'day') fail('This session is not a Day.')
    const before = structuredClone(s.dayBoard)
    let result
    try {
      if (body.op === 'add') result = day.act(s,{...body.item,action:'add'},'operator')
      else if (body.op === 'answer') {
        result = day.answer(s,text(body.itemId,'Item',100),text(body.needId,'Question',100),body.answer,body.decision)
        if (result.need.kind === 'launch' && ['approve','edit'].includes(result.need.decision)) this.launchFromDay(s,result,body)
        // An agent's report is settled here, not by the Day agent: Done closes the item,
        // anything else leaves it open. No run is needed for that.
        if (result.need.report) {
          if (result.need.decision === 'choose' && result.need.answer === 'Done') { day.triage(s,result.item.id,{status:'done'}); this.reportToProject(result.item,'done') }
          this.changed(s,true)
          this.syncThreads(s)
          return result
        }
      }
      else if (body.op === 'triage') {
        if (body.projectId) this.projects.require(text(body.projectId,'Project',100))
        result = day.triage(s,text(body.itemId,'Item',100),body)
      }
      else if (body.op === 'sweep') { this.dayRun(s,'sweep'); return {queued:true} }
      else if (body.op === 'thread') { const t = this.threadFor(s,body); this.changed(s,true); return {threadId:t.id} }
      else fail('Unknown Day action.')
      this.changed(s,true)
    } catch (error) { s.dayBoard = before; throw error }
    // An answer is someone waiting for a response; triage is a burst of clicks.
    this.syncThreads(s)
    this.scheduleDayResume(s, body.op === 'answer' ? DAY_ANSWER_DELAY_MS : DAY_RESUME_DELAY_MS)
    return result
  }
  // When an agent launched from a Day item finishes a turn (or stops on an error), it
  // reports back on that item: its last words in the log, any pull request it opened in
  // the item's links, and a question that puts the item in Waiting on you. One report per
  // reply: a newer one replaces an unanswered older one.
  reportToDay(s) {
    if (s.status !== 'idle' && s.status !== 'error') return
    for (const d of this.sessions.values()) {
      if (d.kind !== 'day' || !d.dayBoard) continue
      const item = d.dayBoard.items.find(i => (i.launched || []).includes(s.id))
      if (!item || item.status === 'dropped') continue
      const last = [...s.messages].reverse().find(m => m.role === 'assistant')
      const key = s.status === 'error' ? `error:${s.updatedAt}` : last?.id
      if (!key || item.reported?.[s.id] === key) return
      item.reported = {...(item.reported || {}), [s.id]:key}
      const prs = linksFromMessages(s.messages).map(l => l.url).filter(u => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u))
      item.links = [...new Set([...item.links, ...prs])].slice(0, 20)
      const words = (s.status === 'error' ? `It stopped with an error: ${s.error || 'unknown error'}` : last.text || 'Finished.').replace(/\s+/g,' ').trim()
      const gist = words.length > 280 ? words.slice(0, 279) + '…' : words
      this.reportToProject(item, s.status === 'error' ? 'stopped' : 'finished', gist, prs)
      item.log.push({at:Date.now(), text:`${s.status === 'error' ? 'Agent stopped' : 'Agent finished'}: ${gist}`.slice(0, 2000)})
      item.log = item.log.slice(-50)
      item.needs = item.needs.filter(n => !(n.report && n.answer === undefined))
      const opened = prs.length ? ` and opened ${prs.length === 1 ? 'a pull request' : `${prs.length} pull requests`}` : ''
      const need = day.act(d, {action:'ask', itemId:item.id, kind:'choose', question:`${s.status === 'error' ? 'The agent stopped' : `The agent finished${opened}`}: ${gist}`.slice(0, 1000), options:['Done','Needs more work']})
      need.report = s.id
      this.changed(d, true)
      return
    }
  }
  // "Agent does it", carried out by Fleet rather than by the Day: the Day cannot edit
  // files or start sessions, so an approved brief becomes an ordinary Fleet session, the
  // same as one launched from the Work queue. The question's id is the request id, so a
  // double click cannot launch twice.
  // A project task's story goes back to its project: what the agent did, the PRs it
  // opened (on the deliverable), and the operator closing it on Today.
  reportToProject(item, what, gist = '', prs = []) {
    if (!item.projectId || !this.projects.get(item.projectId)) return
    try {
      const short = gist.length > 300 ? gist.slice(0, 299) + '…' : gist
      const text = what === 'done' ? `Marked done on Today: ${item.title}` : `Agent ${what} on "${item.title}"${prs.length ? ` (${prs.join(', ')})` : ''}: ${short}`
      this.projects.note(item.projectId, text.slice(0, 1000))
      if (item.deliverableId && prs.length) this.projects.deliverable(item.projectId, item.deliverableId, {addLinks:prs})
      this.emit('change','projects')
    } catch (error) { this.emit('storage-error', error) }
  }
  launchFromDay(s, {item, need}, body) {
    const plan = need.launch
    const prompt = withProject(need.decision === 'edit' ? need.answer : need.draft, item, item.projectId && this.projects.get(item.projectId))
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : plan.cwd
    const teamId = body.teamId !== undefined ? body.teamId || null : plan.teamId || null
    const launched = this.create({cwd,prompt,name:plan.name || item.title.slice(0,100),...(item.projectId && this.projects.get(item.projectId) ? {projectId:item.projectId} : {}),...(teamId ? {teamId} : {}),...(plan.model ? {model:plan.model} : {}),approvalMode:s.approvalMode,requestId:need.id})
    need.launched = launched.id
    item.launched = [...(item.launched || []), launched.id].slice(-5)
    item.status = 'in_progress'
    day.act(s,{action:'update',itemId:item.id,note:`Launched ${teamId ? `${launched.teamName || teamId} initiative` : 'an agent'} in ${cwd.replace(os.homedir(),'~')}.`},'operator')
  }
  // A conversation about one item: started on the first question, continued after that.
  // It is its own session so a long discussion of one PR never fills the Day's context
  // or waits behind its checks.
  threadFor(dayS, body) {
    const item = day.itemFor(dayS, text(body.itemId,'Item',100))
    const message = text(body.message,'Message',16000)
    const rid = requestId(body.requestId || randomUUID())
    const existing = item.thread && this.sessions.get(item.thread.sessionId)
    if (existing) { this.send(existing.id,{message,requestId:rid}); return existing }
    if (['done','dropped'].includes(item.status)) fail('This item is settled. Move it back to Today to discuss it.',409)
    this.checkCapacity()
    const {cwd, known} = this.repoFor(dayS, item)
    const id = randomUUID()
    const t = {id,sessionId:null,name:item.title.slice(0,100),cwd,createRequestId:rid,createdAt:Date.now(),updatedAt:Date.now(),status:'idle',approvalMode:dayS.approvalMode,selectedModel:'',messages:[],approvals:[],model:null,contextTokens:null,error:null,currentTool:null,requestIds:[],queue:[],kind:'thread',parentDayId:dayS.id,itemId:item.id,teamId:null,teamName:null,teamSnapshot:null,taskBoard:null,worktree:null}
    this.sessions.set(id,t)
    item.thread = {sessionId:id,at:Date.now()}
    try { this.send(id,{message,runPrompt:dayAgent.threadPrompt(dayS,item,message,{cwd:cwd.replace(os.homedir(),'~'),repoKnown:known}),requestId:rid}) }
    catch (error) { this.sessions.delete(id); delete item.thread; throw error }
    return t
  }
  // The repository an item is about, from a GitHub link and a folder of that name beside
  // the Day's directory (~/projects/desktop-allo for desktop-allo#2951). Otherwise the
  // Day's own directory, and the thread is told it is guessing.
  repoFor(dayS, item) {
    for (const url of item.links) {
      const repo = /github\.com\/[^/]+\/([\w.-]+)/.exec(url)?.[1]
      if (!repo) continue
      for (const base of [dayS.cwd, path.dirname(dayS.cwd)]) {
        const candidate = path.join(base, repo)
        try { if (fs.statSync(candidate).isDirectory()) return {cwd:fs.realpathSync(candidate), known:true} } catch {}
      }
    }
    return {cwd:dayS.cwd, known:false}
  }
  // A settled item closes its thread: a running one stops, and it stays on disk.
  syncThreads(dayS) {
    for (const item of dayS.dayBoard?.items || []) {
      if (!item.thread || item.thread.closed || !['done','dropped'].includes(item.status)) continue
      item.thread.closed = Date.now()
      if (this.runs.has(item.thread.sessionId)) { try { this.stop(item.thread.sessionId) } catch {} }
    }
  }
  // After each thread turn the item carries the gist of it, which is all the Day reads.
  threadSummary(t) {
    const owner = this.dayFor(t), item = owner?.dayBoard?.items.find(i => i.id === t.itemId)
    const last = [...t.messages].reverse().find(m => m.role === 'assistant')?.text
    if (!item?.thread || !last) return
    item.thread.summary = last.replace(/\s+/g,' ').slice(0,400); item.thread.at = Date.now()
    try { this.changed(owner) } catch (error) { this.emit('storage-error',error) }
  }
  dayFor(t) { return t.kind === 'thread' ? this.sessions.get(t.parentDayId) || null : t.kind === 'day' ? t : null }
  // ── Projects ──────────────────────────────────────────────────────────────
  // Tag (or untag) a session with a project. A Day, a thread or a manager is not work
  // that belongs to one project, so only agents and initiatives can be tagged.
  setProject(id, body) {
    const s = this.get(id)
    if (!['agent','initiative'].includes(s.kind || 'agent')) fail('Only agents and initiatives belong to a project.')
    s.projectId = body.projectId ? this.projects.require(text(body.projectId,'Project',100)).id : null
    this.changed(s,true)
    return s
  }
  members(projectId) {
    return [...this.sessions.values()].filter(x => x.projectId === projectId && x.kind !== 'project')
  }
  managerOf(projectId) { return [...this.sessions.values()].find(x => x.kind === 'project' && x.projectId === projectId) || null }
  // The project's manager: started on the first question, continued after that. It works
  // in the project's first repository so it can read the code it reports on.
  // A new project is a title. Its manager starts straight away and sets the rest up.
  createProject(body) {
    const project = this.projects.create({name:body.name})
    const note = typeof body.note === 'string' && body.note.trim() ? text(body.note,'Note',8000) : ''
    try { this.askProject(project.id,{message:note || 'Set up this project.',runPrompt:projectAgent.SETUP(project.name,note),requestId:body.requestId}) }
    catch (error) { this.emit('storage-error',error) }
    return this.projects.get(project.id)
  }
  askProject(projectId, body) {
    const project = this.projects.require(projectId)
    const message = text(body.message,'Message',16000)
    const runPrompt = typeof body.runPrompt === 'string' ? body.runPrompt : projectAgent.OPENING(message)
    const rid = requestId(body.requestId || randomUUID())
    const existing = this.managerOf(project.id)
    if (existing) { this.send(existing.id,{message,runPrompt,requestId:rid}); return existing }
    this.checkCapacity()
    let cwd = defaultCwd()
    for (const repo of project.repos) {
      const full = repo === '~' || repo.startsWith('~/') ? path.join(os.homedir(), repo.slice(1)) : repo
      try { if (fs.statSync(full).isDirectory()) { cwd = fs.realpathSync(full); break } } catch {}
    }
    const id = randomUUID()
    const pm = {id,projectId:project.id,sessionId:null,name:project.name,cwd,createRequestId:rid,createdAt:Date.now(),updatedAt:Date.now(),status:'idle',approvalMode:'auto',selectedModel:'',messages:[],approvals:[],model:null,contextTokens:null,error:null,currentTool:null,requestIds:[],queue:[],kind:'project',teamId:null,teamName:null,teamSnapshot:null,taskBoard:null,worktree:null}
    this.sessions.set(id,pm)
    try { this.send(id,{message,runPrompt,requestId:rid}) }
    catch (error) { this.sessions.delete(id); throw error }
    return pm
  }
  // A comment on one task. It is kept in the project log and on the task's item on
  // today's Day (so neither loses it, whatever the manager does next), then handed to
  // the manager to fold into the task.
  commentOnTask(projectId, body) {
    const p = this.projects.require(projectId)
    const d = p.deliverables.find(x => x.id === body.deliverableId)
    if (!d) fail('That deliverable is not in this project.')
    const comment = text(body.message,'Comment',8000)
    const short = comment.replace(/\s+/g,' ').slice(0, 600)
    this.projects.note(p.id, `Comment on "${d.title}": ${short}`)
    const today = this.todayDay()
    const item = today?.dayBoard.items.find(i => i.deliverableId === d.id && !['done','dropped'].includes(i.status))
    if (item) { try { day.act(today,{action:'update',itemId:item.id,note:`You commented on the project task: ${short}`},'operator'); this.changed(today,true) } catch {} }
    const pm = this.askProject(p.id,{message:`On "${d.title}": ${comment}`,runPrompt:projectAgent.COMMENT(d, comment),requestId:body.requestId})
    this.emit('change','projects')
    return pm
  }
  // What a manager reads: the project, its sessions as summaries, and today's Day items.
  projectStatus(projectId) {
    const p = this.projects.require(projectId)
    const today = [...this.sessions.values()].filter(x => x.kind === 'day').sort((a,b) => b.createdAt-a.createdAt)[0]
    return {
      name:p.name, deadline:p.deadline, brief:p.brief, repos:p.repos, links:p.links,
      deliverables:p.deliverables.map(d => ({id:d.id,title:d.title,state:d.state,note:d.note,brief:d.brief || '',links:d.links || []})), log:(p.log || []).slice(-15),
      file:p.file, otherSections:p.sections.map(s => s.heading),
      sessions:this.members(p.id).map(x => ({...this.launchedStatus(x.id),lastWords:[...x.messages].reverse().find(m => m.role === 'assistant')?.text?.replace(/\s+/g,' ').slice(0,500) || null,updatedAt:x.updatedAt})),
      today:today?.dayBoard ? today.dayBoard.items.filter(i => i.projectId === p.id).map(i => ({title:i.title,status:i.status,mode:i.mode,lastLog:i.log.at(-1)?.text || null})) : [],
    }
  }
  projectSession(projectId, sessionId) {
    const x = this.sessions.get(sessionId)
    if (!x || x.projectId !== projectId || x.kind === 'project') fail('That session is not part of this project.')
    return {...this.launchedStatus(x.id),cwd:x.cwd,recent:x.messages.filter(m => m.role !== 'tool').slice(-8).map(m => ({role:m.role,text:String(m.text || '').slice(0,1500)}))}
  }
  todayDay() {
    return [...this.sessions.values()].filter(x => x.kind === 'day' && x.dayBoard?.date === day.dateOf()).sort((a,b) => b.createdAt-a.createdAt)[0] || null
  }
  // A deliverable onto today's Day as work to start: an "Agent does it" item tagged with
  // its project and tied to the deliverable. The Day picks it up on its next run and
  // turns it into a launch brief for the operator to approve, as with any such item.
  planDeliverable(projectId, deliverableId) {
    const p = this.projects.require(projectId)
    const d = p.deliverables.find(x => x.id === deliverableId)
    if (!d) fail('That deliverable is not in this project.')
    const today = this.todayDay()
    if (!today) fail('Start your day on the Today tab first, then add this to it.',409)
    const existing = today.dayBoard.items.find(i => i.deliverableId === d.id && !['done','dropped'].includes(i.status))
    if (existing) return {item:existing,existing:true}
    // The task's own links travel with it. The Day does not fold a project task into
    // another item that shares a link (see day.add); the project's general links stay
    // behind, in the file the hand-off points to.
    const context = handoff(p, d)
    const before = structuredClone(today.dayBoard)
    try {
      const {item} = day.act(today,{title:d.title,context,links:d.links || [],priority:'should',mode:'agent',source:'me',projectId:p.id,deliverableId:d.id,action:'add'},'operator')
      this.changed(today,true)
      // The note is the manager's evidence; moving the state leaves it be.
      if (d.state === 'todo') this.projects.deliverable(p.id,d.id,{state:'doing'})
      this.syncThreads(today)
      // Someone is waiting for the brief: as soon as an answer, not after a triage burst.
      this.scheduleDayResume(today, DAY_ANSWER_DELAY_MS)
      this.emit('change','projects')
      return {item,existing:false}
    } catch (error) { today.dayBoard = before; throw error }
  }
  // Which of a project's deliverables are on today's Day, and how far along.
  deliverablesOnToday(projectId) {
    const out = {}
    for (const i of this.todayDay()?.dayBoard?.items || []) if (i.projectId === projectId && i.deliverableId && i.status !== 'dropped') out[i.deliverableId] = {itemId:i.id,status:i.status}
    return out
  }
  // What the Day sees of the sessions it launched: enough to follow them, not their transcripts.
  launchedStatus(id) {
    const x = this.sessions.get(id)
    if (!x) return {id,status:'closed'}
    return {id,name:x.name,status:x.status,kind:x.kind,progress:tasks.progress(x),branch:x.worktree?.branch || null,links:linksFromMessages(x.messages).slice(-3).map(l=>l.url),error:x.error ? String(x.error).slice(0,300) : null}
  }
  scheduleDayResume(s, delay = DAY_RESUME_DELAY_MS) {
    clearTimeout(this.dayTimers.get(s.id))
    const timer = setTimeout(() => {
      this.dayTimers.delete(s.id)
      if (!this.sessions.has(s.id)) return
      // A run already in flight reads the board when it next lists; a queued resume
      // behind it would only repeat that work.
      if (this.runs.has(s.id) || s.queue.some(q => q.background)) return
      try { this.dayRun(s,'resume') } catch (error) { this.emit('storage-error',error) }
    }, delay)
    timer.unref?.()
    this.dayTimers.set(s.id, timer)
  }
  // Sweeps and resumes start from the board, not from the conversation: they do not
  // resume the session, so the main thread never accumulates a day of scout output.
  dayRun(s, kind) {
    // What the Today header says about checks: when the last one started, and how often.
    if (kind === 'sweep') { s.dayChecks = {lastAt:Date.now(),everyMin:DAY_SWEEP_MINUTES,hours:DAY_HOURS}; this.changed(s) }
    return this.send(s.id,{message:kind === 'sweep' ? 'Sweep' : 'Pick up answers',runPrompt:dayAgent.promptFor(kind),background:true,requestId:randomUUID()})
  }
  sweepDays(now = new Date()) {
    if (this.closed) return
    const hour = now.getHours()
    if (hour < DAY_HOURS[0] || hour >= DAY_HOURS[1]) return
    const date = day.dateOf(now.getTime())
    for (const s of this.sessions.values()) {
      if (s.kind !== 'day' || s.dayBoard?.date !== date) continue
      // One failed sweep (a dropped connection, a connector timing out) should not end
      // the day's checks, so an error is retried. Three in a row is not a blip: the Day
      // waits for the operator. A deliberate stop always does.
      if (!['idle','error'].includes(s.status) || (s.dayFailures || 0) >= DAY_MAX_FAILURES || this.runs.has(s.id) || s.queue.length) continue
      try { this.dayRun(s,'sweep') } catch (error) { this.emit('storage-error',error) }
    }
  }
  checkCapacity() {
    if (this.closed) fail('Fleet is shutting down.',503)
    // With the queue on, being over the limit is a reason to wait, not to refuse, so
    // the limit is enforced by admit() below instead of by this throw.
    if (this.queueing) return
    if (this.runs.size >= this.dispatch.limit) fail(`${this.dispatch.limit} agents are already running. Stop one or wait for it to finish.`,409)
  }
  // Hand the slot a finished run just freed to whoever has waited longest. Loops
  // because a waiting session can have gone away, or had its queue emptied by a stop,
  // and skipping it should let the next one in rather than waste the slot.
  dispatchNext() {
    if (!this.queueing) return
    for (;;) {
      const id = this.dispatch.next(this.runs.size)
      if (!id) return
      const s = this.sessions.get(id)
      if (!s) continue
      const next = s.queue[0]
      // Nothing left to send: the operator stopped it, or closed it, while it waited.
      if (!next) { if (s.status === 'queued') { s.status = 'idle'; this.changed(s,true) } ; continue }
      s.queue = s.queue.slice(1)
      try { this.startTurn(s,next) }
      catch (error) { this.emit('storage-error',error) }
    }
  }
  send(id, body) {
    const s = this.get(id)
    const rid = requestId(body.requestId)
    if (s.requestIds.includes(rid)) return s
    const hasImages = Array.isArray(body.images) && body.images.length > 0
    const message = hasImages && !(body.message || '').trim() ? '' : text(body.message,'Message',16000)
    // Another live process on the same session would write the same transcript, so Fleet
    // never sends while one holds it. A message waits instead, and goes the moment that
    // window lets go of the session (releaseHeld). A fork writes a new conversation, so it
    // may proceed.
    const holder = this.holderOf(s)
    const references = resolveReferences(body.references, {target:s, managed:[...this.sessions.values()], external:body.references?.length ? this.externalSessions() : [], transcriptFor})
    const attachments = hasImages ? this.saveImages(body.images) : []
    s.requestIds = [...s.requestIds,rid].slice(-200)
    const queued = {message,attachments,references,...(['day','thread','project'].includes(s.kind) && typeof body.runPrompt === 'string' ? {runPrompt:body.runPrompt.slice(0,32000),background:!!body.background} : {})}
    // Mid-turn, the SDK session can't take a second prompt yet: hold this one and let
    // the run's own completion (see the `finally` in run()) start it the moment the
    // agent is free, instead of making the operator retry once it's idle.
    if (this.runs.has(id)) { s.queue = [...s.queue, queued]; this.changed(s,true); return s }
    if (holder) { s.queue = [...s.queue, queued]; s.waitingForRelease = true; this.changed(s,true); return s }
    this.checkCapacity()
    // Every agent slot is busy: take a place in line and park the payload on the session,
    // the same place a mid-turn message already waits. dispatchNext() starts it when a
    // run ends. Without the queue, checkCapacity above has already thrown.
    if (this.queueing && !this.dispatch.admit(id, this.runs.size)) {
      s.queue = [...s.queue, queued]
      s.status = 'queued'
      this.changed(s,true)
      return s
    }
    this.startTurn(s, queued)
    return s
  }
  holderOf(s) {
    return s.sessionId && !s.forkPending ? this.externalSessions().find(x => x.sessionId === s.sessionId && x.alive) || null : null
  }
  // Messages held back while another program had the session: send the first once it is
  // free, as an ordinary turn (the rest follow it, like any queue).
  releaseHeld() {
    for (const s of this.sessions.values()) {
      if (!s.waitingForRelease || this.runs.has(s.id)) continue
      if (!s.queue.length) { s.waitingForRelease = false; continue }
      if (this.holderOf(s)) continue
      try { this.checkCapacity() } catch { continue }
      if (this.queueing && !this.dispatch.admit(s.id, this.runs.size)) continue
      s.waitingForRelease = false
      const next = s.queue[0]
      s.queue = s.queue.slice(1)
      try { this.startTurn(s, next) } catch (error) { this.emit('storage-error', error) }
    }
  }
  startTurn(s, {message,attachments,references,runPrompt,background}) {
    const entry = {id:randomUUID(),role:'user',text:message,at:Date.now(),...(attachments.length ? {attachments} : {}),...(references.length ? {references} : {}),...(runPrompt ? {runPrompt,background:!!background} : {})}
    s.messages.push(entry)
    this.pruneMessages(s)
    s.lastPrompt = message || `${attachments.length} image${attachments.length === 1 ? '' : 's'}`; s.error = null; s.status = 'starting'; s.currentTool = null
    const run = {controller:new AbortController(),query:null,stopping:false,finished:false,streamText:'',assistant:null,result:false,stderr:'',background:!!background}
    this.runs.set(s.id,run)
    try { this.changed(s,true) }
    catch (error) { this.runs.delete(s.id); s.status='error'; s.messages.pop(); throw error }
    run.done = this.run(s,run,entry)
  }
  // Validate, sniff and persist pasted images. Files are owner-only and named by a
  // fresh id, so a request can never choose where on disk its bytes land.
  saveImages(images) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) fail(`Attach up to ${MAX_IMAGES} images per message.`)
    const saved = []
    for (const image of images) {
      if (!image || typeof image.data !== 'string' || !image.data) fail('An attached image was empty.')
      let buffer
      try { buffer = Buffer.from(image.data, 'base64') } catch { fail('An attached image could not be decoded.') }
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) fail(`Each image must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
      const mediaType = sniffImage(buffer)
      if (!mediaType) fail('Only PNG, JPEG, GIF and WebP images can be attached.')
      const id = `${randomUUID()}.${IMAGE_TYPES[mediaType]}`
      fs.writeFileSync(path.join(this.attachmentsDir, id), buffer, { mode: 0o600 })
      saved.push({ id, mediaType, bytes: buffer.length })
    }
    return saved
  }
  // Keep the conversation window, and delete the files of any message that fell out.
  pruneMessages(s) {
    if (s.messages.length <= MAX_MESSAGES) return
    for (const dropped of s.messages.slice(0, s.messages.length - MAX_MESSAGES)) this.deleteAttachments(dropped)
    s.messages = s.messages.slice(-MAX_MESSAGES)
  }
  deleteAttachments(message) {
    for (const a of message.attachments || []) { try { fs.unlinkSync(path.join(this.attachmentsDir, a.id)) } catch {} }
  }
  // A message with images has to travel as content blocks, which the SDK accepts
  // only in streaming-input form: an iterable that yields the one message and ends.
  promptFor(entry) {
    const promptText = referencePrompt(entry.runPrompt ?? entry.text, entry.references)
    if (!entry.attachments?.length) return promptText
    const dir = this.attachmentsDir
    return (async function* () {
      const content = []
      for (const a of entry.attachments) {
        let data
        try { data = fs.readFileSync(path.join(dir, a.id)).toString('base64') } catch { continue }
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data } })
      }
      content.push({ type: 'text', text: promptText || 'See the attached image.' })
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
    })()
  }
  // A Codex turn: the installed Codex, resuming its thread after the first turn. Fleet's
  // approval setting chooses its sandbox, since Codex cannot ask here before a command.
  codexQuery(s,run,entry,prompt) {
    const images = (typeof entry === 'string' ? [] : entry.attachments || []).map(a => path.join(this.attachmentsDir, a.id))
    return this.codex.query({prompt,cwd:s.cwd,threadId:s.sessionId,approvalMode:s.approvalMode,model:s.selectedModel || '',images,signal:run.controller.signal,onStderr:chunk => { run.stderr = (run.stderr+chunk).slice(-4000) }})
  }
  // A Claude turn: the Agent SDK query, with whatever this kind of session adds (a team,
  // a Day, a project manager, owner review, automatic model choice).
  async claudeQuery(s,run,entry,prompt) {
    const options = {
      cwd:s.cwd,permissionMode:'default',settingSources:['user','project','local'],
      systemPrompt:{type:'preset',preset:'claude_code'},
      includePartialMessages:true,abortController:run.controller,
      canUseTool:(tool,input,context) => this.ask(s,run,tool,input,context),
      stderr:chunk => { run.stderr = (run.stderr+chunk).slice(-4000) },
      ...(s.sessionId && !run.background ? {resume:s.sessionId} : {}),
      // A copy of a conversation still open in its terminal: the first turn forks it, and
      // the new session id it reports is this conversation's from then on.
      ...(s.forkPending && !run.background ? {forkSession:true} : {}),
    }
    const automatic=s.selectedModel===routing.AUTO_MODEL
    const selectedModel=automatic ? '' : s.selectedModel
    options.model = boundedModel(selectedModel, DEFAULT_AGENT_MODEL)
    options.effort = 'medium'
    // `agent` puts the manager on the main thread, so the operator's messages reach it and
    // nobody else; `agents` is where the Agent tool resolves the rest of the team from.
    // Both compose with the claude_code preset above, which keeps the built-in tools.
    const team = s.teamSnapshot || getTeam(s.teamId)
    if (team) {
      Object.assign(options, compile(team))
      const manager=options.agents[team.manager]
      options.model=boundedModel(selectedModel || manager.model,'opus')
      manager.model=options.model
      options.effort=manager.effort
      options.maxTurns=manager.maxTurns
    }
    if (s.kind === 'project') {
      if (!this.projects.get(s.projectId)) throw new Error('This project was deleted.')
      options.systemPrompt = {type:'preset',preset:'claude_code',append:projectAgent.SYSTEM}
      options.model = boundedModel(selectedModel,'sonnet')
      options.disallowedTools = ['Edit','Write','NotebookEdit']
      options.mcpServers = {fleet:await projectAgent.server(s.projectId,{projects:this.projects,status:id=>this.projectStatus(id),session:(id,sid)=>this.projectSession(id,sid)},()=>this.changed(s))}
      options.hooks = {PreToolUse:[{hooks:[async input=>{
        if (!['Agent','Task'].includes(input.tool_name) || !input.tool_input?.run_in_background) return {}
        return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input.tool_input,run_in_background:false}}}
      }]}]}
    }
    if (s.kind === 'thread') {
      const owner = this.dayFor(s)
      if (!owner) throw new Error('The Day this conversation belongs to was closed.')
      options.systemPrompt = {type:'preset',preset:'claude_code',append:dayAgent.THREAD_SYSTEM}
      options.model = boundedModel(selectedModel,'sonnet')
      options.disallowedTools = ['Edit','Write','NotebookEdit']
      options.mcpServers = {fleet:await day.threadServer(owner,s.itemId,()=>this.changed(owner,true))}
      options.hooks = {PreToolUse:[{hooks:[async input=>{
        if (!['Agent','Task'].includes(input.tool_name) || !input.tool_input?.run_in_background) return {}
        return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input.tool_input,run_in_background:false}}}
      }]}]}
    }
    if (s.kind === 'day') {
      options.systemPrompt = {type:'preset',preset:'claude_code',append:dayAgent.SYSTEM}
      options.agents = dayAgent.AGENTS
      options.model = boundedModel(selectedModel,'sonnet')
      // Code is changed by initiatives the operator launches, never by the Day itself.
      options.disallowedTools = ['Edit','Write','NotebookEdit']
      options.mcpServers={fleet:await day.sdkServer(s,()=>{this.syncThreads(s);this.changed(s,true)},{launched:id=>this.launchedStatus(id),teams:()=>this.teams.list().map(t=>({id:t.id,name:t.name,description:t.description})),projects:()=>this.projects.list().map(p=>({id:p.id,name:p.name,repos:p.repos,deadline:p.deadline,open:p.deliverables.filter(d=>d.state!=='done').map(d=>d.title)}))})}
      // Scouts run in the foreground. A background subagent outlives the turn that
      // launched it, and once that turn's result arrives the SDK closes its input:
      // every permission check and every call to the in-process day tool after that
      // fails with "Stream closed". Several foreground calls in one message still run
      // side by side, so the intake loses nothing by waiting for them.
      options.hooks={PreToolUse:[{hooks:[async input=>{
        if (!['Agent','Task'].includes(input.tool_name) || !input.tool_input?.run_in_background) return {}
        return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input.tool_input,run_in_background:false}}}
      }]}]}
    }
    if (team?.workflow) {
      if (ownerReview.refresh(s)) this.changed(s,true)
      options.mcpServers={fleet:await tasks.sdkServer(s,()=>this.changed(s,true))}
      options.hooks={
        PreToolUse:[{hooks:[async input=>{
          if (ownerReview.refresh(s)) this.changed(s,true)
          if (ownerReview.enabled(s) && input.agent_id && (['Agent','Task'].includes(input.tool_name) || input.tool_name==='mcp__fleet__tasks')) {
            return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Only the persistent owner can manage the request or invoke its reviewer.'}}
          }
          if (!['Agent','Task'].includes(input.tool_name)) return {}
          const before=structuredClone(s.taskBoard)
          let applied=false
          try {
            const delegation=tasks.start(s,input.tool_use_id,input.tool_input)
            applied=true
            const task=s.taskBoard.tasks.find(t=>t.id===delegation.taskId)
            const mandate=ownerReview.enabled(s) ? ownerReview.mandate(s,task,this.attachmentsDir) : `\n\nFleet acceptance criteria:\n${task.criteria.map(c=>'- '+c).join('\n')}\nReturn PASS or FAIL with evidence if you are verifying. Do not edit source while verifying.`
            delegation.prompt=(input.tool_input.prompt+mandate).slice(0,48000)
            this.changed(s,true)
            return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input.tool_input,prompt:input.tool_input.prompt+mandate}}}
          } catch(error) {if(applied)s.taskBoard=before;return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:error.message}}}
        }]}],
        Stop:[{hooks:[async (input={})=>{
          if (input.agent_id) return {}
          if (ownerReview.refresh(s)) this.changed(s,true)
          if (ownerReview.enabled(s)) {
            const task=s.taskBoard.tasks[0]
            if (!task || !['verified','blocked'].includes(task.status)) {
              const limit=s.limits?.maxAttempts ?? team.workflow.maxAttempts
              const exhausted=task && ((task.reviewErrors || 0)>=2 || (task.attempt>=limit && !['review','review_error'].includes(task.status)))
              if (!exhausted && (run.continuations || 0)<2) {
                run.continuations=(run.continuations || 0)+1
                return {decision:'block',reason:'The request is not verified. Continue in this owner session: register one task if needed, implement/test/commit, submit with action ready, and invoke the reviewer. Read the board first. Record a concrete blocker if you cannot proceed.'}
              }
              if (task) {task.status='blocked';task.blocker ||= exhausted ? 'Request-wide review or execution retry limit reached. Operator action is required.' : 'Owner stopped before completing independent review. Resume this session to continue.';this.changed(s,true)}
            }
            return {}
          }
          const unfinished=s.taskBoard.tasks.filter(t=>!['verified','blocked'].includes(t.status) && t.attempt<(s.limits?.maxAttempts ?? team.workflow.maxAttempts))
          if (unfinished.length && (run.continuations || 0)<2) {
            run.continuations=(run.continuations || 0)+1
            return {decision:'block',reason:'Fleet tasks remain unfinished. Read the board and continue implementation/verification, or record a concrete blocker before stopping.'}
          }
          return {}
        }]}],
        SubagentStart:[{hooks:[async input=>{run.agentRoles ||= new Map();run.agentRoles.set(input.agent_id,input.agent_type);return {}}]}],
      }
      if (ownerReview.enabled(s)) {
        const check=async input=>{
          if (!ownerReview.refresh(s)) return {}
          this.changed(s,true)
          return {hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:'Fleet review is stale because the code changed or its Git snapshot is unavailable. Submit a clean committed snapshot for review again.'}}
        }
        options.hooks.PostToolUse=[{hooks:[check]}]
        options.hooks.PostToolUseFailure=[{hooks:[check]}]
      }
    }
    if (automatic) {
      if (!s.modelRouting) {
        const original=s.messages.find(m=>m.role==='user')
        let apiKey=''
        try{apiKey=this.gatewaySettings.key()}catch{} // Unreadable credentials retain the preset.
        const decision=await this.modelRouter({original:original?.text,current:typeof entry==='string' ? entry:entry.text,
          fallback:options.model,hasExtraContext:!!(s.sessionId || original?.attachments?.length || original?.references?.length || entry?.attachments?.length || entry?.references?.length),signal:run.controller.signal},{apiKey})
        if (run.stopping || run.controller.signal.aborted) return
        s.modelRouting=decision
        this.changed(s,true)
      }
      options.model=s.modelRouting.model
      if (team) options.agents[team.manager].model=options.model
    }
    if (process.env.CLAUDE_FLEET_EXECUTABLE) options.pathToClaudeCodeExecutable = process.env.CLAUDE_FLEET_EXECUTABLE
    return this.queryFactory({prompt,options})
  }
  async run(s,run,entry) {
    const prompt = typeof entry === 'string' ? entry : this.promptFor(entry)
    try {
      run.query = s.engine === 'codex' ? this.codexQuery(s,run,entry,prompt) : await this.claudeQuery(s,run,entry,prompt)
      if (!run.query) return
      if (run.stopping) { run.query.close(); return }
      if (!this.models) run.query.supportedModels?.()
        .then(list => { if (Array.isArray(list) && list.length) this.models = [FALLBACK_MODELS[0], ...list] })
        .catch(() => {})
      for await (const event of run.query) {
        if (run.stopping) break
        this.event(s,run,event)
      }
      if (!run.stopping && !run.result) throw new Error(run.stderr || 'Claude exited before completing the turn.')
    } catch (error) {
      if (!run.stopping) { s.status='error'; s.error=String(error.message || error).slice(0,4000) }
    } finally {
      run.finished = true
      this.cancelApprovals(s.id,'The agent stopped before this request was answered.')
      try { run.query?.close() } catch {}
      // Only a delegation that is itself still running was actually interrupted here; a
      // delegation that already finished may carry a step whose tool_result simply never
      // arrived, and flipping that step to "interrupted" next to a completed delegation
      // would misreport a race as a stop.
      if (s.taskBoard) for (const d of s.taskBoard.delegations) if (d.status === 'running') for (const step of d.steps || []) if (step.status === 'running') step.status = 'interrupted'
      tasks.interrupt(s)
      interruptSubagents(s)
      ownerReview.refresh(s)
      for (const entry of run.tools?.values() || []) if (entry.status === 'running') entry.status = 'interrupted'
      if (run.stopping) s.status='stopped'
      else if (s.status !== 'error') s.status='idle'
      if (s.kind === 'day') { s.dayFailures = s.status === 'error' ? (s.dayFailures || 0)+1 : 0; if (s.dayBoard) s.dayBoard.focus = null }
      if (s.kind === 'thread' && s.status === 'idle') this.threadSummary(s)
      // An agent the Day launched says how it went, on the item it came from.
      if (!run.background && ['agent','initiative'].includes(s.kind || 'agent')) { try { this.reportToDay(s) } catch (error) { this.emit('storage-error',error) } }
      s.currentTool=null
      this.runs.delete(s.id)
      // A clean finish with something waiting picks it straight back up. A stop already
      // dropped the queue; an error drops it too rather than firing a follow-up message
      // at a conversation that just failed, unseen, behind the operator's back.
      if (s.status !== 'idle') s.queue=[]
      const next = s.status === 'idle' && s.queue.length ? s.queue[0] : null
      // Follow-up messages are new turns too: pausing or lowering the limit must
      // gate them just like a newly submitted task, without losing their payload.
      const admitted=next && (!this.queueing || this.dispatch.admit(s.id,this.runs.size))
      if (admitted) s.queue = s.queue.slice(1)
      else if (next) s.status='queued'
      try { this.changed(s,true) } catch (error) { this.emit('storage-error',error) }
      if (admitted) { try { this.startTurn(s,next) } catch (error) { this.emit('storage-error',error) } }
      // This session's own follow-up comes first — it is mid-conversation and already
      // holds the slot. Only what is genuinely left over goes to the queue.
      this.dispatchNext()
    }
  }
  event(s,run,event) {
    if (event.session_id && !event.parent_tool_use_id && !run.background) { if (s.forkPending && event.session_id!==s.sessionId) delete s.forkPending; s.sessionId=event.session_id }
    // Account-wide, so it is recorded whoever emitted it, sub-agent turns included.
    if (event.type==='rate_limit_event') this.usage.recordEvent(event.rate_limit_info)
    if (event.parent_tool_use_id && (s.taskBoard || s.subagents)) {
      const d=delegationFor(s,event.parent_tool_use_id)
      if (d && event.type==='assistant') {
        const content=event.message.content || []
        d.activity=content.filter(b=>b.type==='tool_use').map(b=>b.name).join(', ') || d.activity
        d.model=event.message.model || d.model
        this.delegationUsage(d,run,event.message)
        const output=content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
        if (output) d.output=output.slice(0,24000)
        // The one place a sub-agent's own tool calls are kept at all: as steps on its
        // delegation, never as messages (every branch above stays guarded by
        // `!event.parent_tool_use_id`). Inputs and results are bounded for inspection.
        for (const block of content) if (block.type==='tool_use') this.stepStarted(d,block)
      }
      if (d && event.type==='result' && Number.isFinite(event.total_cost_usd) && event.total_cost_usd>=0) d.costUsd=event.total_cost_usd
      if (d && event.type==='user') {
        for (const block of event.message?.content || []) if (block.type==='tool_result') this.stepFinished(d,block)
      }
    }
    if ((s.taskBoard || s.subagents) && event.type==='system' && ['task_progress','task_notification'].includes(event.subtype)) {
      const d=delegationFor(s,event.tool_use_id)
      if (d && event.usage) {
        d.runtimeUsage ||= {}
        for (const key of ['total_tokens','tool_uses','duration_ms']) {
          const value=event.usage[key]
          if (Number.isFinite(value) && value>=0) d.runtimeUsage[key]=Math.max(d.runtimeUsage[key] || 0,value)
        }
      }
    }
    if (event.type === 'system' && event.subtype === 'init' && !event.parent_tool_use_id) { s.model=event.model; s.status='running' }
    if (event.type === 'stream_event' && !event.parent_tool_use_id) {
      if (event.event.type === 'message_start') { run.assistant=null; run.streamText='' }
      if (event.event.delta?.type === 'text_delta') {
        run.streamText = (run.streamText + event.event.delta.text).slice(-24000)
        if (!run.assistant) { run.assistant={id:randomUUID(),role:'assistant',text:'',at:Date.now()}; s.messages.push(run.assistant); s.messages=s.messages.slice(-MAX_MESSAGES) }
        run.assistant.text=run.streamText.slice(-24000)
      }
      if (event.event.type === 'content_block_start' && event.event.content_block?.type === 'tool_use') s.currentTool=event.event.content_block.name
    }
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      const content=event.message.content || []
      const visible=content.filter(b=>b.type==='text').map(b=>b.text).join('\n\n')
      if (visible) {
        if (!run.assistant) { run.assistant={id:randomUUID(),role:'assistant',text:'',at:Date.now()}; s.messages.push(run.assistant) }
        run.assistant.text=visible.slice(-24000)
      }
      for (const block of content) if (block.type==='tool_use') this.toolStarted(s,run,block)
      const tool=content.find(b=>b.type==='tool_use'); if(tool) s.currentTool=tool.name
      const usage=event.message.usage
      if (usage) s.contextTokens=(usage.input_tokens||0)+(usage.cache_read_input_tokens||0)+(usage.cache_creation_input_tokens||0)
      if (s.contextTokens > 200000 || s.model?.includes('[1m]')) s.contextLimit=1000000
      run.assistant=null; run.streamText=''
      s.messages=s.messages.slice(-MAX_MESSAGES)
    }
    if (event.type === 'user' && !event.parent_tool_use_id) {
      for (const block of event.message?.content || []) if (block.type==='tool_result') this.toolFinished(s,run,block)
    }
    if (event.type === 'tool_progress' && !event.parent_tool_use_id) s.currentTool=event.tool_name
    if (s.taskBoard && event.type==='system' && event.subtype==='task_notification' && event.tool_use_id && event.status!=='completed') tasks.finish(s,event.tool_use_id,event.summary,true)
    if (event.type === 'result' && !event.parent_tool_use_id) {
      run.result=true
      if (event.is_error) { s.status='error'; s.error=event.errors?.join('\n') || event.result || 'Claude could not finish this turn.' }
      else if (event.result && !s.messages.some(m=>m.role==='assistant' && m.text===event.result.slice(-24000))) s.messages.push({id:randomUUID(),role:'assistant',text:event.result.slice(-24000),at:Date.now()})
      s.costUsd=(s.costUsd||0)+(event.total_cost_usd||0)
      addTokens(s,event)
      s.messages=s.messages.slice(-MAX_MESSAGES)
      this.captureUsage(run)
    }
    this.changed(s)
  }
  // The end of a turn is the one moment a query is both idle and still open, so it is
  // where the every-window reading is taken. Fire and forget: the push event already
  // carries the window that matters, this only fills in the rest. The method is marked
  // experimental upstream and may simply not be there, which is not an error.
  captureUsage(run) {
    if (!run || run.usagePulled) return
    const pull=run.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof pull!=='function') return
    run.usagePulled=true
    Promise.resolve(pull.call(run.query)).then(response=>this.usage.recordUsage(response)).catch(()=>{})
  }
  // A tool call becomes its own conversation entry so the UI can render it as a command block.
  toolStarted(s,run,block) {
    if (!block.id || run.tools?.has(block.id)) return
    run.tools ||= new Map()
    const entry = {
      id:block.id, role:'tool', tool:block.name || 'Tool', at:Date.now(), status:'running',
      input:clampInput(block.input), target:toolTarget(block.name,block.input), text:'', result:null, ms:null,
      approval:askReason(block.name, block.input, s.approvalMode) ? 'asked' : 'auto',
    }
    run.tools.set(block.id,entry)
    // A Day's subagents get the same record an initiative's delegations do, so the
    // Today console can show each one's assignment, steps and report.
    if (s.kind === 'day' && ['Agent','Task'].includes(block.name)) {
      // "Fleet item: <id>" at the top of a delegation ties the subagent to its item, so
      // the board can say which item is being worked on and by whom.
      const itemId = /^\s*Fleet item:\s*([\w-]{8,})/m.exec(String(block.input?.prompt || ''))?.[1]
      const known = itemId && s.dayBoard?.items.some(i => i.id === itemId) ? itemId : null
      s.subagents = [...(s.subagents || []), {id:block.id,itemId:known,role:block.input?.subagent_type || 'general-purpose',description:String(block.input?.description || '').slice(0,200),prompt:String(block.input?.prompt || '').slice(0,24000),status:'running',startedAt:Date.now(),finishedAt:null,steps:[],output:'',report:''}].slice(-MAX_DAY_SUBAGENTS)
    }
    s.messages.push(entry)
    s.messages=s.messages.slice(-MAX_MESSAGES)
  }
  toolFinished(s,run,block) {
    const entry = run.tools?.get(block.tool_use_id) || s.messages.find(m=>m.role==='tool' && m.id===block.tool_use_id)
    if (!entry || entry.status!=='running') return
    entry.status = block.is_error ? 'error' : 'done'
    entry.ms = Date.now()-entry.at
    const result = resultText(block.content)
    if (s.taskBoard) {
      tasks.finish(s,block.tool_use_id,result,!!block.is_error)
      // The delegation just reached a terminal status. A step whose own tool_result
      // never arrived from the sub-agent can no longer resolve on its own, by
      // definition; left as "running" it would look like a live step under a
      // finished delegation, so it gets its own terminal label instead.
      const d=s.taskBoard.delegations.find(d=>d.id===block.tool_use_id)
      if (d && d.status!=='running') for (const step of d.steps || []) if (step.status==='running') step.status='unreported'
    }
    const sub = s.subagents?.find(d => d.id === block.tool_use_id)
    if (sub && sub.status === 'running') {
      sub.status = block.is_error ? 'failed' : 'completed'; sub.finishedAt = Date.now(); sub.report = result.slice(0,24000)
      for (const step of sub.steps) if (step.status === 'running') step.status = 'unreported'
    }
    entry.truncated = result.length > MAX_TOOL_RESULT
    entry.result = block.is_error || !QUIET_RESULT.has(entry.tool) ? result.slice(0,MAX_TOOL_RESULT) : null
  }
  // A sub-agent's tool call becomes a step on its delegation rather than a conversation
  // entry: bounded input/output, status and timing, so the operator can see what happened
  // without the console ever rendering it.
  stepStarted(d,block) {
    if (!block.id) return
    d.steps ||= []
    if (d.steps.some(step=>step.id===block.id)) return
    d.steps.push({id:block.id,tool:block.name || 'Tool',target:toolTarget(block.name,block.input),input:clampInput(block.input),result:null,status:'running',at:Date.now(),ms:null})
    if (d.steps.length > MAX_DELEGATION_STEPS) { d.steps=d.steps.slice(-MAX_DELEGATION_STEPS); d.stepsTruncated=true }
  }
  stepFinished(d,block) {
    const step=d.steps?.find(step=>step.id===block.tool_use_id)
    if (!step || step.status!=='running') return
    step.status=block.is_error ? 'error' : 'done'
    step.ms=Date.now()-step.at
    const result=resultText(block.content)
    step.result=result.slice(0,MAX_TOOL_RESULT)
    step.truncated=result.length>MAX_TOOL_RESULT
  }
  // The SDK can emit multiple blocks for the same assistant message. Count each
  // usage counter only once, accepting later updates without double-counting.
  delegationUsage(d,run,message) {
    if (!message.id || !message.usage) return
    run.delegationUsage ||= new Map()
    const key=JSON.stringify([d.id,message.id])
    const previous=run.delegationUsage.get(key) || {}
    d.usage ||= {}
    for (const field of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']) {
      const value=message.usage[field]
      if (!Number.isFinite(value) || value<0) continue
      const next=Math.max(previous[field] || 0,value)
      d.usage[field]=(d.usage[field] || 0)+next-(previous[field] || 0)
      previous[field]=next
    }
    run.delegationUsage.set(key,previous)
  }
  setLimits(id,body) {
    const s=this.get(id)
    if (!s.teamSnapshot?.workflow) fail('This initiative does not have configurable limits.')
    if (this.runs.has(id)) fail('Stop the manager before changing its limits.',409)
    const {maxAttempts}=body
    if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>10) fail('Choose 1–10 attempts per task.')
    const previous=s.limits
    s.limits={maxAttempts}
    try {this.changed(s,true)} catch(error) {s.limits=previous;throw error}
    return s
  }
  setModelChoice(id,body) {
    const s=this.get(id)
    s.selectedModel=modelChoice(body.model)
    this.changed(s,true)
    return s
  }
  // A name you chose stays: Claude's own title no longer replaces it (see server.js).
  setName(id,body) {
    const s=this.get(id)
    if (!['agent','initiative'].includes(s.kind || 'agent')) fail('Only agents and initiatives can be renamed.')
    s.name=text(body.name,'Name',100)
    s.renamed=true
    this.changed(s,true)
    return s
  }
  setMode(id,body) {
    const s=this.get(id)
    if (!MODES.includes(body.mode)) fail('Choose ask, auto, or all.')
    s.approvalMode=body.mode
    this.changed(s,true)
    return s
  }
  ask(s,run,tool,input,context) {
    if (run.stopping || context.signal.aborted) return Promise.resolve({behavior:'deny',message:'Agent stopped.'})
    if (JSON.stringify(input).length > 256000) return Promise.resolve({behavior:'deny',message:'Tool input is too large for Fleet approval. Split the action into smaller steps.'})
    let reason=askReason(tool,input,s.approvalMode)
    // A Day reaches other people on the operator's behalf. Whatever the approval mode,
    // that happens only for content they approved on the board, or approve right here.
    // A project manager may change the operator's documents and tickets, one approved
    // change at a time and only in a turn the operator asked for. It never reaches people.
    let projectWrite=false
    if (s.kind === 'project' && day.outward(tool)) {
      if (projectAgent.reachesPeople(tool)) return Promise.resolve({behavior:'deny',message:'A project manager does not message people (Slack, email, comments). Suggest the wording to the operator; it goes out through their Day.'})
      if (run.background) return Promise.resolve({behavior:'deny',message:'Changes outside Fleet happen only when the operator asks for them in this conversation.'})
      reason='Changes something outside Fleet. Check exactly what it writes'
      projectWrite=true
    }
    const owner=this.dayFor(s)
    if (owner && day.outward(tool)) {
      const approved=day.approvedFor(owner,input)
      if (approved) { day.act(owner,{action:'update',itemId:approved.item.id,note:`Sent with ${tool}.`},'agent'); this.changed(owner,true); return Promise.resolve({behavior:'allow',updatedInput:input}) }
      reason='Reaches other people and has no approved draft on the Day board'
    }
    if (!reason) return Promise.resolve({behavior:'allow',updatedInput:input})
    const decided=new Promise(resolve => {
      const id=randomUUID()
      const approval={id,tool,input,at:Date.now(),reason,description:context.title || context.decisionReason || null,role:run.agentRoles?.get(context.agentID) || roleAsking(s,context)}
      let settled=false
      const finish=result=>{
        if(settled)return
        settled=true
        context.signal.removeEventListener('abort',abort)
        this.pending.delete(id); s.approvals=s.approvals.filter(p=>p.id!==id)
        if (!run.stopping && !run.finished) s.status=s.approvals.length ? 'approval' : 'running'
        this.changed(s); resolve(result)
      }
      const abort=()=>finish({behavior:'deny',message:'Request cancelled.'})
      this.pending.set(id,{sessionId:s.id,input,tool,finish})
      context.signal.addEventListener('abort',abort,{once:true})
      s.approvals.push(approval); s.status='approval'; this.changed(s)
    })
    if (!projectWrite) return decided
    // What the manager changed outside Fleet goes in the project's log, so the file says it.
    return decided.then(result => {
      if (result.behavior === 'allow') { try { this.projects.note(s.projectId,`Approved change outside Fleet: ${describeWrite(tool,result.updatedInput || input)}`); this.emit('change','projects') } catch {} }
      return result
    })
  }
  decide(id,approvalId,body) {
    this.get(id)
    const pending=this.pending.get(approvalId)
    if (!pending || pending.sessionId!==id) fail('This approval is no longer pending.',409)
    if (!['allow','deny'].includes(body.decision)) fail('Choose allow or deny.')
    if (body.decision==='deny') pending.finish({behavior:'deny',message:typeof body.reason==='string' && body.reason.trim() ? body.reason.slice(0,2000) : 'The user declined this action.'})
    else {
      let updatedInput=pending.input
      if (pending.tool==='AskUserQuestion') {
        const questions=pending.input.questions || []
        const answers={}
        for (const q of questions) answers[q.question]=text(body.answers?.[q.question],'Answer',4000)
        updatedInput={...pending.input,answers}
      }
      pending.finish({behavior:'allow',updatedInput})
    }
  }
  cancelApprovals(id,message) { for (const p of [...this.pending.values()]) if (p.sessionId===id) p.finish({behavior:'deny',message}) }
  stop(id) {
    const s=this.get(id),run=this.runs.get(id)
    if (!run && s.waitingForRelease) { s.queue=[]; s.waitingForRelease=false; this.changed(s,true); return s }
    // Stopping something that is only waiting has no run to abort: give up its place
    // and drop what it was going to send. Without this, Stop looks broken on a queued
    // session — the one state where the operator is most likely to press it.
    if (!run && this.dispatch.drop(id)) {
      s.queue=[]; s.status='idle'
      this.changed(s,true)
      return s
    }
    if (!run || run.stopping) return s
    run.stopping=true; s.status='stopping'; this.cancelApprovals(id,'The user stopped this agent.')
    // A deliberate stop means abandon what's queued too — firing it anyway right after
    // the operator hit Stop would look like Fleet ignoring them.
    s.queue=[]
    run.controller.abort()
    try { run.query?.close() } catch {}
    this.changed(s,true)
    return s
  }
  // Forgets Fleet's own record of a conversation. Claude keeps its transcript, so
  // the session id remains resumable from a terminal afterwards.
  async remove(id) {
    const s=this.get(id), run=this.runs.get(id)
    if (run) { this.stop(id); try { await run.done } catch {} }
    // A closed session must not keep a place in line; dispatchNext would otherwise
    // spend a slot on it and find nothing to send.
    this.dispatch.drop(id)
    clearTimeout(this.dayTimers.get(id)); this.dayTimers.delete(id)
    this.cancelApprovals(id,'This agent was closed.')
    for (const m of s.messages) this.deleteAttachments(m)
    this.sessions.delete(id)
    try { this.save() } catch (error) { this.emit('storage-error',error) }
    this.emit('change',id)
    // An initiative's worktree is left on disk on purpose. Forgetting a conversation is a
    // change to Fleet's records; deleting a branch with uncommitted work on it is a change
    // to the operator's code, and the two should never happen with the same click. The path
    // comes back so the caller can say where the work went.
    return {id, sessionId:s.sessionId, worktree:s.worktree?.path || null, branch:s.worktree?.branch || null}
  }
  async close() {
    this.closed=true
    clearInterval(this.sweepTimer)
    clearInterval(this.heldTimer)
    for (const timer of this.dayTimers.values()) clearTimeout(timer)
    const running=[...this.runs.values()]
    for (const id of this.runs.keys()) this.stop(id)
    await Promise.allSettled(running.map(r=>r.done))
    try { this.save() } finally { clearTimeout(this.saveTimer); this.releaseLock() }
  }
}
// An empty choice means "leave it to the project", which is the SDK's own default.
// Who is asking for this approval. Inside an initiative, "the session wants to run rm" is
// not good enough: the operator needs to know which role wants it. The SDK marks a
// subagent's request with an agentID but not with the role name, so the name is recovered
// from the delegation that is in flight. With two delegations running at once that is
// ambiguous, and an honest null beats a confident guess at the wrong role.
// Where a sub-agent's events land: an initiative's delegation, or a Day's subagent.
function delegationFor(s,id) {
  return s.taskBoard?.delegations.find(d=>d.id===id) || s.subagents?.find(d=>d.id===id) || null
}
function interruptSubagents(s) {
  for (const d of s.subagents || []) if (d.status === 'running') {
    d.status = 'interrupted'; d.finishedAt = Date.now()
    for (const step of d.steps) if (step.status === 'running') step.status = 'interrupted'
  }
}
// Tokens this session has used, summed across every model in each turn (a Day's Haiku
// scouts included), from the totals the SDK reports once a turn ends.
function addTokens(s,event) {
  const models=Object.values(event.modelUsage || {})
  if (!models.length) return
  const total=s.tokenUsage ||= {input:0,output:0,cacheRead:0,cacheCreation:0}
  for (const m of models) for (const [key,field] of [['input','inputTokens'],['output','outputTokens'],['cacheRead','cacheReadInputTokens'],['cacheCreation','cacheCreationInputTokens']]) {
    const value=m[field]
    if (Number.isFinite(value) && value>0) total[key]+=value
  }
}
function roleAsking(s,context) {
  const team = s.teamSnapshot || getTeam(s.teamId)
  if (!team) return null
  // No agentID means the request came from the main thread, which is the manager by
  // definition. The role name comes from the team rather than a literal, because a future
  // team is free to call that role something else.
  if (!context.agentID) return team.manager
  const running = s.messages.filter(m => m.role==='tool' && (m.tool==='Agent' || m.tool==='Task') && m.status==='running')
  return running.length === 1 ? (running[0].input?.subagent_type || null) : null
}
function modelChoice(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !/^[\w.:-]{1,80}$/.test(value)) fail('That model name is not valid.')
  return value
}
// Stored conversation entries, in the shape turnSummary() reads from transcripts.
function managedEvents(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'user') out.push({ at: m.at, kind: 'user' })
    else if (m.role === 'assistant') out.push({ at: m.at, kind: 'answer' })
    else if (m.role === 'tool') {
      out.push({ at: m.at, kind: 'tool', id: m.id, tool: m.tool, target: m.target || null })
      if (m.status === 'error') out.push({ at: m.at + (m.ms || 0), kind: 'error', id: m.id, tool: m.tool })
    }
  }
  return out
}
// What + Today hands the Day about a project task: the task itself (brief, note, links),
// then the project's story in order of use (brief, decisions, recent log), and the path
// to the file for everything else. Bounded to what an item's context holds.
const HANDOFF_MAX = 8000
function handoff(p, d) {
  const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text
  const decisions = p.sections.find(x => /^decisions?$/i.test(x.heading))?.body || ''
  const others = p.sections.filter(x => !/^decisions?$/i.test(x.heading)).map(x => x.heading)
  const log = (p.log || []).slice(-8).map(l => `- ${stamp(l.at)} ${l.text}`).join('\n')
  const head = [
    `A task from the project "${p.name}"${p.deadline ? ` (deadline ${p.deadline})` : ''}. Its file is ${p.file}: read it for the full story before writing the launch brief.`,
    `## The task: ${d.title}\n${d.brief || 'No brief written for this task yet. Read the project file, and ask the operator only what it does not answer.'}${d.note ? `\nStatus note: ${d.note}` : ''}${d.links?.length ? `\nLinks:\n${d.links.map(l => `- ${l}`).join('\n')}` : ''}`,
  ].join('\n\n')
  const rest = [
    p.brief ? `## Project brief\n${clip(p.brief, 2500)}` : '',
    decisions ? `## Decisions\n${clip(decisions, 1500)}` : '',
    log ? `## Recent project log\n${log}` : '',
    p.repos?.length ? `Repositories: ${p.repos.join(', ')}` : '',
    others.length ? `Also in the project file: ${others.join(', ')}.` : '',
  ].filter(Boolean).join('\n\n')
  return clip(rest ? `${head}\n\n${rest}` : head, HANDOFF_MAX)
}
// A session launched for a project task starts knowing where the project's story is,
// and with the task's links even if the brief left them out.
function withProject(prompt, item, p) {
  if (!p) return prompt
  const links = (item.links || []).filter(l => !prompt.includes(l))
  const footer = `\n\n---\nThis is a task of the project "${p.name}". Its file, ${p.file}, holds the project's brief, decisions, sources and history: read it before you start. Fleet keeps that file up to date; do not edit it.${links.length ? `\nLinks for this task:\n${links.slice(0, 12).map(l => `- ${l}`).join('\n')}` : ''}`
  return `${prompt.slice(0, 16000 - footer.length)}${footer}`
}
// One line for the project log about a change made outside Fleet: the tool and the thing
// it changed, never the content itself.
function describeWrite(tool, input) {
  const name = tool.replace(/^mcp__/, '').replace(/__/, ' ')
  const target = ['url','page_id','pageId','id','issueId','identifier','title','name'].map(k => input?.[k]).find(v => typeof v === 'string' && v.trim())
  return `${name}${target ? ` (${String(target).replace(/\s+/g, ' ').slice(0, 120)})` : ''}`
}
function linksFromMessages(messages) {
  const links=new Map()
  for(const message of messages)for(const match of (message.role==='tool' ? '' : message.text || '').matchAll(/https:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+|linear\.app\/[A-Za-z0-9_-]+\/issue\/[A-Za-z]+-\d+(?:\/[A-Za-z0-9_-]+)?)/g)) {
    const url=match[0],pr=url.includes('github.com/')
    links.set(url,{url,kind:pr?'pr':'linear',label:pr?'PR #'+url.split('/').pop():url.match(/issue\/([A-Za-z]+-\d+)/)[1]})
  }
  return [...links.values()].slice(-20)
}
module.exports={ManagedSessions,ACTIVE}
