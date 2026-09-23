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
      // A directory entry in `files` ships everything under it, so `public/` covers
      // `public/app.js`. Only bare root modules need naming individually.
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

test('the production Work queue tab and its script ship in npm, not just the prototype',()=>{
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8')
  assert.match(html,/id="view-queue"/)
  assert.match(html,/<script src="\/work-queue.js" defer>/)
  assert.ok(shipped.has('public/'))
  assert.ok(fs.existsSync(path.join(root,'public/work-queue.js')))
  assert.doesNotMatch(html,/\/prototype\//)
})
