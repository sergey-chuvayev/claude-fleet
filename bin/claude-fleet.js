#!/usr/bin/env node
'use strict'
// The installed command. Everything Fleet does from a terminal goes through here,
// which also means argv[1] is a stable path that survives an in-place npm update —
// that is what lets the server re-run itself after installing a new version.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))

const HELP = `
  Claude Fleet v${pkg.version} — a local control room for Claude Code sessions

  claude-fleet                 start Fleet and open it as an app window
  claude-fleet start           start it without opening anything
  claude-fleet --browser       open a normal browser tab instead of an app window
  claude-fleet install-app     put a "Claude Fleet" app in ~/Applications (macOS)
  claude-fleet update          install the latest published version
  claude-fleet --version       print the version
  claude-fleet --help          this

  The app window is a Chromium window with no tab strip and no address bar. If Fleet
  is already running, claude-fleet puts that server on screen rather than starting a
  second one.

  Environment
    PORT                       port to listen on (default 7777, next free one if taken)
    CLAUDE_FLEET_HOME          where Fleet keeps its own state (default ~/.claude-fleet)
    CLAUDE_FLEET_DIR           the Claude directory to read (default ~/.claude)
    CLAUDE_FLEET_EXECUTABLE    the claude binary to run; "bundled" uses the SDK's own
    CLAUDE_FLEET_BROWSER       the Chromium to open the app window with
    CLAUDE_FLEET_APP_PROFILE   where that window keeps its profile
`

// A PATH walk rather than `command -v`, because this has to work without a shell
// and on Windows.
function which(command) {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch {}
    }
  }
  return null
}

// The SDK ships its own Claude runtime, which can lag the CLI you actually use and
// therefore offer an older set of models. Prefer the installed CLI, so Fleet's
// agents run the same Claude as your terminals.
function preferInstalledClaude() {
  const pinned = process.env.CLAUDE_FLEET_EXECUTABLE
  if (pinned === 'bundled') { delete process.env.CLAUDE_FLEET_EXECUTABLE; return null }
  if (pinned) return pinned
  const found = which('claude')
  if (found) process.env.CLAUDE_FLEET_EXECUTABLE = found
  return found
}

function start({ open }) {
  const claude = preferInstalledClaude()
  if (claude) console.log(`  Using your Claude CLI: ${claude}`)
  if (open && !process.argv.includes('--open')) process.argv.push('--open')
  require(path.join(ROOT, 'server.js')).main()
}

function installApp() {
  if (process.platform !== 'darwin') {
    console.error('install-app builds a macOS app bundle. On other platforms, use your browser\'s "Install app" option instead.')
    process.exit(1)
  }
  const node = process.execPath
  // Bake in absolute paths: a GUI app launched from Finder gets a minimal PATH and
  // would not find node, nvm or Homebrew.
  const result = spawnSync('bash', [path.join(ROOT, 'build', 'make-app.sh')], {
    stdio: 'inherit',
    env: { ...process.env, PROJECT: ROOT, NODE_BIN: node, FLEET_BIN: path.join(ROOT, 'bin', 'claude-fleet.js') },
  })
  process.exit(result.status === null ? 1 : result.status)
}

function update() {
  const { Updater } = require(path.join(ROOT, 'update.js'))
  const updater = new Updater()
  updater.check({ force: true }).then(async status => {
    if (!status.available) return console.log(`  Claude Fleet v${status.current} is up to date.`)
    if (!status.canInstall) {
      console.log(`  v${status.latest} is out. This copy runs from ${status.channel === 'source' ? 'a git checkout — update it with `git pull`' : 'an install npm does not manage'}.`)
      return
    }
    console.log(`  Installing Claude Fleet v${status.latest}…`)
    try { await updater.apply(); console.log(`  Done. v${status.latest} is installed.`) }
    catch (error) { console.error(`  ${error.message}`); process.exitCode = 1 }
  }).catch(error => { console.error(`  ${error.message}`); process.exitCode = 1 })
}

const [command] = process.argv.slice(2).filter(argument => !argument.startsWith('-'))
const flags = new Set(process.argv.slice(2).filter(argument => argument.startsWith('-')))

if (flags.has('--help') || flags.has('-h') || command === 'help') console.log(HELP)
else if (flags.has('--version') || flags.has('-v') || command === 'version') console.log(pkg.version)
else if (command === 'install-app') installApp()
else if (command === 'update') update()
else if (command === 'start') start({ open: false })
else if (!command) start({ open: !flags.has('--no-open') })
else { console.error(`Unknown command: ${command}\n${HELP}`); process.exit(1) }
