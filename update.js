'use strict'
// Fleet checks npm for a newer published version and can install it on request.
// The check is cached on disk and rate-limited, because a dashboard that phones a
// registry on every page load is a dashboard nobody trusts. Nothing installs on
// its own: the operator clicks.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { stateDir } = require('./paths')
const pkg = require('./package.json')

const REGISTRY = process.env.CLAUDE_FLEET_REGISTRY || 'https://registry.npmjs.org'
const CHECK_EVERY = 6 * 60 * 60 * 1000
const CHECK_TIMEOUT = 6000
const INSTALL_TIMEOUT = 5 * 60 * 1000

function parse(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim())
  return match ? { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || null } : null
}
// Deliberately narrow: is `candidate` a release the operator should be offered?
// A prerelease never qualifies, so a stray `1.2.0-beta.1` on the registry cannot
// nag every install in the world.
function isNewer(candidate, current) {
  const a = parse(candidate), b = parse(current)
  if (!a || !b || a.pre) return false
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  return !!b.pre
}
// How this copy of Fleet got here decides whether it can replace itself.
// A git checkout updates with `git pull`; only an npm install can be npm-installed over.
function detectChannel(dir = __dirname) {
  if (dir.split(path.sep).includes('node_modules')) return 'npm'
  if (fs.existsSync(path.join(dir, '.git'))) return 'source'
  return 'unknown'
}

async function fetchLatest(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/latest`
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT),
  })
  if (!response.ok) throw new Error(`Registry answered ${response.status}`)
  const data = await response.json()
  if (!data || typeof data.version !== 'string') throw new Error('Registry returned no version')
  return data.version
}

function npmInstall(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--global', '--no-fund', '--no-audit', spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // npm resolves its own prefix; inheriting a project's .npmrc here would be surprising.
      env: { ...process.env, npm_config_yes: 'true' },
    })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The install took too long and was stopped.')) }, INSTALL_TIMEOUT)
    timer.unref()
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not run npm: ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      // npm's own last words are far more useful than "exit 1".
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-4).join(' · ')
      reject(new Error(tail ? `npm failed: ${tail}` : `npm exited with code ${code}.`))
    })
  })
}

class Updater {
  constructor({
    directory = stateDir(),
    name = pkg.name,
    version = pkg.version,
    channel = detectChannel(),
    latestVersion = fetchLatest,
    install = npmInstall,
    now = Date.now,
  } = {}) {
    this.name = name
    this.version = version
    this.channel = channel
    this.latestVersion = latestVersion
    this.install = install
    this.now = now
    this.file = path.join(directory, 'update.json')
    this.state = 'idle' // idle | checking | installing | installed | failed
    this.error = null
    this.installed = null
    this.checkedAt = 0
    this.latest = null
    this.inFlight = null
    this.load()
  }
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!data || data.version !== 1) return
      if (Number.isFinite(data.checkedAt)) this.checkedAt = data.checkedAt
      // A cached answer about a version we are no longer running says nothing.
      if (typeof data.latest === 'string' && data.for === this.version) this.latest = data.latest
    } catch {}
  }
  persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, checkedAt: this.checkedAt, latest: this.latest, for: this.version }), { mode: 0o600 })
    } catch {}
  }
  status() {
    const available = !!this.latest && isNewer(this.latest, this.version)
    return {
      name: this.name,
      current: this.version,
      latest: this.latest,
      available,
      // Only an npm install can npm-install over itself; a checkout is the user's to pull.
      canInstall: available && this.channel === 'npm',
      channel: this.channel,
      checkedAt: this.checkedAt || null,
      state: this.state,
      error: this.error,
      installed: this.installed,
    }
  }
  // Cheap and idempotent: concurrent callers share one request, and a fresh answer
  // is reused until it goes stale.
  check({ force = false } = {}) {
    if (this.inFlight) return this.inFlight
    if (!force && this.now() - this.checkedAt < CHECK_EVERY) return Promise.resolve(this.status())
    this.state = 'checking'
    this.inFlight = (async () => {
      try {
        this.latest = await this.latestVersion(this.name)
        this.checkedAt = this.now()
        this.error = null
        this.persist()
      } catch (error) {
        // A registry that is down or blocked is not worth an alarm; it just means
        // we do not know yet. Keep whatever the last known answer was.
        this.error = null
        this.checkedAt = this.now()
        this.persist()
        if (process.env.CLAUDE_FLEET_DEBUG) console.error(`Update check failed: ${error.message}`)
      } finally {
        if (this.state === 'checking') this.state = 'idle'
        this.inFlight = null
      }
      return this.status()
    })()
    return this.inFlight
  }
  async apply() {
    const status = this.status()
    if (this.state === 'installing') { const error = new Error('An update is already installing.'); error.status = 409; throw error }
    if (!status.available) { const error = new Error('Fleet is already up to date.'); error.status = 409; throw error }
    if (!status.canInstall) {
      const error = new Error(this.channel === 'source'
        ? 'This Fleet runs from a git checkout. Update it with `git pull`.'
        : 'This Fleet was not installed with npm, so it cannot update itself.')
      error.status = 409
      throw error
    }
    this.state = 'installing'
    this.error = null
    try {
      await this.install(`${this.name}@${this.latest}`)
      this.state = 'installed'
      this.installed = this.latest
      return this.status()
    } catch (error) {
      this.state = 'failed'
      this.error = error.message
      const failure = new Error(error.message)
      failure.status = 502
      throw failure
    }
  }
}

module.exports = { Updater, isNewer, detectChannel, CHECK_EVERY }
