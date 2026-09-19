'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// projects.js reads CLAUDE_FLEET_DIR once, at load. Every fixture therefore needs a
// fresh copy of the module rather than a fresh call.
function withFixture(build, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-projects-'))
  const saved = { dir: process.env.CLAUDE_FLEET_DIR, cwd: process.env.CLAUDE_FLEET_DEFAULT_CWD }
  try {
    const context = build(root)
    process.env.CLAUDE_FLEET_DIR = path.join(root, 'claude')
    process.env.CLAUDE_FLEET_DEFAULT_CWD = context.defaultCwd || path.join(root, 'empty')
    delete require.cache[require.resolve('./projects')]
    delete require.cache[require.resolve('./paths')]
    return run(require('./projects').listProjects({ force: true }), context)
  } finally {
    for (const [key, value] of [['CLAUDE_FLEET_DIR', saved.dir], ['CLAUDE_FLEET_DEFAULT_CWD', saved.cwd]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete require.cache[require.resolve('./projects')]
    delete require.cache[require.resolve('./paths')]
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// The slug on disk is a lossy encoding of the path, so the directory has to come from
// inside the transcript. These fixtures deliberately use slugs that could not be decoded.
function transcript(root, slug, cwd, { mtime = null, lines = [] } = {}) {
  const dir = path.join(root, 'claude', 'projects', slug)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${slug}-session.jsonl`)
  const records = [
    { type: 'mode', mode: 'normal' },
    ...lines,
    { type: 'user', cwd, message: { content: 'hello' } },
  ]
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}

test('projects come from transcript cwds, newest first, with the slug ignored', () => {
  withFixture(root => {
    const older = path.join(root, 'code', 'api-allo')
    const newer = path.join(root, 'code', 'desktop-allo')
    fs.mkdirSync(older, { recursive: true })
    fs.mkdirSync(newer, { recursive: true })
    transcript(root, '-code-api-allo', older, { mtime: Date.now() - 86400000 })
    transcript(root, '-code-desktop-allo', newer, { mtime: Date.now() })
    return { older, newer }
  }, (projects, { older, newer }) => {
    assert.deepEqual(projects.map(p => p.path), [newer, older])
    assert.deepEqual(projects.map(p => p.name), ['desktop-allo', 'api-allo'])
    assert.ok(projects[0].lastUsed > projects[1].lastUsed)
  })
})

test('a cwd buried behind a huge first record is still found', () => {
  withFixture(root => {
    const cwd = path.join(root, 'code', 'big')
    fs.mkdirSync(cwd, { recursive: true })
    // A SessionStart hook can write tens of kilobytes on one line before any record
    // that names the directory.
    transcript(root, '-code-big', cwd, { lines: [{ type: 'attachment', stdout: 'x'.repeat(60000) }] })
    return { cwd }
  }, (projects, { cwd }) => {
    assert.deepEqual(projects.map(p => p.path), [cwd])
  })
})

test('directories that no longer exist, and claude-mem observers, are left out', () => {
  withFixture(root => {
    const live = path.join(root, 'code', 'live')
    fs.mkdirSync(live, { recursive: true })
    transcript(root, '-code-live', live)
    transcript(root, '-code-gone', path.join(root, 'code', 'deleted-last-week'))
    const observer = path.join(root, '.claude-mem', 'observer-sessions')
    fs.mkdirSync(observer, { recursive: true })
    transcript(root, '-observer', observer, { mtime: Date.now() + 60000 })
    return { live }
  }, (projects, { live }) => {
    assert.deepEqual(projects.map(p => p.path), [live])
  })
})

test('checkouts next to the default directory are offered even with no transcript', () => {
  withFixture(root => {
    const work = path.join(root, 'work')
    const fresh = path.join(work, 'never-opened')
    const notARepo = path.join(work, 'just-a-folder')
    const hidden = path.join(work, '.hidden-repo')
    fs.mkdirSync(path.join(fresh, '.git'), { recursive: true })
    fs.mkdirSync(notARepo, { recursive: true })
    fs.mkdirSync(path.join(hidden, '.git'), { recursive: true })
    const used = path.join(root, 'elsewhere', 'used')
    fs.mkdirSync(used, { recursive: true })
    transcript(root, '-elsewhere-used', used)
    return { defaultCwd: work, fresh, used }
  }, (projects, { fresh, used }) => {
    // Used first, never-opened after; the non-repo and the dotfile directory are absent.
    assert.deepEqual(projects.map(p => p.path), [used, fresh])
    assert.equal(projects.find(p => p.path === fresh).lastUsed, null)
    assert.equal(projects.find(p => p.path === fresh).git, true)
  })
})

test('a directory named by both sources appears once, keeping its last-used time', () => {
  withFixture(root => {
    const work = path.join(root, 'work')
    const repo = path.join(work, 'claude-fleet')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    transcript(root, '-work-claude-fleet', repo)
    return { defaultCwd: work, repo }
  }, (projects, { repo }) => {
    assert.equal(projects.length, 1)
    assert.equal(projects[0].path, repo)
    assert.ok(projects[0].lastUsed, 'the transcript entry should win over the bare checkout')
  })
})

test('a short path is offered for the label, with the home directory abbreviated', () => {
  withFixture(root => {
    const cwd = path.join(os.homedir(), 'fleet-projects-test-fixture')
    fs.mkdirSync(cwd, { recursive: true })
    transcript(root, '-home-fixture', cwd)
    return { cwd }
  }, (projects, { cwd }) => {
    try {
      assert.equal(projects[0].short, '~/fleet-projects-test-fixture')
      assert.equal(projects[0].parent, '~')
    } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
  })
})

test('an unreadable projects directory yields a list rather than an error', () => {
  withFixture(root => ({ defaultCwd: path.join(root, 'nothing-here') }), projects => {
    assert.deepEqual(projects, [])
  })
})

test('the browser can read the list over HTTP, without a token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-projects-http-'))
  const saved = { dir: process.env.CLAUDE_FLEET_DIR, cwd: process.env.CLAUDE_FLEET_DEFAULT_CWD }
  const repo = path.join(root, 'work', 'a-repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  process.env.CLAUDE_FLEET_DIR = path.join(root, 'claude')
  process.env.CLAUDE_FLEET_DEFAULT_CWD = path.join(root, 'work')
  delete require.cache[require.resolve('./projects')]
  delete require.cache[require.resolve('./paths')]
  delete require.cache[require.resolve('./server')]
  const { createApp } = require('./server')
  const app = createApp({ collectSessions: () => ({ sessions: [], counts: {}, total: 0, generatedAt: Date.now() }) })
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const data = await (await fetch(base + '/api/projects')).json()
    assert.deepEqual(data.projects.map(p => p.path), [repo])
    // The dialog seeds the path field from this before the list arrives.
    assert.equal(data.defaultCwd, path.join(root, 'work'))
  } finally {
    await app.close()
    for (const [key, value] of [['CLAUDE_FLEET_DIR', saved.dir], ['CLAUDE_FLEET_DEFAULT_CWD', saved.cwd]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete require.cache[require.resolve('./projects')]
    delete require.cache[require.resolve('./paths')]
    delete require.cache[require.resolve('./server')]
    fs.rmSync(root, { recursive: true, force: true })
  }
})
