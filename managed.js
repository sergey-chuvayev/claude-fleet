'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { gitBranch, turnSummary, toolTarget, transcriptFor } = require('./fleet')
const { askReason, normaliseMode, MODES, DEFAULT_MODE } = require('./permissions')
const { stateDir } = require('./paths')
const { getTeam, compile, boundedModel } = require('./teams')
const { TeamStore } = require('./team-store')
const { UsageTracker } = require('./usage')
const { Dispatcher } = require('./dispatch')
const tasks = require('./tasks')
const ownerReview = require('./owner-review')
const worktrees = require('./worktree')

const { resolveReferences, referencePrompt } = require('./references')

const ACTIVE = new Set(['starting', 'running', 'approval', 'stopping'])
// Used until a live run reports the runtime's own list, which replaces it.
const FALLBACK_MODELS = [
  { value: '', displayName: 'Fleet default', description: 'Team manager model, or Sonnet for a single agent; without [1m]' },
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
]
const MAX_MESSAGES = 200
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
const MAX_TOOL_INPUT = 2000
const MAX_TOOL_RESULT = 6000
// Tool names whose result is the point of the block; others are summarised by their input.
const QUIET_RESULT = new Set(['TodoWrite', 'Write', 'Edit', 'NotebookEdit'])
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
  constructor({ directory = stateDir(), queryFactory, externalSessions = () => [], queue } = {}) {
    super()
    this.directory = directory
    this.queryFactory = queryFactory || (async args => (await import('@anthropic-ai/claude-agent-sdk')).query(args))
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
    this.saveTimer = null
    // Plan windows belong to the account, so one tracker serves every session and
    // outlives all of them. It is deliberately not persisted: a utilisation figure from
    // before a restart describes a window that has probably already turned over.
    this.usage = new UsageTracker()
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = path.join(directory, 'sessions.json')
    this.attachmentsDir = path.join(directory, 'attachments')
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 })
    this.lock = path.join(directory, 'server.lock')
    this.acquireLock()
    try {
      this.teams = new TeamStore(directory)
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Unsupported session store format')
        for (const s of data.sessions) {
          if (!s.id || !Array.isArray(s.messages)) throw new Error('Invalid saved session')
          if (ACTIVE.has(s.status)) { s.status = 'stopped'; s.error = 'Fleet restarted. Send a message to continue this conversation.' }
          // The order sessions were waiting in lives in memory and does not survive a
          // restart, so a reloaded session cannot be left claiming a place it no longer
          // holds. It says so rather than sitting at "queued" forever, waiting for a
          // turn that nothing will ever hand it.
          if (s.status === 'queued') { s.status = 'stopped'; s.error = 'Fleet restarted while this was waiting for a free agent. Send a message to start it.' }
          tasks.interrupt(s)
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
    fs.writeFileSync(tmp, JSON.stringify({version:1,sessions:[...this.sessions.values()].map(s => ({...s,approvals:[]}))}), {mode:0o600})
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
      managedId:s.id, sessionId:s.sessionId, shortId:(s.sessionId || s.id).slice(0,8),
      name:s.name, title:s.name, branch:gitBranch(s.cwd), cwd:s.cwd, cwdShort:s.cwd.replace(os.homedir(),'~'),
      state:ACTIVE.has(s.status) && s.status !== 'approval' ? 'busy' : 'idle',
      managedStatus:s.status, managed:true, alive:ACTIVE.has(s.status), pid:null,
      lastActivity:s.updatedAt, startedAt:s.createdAt, lastPrompt:s.lastPrompt,
      latestResponse:[...s.messages].reverse().find(m => m.role === 'assistant')?.text || null,
      model:s.model, contextTokens:s.contextTokens || null, contextLimit:s.contextLimit || 200000,
      permissionMode:'default', approvalMode:s.approvalMode || DEFAULT_MODE, selectedModel:s.selectedModel || '', messages:s.messages.filter(m=>m.role!=='tool').length, links:linksFromMessages(s.messages), approvals:s.approvals.length,
      turn:turnSummary(managedEvents(s.messages), { working: ACTIVE.has(s.status) && s.status !== 'approval' }),
      error:s.error, currentTool:s.currentTool, resumeCmd:s.sessionId ? `claude --resume ${s.sessionId}` : null,
      kind:s.kind || 'agent', teamId:s.teamId || null, teamName:s.teamName || null, taskProgress:tasks.progress(s),
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
  setQueue({ limit, paused } = {}) {
    if (limit !== undefined) this.dispatch.setLimit(limit)
    if (paused !== undefined) this.dispatch.setPaused(paused)
    this.dispatchNext()
    return this.queueState()
  }
  create(body) {
    const rid = requestId(body.requestId)
    const previous = [...this.sessions.values()].find(s => s.createRequestId === rid)
    if (previous) return previous
    if (this.closed) fail('Fleet is shutting down.',503)
    if (this.sessions.size >= 100) fail('Fleet has reached its 100-session limit.',409)
    let cwd = text(body.cwd,'Project directory',4096)
    if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1))
    if (!path.isAbsolute(cwd)) fail('Use an absolute project path or ~/path.')
    try { cwd = fs.realpathSync(cwd); if (!fs.statSync(cwd).isDirectory()) fail('Project path must be a directory.') }
    catch { fail('Project directory does not exist or is not accessible.') }
    const hasImages = Array.isArray(body.images) && body.images.length > 0
    const prompt = hasImages && !(body.prompt || '').trim() ? '' : text(body.prompt,'Message',16000)
    const name = body.name?.trim() ? text(body.name,'Session name',100) : (prompt || 'Image').slice(0,70)
    let resume = null
    if (body.resumeSessionId) {
      const source = this.externalSessions().find(s => s.sessionId === body.resumeSessionId)
      if (!source || source.alive || source.cwd !== cwd) fail('Only a stopped session in this project can be resumed.',409)
      if ([...this.sessions.values()].some(s => s.sessionId === source.sessionId)) fail('This conversation is already managed by Fleet.',409)
      resume = source.sessionId
    }
    this.checkCapacity()
    // A team turns this conversation into an initiative: the manager takes the main thread
    // and the work happens on a branch of its own rather than in the operator's checkout.
    const team = body.teamId ? this.teams.get(text(body.teamId,'Team',60)) : null
    if (body.teamId && !team) fail('That team does not exist.')
    if (team && resume) fail('A resumed conversation cannot be given a team.',409)
    const id = randomUUID()
    const worktree = team ? worktrees.create({cwd,id,name}) : null
    const s = {id,sessionId:resume,name,cwd:worktree ? worktree.path : cwd,createRequestId:rid,createdAt:Date.now(),updatedAt:Date.now(),status:'idle',approvalMode:normaliseMode(body.approvalMode),selectedModel:modelChoice(body.model),messages:[],approvals:[],model:null,contextTokens:null,error:null,currentTool:null,requestIds:[],queue:[],kind:team ? 'initiative' : 'agent',teamId:team?.id || null,teamName:team?.name || null,teamSnapshot:team ? structuredClone(team) : null,taskBoard:team?.workflow ? {tasks:[],delegations:[]} : null,worktree}
    if (ownerReview.enabled(s)) {
      try {s.reviewBaseCommit=ownerReview.snapshot(s).commit;s.ownerRequest=prompt || 'Implement the request in the attached images.'}
      catch(error) {worktrees.remove(worktree);throw error}
    }
    this.sessions.set(s.id,s)
    try { this.send(s.id,{message:prompt,images:body.images,requestId:rid}) }
    catch (error) { this.sessions.delete(s.id); if (worktree) worktrees.remove(worktree); throw error }
    return s
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
    // Another live process on the same session would write the same transcript.
    // Refuse, and name the holder so the operator can find that window.
    const holder = s.sessionId ? this.externalSessions().find(x => x.sessionId === s.sessionId && x.alive) : null
    if (holder) {
      const where = holder.entrypoint === 'cli' ? 'a terminal' : 'another program'
      const since = holder.startedAt ? ` since ${new Date(holder.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
      fail(`This conversation is open in ${where}${holder.name ? ` (${holder.name}${since})` : since ? ` (${since.trim()})` : ''}. Fleet will not send while another process is driving the same session; close it there, or keep working there.`,409)
    }
    const references = resolveReferences(body.references, {target:s, managed:[...this.sessions.values()], external:body.references?.length ? this.externalSessions() : [], transcriptFor})
    const attachments = hasImages ? this.saveImages(body.images) : []
    s.requestIds = [...s.requestIds,rid].slice(-200)
    const queued = {message,attachments,references}
    // Mid-turn, the SDK session can't take a second prompt yet: hold this one and let
    // the run's own completion (see the `finally` in run()) start it the moment the
    // agent is free, instead of making the operator retry once it's idle.
    if (this.runs.has(id)) { s.queue = [...s.queue, queued]; this.changed(s,true); return s }
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
  startTurn(s, {message,attachments,references}) {
    const entry = {id:randomUUID(),role:'user',text:message,at:Date.now(),...(attachments.length ? {attachments} : {}),...(references.length ? {references} : {})}
    s.messages.push(entry)
    this.pruneMessages(s)
    s.lastPrompt = message || `${attachments.length} image${attachments.length === 1 ? '' : 's'}`; s.error = null; s.status = 'starting'; s.currentTool = null
    const run = {controller:new AbortController(),query:null,stopping:false,finished:false,streamText:'',assistant:null,result:false,stderr:''}
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
    const promptText = referencePrompt(entry.text, entry.references)
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
  async run(s,run,entry) {
    const prompt = typeof entry === 'string' ? entry : this.promptFor(entry)
    try {
      const options = {
        cwd:s.cwd,permissionMode:'default',settingSources:['user','project','local'],
        systemPrompt:{type:'preset',preset:'claude_code'},
        includePartialMessages:true,abortController:run.controller,
        canUseTool:(tool,input,context) => this.ask(s,run,tool,input,context),
        stderr:chunk => { run.stderr = (run.stderr+chunk).slice(-4000) },
        ...(s.sessionId ? {resume:s.sessionId} : {}),
      }
      options.model = boundedModel(s.selectedModel)
      options.effort = 'medium'
      // `agent` puts the manager on the main thread, so the operator's messages reach it and
      // nobody else; `agents` is where the Agent tool resolves the rest of the team from.
      // Both compose with the claude_code preset above, which keeps the built-in tools.
      const team = s.teamSnapshot || getTeam(s.teamId)
      if (team) {
        Object.assign(options, compile(team))
        const manager=options.agents[team.manager]
        options.model=boundedModel(s.selectedModel || manager.model,'opus')
        manager.model=options.model
        options.effort=manager.effort
        options.maxTurns=manager.maxTurns
      }
      if (team?.workflow) {
        if (ownerReview.refresh(s)) this.changed(s,true)
        const remaining=(s.limits?.budgetUsd ?? team.workflow.budgetUsd)-(s.costUsd || 0)
        if (remaining<=0) throw new Error('Usage cap reached. Increase the cap explicitly before continuing.')
        options.maxBudgetUsd=remaining
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
      if (process.env.CLAUDE_FLEET_EXECUTABLE) options.pathToClaudeCodeExecutable = process.env.CLAUDE_FLEET_EXECUTABLE
      run.query = await this.queryFactory({prompt,options})
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
      ownerReview.refresh(s)
      for (const entry of run.tools?.values() || []) if (entry.status === 'running') entry.status = 'interrupted'
      if (run.stopping) s.status='stopped'
      else if (s.status !== 'error') s.status='idle'
      s.currentTool=null
      this.runs.delete(s.id)
      // A clean finish with something waiting picks it straight back up. A stop already
      // dropped the queue; an error drops it too rather than firing a follow-up message
      // at a conversation that just failed, unseen, behind the operator's back.
      if (s.status !== 'idle') s.queue=[]
      const next = s.status === 'idle' && s.queue.length ? s.queue[0] : null
      if (next) s.queue = s.queue.slice(1)
      try { this.changed(s,true) } catch (error) { this.emit('storage-error',error) }
      if (next) { try { this.startTurn(s,next) } catch (error) { this.emit('storage-error',error) } }
      // This session's own follow-up comes first — it is mid-conversation and already
      // holds the slot. Only what is genuinely left over goes to the queue.
      this.dispatchNext()
    }
  }
  event(s,run,event) {
    if (event.session_id && !event.parent_tool_use_id) s.sessionId=event.session_id
    // Account-wide, so it is recorded whoever emitted it, sub-agent turns included.
    if (event.type==='rate_limit_event') this.usage.recordEvent(event.rate_limit_info)
    if (s.taskBoard && event.parent_tool_use_id) {
      const d=s.taskBoard.delegations.find(d=>d.id===event.parent_tool_use_id)
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
    if (s.taskBoard && event.type==='system' && ['task_progress','task_notification'].includes(event.subtype)) {
      const d=s.taskBoard.delegations.find(d=>d.id===event.tool_use_id)
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
    const {budgetUsd,maxAttempts}=body
    if (!Number.isFinite(budgetUsd) || budgetUsd<0.1 || budgetUsd>1000 || budgetUsd<(s.costUsd || 0)) fail('Choose a usage cap between the amount already used and $1,000 (minimum $0.10).')
    if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>10) fail('Choose 1–10 attempts per task.')
    const previous=s.limits
    s.limits={budgetUsd,maxAttempts}
    try {this.changed(s,true)} catch(error) {s.limits=previous;throw error}
    return s
  }
  setModelChoice(id,body) {
    const s=this.get(id)
    s.selectedModel=modelChoice(body.model)
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
    const reason=askReason(tool,input,s.approvalMode)
    if (!reason) return Promise.resolve({behavior:'allow',updatedInput:input})
    return new Promise(resolve => {
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
function clampInput(input) {
  if (input === null || typeof input !== 'object') return {}
  const out = {}
  for (const [key,value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value.length > MAX_TOOL_INPUT ? value.slice(0,MAX_TOOL_INPUT)+'\n… truncated' : value
    else if (value === null || ['number','boolean'].includes(typeof value)) out[key] = value
    else { const json = JSON.stringify(value) ?? ''; out[key] = json.length > MAX_TOOL_INPUT ? json.slice(0,MAX_TOOL_INPUT)+'… truncated' : value }
  }
  return out
}
function resultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : '').filter(Boolean).join('\n')
  return ''
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
function linksFromMessages(messages) {
  const links=new Map()
  for(const message of messages)for(const match of (message.role==='tool' ? '' : message.text || '').matchAll(/https:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+|linear\.app\/[A-Za-z0-9_-]+\/issue\/[A-Za-z]+-\d+(?:\/[A-Za-z0-9_-]+)?)/g)) {
    const url=match[0],pr=url.includes('github.com/')
    links.set(url,{url,kind:pr?'pr':'linear',label:pr?'PR #'+url.split('/').pop():url.match(/issue\/([A-Za-z]+-\d+)/)[1]})
  }
  return [...links.values()].slice(-20)
}
module.exports={ManagedSessions,ACTIVE}
