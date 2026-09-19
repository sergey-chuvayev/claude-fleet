#!/usr/bin/env node
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { collect, transcriptFor } = require('./fleet.js')
const { ManagedSessions } = require('./managed.js')
const { readTheme, themeCss } = require('./theme.js')
const { collect: collectCatalog } = require('./catalog.js')
const { SearchJobs, warm: warmSearch, WINDOW_DAYS: SEARCH_DAYS } = require('./search.js')
const { Archive } = require('./archive.js')
const { Updater } = require('./update.js')
const { defaultCwd } = require('./paths.js')
const { listTeams } = require('./teams.js')
const { listProjects } = require('./projects.js')
const { openDashboard } = require('./open.js')
const { version: VERSION } = require('./package.json')
const HOST = '127.0.0.1'
const MODEL_FALLBACK = [
  { value:'', displayName:'Project default', description:'Whatever this project is configured to use' },
  { value:'opus', displayName:'Opus', description:'Most capable' },
  { value:'sonnet', displayName:'Sonnet', description:'Balanced' },
  { value:'haiku', displayName:'Haiku', description:'Fastest' },
]
const PUBLIC = path.join(__dirname,'public')
const TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.webmanifest':'application/manifest+json'}

function createApp({manager = new ManagedSessions({externalSessions:()=>collect().sessions}), collectSessions = collect, search = new SearchJobs(), archive = new Archive(), updater = new Updater(), restart = null} = {}) {
  const token=randomBytes(32).toString('hex')
  const clients=new Set(), changes=new Set()
  let eventTimer=null, storageError=null
  const broadcast=()=>{
    eventTimer=null
    const data=`event: sessions\ndata: ${JSON.stringify([...changes])}\n\n`
    changes.clear()
    for (const res of clients) if (!res.write(data)) { res.end(); clients.delete(res) }
  }
  manager.on('change',id=>{changes.add(id);if(!eventTimer) eventTimer=setTimeout(broadcast,120)})
  manager.on('storage-error',error=>{storageError='Unable to save Fleet conversations. Check disk space and permissions.';console.error(error.message)})
  let theme=readTheme(), themeReadAt=Date.now()
  const currentTheme=()=>{
    if(Date.now()-themeReadAt>30000){theme=readTheme();themeReadAt=Date.now()}
    return theme
  }
  const heartbeat=setInterval(()=>{for(const res of clients) res.write(': heartbeat\n\n')},15000)
  heartbeat.unref()
  const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const elsewhere=(row)=>row && row.alive ? {pid:row.pid,name:row.name || row.shortId || null,entrypoint:row.entrypoint || null,background:!!row.background,state:row.state,startedAt:row.startedAt || null} : null
  const getSnapshot=()=>{
    const snap=collectSessions()
    const managed=manager.summaries()
    const managedIds=new Set(managed.map(s=>s.sessionId).filter(Boolean))
    const external=snap.sessions.filter(s=>!managedIds.has(s.sessionId))
    for(const s of managed) {
      const transcript=snap.sessions.find(t=>t.sessionId===s.sessionId)
      const holder=elsewhere(transcript)
      if(holder){
        s.openElsewhere=holder
        s.state=holder.state==='busy' ? 'busy' : 'idle'; s.alive=true
        if(transcript.turn) s.turn=transcript.turn
        s.lastActivity=Math.max(s.lastActivity || 0, transcript.lastActivity || 0)
      }
      if(transcript){
        s.branch=transcript.branch || s.branch
        s.links=[...new Map([...(transcript.links||[]),...s.links].map(l=>[l.url,l])).values()].slice(-20)
        s.transcriptTruncated=transcript.transcriptTruncated
        // Claude names its own sessions once a conversation has taken shape. Prefer
        // that over Fleet's first-prompt slice, and keep it for the detail view too.
      }
      // Claude names its own sessions once a conversation has taken shape. Prefer
      // that over Fleet's first-prompt slice, and keep it for the detail view too.
      const aiTitle=transcriptFor(s.sessionId)?.title
      if(aiTitle){s.title=aiTitle;try{manager.get(s.managedId).aiTitle=aiTitle}catch{}}
    }
    const sessions=[...managed,...external].sort((a,b)=>{
      const rank=s=>s.managedStatus==='approval'?0:s.state==='busy'?1:s.state==='idle'?2:s.state==='stale'?3:4
      return rank(a)-rank(b) || (b.lastActivity||0)-(a.lastActivity||0)
    })
    // Archived rows are still sent, flagged: the dashboard needs them to offer an
    // Archived filter, and the counts above them describe the fleet you are working.
    const counts={busy:0,idle:0,stale:0,dead:0}
    let archived=0
    for(const s of sessions){
      s.archived=archive.isArchived(s)
      if(s.archived) archived++
      else counts[s.state]++
    }
    return {...snap,sessions,counts,total:sessions.length-archived,archived,archiveRule:archive.rule,storageError}
  }
  const authorized=(req)=>{
    const supplied=req.headers['x-fleet-token']
    if(typeof supplied!=='string' || supplied.length!==token.length) return false
    return timingSafeEqual(Buffer.from(supplied),Buffer.from(token))
  }
  async function body(req, limit = 65536) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON content type is required.'),{status:415})
    let size=0, chunks=[]
    for await(const chunk of req){size+=chunk.length;if(size>limit) throw Object.assign(new Error(limit > 65536 ? 'Attachments are too large for one message.' : 'Request is too large.'),{status:413});chunks.push(chunk)}
    let data
    try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400})}
    if(!data || typeof data!=='object' || Array.isArray(data)) throw Object.assign(new Error('Expected a JSON object.'),{status:400})
    return data
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Referrer-Policy','no-referrer')
    res.setHeader('X-Frame-Options','DENY')
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try{
      const port=server.address()?.port
      const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`])
      if(!hosts.has(req.headers.host)) return json(res,403,{error:'Invalid host.'})
      const origin=req.headers.origin
      if(origin && origin!==`http://${req.headers.host}`) return json(res,403,{error:'Cross-origin requests are not allowed.'})
      if(req.headers['sec-fetch-site']==='cross-site') return json(res,403,{error:'Cross-site requests are not allowed.'})
      const url=new URL(req.url,`http://${req.headers.host}`)
      if(req.method==='POST') {
        if(!authorized(req)) return json(res,403,{error:'Reload Fleet before sending commands.'})
        // Stopping an agent and installing an update both stay available when the
        // session store is unwritable: one is an escape hatch, the other may be the fix.
        if(storageError && url.pathname!=='/api/update' && !/^\/api\/managed\/[\w-]+\/stop$/.test(url.pathname)) return json(res,503,{error:storageError})
        // Only the two endpoints that carry a message accept image-sized bodies.
        const carriesMessage=url.pathname==='/api/managed' || /^\/api\/managed\/[\w-]+\/messages$/.test(url.pathname)
        const data=await body(req, carriesMessage ? 40 * 1024 * 1024 : 65536)
        if(url.pathname==='/api/managed') return json(res,201,{session:manager.detail(manager.create(data).id)})
        // Keyword hits come back at once; the answer is fetched by id while Claude reads them.
        if(url.pathname==='/api/search') return json(res,201,{job:search.start(data)})
        if(url.pathname==='/api/archive') return json(res,200,{changed:archive.set(data.ids,data.archived!==false),archived:archive.archived.size})
        if(url.pathname==='/api/archive/rule') return json(res,200,{rule:archive.setRule(data)})
        if(url.pathname==='/api/update'){
          const update=await updater.apply()
          // The new code is on disk but this process is still the old one. Hand the
          // port over once the answer has been written, so the page knows to wait.
          if(restart) setTimeout(()=>{restart().catch(error=>console.error(error.message))},250).unref()
          return json(res,200,{update:{...update,restarting:!!restart}})
        }
        const match=url.pathname.match(/^\/api\/managed\/([\w-]+)\/(messages|stop|mode|model|close|approvals\/([\w-]+))$/)
        if(!match) return json(res,404,{error:'Unknown action.'})
        const [,id,action,approvalId]=match
        if(action==='close') return json(res,200,{closed:await manager.remove(id)})
        if(action==='messages') manager.send(id,data)
        else if(action==='stop') manager.stop(id)
        else if(action==='mode') manager.setMode(id,data)
        else if(action==='model') manager.setModelChoice(id,data)
        else manager.decide(id,approvalId,data)
        return json(res,200,{session:manager.detail(id)})
      }
      if(req.method!=='GET') return json(res,405,{error:'Method not allowed.'})
      if(url.pathname==='/api/control') return json(res,200,{token,version:VERSION,defaultCwd:defaultCwd(),maxConcurrent:4,storageError,searchDays:SEARCH_DAYS,theme:{name:currentTheme().name,source:currentTheme().source}})
      if(url.pathname==='/api/update'){
        // Answer from the cache and refresh behind the request: a page load should
        // never wait on npm's registry, and the dashboard asks again shortly after.
        updater.check().catch(()=>{})
        return json(res,200,{update:updater.status()})
      }
      if(url.pathname==='/manifest.webmanifest'){
        const theme=currentTheme()
        res.writeHead(200,{'content-type':TYPES['.webmanifest'],'cache-control':'no-cache'})
        return res.end(JSON.stringify({
          name:'Claude Fleet', short_name:'Fleet', description:'Local control room for Claude Code sessions',
          start_url:'/', scope:'/', display:'standalone', orientation:'any',
          background_color:theme.background, theme_color:theme.background,
          icons:[192,512].map(size=>({src:`/icons/fleet-${size}.png`,sizes:`${size}x${size}`,type:'image/png',purpose:'any maskable'})),
        }))
      }
      if(url.pathname==='/theme.css'){
        res.writeHead(200,{'content-type':TYPES['.css'],'cache-control':'no-cache'})
        return res.end(themeCss(currentTheme()))
      }
      if(url.pathname==='/api/models') return json(res,200,{models:manager.models || MODEL_FALLBACK})
      if(url.pathname==='/api/teams') return json(res,200,{teams:listTeams()})
      if(url.pathname==='/api/projects') return json(res,200,{projects:listProjects(),defaultCwd:defaultCwd()})
      if(url.pathname==='/api/sessions') return json(res,200,getSnapshot())
      if(url.pathname==='/api/events') {
        if(clients.size>=20) return json(res,429,{error:'Too many dashboard connections.'})
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'})
        res.write(': connected\n\n');clients.add(res)
        req.on('close',()=>clients.delete(res));return
      }
      const searchJob=url.pathname.match(/^\/api\/search\/([\w-]+)$/)
      if(searchJob) return json(res,200,{job:search.get(searchJob[1])})
      const commands=url.pathname.match(/^\/api\/managed\/([\w-]+)\/commands$/)
      if(commands) return json(res,200,{commands:collectCatalog(manager.detail(commands[1]).cwd)})
      const attachment=url.pathname.match(/^\/api\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp))$/)
      if(attachment){
        let data
        try{ data=await fs.promises.readFile(path.join(manager.attachmentsDir,attachment[1])) }
        catch{ return json(res,404,{error:'Attachment not found.'}) }
        res.writeHead(200,{'content-type':TYPES['.'+attachment[2]],'cache-control':'private, max-age=31536000, immutable','content-length':data.length})
        return res.end(data)
      }
      const detail=url.pathname.match(/^\/api\/managed\/([\w-]+)$/)
      if(detail){
        const session=manager.detail(detail[1])
        const holder=elsewhere(collectSessions().sessions.find(t=>t.sessionId===session.sessionId))
        if(holder) session.openElsewhere=holder
        return json(res,200,{session})
      }
      const files={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/control.js':'control.js','/blocks.js':'blocks.js','/ask.js':'ask.js','/vendor/libs.js':path.join('vendor','libs.js'),'/icons/fleet-192.png':path.join('icons','fleet-192.png'),'/icons/fleet-512.png':path.join('icons','fleet-512.png')}
      const file=files[url.pathname]
      if(!file) return json(res,404,{error:'Not found.'})
      const data=await fs.promises.readFile(path.join(PUBLIC,file))
      res.writeHead(200,{'content-type':TYPES[path.extname(file)],'cache-control':'no-cache'});res.end(data)
    }catch(error){if(!res.headersSent) json(res,error.status||500,{error:error.status ? error.message : 'Fleet could not complete the request. Check the server log.'});else res.end();if(!error.status) console.error(error)}
  })
  server.requestTimeout=15000
  server.headersTimeout=10000
  async function close(){clearTimeout(eventTimer);clearInterval(heartbeat);for(const res of clients)res.end();server.close();await Promise.all([manager.close(),search.close()])}
  return {server,manager,search,archive,updater,close,getSnapshot}
}

// Starting the server is the CLI's job too, so it lives in a function rather than
// in a `require.main` block: bin/claude-fleet.js calls this, which keeps argv[1]
// pointing at the installed command that a restart needs to re-run.
function main(){
  let app
  // Hand the port to the version that was just installed. argv[1] is the entry npm
  // put on PATH; the update replaced what it points at, so re-running it runs the
  // new code. The session lock and the port are both released by close() first.
  const restart=async()=>{
    const entry=process.argv[1]
    const held=app.server.address()?.port || port
    // The page that asked for this is already open and waiting to be reloaded, so
    // the replacement must not raise a second window. Dropping --open is not enough:
    // with no command, the CLI opens one by default. --no-open says it outright.
    const args=[...process.argv.slice(2).filter(a=>a!=='--open'),'--no-open']
    await app.close()
    const child=require('node:child_process').spawn(process.execPath,[entry,...args],{detached:true,stdio:'ignore',env:{...process.env,PORT:String(held)}})
    child.on('error',error=>{console.error(`Could not restart Fleet: ${error.message}`);process.exit(1)})
    child.unref()
    setTimeout(()=>process.exit(0),100).unref()
  }
  try{app=createApp({restart})}catch(error){
    // Already running is the everyday case, not a crash: put the window the operator
    // asked for on screen and leave quietly. Exiting 1 with no window was the whole
    // reason a second `claude-fleet` looked like a broken one.
    if(error.code==='FLEET_ALREADY_RUNNING'){
      // A lock written by an older Fleet carries no port, so fall back to the one this
      // run would have asked for. Every lock written from here on records the real one.
      const running=error.holder?.port||Number(process.env.PORT||7777)
      const target=`http://${HOST}:${running}`
      console.log(`\n  ${error.message} → ${target}\n`)
      if(process.argv.includes('--open')) openDashboard(target,{app:!process.argv.includes('--browser')})
      process.exit(0)
    }
    console.error(error.message);process.exit(1)
  }
  let attempt=0,port=Number(process.env.PORT||7777)
  app.server.on('error',async error=>{
    if(error.code==='EADDRINUSE' && attempt++<10){app.server.listen(++port,HOST);return}
    console.error(error.message);await app.close();process.exit(1)
  })
  app.server.on('listening',()=>{
    const url=`http://${HOST}:${app.server.address().port}`
    // Write the port where the next `claude-fleet` will look for it.
    app.manager.recordPort(app.server.address().port)
    console.log(`\n  Claude Fleet v${VERSION} → ${url}\n  Local dashboard + managed agents · ctrl-c to stop\n`)
    // Index transcripts in the background so the first question does not wait for it.
    setTimeout(()=>warmSearch().catch(()=>{}),1500).unref()
    // And ask npm whether there is a newer Fleet, well after the page has loaded.
    setTimeout(()=>app.updater.check().catch(()=>{}),5000).unref()
    if(process.argv.includes('--open')) openDashboard(url,{app:!process.argv.includes('--browser')})
  })
  app.server.listen(port,HOST)
  let closing=false
  const shutdown=async()=>{if(closing)return;closing=true;await app.close();process.exit(0)}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown)
  return app
}
if(require.main===module) main()
module.exports={createApp,main}
