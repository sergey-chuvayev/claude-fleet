'use strict'
// How the dashboard gets on screen. Fleet is a desktop tool in everything but
// packaging, so the default is a Chromium app window — no tab strip, no address
// bar, its own Dock entry — rather than a tab that goes missing among forty others.
//
// The profile directory is shared with the bundle `install-app` builds, on purpose.
// Chrome keys localStorage and window state to the profile, so a terminal launch and
// a Spotlight launch have to point at the same one or they become two windows that
// disagree about which sessions you had open.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Tried in order. Chrome first because it is the likeliest to be installed and its
// `--app` behaviour has been stable for years.
const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const UNIX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
const WIN_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false } }

// Absolute paths are checked as given; bare names are walked down PATH, because an
// app launched from Finder or a .desktop file has no shell to resolve them for it.
function locate(candidate, { env, exists }) {
  if (candidate.includes(path.sep) || candidate.includes('/')) return exists(candidate) ? candidate : null
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, candidate)
    if (exists(full)) return full
  }
  return null
}

// Kept in step with build/make-app.sh. If one of them moves, both move.
function profileDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.CLAUDE_FLEET_APP_PROFILE) return path.resolve(env.CLAUDE_FLEET_APP_PROFILE)
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ClaudeFleetApp')
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ClaudeFleetApp')
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'ClaudeFleetApp')
}

// CLAUDE_FLEET_BROWSER wins outright, so an operator on a Chromium this does not know
// about is never stuck with a plain tab.
function findBrowser({ env = process.env, platform = process.platform, exists = executable } = {}) {
  const known = platform === 'darwin' ? MAC_BROWSERS : platform === 'win32' ? WIN_BROWSERS : UNIX_BROWSERS
  const candidates = env.CLAUDE_FLEET_BROWSER ? [env.CLAUDE_FLEET_BROWSER, ...known] : known
  for (const candidate of candidates) {
    const found = locate(candidate, { env, exists })
    if (found) return found
  }
  return null
}

// The plain-tab route, for when no Chromium is installed or the operator asked for it.
function browserCommand(url, platform) {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]]
  return ['xdg-open', [url]]
}

// Returns what it did, so the caller can say so and the tests can assert on it without
// launching anything: {mode:'app'|'browser', command, args}.
function openDashboard(url, {
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  exists = executable,
  spawn = require('node:child_process').spawn,
  app = true,
} = {}) {
  const browser = app ? findBrowser({ env, platform, exists }) : null
  const [command, args] = browser
    // --app is what drops the tab strip and the address bar. The separate profile also
    // keeps Fleet out of the way of whatever the operator has open for actual browsing.
    ? [browser, [`--app=${url}`, `--user-data-dir=${profileDir({ env, platform, home })}`]]
    : browserCommand(url, platform)
  // Detached: the window has to outlive `claude-fleet` when the server is already up
  // and this process is about to exit.
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
  return { mode: browser ? 'app' : 'browser', command, args }
}

module.exports = { openDashboard, findBrowser, profileDir, MAC_BROWSERS, UNIX_BROWSERS, WIN_BROWSERS }
