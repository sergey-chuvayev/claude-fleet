'use strict'
const fs=require('node:fs')
const path=require('node:path')
const os=require('node:os')
const {randomUUID}=require('node:crypto')
const {spawn}=require('node:child_process')
const {defaultCwd}=require('./paths')
const fail=(message,status=400)=>Object.assign(new Error(message),{status})
const STATES=new Set(['connected','failed','needs-auth','pending','disabled'])
// Deliberately do not expose config, stderr, or raw errors: MCP transports can
// include bearer headers, environment variables and credential-bearing URLs.
function publicServer(server,query) {
  const status=STATES.has(server.status) ? server.status : 'pending'
  const internal=server.name==='fleet'
  return {name:String(server.name),status,scope:server.scope || 'unknown',internal,
    tools:(server.tools || []).map(t=>String(t.name)),
    canReconnect:!internal && typeof query.reconnectMcpServer==='function',
    canToggle:!internal && typeof query.toggleMcpServer==='function',
    canAuthenticate:!internal && typeof query.mcpAuthenticate==='function',
    auth:server.scope==='claudeai' || server.config?.type==='claudeai-proxy' ? 'claudeai':'cli',
    error:status==='failed' ? 'Connection failed. Check that the server is reachable and its credentials are current, then reconnect.' : null}
}
// A sign-in page opens in the operator's default browser, where they are already signed
// in to claude.ai and their other accounts. Opening it from the dashboard would land in
// Fleet's own app window, a separate browser profile signed in to nothing.
function openInBrowser(url) {
  const [command,args]=process.platform==='darwin' ? ['open',[url]] : process.platform==='win32' ? ['cmd',['/c','start','',url]] : ['xdg-open',[url]]
  return new Promise(resolve=>{
    try {
      const child=spawn(command,args,{stdio:'ignore',detached:true})
      child.once('error',()=>resolve(false))
      child.once('spawn',()=>{child.unref();resolve(true)})
    } catch { resolve(false) }
  })
}
class Connections {
  constructor(manager,{timeoutMs=10000,idleMs=180000,openUrl=openInBrowser}={}) {
    this.manager=manager;this.timeoutMs=timeoutMs;this.idleMs=idleMs;this.openUrl=openUrl;this.probe=null;this.busy=false;this.closed=false;this.identities=new WeakMap()
  }
  async bounded(promise) {
    let timer
    try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('Connection check timed out. Try again; the server may still be starting.',504)),Math.max(1,this.deadline-Date.now()))})])}
    finally {clearTimeout(timer)}
  }
  dispose() {
    const probe=this.probe;this.probe=null
    if(!probe)return
    clearTimeout(probe.timer);probe.release();probe.controller.abort()
    try{probe.query?.close()}catch{}
  }
  touch() {
    if(!this.probe)return
    clearTimeout(this.probe.timer)
    this.probe.timer=setTimeout(()=>this.dispose(),this.idleMs);this.probe.timer.unref?.()
  }
  async target(data) {
    if(this.closed)throw fail('Fleet is shutting down.',503)
    const session=data.sessionId ? this.manager.get(data.sessionId) : null
    const run=session && this.manager.runs.get(session.id)
    if(run && (!run.query || run.stopping || run.finished))throw fail('The agent is starting or stopping. Try again in a moment.',409)
    if(run?.query){
      if(!this.identities.has(run.query))this.identities.set(run.query,randomUUID())
      return {query:run.query,cwd:session.cwd,source:'session',connectionId:this.identities.get(run.query)}
    }
    let cwd=session?.cwd || data.cwd || defaultCwd()
    if(typeof cwd!=='string' || cwd.length>4096)throw fail('Choose a valid project directory.')
    cwd=path.resolve(cwd.replace(/^~(?=\/|$)/,os.homedir()))
    try {if(!fs.statSync(cwd).isDirectory())throw Error();cwd=fs.realpathSync(cwd)}catch{throw fail('Project directory does not exist.')}
    if(this.probe?.cwd!==cwd)this.dispose()
    if(!this.probe){
      let release
      const wait=new Promise(resolve=>{release=resolve})
      const probe={cwd,id:randomUUID(),controller:new AbortController(),release,query:null}
      this.probe=probe
      const prompt=(async function*(){await wait})()
      const options={cwd,settingSources:['user','project','local'],abortController:probe.controller,persistSession:false,
        canUseTool:async()=>({behavior:'deny',message:'Connection checks do not execute agent tools.'})}
      if(process.env.CLAUDE_FLEET_EXECUTABLE)options.pathToClaudeCodeExecutable=process.env.CLAUDE_FLEET_EXECUTABLE
      const creating=Promise.resolve(this.manager.queryFactory({prompt,options})).then(query=>{
        if(this.probe!==probe){try{query.close()}catch{};throw fail('Connection check expired. Check again.',409)}
        probe.query=query;return query
      })
      probe.query=await this.bounded(creating)
    }
    this.touch()
    return {query:this.probe.query,cwd,source:'project',connectionId:this.probe.id}
  }
  async request(data={}) {
    if(this.busy)throw fail('Another connection check is in progress. Try again shortly.',409)
    if(!['check','reconnect','enable','disable','authenticate'].includes(data.action || 'check'))throw fail('Unknown connection action.')
    this.busy=true;this.deadline=Date.now()+this.timeoutMs
    try {
      const target=await this.target(data),{query}=target
      if(typeof query.mcpServerStatus!=='function')throw fail('This Claude SDK does not support connection checks. Update Fleet.',409)
      let servers=await this.bounded(query.mcpServerStatus())
      const action=data.action || 'check'
      let auth=null
      if(action!=='check'){
        // Never silently act on a replacement transport after the selected turn ended.
        if(data.connectionId!==target.connectionId || data.source!==target.source)throw fail('The connection changed. Check connections again before making changes.',409)
        const server=servers.find(s=>s.name===data.name)
        if(!server)throw fail('This server is no longer available. Check connections again.',404)
        if(server.name==='fleet')throw fail('Fleet’s task tools are managed by Fleet.')
        if(action==='authenticate')auth=await this.authenticate(query,data.name)
        else {
          const method=action==='reconnect' ? 'reconnectMcpServer':'toggleMcpServer'
          if(typeof query[method]!=='function')throw fail('Update Fleet to use this connection control.',409)
          await this.bounded(query[method](data.name,...(action==='reconnect' ? []:[action==='enable'])))
        }
        servers=await this.bounded(query.mcpServerStatus())
      }
      this.touch()
      return {...target,query:undefined,checkedAt:Date.now(),servers:servers.map(s=>publicServer(s,query)),...(auth ? {auth} : {})}
    }catch(error){
      this.dispose()
      if(error.status)throw error
      throw fail('Claude could not complete the connection check. Check your Claude login and server configuration, then retry.',502)
    }finally{this.busy=false}
  }
  // Start a server's sign-in. Claude returns the page to finish it on: a claude.ai
  // connector's own authorization page, or an OAuth provider's, with Claude listening on
  // localhost for the callback and reconnecting by itself once it arrives. The probe is
  // kept alive meanwhile, since that listener lives in it.
  async authenticate(query,name) {
    if(typeof query.mcpAuthenticate!=='function')throw fail('This Claude runtime cannot start a sign-in. Update Claude Code, or run /mcp in Claude Code for this project.',409)
    let response
    try { response=await this.bounded(query.mcpAuthenticate(name)) }
    catch(error) { if(error.status)throw error; throw fail(`Claude could not start the sign-in for ${name}. ${String(error.message || '').slice(0,200)}`.trim(),502) }
    const url=typeof response?.authUrl==='string' ? response.authUrl : null
    if(url && !/^https:\/\//.test(url))throw fail('Claude returned a sign-in address Fleet will not open.',502)
    const opened=url ? await this.openUrl(url) : false
    return {name,url,opened,needsAction:!!response?.requiresUserAction,callback:!!response?.callbackExpected}
  }
  close(){this.closed=true;this.dispose()}
}
module.exports={Connections,publicServer,openInBrowser}
