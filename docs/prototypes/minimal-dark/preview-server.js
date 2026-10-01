// Isolated synthetic preview: no Claude account or real transcripts are used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-minimal-preview-'));
process.env.CLAUDE_FLEET_HOME=path.join(directory,'state');
process.env.CLAUDE_FLEET_DIR=path.join(directory,'claude');
process.env.CLAUDE_FLEET_DEFAULT_CWD=directory;
const {ManagedSessions}=require('../../../managed');
const {createApp}=require('../../../server');
const now=Date.now();
const manager=new ManagedSessions({queryFactory:async()=>({close(){},async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',result:'Preview message received.',usage:{}}}})});
manager.models=[{value:'sonnet',displayName:'Sonnet'},{value:'opus',displayName:'Opus'},{value:'haiku',displayName:'Haiku'}];
const names=['A quieter Fleet','Loanword trails','Polish the onboarding','Review the API','Weekend reading','Tidy up the docs'];
for(let i=0;i<names.length;i++){
const id=`preview-agent-${i}`;
const messages=[
{id:`${id}-1`,role:'user',text:'Let’s give Fleet a little more room to breathe. Something simple, calm, and easy to come back to.',at:now-240000},
{id:`${id}-2`,role:'assistant',text:'I’m exploring a quieter workspace: your agents on the left, the conversation in the middle, and the details close at hand.\n\nA few small changes make a big difference:\n- A neutral charcoal palette with softer contrast\n- Clearer messages and less visual noise\n- All your tools, just a little more tucked away',at:now-180000},
{id:`${id}-3`,role:'tool',tool:'Read',target:'public/styles.css',input:{file_path:'public/styles.css'},result:':root {\n  --bg: #151517;\n  --text: #e8e7e5;\n}',status:'done',ms:42,at:now-150000},
{id:`${id}-4`,role:'user',text:'Yes, that’s the feeling. Keep it dark.',at:now-100000},
{id:`${id}-5`,role:'assistant',text:'The first pass is ready. The conversation now has its own space, with a soft composer below and a collapsible inspector on the right.\n\nI’ve kept the familiar controls close by. **Take a look around** — we can refine the details from here.',at:now-60000}
];
if(i)messages.splice(0,messages.length,{id:`${id}-1`,role:'assistant',text:['','Following the journey of everyday words.','The welcome screen is ready for a look.','I found two small improvements to review.','A few good things for a slower Sunday.','All the examples are now up to date.'][i],at:now-i*900000});
manager.sessions.set(id,{id,name:names[i],cwd:directory,status:'idle',createdAt:now-3600000,updatedAt:now-i*900000,messages,approvals:[],queue:[],requestIds:[],model:'claude-sonnet',selectedModel:'sonnet',approvalMode:'auto',contextTokens:24000+i*7000,contextLimit:200000,lastPrompt:'Explore the next idea.',costUsd:0.12,delegations:[]});
}
// Include a Day and an owner-review initiative for UI regression checks.
const day=require('../../../day');
const today=manager.sessions.get('preview-agent-1');
today.kind='day';today.name='Today';today.dayBoard={date:day.dateOf(),items:[],cursors:{}};
day.act(today,{action:'add',title:'Review the onboarding draft',source:'me',priority:'must',mode:'me',estimateMin:20},'operator');
day.act(today,{action:'add',title:'Follow up on the API review',source:'github',priority:'should',mode:'ask',estimateMin:15},'agent');
const owner=manager.sessions.get('preview-agent-0');
owner.kind='initiative';owner.teamName='Owner + review';owner.teamSnapshot=require('../../../teams').getTeam('owner-review');owner.taskBoard={tasks:[],delegations:[]};
const app=createApp({manager,collectSessions:()=>({sessions:[],counts:{},total:0,generatedAt:Date.now()}),search:{start(){throw new Error('Search is unavailable in this synthetic preview.')},get(){throw new Error('No preview search jobs.')},close(){}},updater:{status:()=>({current:'0.14.1',available:false}),close(){}}});
const port=Number(process.env.FLEET_PREVIEW_PORT || 7788);
app.server.listen(port,'127.0.0.1',()=>console.log(`Synthetic Fleet preview: http://localhost:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});process.exit(0)});
