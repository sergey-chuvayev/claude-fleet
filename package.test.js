'use strict'
// The `files` whitelist in package.json is maintained by hand, so it drifts silently every
// time a module is added: the whole suite still passes, because a checkout has the file that
// the tarball is missing. It only breaks for people who installed from npm, on boot.
// v0.2.0 shipped `managed.js` requiring `./teams` without shipping teams.js.
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const pkg=require('./package.json')

const root=__dirname
const isTest=name=>name.endsWith('.test.js') || name==='test-setup.js'
const rootModules=fs.readdirSync(root).filter(n=>n.endsWith('.js') && !isTest(n))
// npm puts these in the tarball whatever `files` says, so requiring them is always safe.
const ALWAYS_PACKED=['package.json','README.md','LICENSE']
const shipped=new Set([...pkg.files,...ALWAYS_PACKED])

test('every module at the repo root is in the published files list',()=>{
  const missing=rootModules.filter(n=>!shipped.has(n))
  assert.deepEqual(missing,[],`package.json "files" is missing: ${missing.join(', ')}. An installed Fleet would fail to boot.`)
})

test('every relative require in a shipped module points at something else that ships',()=>{
  const broken=[]
  for (const name of rootModules.filter(n=>shipped.has(n))) {
    const source=fs.readFileSync(path.join(root,name),'utf8')
    for (const match of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const target=match[1].replace(/^\.\//,'')
      // `require('./teams')` means teams.js; `require('./package.json')` means itself.
      const file=path.extname(target) ? target : `${target}.js`
      // A directory entry in `files` ships everything under it, so `dist/` covers
      // `dist/index.html`. Only bare root modules need naming individually.
      const covered=shipped.has(file) || [...shipped].some(entry=>entry.endsWith('/') && file.startsWith(entry))
      if (!covered) broken.push(`${name} requires ${match[1]}`)
    }
  }
  assert.deepEqual(broken,[],`These requires would not resolve in the published package: ${broken.join('; ')}`)
})

test('the bin entry point ships',()=>{
  const bin=Object.values(pkg.bin||{})
  assert.ok(bin.length,'the package must expose a bin')
  for (const entry of bin) {
    assert.ok(fs.existsSync(path.join(root,entry)),`${entry} does not exist`)
    assert.ok([...shipped].some(f=>entry===f || (f.endsWith('/') && entry.startsWith(f))),`${entry} is not in files`)
  }
})

// A29: the release as a user gets it. Pack the tarball (prepack builds the web app), install
// it globally into a throwaway prefix the way `npm install -g` does (no devDependencies),
// start it with its own Fleet home on a free port, and check what a browser would load.
// Optional dependencies are left out only because they are the SDK's ~200 MB native Claude
// runtime, which serving the page never touches.
const {spawn,spawnSync,execFile}=require('node:child_process')
const http=require('node:http')
const net=require('node:net')
const os=require('node:os')
const {createHash}=require('node:crypto')
const npmCommand=process.platform==='win32' ? 'npm.cmd' : 'npm'
const npm=(args,options={})=>new Promise((resolve,reject)=>{
  execFile(npmCommand,args,{cwd:root,maxBuffer:64*1024*1024,shell:process.platform==='win32',...options},(error,stdout,stderr)=>{
    if(error) reject(new Error(`npm ${args.join(' ')} failed:\n${stdout}\n${stderr}`))
    else resolve(stdout)
  })
})
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port))})})
// fetch() resolves `..` and `%2e` itself, so traversal attempts go out as raw paths.
const get=(port,pathname)=>new Promise((resolve,reject)=>{
  http.get({host:'127.0.0.1',port,path:pathname,headers:{host:`127.0.0.1:${port}`}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}))
  }).on('error',reject)
})
const MIME={'.js':/^text\/javascript/,'.css':/^text\/css/,'.png':/^image\/png$/,'.svg':/^image\/svg\+xml$/,'.woff2':/^font\/woff2$/}
const LEGACY=['/app.js','/select.js','/review.js','/ui.js','/sync.js','/control.js','/blocks.js','/ask.js','/teams.js','/day.js','/sounds.js','/projects.js','/progress.js','/worktrees.js','/views.js','/connections.js','/settings.js','/styles.css','/vendor/libs.js']

test('the packed release installs without devDependencies and serves only its built web app (A29)',{timeout:600000},async t=>{
  if(spawnSync(npmCommand,['--version'],{shell:process.platform==='win32'}).status!==0){t.skip('npm is not available, so the release cannot be packed here');return}
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-pack-'))
  let server
  try{
    // prepack's build log shares stdout with npm's JSON report, which comes last.
    const report=await npm(['pack','--json','--pack-destination',work])
    const [packed]=JSON.parse(report.slice(report.search(/^\[\s*\{/m)))
    const shippedFiles=packed.files.map(f=>f.path)
    assert.ok(shippedFiles.includes('dist/index.html'),'dist/index.html is in the tarball')
    assert.ok(shippedFiles.includes('dist/.vite/manifest.json'),'the Vite manifest is in the tarball')
    assert.ok(shippedFiles.includes('dist/icons/fleet-192.png') && shippedFiles.includes('dist/icons/fleet-512.png'),'the icons are in the tarball')
    assert.deepEqual(shippedFiles.filter(f=>/^(public|frontend|src)\//.test(f) || f==='build/vendor-entry.js'),[],'no legacy app and no frontend sources ship')

    const prefix=path.join(work,'prefix')
    await npm(['install','--global','--prefix',prefix,'--omit=dev','--omit=optional','--no-audit','--no-fund','--prefer-offline',path.join(work,packed.filename)])
    const installed=[path.join(prefix,'lib','node_modules',pkg.name),path.join(prefix,'node_modules',pkg.name)].find(dir=>fs.existsSync(dir))
    assert.ok(installed,'the package is installed under the prefix')
    for(const dev of ['react','react-dom','vite','typescript','marked']) assert.ok(!fs.existsSync(path.join(installed,'node_modules',dev)),`${dev} is not installed with the release`)
    const manifestBytes=fs.readFileSync(path.join(installed,'dist','.vite','manifest.json'))
    const manifest=JSON.parse(manifestBytes)

    const home=path.join(work,'home'),claudeDir=path.join(work,'claude'),codexHome=path.join(work,'codex')
    for(const dir of [home,claudeDir,codexHome]) fs.mkdirSync(dir)
    server=spawn(process.execPath,[path.join(installed,'bin','claude-fleet.js'),'start'],{env:{...process.env,PORT:String(await freePort()),CLAUDE_FLEET_HOME:home,CLAUDE_FLEET_DIR:claudeDir,CODEX_HOME:codexHome,CLAUDE_FLEET_EXECUTABLE:'bundled'},stdio:['ignore','pipe','pipe']})
    let output=''
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`The installed Fleet did not start:\n${output}`)),30000)
      const read=chunk=>{output+=chunk;const m=output.match(/→ http:\/\/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]))}}
      server.stdout.on('data',read);server.stderr.on('data',read)
      server.once('exit',code=>{clearTimeout(timer);reject(new Error(`The installed Fleet exited with ${code}:\n${output}`))})
    })

    const page=await get(port,'/')
    assert.equal(page.status,200)
    assert.match(page.headers['content-type'],/^text\/html/)
    assert.equal(page.headers['cache-control'],'no-cache')
    const csp=page.headers['content-security-policy']
    assert.match(csp,/default-src 'self'/)
    assert.match(csp,/script-src 'self';/)
    assert.doesNotMatch(csp,/unsafe-eval/)
    assert.equal(page.headers['x-content-type-options'],'nosniff')
    const html=page.body.toString('utf8')
    const scripts=[...html.matchAll(/<script\b[^>]*>/g)].map(m=>m[0])
    assert.equal(scripts.length,1,`one script tag, the React entry: ${scripts.join(' ')}`)
    assert.match(scripts[0],/type="module"/)
    assert.match(scripts[0],/src="\/assets\/[\w.-]+\.js"/)
    assert.doesNotMatch(html,/<script\b[^>]*>\s*[^<\s]/,'no inline script')
    assert.doesNotMatch(html,/\/prototype\/|view-queue|work-queue/)

    const assets=new Set()
    for(const entry of Object.values(manifest)) for(const file of [entry.file,...(entry.css||[]),...(entry.assets||[])]) if(file) assets.add(`/${file}`)
    assert.ok(assets.size>1)
    for(const asset of assets){
      const response=await get(port,asset)
      assert.equal(response.status,200,asset)
      assert.match(response.headers['content-type'],MIME[path.extname(asset)],asset)
      assert.match(response.headers['cache-control'],/immutable/,asset)
    }
    for(const icon of ['/icons/fleet-192.png','/icons/fleet-512.png']){
      const response=await get(port,icon)
      assert.equal(response.status,200,icon)
      assert.equal(response.headers['content-type'],'image/png')
      assert.deepEqual(response.body,fs.readFileSync(path.join(root,'frontend','public',icon)))
    }
    const webmanifest=await get(port,'/manifest.webmanifest')
    assert.equal(webmanifest.status,200)
    assert.match(webmanifest.headers['content-type'],/^application\/manifest\+json/)
    assert.deepEqual(JSON.parse(webmanifest.body).icons.map(i=>i.src),['/icons/fleet-192.png','/icons/fleet-512.png'])
    assert.equal((await get(port,'/theme.css')).status,200)

    for(const pathname of ['/assets/missing-0000.js','/assets/index.js.map',...LEGACY,'/assets/../package.json','/assets/%2e%2e/package.json','/assets/..%2fpackage.json','/icons/../index.html','/dist/index.html','/server.js']){
      const response=await get(port,pathname)
      assert.equal(response.status,404,pathname)
      assert.match(response.headers['content-type'],/^application\/json/,pathname)
    }

    const control=JSON.parse((await get(port,'/api/control')).body)
    assert.equal(control.version,pkg.version)
    assert.equal(control.buildId,`${pkg.version}+${createHash('sha256').update(manifestBytes).digest('hex').slice(0,12)}`)
  }finally{
    if(server && server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>{server.once('exit',resolve);setTimeout(resolve,5000).unref()})}
    fs.rmSync(work,{recursive:true,force:true})
  }
})
