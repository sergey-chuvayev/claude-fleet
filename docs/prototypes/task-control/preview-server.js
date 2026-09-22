'use strict';
// The real Fleet frontend, served with synthetic read-only session data. This module
// deliberately does not import ManagedSessions, the SDK, or Fleet's live state store.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {initial}=require('./state');
const root=path.resolve(__dirname,'../../..');
const publicDir=path.join(root,'public');
const fixtures=initial().tasks.slice(0,3);
const now=Date.now();
const ids=fixtures.map(t=>'demo-'+t.id);
const messages=t=>[
  {id:'brief-'+t.id,role:'user',at:now-120000,text:t.brief},
  {id:'reply-'+t.id,role:'assistant',at:now-90000,text:'I’m checking the relevant implementation and existing tests. This conversation uses sample data for the Fleet preview.'},
  {id:'read-'+t.id,role:'tool',tool:'Read',target:'src/handler.ts',input:{file_path:'src/handler.ts'},result:'// Illustrative source content\nexport function handleRequest(input) {\n  return validate(input);\n}',status:'done',at:now-60000,ms:15},
  {id:'report-'+t.id,role:'assistant',at:now-30000,text:t.question || 'The scoped changes are ready for review. The sample checks and diff are available in the Work queue view.'},
];
const sessions=fixtures.map((t,i)=>({id:ids[i],sessionId:ids[i],managedId:ids[i],managed:true,managedStatus:'idle',status:'idle',state:'idle',alive:true,name:t.title,title:t.title,shortId:ids[i],cwd:'/demo/'+t.repo,project:t.repo,branch:'task/fl-'+t.id,selectedModel:'sonnet',model:'claude-sonnet',contextTokens:24000+i*12000,contextLimit:200000,startedAt:now-180000,lastActivity:now-30000,updatedAt:now,createdAt:now,approvalMode:'auto',costUsd:t.spend,messages:messages(t),approvals:[],queue:[],links:[],latestResponse:messages(t).at(-1).text,kind:'agent',archived:false}));
function createPreviewServer() {
  return http.createServer((req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET') return json(405,{error:'Preview only: live agent actions are disabled. Use Work queue to try simulated tasks.'});
    if(url.pathname==='/api/control')return json(200,{token:'prototype-only',version:'0.12.2 · preview',defaultCwd:'/demo/web-app',supportsSessionReferences:false});
    if(url.pathname==='/api/sessions')return json(200,{sessions:sessions.map(s=>({...s,messages:s.messages.length})),counts:{busy:0,idle:3,stale:0,dead:0},total:3,archived:0,generatedAt:Date.now(),usage:null,archiveRule:{enabled:false,days:14}});
    if(url.pathname==='/api/models')return json(200,{models:[{value:'',displayName:'Fleet default'},{value:'sonnet',displayName:'Sonnet'},{value:'haiku',displayName:'Haiku'},{value:'opus',displayName:'Opus'}]});
    if(url.pathname==='/api/update')return json(200,{update:null});
    if(url.pathname==='/api/teams')return json(200,{teams:[],tools:[]});
    if(url.pathname==='/api/events') {
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(': prototype connected\n\n');
      const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);timer.unref();req.on('close',()=>clearInterval(timer));return;
    }
    const match=url.pathname.match(/^\/api\/managed\/(demo-\d+)(\/commands)?$/);
    if(match){const session=sessions.find(s=>s.id===match[1]);return session?json(200,match[2]?{commands:[]}:{session}):json(404,{error:'Unknown demo session'});}
    if(url.pathname==='/theme.css') {res.writeHead(200,{'content-type':'text/css'});return res.end('/* Fleet default theme; no personal configuration loaded. */');}
    if(url.pathname==='/' || url.pathname==='/index.html') {
      const html=fs.readFileSync(path.join(publicDir,'index.html'),'utf8').replace('</head>','<link rel="stylesheet" href="/prototype/queue.css"><script src="/prototype/state.js" defer></script><script src="/prototype/queue.js" defer></script></head>');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html);
    }
    const prototype=url.pathname.startsWith('/prototype/');
    const relative=prototype?url.pathname.slice('/prototype/'.length):url.pathname.slice(1);
    if(prototype && !['queue.css','queue.js','state.js'].includes(relative))return json(404,{error:'Not found'});
    const base=prototype?__dirname:publicDir;
    const file=path.resolve(base,relative);
    if(!file.startsWith(base+path.sep))return json(404,{error:'Not found'});
    const type={'.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[path.extname(file)];
    if(!type || !fs.existsSync(file)||!fs.statSync(file).isFile())return json(404,{error:'Not found'});
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});fs.createReadStream(file).pipe(res);
  });
}
if(require.main===module) {
  const server=createPreviewServer();
  server.listen(Number(process.env.FLEET_PREVIEW_PORT)||7791,'127.0.0.1',()=>console.log('Fleet additive prototype: http://127.0.0.1:'+server.address().port));
}
module.exports={createPreviewServer};
