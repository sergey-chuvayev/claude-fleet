'use strict'
// Start at login: Fleet as a macOS LaunchAgent, so the server runs without a terminal,
// comes up when the operator logs in, and is started again if it ever crashes.
//
// launchd owns the process, which changes how Fleet restarts itself. When a launchd
// job exits, launchd also ends what the job spawned, so the usual "spawn the new
// version, then exit" would lose the replacement. Under the service Fleet instead
// exits with RESTART_CODE and launchd, told to keep the job alive after any unclean
// exit, starts the freshly installed code. A clean exit (logout, `launchctl bootout`,
// Ctrl-C) stays stopped.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const LABEL = 'local.claude.fleet.server'
const RESTART_CODE = 75 // EX_TEMPFAIL: "try again", which is what launchd will do.
const ENTRY = path.join(__dirname, 'bin', 'claude-fleet.js')

const xml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])

class Service {
  constructor({ home = os.homedir(), platform = process.platform, uid = process.getuid?.(), node = process.execPath, entry = ENTRY, env = process.env, run = (command, args) => spawnSync(command, args, { encoding: 'utf8' }) } = {}) {
    Object.assign(this, { home, platform, uid, node, entry, env, run })
    // Another label keeps a second, throwaway service (a test, a second instance) apart.
    this.label = env.CLAUDE_FLEET_SERVICE_LABEL || LABEL
    this.file = path.join(home, 'Library', 'LaunchAgents', `${this.label}.plist`)
    this.log = path.join(home, 'Library', 'Logs', 'claude-fleet.log')
  }
  get supported() { return this.platform === 'darwin' }
  // True when this very process was started by launchd as the service.
  get managed() { return this.env.CLAUDE_FLEET_SERVICE === '1' }
  get target() { return `gui/${this.uid}/${this.label}` }

  status() {
    if (!this.supported) return { supported: false, enabled: false, loaded: false, managed: false }
    const loaded = this.run('launchctl', ['print', this.target]).status === 0
    return { supported: true, enabled: fs.existsSync(this.file), loaded, managed: this.managed, file: this.file, log: this.log }
  }

  // Where agents start by default, as the app launcher picks it.
  defaultCwd() {
    const projects = path.join(this.home, 'projects')
    return fs.existsSync(projects) ? projects : this.home
  }

  plist({ port } = {}) {
    // A login session hands launchd a minimal PATH; widen it so the server finds the
    // claude CLI and npm (for its own updates), as the app launcher does.
    const PATH = [path.join(this.home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.dirname(this.node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
    const env = { PATH, CLAUDE_FLEET_SERVICE: '1', CLAUDE_FLEET_DEFAULT_CWD: this.defaultCwd(), ...(port ? { PORT: String(port) } : {}) }
    for (const key of ['CLAUDE_FLEET_HOME', 'CLAUDE_FLEET_DIR', 'CLAUDE_FLEET_EXECUTABLE', 'CLAUDE_FLEET_SERVICE_LABEL']) if (this.env[key]) env[key] = this.env[key]
    const pairs = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by Claude Fleet (Settings → Startup, or \`claude-fleet service on\`). -->
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(this.label)}</string>
  <key>ProgramArguments</key><array><string>${xml(this.node)}</string><string>${xml(this.entry)}</string><string>start</string><string>--no-open</string></array>
  <key>EnvironmentVariables</key><dict>
${pairs}
  </dict>
  <key>WorkingDirectory</key><string>${xml(this.defaultCwd())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(this.log)}</string>
  <key>StandardErrorPath</key><string>${xml(this.log)}</string>
</dict></plist>
`
  }

  // Write the job and register it with launchd, which starts it at once. If a Fleet
  // server is already running, that instance finds it and exits cleanly; a running
  // server hands over with write(), then load() once it has let go of the port.
  enable({ port } = {}) {
    this.write({ port })
    return this.load()
  }

  write({ port } = {}) {
    if (!this.supported) throw new Error('Starting at login is only available on macOS.')
    if (!fs.existsSync(this.node)) throw new Error(`Node was not found at ${this.node}.`)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.mkdirSync(path.dirname(this.log), { recursive: true })
    fs.writeFileSync(this.file, this.plist({ port }))
  }

  load() {
    this.run('launchctl', ['bootout', this.target])
    const result = this.run('launchctl', ['bootstrap', `gui/${this.uid}`, this.file])
    if (result.status !== 0) {
      fs.rmSync(this.file, { force: true })
      throw new Error(`launchctl could not load the service: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`)
    }
    return this.status()
  }

  // An installed Claude Fleet.app predating the service would start a second Fleet
  // beside it; rebuild its launcher so it asks launchd instead.
  refreshApp() {
    const app = path.join(this.home, 'Applications', 'Claude Fleet.app')
    if (!fs.existsSync(app)) return false
    const root = path.dirname(path.dirname(this.entry))
    const result = spawnSync('bash', [path.join(root, 'build', 'make-app.sh')], { encoding: 'utf8', env: { ...this.env, PROJECT: root, NODE_BIN: this.node, FLEET_BIN: this.entry, APP_DEST: path.dirname(app) } })
    return result.status === 0
  }

  // Whether launchd has the job's process up right now (not just loaded).
  running() {
    const result = this.run('launchctl', ['print', this.target])
    return result.status === 0 && /\bstate = running\b/.test(result.stdout || '')
  }

  // Take the job out of login. A server launchd started keeps running until it exits
  // or the operator logs out (unloading it would end this very process); one started
  // any other way unloads at once.
  disable() {
    if (!this.supported) throw new Error('Starting at login is only available on macOS.')
    fs.rmSync(this.file, { force: true })
    if (!this.managed) this.run('launchctl', ['bootout', this.target])
    return this.status()
  }
}

module.exports = { Service, LABEL, RESTART_CODE }
