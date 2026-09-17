'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { gitBranch, turnSummary, toolTarget, transcriptFor } = require('./fleet')
const { askReason, normaliseMode, MODES, DEFAULT_MODE } = require('./permissions')

const { resolveReferences, referencePrompt } = require('./references')

const ACTIVE = new Set(['starting', 'running', 'approval', 'stopping'])
// Used until a live run reports the runtime's own list, which replaces it.
const FALLBACK_MODELS = [
  { value: '', displayName: 'Project default', description: 'Whatever this project is configured to use' },
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
  constructor({ directory = path.join(__dirname, '.fleet'), queryFactory, externalSessions = () => [] } = {}) {
    super()
    this.directory = directory
    this.queryFactory = queryFactory || (async args => (await import('@anthropic-ai/claude-agent-sdk')).query(args))
    this.externalSessions = externalSessions
    this.sessions = new Map()
    this.runs = new Map()
    this.pending = new Map()
    this.closed = false
    this.models = null
    this.saveTimer = null
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = path.join(directory, 'sessions.json')
    this.attachmentsDir = path.join(directory, 'attachments')
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 })
    this.lock = path.join(directory, 'server.lock')
    this.acquireLock()
    try {
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Unsupported session store format')
        for (const s of data.sessions) {
          if (!s.id || !Array.isArray(s.messages)) throw new Error('Invalid saved session')
          if (ACTIVE.has(s.status)) { s.status = 'stopped'; s.error = 'Fleet restarted. Send a message to continue this conversation.' }
          s.approvals = []
          s.currentTool = null
          for (const m of s.messages) if (m.role === 'tool' && m.status === 'running') m.status = 'interrupted'
          s.approvalMode = normaliseMode(s.approvalMode)
          this.sessions.set(s.id, s)
        }
      }
    } catch (error) { this.releaseLock(); throw new Error(`Cannot read Fleet session store: ${error.message}`) }
  }
  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        const pid = Number(fs.readFileSync(this.lock, 'utf8'))
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Fleet lock file; inspect .fleet/server.lock.')
        try { process.kill(pid, 0) }
        catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(this.lock); continue } }
        throw new Error(`Fleet controls are already running (PID ${pid}). Open that server instead.`)
      }
    }
    throw new Error('Cannot acquire Fleet session lock')
  }
  releaseLock() {
    try { if (fs.readFileSync(this.lock, 'utf8') === String(process.pid)) fs.unlinkSync(this.lock) } catch {}
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
  detail(id) { return structuredClone(this.get(id)) }
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
    }))
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
    const s = {id:randomUUID(),sessionId:resume,name,cwd,createRequestId:rid,createdAt:Date.now(),updatedAt:Date.now(),status:'idle',approvalMode:normaliseMode(body.approvalMode),selectedModel:modelChoice(body.model),messages:[],approvals:[],model:null,contextTokens:null,error:null,currentTool:null,requestIds:[]}
    this.sessions.set(s.id,s)
    try { this.send(s.id,{message:prompt,images:body.images,requestId:rid}) }
    catch (error) { this.sessions.delete(s.id); throw error }
    return s
  }
  checkCapacity() {
    if (this.closed) fail('Fleet is shutting down.',503)
    if (this.runs.size >= 4) fail('Four agents are already running. Stop one or wait for it to finish.',409)
  }
  send(id, body) {
    const s = this.get(id)
    const rid = requestId(body.requestId)
    if (s.requestIds.includes(rid)) return s
    const hasImages = Array.isArray(body.images) && body.images.length > 0
    const message = hasImages && !(body.message || '').trim() ? '' : text(body.message,'Message',16000)
    if (this.runs.has(id)) fail('This agent is still working. Stop it or wait before sending another message.',409)
    // Another live process on the same session would write the same transcript.
    // Refuse, and name the holder so the operator can find that window.
    const holder = s.sessionId ? this.externalSessions().find(x => x.sessionId === s.sessionId && x.alive) : null
    if (holder) {
      const where = holder.entrypoint === 'cli' ? 'a terminal' : 'another program'
      const since = holder.startedAt ? ` since ${new Date(holder.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
      fail(`This conversation is open in ${where}${holder.name ? ` (${holder.name}${since})` : since ? ` (${since.trim()})` : ''}. Fleet will not send while another process is driving the same session; close it there, or keep working there.`,409)
    }
    this.checkCapacity()
    const references = resolveReferences(body.references, {target:s, managed:[...this.sessions.values()], external:body.references?.length ? this.externalSessions() : [], transcriptFor})
    const attachments = hasImages ? this.saveImages(body.images) : []
    s.requestIds = [...s.requestIds,rid].slice(-200)
    const entry = {id:randomUUID(),role:'user',text:message,at:Date.now(),...(attachments.length ? {attachments} : {}),...(references.length ? {references} : {})}
    s.messages.push(entry)
    this.pruneMessages(s)
    s.lastPrompt = message || `${attachments.length} image${attachments.length === 1 ? '' : 's'}`; s.error = null; s.status = 'starting'; s.currentTool = null
    const run = {controller:new AbortController(),query:null,stopping:false,finished:false,streamText:'',assistant:null,result:false,stderr:''}
    this.runs.set(id,run)
    try { this.changed(s,true) }
    catch (error) { this.runs.delete(id); s.status='error'; s.requestIds=s.requestIds.filter(x=>x!==rid); s.messages.pop(); throw error }
    run.done = this.run(s,run,entry)
    return s
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
      if (s.selectedModel) options.model = s.selectedModel
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
      for (const entry of run.tools?.values() || []) if (entry.status === 'running') entry.status = 'interrupted'
      if (run.stopping) s.status='stopped'
      else if (s.status !== 'error') s.status='idle'
      s.currentTool=null
      this.runs.delete(s.id)
      try { this.changed(s,true) } catch (error) { this.emit('storage-error',error) }
    }
  }
  event(s,run,event) {
    if (event.session_id) s.sessionId=event.session_id
    if (event.type === 'system' && event.subtype === 'init') { s.model=event.model; s.status='running' }
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
    if (event.type === 'tool_progress') s.currentTool=event.tool_name
    if (event.type === 'result') {
      run.result=true
      if (event.is_error) { s.status='error'; s.error=event.errors?.join('\n') || event.result || 'Claude could not finish this turn.' }
      else if (event.result && !s.messages.some(m=>m.role==='assistant' && m.text===event.result.slice(-24000))) s.messages.push({id:randomUUID(),role:'assistant',text:event.result.slice(-24000),at:Date.now()})
      s.costUsd=(s.costUsd||0)+(event.total_cost_usd||0)
      s.messages=s.messages.slice(-MAX_MESSAGES)
    }
    this.changed(s)
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
    entry.truncated = result.length > MAX_TOOL_RESULT
    entry.result = block.is_error || !QUIET_RESULT.has(entry.tool) ? result.slice(0,MAX_TOOL_RESULT) : null
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
      const approval={id,tool,input,at:Date.now(),reason,description:context.title || context.decisionReason || null}
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
    if (!run || run.stopping) return s
    run.stopping=true; s.status='stopping'; this.cancelApprovals(id,'The user stopped this agent.')
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
    this.cancelApprovals(id,'This agent was closed.')
    for (const m of s.messages) this.deleteAttachments(m)
    this.sessions.delete(id)
    try { this.save() } catch (error) { this.emit('storage-error',error) }
    this.emit('change',id)
    return {id, sessionId:s.sessionId}
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
