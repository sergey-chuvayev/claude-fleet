'use strict'
// Which git checkout each session works in, and whether that checkout can safely go.
//
// Agents leave worktrees behind: one per task, still on disk long after the pull request
// merged. This reads them back from git itself (never from Fleet's own records, which only
// know the worktrees Fleet made) and answers the one question that matters before removing
// one: is anything in it that exists nowhere else?
//
// Everything here is read-only except `clear`, and `clear` re-derives its verdict from
// scratch. The page only ever names a path; what that path is, and whether it may go, is
// decided again on the server at the moment of removal.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

// Never prompt, and never take an optional lock: looking at a checkout must not make an
// editor's own `git status` wait, or rewrite its index.
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0', GH_PROMPT_DISABLED:'1' }

// Arguments always travel as an array. A branch name or path is text from outside Fleet
// and must never reach a shell.
function run(command, cwd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env:ENV, encoding:'utf8', timeout, maxBuffer:16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error) } else resolve(stdout)
    })
  })
}
const git = (cwd, args) => run('git', cwd, args)
const text = async (cwd, args) => (await git(cwd, args)).trim()
const succeeds = (cwd, args) => git(cwd, args).then(() => true, () => false)
const real = target => { try { return fs.realpathSync(target) } catch { return path.resolve(target) } }
const short = target => target.startsWith(os.homedir() + path.sep) ? `~${target.slice(os.homedir().length)}` : target
const fail = (message, status = 400) => Object.assign(new Error(message), { status })

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length:Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

// `git worktree list --porcelain`: blank-line separated records, the main checkout first.
function parseWorktrees(output) {
  const list = []
  for (const block of String(output).split(/\n\s*\n/)) {
    const entry = {}
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ')
      const key = space < 0 ? line : line.slice(0, space), value = space < 0 ? '' : line.slice(space + 1)
      if (key === 'worktree') entry.path = value
      else if (key === 'HEAD') entry.head = value
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'detached') entry.detached = true
      else if (key === 'bare') entry.bare = true
      else if (key === 'locked') entry.locked = true
      else if (key === 'prunable') entry.prunable = true
    }
    if (entry.path) list.push(entry)
  }
  return list
}

// The branch work is merged into. The remote's copy wins over the local one when both
// exist: a local main that has not been pulled lags behind what was actually merged.
async function trunkOf(root) {
  let named = null
  try { named = (await text(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '') } catch {}
  for (const name of new Set([named, 'main', 'master'].filter(Boolean))) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      try { return { name, ref, sha:await text(root, ['rev-parse', '--verify', '--quiet', ref]) } } catch {}
    }
  }
  return null
}

// Every pull request on the repo, newest first, through the operator's own `gh`. It is
// optional: without it (or off GitHub) pull requests are simply unknown, and a branch that
// was squash-merged then reads as unmerged, which only ever errs towards keeping it.
async function ghPulls(root) {
  try {
    const out = await run('gh', root, ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,url,state,headRefName,headRefOid'], 15000)
    const list = JSON.parse(out)
    return Array.isArray(list) ? list : null
  } catch { return null }
}
const pullCache = new Map() // repo root -> { at, list }
async function cachedPulls(root, { fresh = false } = {}) {
  const hit = pullCache.get(root)
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.list
  const list = await ghPulls(root)
  pullCache.set(root, { at:Date.now(), list })
  return list
}

// The pull request to show for a branch, and whether one was merged at exactly the commit
// the branch is on now. A merged pull request alone proves nothing about commits added
// after it; the tip has to match.
function pullFor(pulls, branch, tip) {
  if (!pulls || !branch) return { pr:null, mergedAtTip:false }
  const mine = pulls.filter(p => p.headRefName === branch).sort((a, b) => b.number - a.number)
  const open = mine.find(p => p.state === 'OPEN')
  const merged = mine.find(p => p.state === 'MERGED' && p.headRefOid === tip)
  const shown = open || merged || mine[0]
  return { pr:shown ? { number:shown.number, url:shown.url, state:shown.state } : null, mergedAtTip:!!merged }
}

// The whole safety decision, kept free of git so every refusal can be tested on its own.
// A checkout may go only when this returns nothing. Missing knowledge (a failed command, no
// trunk) blocks just like bad news: not knowing is not permission.
function blockers(f) {
  const out = []
  const add = (code, message) => out.push({ code, text:message })
  const trunk = f.trunk || 'main'
  // Nothing else about the main checkout matters: it is not a candidate at all.
  if (f.isMain) return [{ code:'main', text:'This is the main checkout.' }]
  if (f.missing) add('missing', 'The folder is already gone.')
  if (f.detached || !f.branch) add('detached', 'HEAD is detached, so there is no branch to check.')
  else if (f.trunk && f.branch === f.trunk) add('trunk', `This is ${trunk} itself.`)
  if (f.locked) add('locked', 'The worktree is locked.')
  if (!f.trunk) add('no-trunk', 'No main or master branch to compare against.')
  if (f.dirty === null) add('unknown', 'Could not read its status.')
  else if (f.dirty > 0) add('dirty', `${f.dirty} uncommitted change${f.dirty === 1 ? '' : 's'}.`)
  if (f.unpushed === null) add('unknown', 'Could not tell whether its commits are pushed.')
  else if (f.unpushed > 0) add('unpushed', `${f.unpushed} commit${f.unpushed === 1 ? '' : 's'} that exist nowhere else.`)
  if (f.trunk && !f.merged) add(f.empty ? 'empty' : 'unmerged', f.empty ? 'No commits of its own yet.' : `Not merged into ${trunk}.`)
  if (f.running) add('running', 'A session is still running here.')
  return out
}

// Facts about one worktree entry. `null` means a command failed, which blockers() treats
// as a refusal rather than as zero.
async function inspect(entry, { root, isMain, trunk, pulls, running }) {
  const missing = !fs.existsSync(entry.path)
  const tip = entry.head || null
  const f = { path:real(entry.path), pathShort:short(real(entry.path)), isMain, branch:entry.branch || null, detached:!!entry.detached || (!entry.branch && !entry.bare), tip, locked:!!entry.locked, missing, trunk:trunk ? trunk.name : null, running, dirty:null, unpushed:null, ahead:null, merged:false, mergedBy:null, empty:false, pr:null }
  const { pr, mergedAtTip } = pullFor(pulls, f.branch, tip)
  f.pr = pr
  f.prKnown = !!pulls
  if (!missing) {
    try {
      // Untracked files count: `worktree remove` would delete them along with the folder.
      f.dirty = (await git(entry.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])).split('\0').filter(Boolean).length
    } catch {}
  }
  if (trunk && tip) {
    // Repo-wide questions about a commit, asked from the main checkout so they still work
    // when the worktree's own folder is gone.
    const ancestor = await succeeds(root, ['merge-base', '--is-ancestor', tip, trunk.ref])
    const atTrunk = tip === trunk.sha
    f.empty = atTrunk && !mergedAtTip
    f.merged = (ancestor && !atTrunk) || mergedAtTip
    f.mergedBy = mergedAtTip ? 'pr' : f.merged ? 'ancestor' : null
    try {
      f.ahead = Number(await text(root, ['rev-list', '--count', `${trunk.ref}..${tip}`]))
      // Commits no remote and not the trunk has. A pull request merged at this very commit
      // proves it reached GitHub even once the remote branch was deleted.
      f.unpushed = mergedAtTip ? 0 : Number(await text(root, ['rev-list', '--count', tip, '--not', '--remotes', trunk.ref]))
    } catch {}
  }
  f.blockers = blockers(f)
  f.clearable = f.blockers.length === 0
  return f
}

async function locate(dir) {
  try {
    const [top, common] = (await text(dir, ['rev-parse', '--show-toplevel', '--git-common-dir'])).split('\n')
    return top && common ? { top:real(top), common:real(path.resolve(dir, common)) } : null
  } catch { return null }
}

// `sessions` is [{ id, name, cwd, alive, engine, lastActivity }]. Returns one entry per
// checkout any session used, with those sessions listed under it.
async function collect(sessions, { pulls = cachedPulls, fresh = false, limit = 6 } = {}) {
  const byDir = new Map()
  let outside = 0
  for (const s of sessions) {
    if (!s.cwd) { outside++; continue }
    const dir = real(s.cwd)
    if (!fs.existsSync(dir)) { outside++; continue }
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(s)
  }
  const dirs = [...byDir.keys()]
  const where = await mapLimit(dirs, limit, locate)
  const repos = new Map() // common dir -> { dir, tops: Map(top -> sessions) }
  dirs.forEach((dir, i) => {
    if (!where[i]) { outside += byDir.get(dir).length; return }
    const { top, common } = where[i]
    if (!repos.has(common)) repos.set(common, { dir, tops:new Map() })
    const tops = repos.get(common).tops
    tops.set(top, [...(tops.get(top) || []), ...byDir.get(dir).map(s => ({ ...s, cwdDir:dir }))])
  })

  const found = await mapLimit([...repos.values()], 3, async repo => {
    let list
    try { list = parseWorktrees(await git(repo.dir, ['worktree', 'list', '--porcelain'])) } catch { return [] }
    if (!list.length) return []
    const root = real(list[0].path)
    const trunk = await trunkOf(root)
    // Only ask GitHub when something other than the main checkout is in play.
    const needsPulls = [...repo.tops.keys()].some(top => top !== root)
    const prs = needsPulls ? await pulls(root, { fresh }) : null
    const entries = []
    for (const [top, group] of repo.tops) {
      const entry = list.find(e => real(e.path) === top)
      if (!entry) continue
      entries.push({ entry, group })
    }
    return mapLimit(entries, limit, async ({ entry, group }) => {
      const running = group.some(s => s.alive)
      const f = await inspect(entry, { root, isMain:real(entry.path) === root, trunk, pulls:prs, running })
      return {
        ...f,
        repo:{ name:path.basename(root), root },
        sessions:group.map(s => ({ id:s.id, name:s.name || null, cwd:short(s.cwdDir), alive:!!s.alive, engine:s.engine || 'claude', lastActivity:s.lastActivity || null })),
        lastActivity:Math.max(0, ...group.map(s => s.lastActivity || 0)),
      }
    })
  })

  const checkouts = found.flat().sort((a, b) =>
    (b.clearable - a.clearable) || (a.isMain - b.isMain) || (b.lastActivity - a.lastActivity))
  return { generatedAt:Date.now(), checkouts, outside }
}

// Remove one worktree and its local branch. The verdict is recomputed here, from git, with
// fresh pull request data: nothing the page said earlier is trusted.
//
// Two further guards sit under that. `git worktree remove` is run without --force, so git
// itself refuses a worktree with changes or a lock if one appeared since the check. And the
// branch is deleted with update-ref against the tip that was verified, so a commit made in
// the meantime keeps the branch alive. It runs in the main checkout, which it never modifies.
async function clear(sessions, target, options = {}) {
  const wanted = real(String(target || ''))
  const { checkouts } = await collect(sessions, { ...options, fresh:true })
  const hit = checkouts.find(c => c.path === wanted)
  if (!hit) throw fail('That worktree is not used by any session Fleet can see, so Fleet will not touch it.', 404)
  if (!hit.clearable) throw fail(`Not removed: ${hit.blockers.map(b => b.text).join(' ')}`, 409)
  const root = hit.repo.root
  try { await git(root, ['worktree', 'remove', '--', hit.path]) }
  catch (cause) { throw fail(`Git declined to remove it: ${String(cause.stderr || cause.message).trim().slice(0, 400)}`, 409) }
  let branchDeleted = true
  try {
    await git(root, ['update-ref', '-d', `refs/heads/${hit.branch}`, hit.tip])
    // Best effort: the branch's upstream settings are config, not history.
    await git(root, ['config', '--remove-section', `branch.${hit.branch}`]).catch(() => {})
  } catch { branchDeleted = false }
  return { removed:hit.path, branch:hit.branch, tip:hit.tip, branchDeleted }
}

module.exports = { collect, clear, inspect, blockers, parseWorktrees, pullFor, trunkOf }
