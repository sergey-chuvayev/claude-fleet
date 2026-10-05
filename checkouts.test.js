'use strict'
// Which worktrees may go: merged-and-clean detection, and every reason to refuse.
// Real git, in throwaway repositories under the OS temp directory.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { collect, clear, blockers, parseWorktrees, pullFor } = require('./checkouts')

const IDENTITY = { GIT_AUTHOR_NAME:'Test', GIT_AUTHOR_EMAIL:'test@example.com', GIT_COMMITTER_NAME:'Test', GIT_COMMITTER_EMAIL:'test@example.com' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding:'utf8', env:{ ...process.env, ...IDENTITY }, stdio:['ignore', 'pipe', 'pipe'] }).trim()
const write = (file, content = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, content) }
const noPulls = async () => null

// A repo with a remote: `main` pushed to a bare origin, plus helpers to add worktrees.
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-checkouts-')))
  const origin = path.join(base, 'origin.git'), repo = path.join(base, 'app')
  git(base, 'init', '--bare', '--initial-branch=main', origin)
  git(base, 'clone', origin, repo)
  git(repo, 'checkout', '-b', 'main')
  write(path.join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'init'); git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  const worktree = (name, { commit = false } = {}) => {
    const dir = path.join(base, `wt-${name}`)
    git(repo, 'worktree', 'add', '-b', `feat/${name}`, dir)
    if (commit) { write(path.join(dir, `${name}.txt`)); git(dir, 'add', `${name}.txt`); git(dir, 'commit', '-m', `add ${name}`) }
    return dir
  }
  const merge = name => { git(repo, 'merge', '--no-ff', '-m', `merge ${name}`, `feat/${name}`); git(repo, 'push', 'origin', 'main') }
  const session = (cwd, extra = {}) => ({ id:`s-${path.basename(cwd)}`, name:`session in ${path.basename(cwd)}`, cwd, alive:false, ...extra })
  return { base, repo, worktree, merge, session, done:() => fs.rmSync(base, { recursive:true, force:true }) }
}
const find = (result, dir) => result.checkouts.find(c => c.path === fs.realpathSync(dir))
const codes = checkout => checkout.blockers.map(b => b.code)

test('a merged, clean worktree is clearable; its facts read back from git', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('done', { commit:true })
  fx.merge('done')
  const result = await collect([fx.session(dir)], { pulls:noPulls })
  const c = find(result, dir)
  assert.equal(c.branch, 'feat/done')
  assert.equal(c.merged, true)
  assert.equal(c.mergedBy, 'ancestor')
  assert.equal(c.dirty, 0)
  assert.equal(c.unpushed, 0)
  assert.equal(c.trunk, 'main')
  assert.equal(c.clearable, true)
  assert.deepEqual(c.blockers, [])
  assert.equal(c.sessions.length, 1)
})

test('sessions in one checkout, or in a subfolder of it, share one entry', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('shared', { commit:true })
  fs.mkdirSync(path.join(dir, 'sub'))
  const result = await collect([fx.session(dir, { id:'a' }), fx.session(path.join(dir, 'sub'), { id:'b' })], { pulls:noPulls })
  assert.equal(result.checkouts.length, 1)
  assert.deepEqual(result.checkouts[0].sessions.map(s => s.id).sort(), ['a', 'b'])
})

test('a branch that is not merged is refused, and so is one with unpushed commits', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('wip', { commit:true })
  const c = find(await collect([fx.session(dir)], { pulls:noPulls }), dir)
  assert.equal(c.merged, false)
  assert.equal(c.ahead, 1)
  assert.equal(c.unpushed, 1)
  assert.equal(c.clearable, false)
  assert.deepEqual(codes(c).sort(), ['unmerged', 'unpushed'])
  git(dir, 'push', '-u', 'origin', 'feat/wip')
  const pushed = find(await collect([fx.session(dir)], { pulls:noPulls }), dir)
  assert.equal(pushed.unpushed, 0, 'pushed commits are no longer at risk')
  assert.deepEqual(codes(pushed), ['unmerged'], 'but pushed is not merged')
})

test('uncommitted changes, including untracked files, refuse a merged branch', async t => {
  const fx = fixture(); t.after(fx.done)
  const tracked = fx.worktree('tracked', { commit:true }), untracked = fx.worktree('untracked', { commit:true })
  fx.merge('tracked'); fx.merge('untracked')
  write(path.join(tracked, 'tracked.txt'), 'edited\n')
  write(path.join(untracked, 'scratch.txt'))
  const result = await collect([fx.session(tracked), fx.session(untracked)], { pulls:noPulls })
  for (const dir of [tracked, untracked]) {
    const c = find(result, dir)
    assert.equal(c.merged, true)
    assert.equal(c.dirty, 1)
    assert.equal(c.clearable, false)
    assert.deepEqual(codes(c), ['dirty'])
  }
})

test('a fresh worktree with no commits of its own is not treated as merged', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('fresh')
  const c = find(await collect([fx.session(dir)], { pulls:noPulls }), dir)
  assert.equal(c.merged, false)
  assert.equal(c.empty, true)
  assert.deepEqual(codes(c), ['empty'])
})

test('the main checkout is never clearable, even on a clean trunk', async t => {
  const fx = fixture(); t.after(fx.done)
  const c = find(await collect([fx.session(fx.repo)], { pulls:noPulls }), fx.repo)
  assert.equal(c.isMain, true)
  assert.equal(c.clearable, false)
  assert.ok(codes(c).includes('main'))
})

test('a session still running in the folder refuses it', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('live', { commit:true })
  fx.merge('live')
  const c = find(await collect([fx.session(dir, { alive:true })], { pulls:noPulls }), dir)
  assert.equal(c.merged, true)
  assert.deepEqual(codes(c), ['running'])
})

test('a locked or detached worktree is refused', async t => {
  const fx = fixture(); t.after(fx.done)
  const locked = fx.worktree('locked', { commit:true }), detached = fx.worktree('detached', { commit:true })
  fx.merge('locked'); fx.merge('detached')
  git(fx.repo, 'worktree', 'lock', locked)
  git(detached, 'checkout', '--detach')
  const result = await collect([fx.session(locked), fx.session(detached)], { pulls:noPulls })
  assert.ok(codes(find(result, locked)).includes('locked'))
  assert.ok(codes(find(result, detached)).includes('detached'))
  assert.equal(find(result, detached).clearable, false)
})

test('a squash-merged pull request counts only when it merged this exact commit', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('squashed', { commit:true })
  const tip = git(dir, 'rev-parse', 'HEAD')
  const pr = (state, headRefOid) => async () => [{ number:7, url:'https://example.com/pull/7', state, headRefName:'feat/squashed', headRefOid }]
  const merged = find(await collect([fx.session(dir)], { pulls:pr('MERGED', tip) }), dir)
  assert.equal(merged.mergedBy, 'pr')
  assert.equal(merged.unpushed, 0, 'it reached GitHub even though the remote branch is gone')
  assert.equal(merged.clearable, true)
  assert.equal(merged.pr.number, 7)
  const later = find(await collect([fx.session(dir)], { pulls:pr('MERGED', 'f'.repeat(40)) }), dir)
  assert.equal(later.merged, false, 'commits added after the merge are not covered by it')
  assert.equal(later.clearable, false)
  const open = find(await collect([fx.session(dir)], { pulls:pr('OPEN', tip) }), dir)
  assert.equal(open.pr.state, 'OPEN')
  assert.equal(open.merged, false)
  assert.equal(open.clearable, false)
})

test('without GitHub data a squash-merged branch reads as unmerged, which keeps it', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('nogh', { commit:true })
  const c = find(await collect([fx.session(dir)], { pulls:noPulls }), dir)
  assert.equal(c.prKnown, false)
  assert.equal(c.pr, null)
  assert.equal(c.clearable, false)
})

test('sessions outside a git checkout, or with no folder, are counted and left out', async t => {
  const fx = fixture(); t.after(fx.done)
  const plain = path.join(fx.base, 'plain'); fs.mkdirSync(plain)
  const result = await collect([fx.session(plain), { id:'x', cwd:null }, fx.session(path.join(fx.base, 'gone'))], { pulls:noPulls })
  assert.equal(result.checkouts.length, 0)
  assert.equal(result.outside, 3)
})

test('clear removes a merged, clean worktree and its branch, and leaves the main checkout alone', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('gone', { commit:true })
  const keep = fx.worktree('keep', { commit:true })
  fx.merge('gone')
  write(path.join(fx.repo, 'README.md'), 'edited in the main checkout\n') // uncommitted work there must survive
  const mainHead = git(fx.repo, 'rev-parse', 'HEAD'), mainStatus = git(fx.repo, 'status', '--porcelain')
  const tip = git(dir, 'rev-parse', 'HEAD')
  const sessions = [fx.session(dir), fx.session(keep)]
  const result = await clear(sessions, dir, { pulls:noPulls })
  assert.deepEqual(result, { removed:fs.realpathSync(path.join(fx.base)) + '/wt-gone', branch:'feat/gone', tip, branchDeleted:true })
  assert.equal(fs.existsSync(dir), false)
  assert.equal(git(fx.repo, 'branch', '--list', 'feat/gone'), '')
  assert.ok(fs.existsSync(keep), 'another worktree is untouched')
  assert.equal(git(fx.repo, 'branch', '--list', 'feat/keep').includes('feat/keep'), true)
  assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), mainHead)
  assert.equal(git(fx.repo, 'status', '--porcelain'), mainStatus)
  assert.equal(fs.readFileSync(path.join(fx.repo, 'README.md'), 'utf8'), 'edited in the main checkout\n')
  assert.equal(git(fx.repo, 'cat-file', '-t', tip), 'commit', 'the commits themselves stay reachable through main')
})

test('clear refuses dirty, unpushed, unmerged, running, locked and main, and removes nothing', async t => {
  const fx = fixture(); t.after(fx.done)
  const dirty = fx.worktree('dirty', { commit:true }), unmerged = fx.worktree('unmerged', { commit:true }), running = fx.worktree('running', { commit:true }), locked = fx.worktree('locked', { commit:true })
  for (const name of ['dirty', 'running', 'locked']) fx.merge(name)
  write(path.join(dirty, 'new.txt'))
  git(fx.repo, 'worktree', 'lock', locked)
  const sessions = [fx.session(dirty), fx.session(unmerged), fx.session(running, { alive:true }), fx.session(locked), fx.session(fx.repo)]
  const refused = async (dir, code) => {
    await assert.rejects(clear(sessions, dir, { pulls:noPulls }), error => {
      assert.equal(error.status, 409)
      assert.match(error.message, /^Not removed:/)
      return true
    }, code)
    assert.ok(fs.existsSync(dir), `${code}: the folder is still there`)
  }
  await refused(dirty, 'dirty')
  await refused(unmerged, 'unmerged and unpushed')
  await refused(running, 'running')
  await refused(locked, 'locked')
  await refused(fx.repo, 'main')
  assert.equal(fs.existsSync(path.join(dirty, 'new.txt')), true, 'the untracked file survived')
  for (const name of ['dirty', 'unmerged', 'running', 'locked']) assert.ok(git(fx.repo, 'branch', '--list', `feat/${name}`), `feat/${name} still exists`)
  git(fx.repo, 'worktree', 'unlock', locked)
})

test('clear only touches worktrees of sessions Fleet can see', async t => {
  const fx = fixture(); t.after(fx.done)
  const stranger = fx.worktree('stranger', { commit:true }), seen = fx.worktree('seen', { commit:true })
  fx.merge('stranger')
  const sessions = [fx.session(seen)]
  for (const target of [stranger, path.join(seen, '..'), path.join(fx.base, 'nothing'), '', undefined, os.homedir()]) {
    await assert.rejects(clear(sessions, target, { pulls:noPulls }), error => error.status === 404 || error.status === 409)
  }
  assert.ok(fs.existsSync(stranger))
  assert.ok(fs.existsSync(os.homedir()))
})

test('clear checks again at removal time: changes made after the list was drawn refuse it', async t => {
  const fx = fixture(); t.after(fx.done)
  const dir = fx.worktree('late', { commit:true })
  fx.merge('late')
  const sessions = [fx.session(dir)]
  assert.equal(find(await collect(sessions, { pulls:noPulls }), dir).clearable, true, 'clearable when listed')
  write(path.join(dir, 'unsaved.txt'), 'work in progress\n')
  await assert.rejects(clear(sessions, dir, { pulls:noPulls }), error => error.status === 409 && /uncommitted/.test(error.message))
  assert.equal(fs.readFileSync(path.join(dir, 'unsaved.txt'), 'utf8'), 'work in progress\n')
})

test('blockers: every refusal reason, and unknowns refuse like bad news', () => {
  const ok = { isMain:false, missing:false, detached:false, branch:'feat/x', trunk:'main', locked:false, dirty:0, unpushed:0, merged:true, empty:false, running:false }
  assert.deepEqual(blockers(ok), [])
  const code = overrides => blockers({ ...ok, ...overrides }).map(b => b.code)
  assert.deepEqual(code({ isMain:true }), ['main'])
  assert.deepEqual(code({ missing:true }), ['missing'])
  assert.deepEqual(code({ detached:true, branch:null }), ['detached'])
  assert.deepEqual(code({ branch:'main' }), ['trunk'])
  assert.deepEqual(code({ locked:true }), ['locked'])
  assert.deepEqual(code({ trunk:null, merged:false }), ['no-trunk'])
  assert.deepEqual(code({ dirty:3 }), ['dirty'])
  assert.deepEqual(code({ unpushed:2 }), ['unpushed'])
  assert.deepEqual(code({ merged:false }), ['unmerged'])
  assert.deepEqual(code({ merged:false, empty:true }), ['empty'])
  assert.deepEqual(code({ running:true }), ['running'])
  assert.deepEqual(code({ dirty:null }), ['unknown'], 'a status that could not be read')
  assert.deepEqual(code({ unpushed:null }), ['unknown'], 'a push state that could not be read')
  assert.match(blockers({ ...ok, dirty:1 })[0].text, /^1 uncommitted change\./)
})

test('parseWorktrees reads the porcelain listing, main checkout first', () => {
  const list = parseWorktrees('worktree /tmp/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree /tmp/wt\nHEAD bbb\nbranch refs/heads/feat/x\nlocked\n\nworktree /tmp/d\nHEAD ccc\ndetached\n\n')
  assert.deepEqual(list.map(e => e.path), ['/tmp/app', '/tmp/wt', '/tmp/d'])
  assert.equal(list[1].branch, 'feat/x')
  assert.equal(list[1].locked, true)
  assert.equal(list[2].detached, true)
})

test('pullFor prefers an open pull request and needs the tip to match a merged one', () => {
  const pulls = [
    { number:1, url:'u1', state:'MERGED', headRefName:'b', headRefOid:'old' },
    { number:2, url:'u2', state:'OPEN', headRefName:'b', headRefOid:'new' },
    { number:3, url:'u3', state:'OPEN', headRefName:'other', headRefOid:'new' },
  ]
  assert.deepEqual(pullFor(pulls, 'b', 'new'), { pr:{ number:2, url:'u2', state:'OPEN' }, mergedAtTip:false })
  assert.equal(pullFor(pulls, 'b', 'old').mergedAtTip, true)
  assert.deepEqual(pullFor(null, 'b', 'old'), { pr:null, mergedAtTip:false })
})
