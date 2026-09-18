'use strict'
// An initiative gets its own git worktree, so a team editing files cannot collide with the
// operator's own checkout or with another initiative in the same repo. Worktrees live under
// Fleet's state directory rather than inside the project, for the same reason the archive
// does: Fleet's bookkeeping is Fleet's business and should be removable in one directory.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { stateDir } = require('./paths')

// Arguments always travel as an array. A branch name is operator-derived text and must
// never reach a shell.
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repoRoot(cwd) {
  try { return git(cwd, ['rev-parse', '--show-toplevel']) } catch { return null }
}

// The branch an initiative forks from: the checked-out branch, or the commit itself when
// HEAD is detached, which still gives the worktree something to stand on.
//
// A repository with no commits answers `symbolic-ref` perfectly happily with its unborn
// branch, so the name alone proves nothing. Confirm HEAD resolves to a commit first, or the
// operator gets `fatal: invalid reference: main` instead of being told the repo is empty.
function baseRef(root) {
  try { git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) } catch { return null }
  try {
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (branch) return branch
  } catch {}
  try { return git(root, ['rev-parse', 'HEAD']) } catch { return null }
}

function slugify(value, fallback) {
  const slug = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug || fallback
}

function branchExists(root, branch) {
  try { git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true } catch { return false }
}

// Create the worktree for one initiative. Throws with a message meant for the operator:
// every failure here happens at launch, where there is still a human watching.
function create({ cwd, id, name }) {
  const root = repoRoot(cwd)
  if (!root) {
    const error = new Error('An initiative needs a git repository: its team works on a branch and finishes with a pull request. Point it at a checkout, or launch a single agent instead.')
    error.status = 400
    throw error
  }
  const base = baseRef(root)
  if (!base) {
    const error = new Error('This repository has no commits yet, so there is nothing to branch from.')
    error.status = 400
    throw error
  }

  const short = String(id).slice(0, 8)
  let branch = `initiative/${slugify(name, short)}`
  if (branchExists(root, branch)) branch = `${branch}-${short}`

  const dir = path.join(stateDir(), 'worktrees', short)
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  if (fs.existsSync(dir)) {
    const error = new Error(`A worktree already exists at ${dir}.`)
    error.status = 409
    throw error
  }

  try { git(root, ['worktree', 'add', '-b', branch, dir, base]) }
  catch (cause) {
    const error = new Error(`Could not create a worktree for this initiative: ${String(cause.stderr || cause.message).trim().slice(0, 500)}`)
    error.status = 400
    throw error
  }
  return { path: dir, branch, base, repo: root }
}

// Best effort: an initiative whose worktree is gone is still readable, and a half-removed
// worktree is worse than one left behind for `git worktree prune` to notice.
function remove(worktree) {
  if (!worktree?.path || !worktree?.repo) return false
  try { git(worktree.repo, ['worktree', 'remove', '--force', worktree.path]); return true }
  catch { return false }
}

module.exports = { create, remove, repoRoot, baseRef, slugify }
