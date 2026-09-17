'use strict'
// Decides which tool requests Fleet answers on the operator's behalf.
//
// Fleet only sees a request at all when the project's own Claude settings did not
// already allow it, so this is the last gate before a prompt appears. In `auto`
// mode everything is approved except the commands on DENIED below; in `ask` mode
// nothing is, which is the original behaviour.

const MODES = ['ask', 'auto', 'all']
const DEFAULT_MODE = 'auto'

// Mirrors the command_denylist in ~/.warp/settings.toml, plus a few commands that
// destroy data outright. Edit this list to change what still stops for approval.
const DENIED = [
  'rm', 'rmdir', 'shred', 'dd', 'mkfs',            // destroys data
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'telnet', // reaches the network or another host
  'dig', 'nslookup', 'host',
  'sh', 'bash', 'zsh', 'fish', 'pwsh',             // an arbitrary script is not reviewable
  'eval', 'exec', 'source', 'sudo', 'doas',
]
// Commands whose damage is done elsewhere, so a human should see them first.
const DENIED_PHRASES = [/^git\s+push\b/, /^npm\s+publish\b/, /^gh\s+(pr|release)\s+(create|merge)\b/]
// A question for the operator is never a permission Fleet may answer for them.
const ALWAYS_ASK = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Split a command line the way a shell would hand pieces to separate programs, so
// `cd build && rm -rf .` is judged on `rm -rf .` and not on `cd`.
function segments(command) {
  return String(command)
    .split(/\n|&&|\|\||[;|]|\$\(|`/)
    .map(part => part.trim())
    .filter(Boolean)
}
// Drop the wrappers that would otherwise hide the real command behind them. `sudo`
// is deliberately NOT stripped: running anything as root is itself worth approving.
function head(segment) {
  let rest = segment.replace(/^[({\s]+/, '')
  for (let i = 0; i < 4; i++) {
    const next = rest.replace(/^(?:command|nohup|time|env|xargs|nice)\s+/, '').replace(/^\w+=[^\s]*\s+/, '')
    if (next === rest) break
    rest = next
  }
  return rest
}
function deniedCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null
  for (const segment of segments(command)) {
    const rest = head(segment)
    const name = rest.split(/\s/)[0].replace(/^.*\//, '')
    if (DENIED.includes(name)) return name
    for (const phrase of DENIED_PHRASES) if (phrase.test(rest)) return rest.split(/\s/).slice(0, 2).join(' ')
  }
  // `find . -exec rm {} \;` and friends never appear at the head of a segment.
  for (const name of ['rm', 'shred', 'dd', 'mkfs']) {
    if (new RegExp(`(?:^|\\s)-(?:exec|execdir|delete)\\s+${name}\\b|\\bxargs\\s+(?:-\\S+\\s+)*${name}\\b`).test(command)) return name
  }
  return null
}

// Returns null when Fleet may answer for the operator, or the reason it must ask.
function askReason(tool, input, mode = DEFAULT_MODE) {
  if (ALWAYS_ASK.has(tool)) return tool === 'AskUserQuestion' ? 'Claude is asking you a question' : 'Plan needs your review'
  if (mode === 'all') return null
  if (mode !== 'auto') return 'Approvals are set to ask every time'
  if (tool === 'Bash' || tool === 'BashOutput') {
    const denied = deniedCommand(input?.command)
    if (denied) return `\`${denied}\` is on the approval list`
  }
  return null
}
const normaliseMode = value => (MODES.includes(value) ? value : DEFAULT_MODE)

module.exports = { MODES, DEFAULT_MODE, DENIED, ALWAYS_ASK, askReason, deniedCommand, normaliseMode }
