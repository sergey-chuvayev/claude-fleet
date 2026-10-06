'use strict'
// Decides which tool requests Fleet answers on the operator's behalf.
//
// Fleet only sees a request at all when the project's own Claude settings did not
// already allow it, so this is the last gate before a prompt appears. In `auto`
// mode everything is approved except the commands on DENIED below; in `ask` mode
// nothing is, which is the original behaviour.
//
// The list is a convenience check that catches the usual ways an agent destroys data
// or publishes by accident. It is not a sandbox: an agent determined to run `rm` can
// still reach it through an interpreter (`node -e`, `python -c`) or a script file.

const MODES = ['ask', 'auto', 'all']
const DEFAULT_MODE = 'auto'
// What a newly created agent starts with until the operator changes the setting. It is
// separate from DEFAULT_MODE, which stays the fallback for a saved value nobody can read.
const DEFAULT_NEW_MODE = 'all'

// Mirrors the command_denylist in ~/.warp/settings.toml, plus a few commands that
// destroy data outright. Edit this list to change what still stops for approval.
const DENIED = [
  'rm', 'rmdir', 'shred', 'dd', 'mkfs',            // destroys data
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'telnet', // reaches the network or another host
  'dig', 'nslookup', 'host',
  'sh', 'bash', 'zsh', 'fish', 'pwsh',             // an arbitrary script is not reviewable
  'eval', 'exec', 'source', '.', 'sudo', 'doas',
]
// A question for the operator is never a permission Fleet may answer for them.
const ALWAYS_ASK = new Set(['AskUserQuestion', 'ExitPlanMode'])

// ---- Reading a command line ------------------------------------------------------
//
// A small shell reader: quotes, escapes, comments, `;` `&&` `||` `|` `&`, subshells,
// redirections, `$(…)`, backticks, `<(…)` and heredocs. It returns every simple
// command it finds, including the ones inside substitutions, as lists of words. A
// heredoc body is data, so its text is never mistaken for a command, but an unquoted
// body still has its `$(…)` read. Anything it cannot close (a quote, a substitution,
// a heredoc) throws, and the caller treats that as a reason to ask.

class Unreadable extends Error {}

function parseShell(src) {
  const commands = []
  const pending = []        // heredocs whose bodies start after the next newline
  const n = src.length
  let i = 0

  const blank = c => c === ' ' || c === '\t'
  const ends = c => c === undefined || blank(c) || c === '\n' || ';&|()<>'.includes(c)

  function list(close) {
    let words = []
    let depth = 0
    const flush = () => { if (words.length) commands.push(words); words = [] }
    for (;;) {
      while (i < n && blank(src[i])) i++
      if (i >= n) {
        if (close || depth || pending.length) throw new Unreadable('unclosed')
        flush()
        return
      }
      const c = src[i]
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue }
      if (c === '\n') { i++; flush(); bodies(); continue }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue }
      if (c === '(') { i++; flush(); depth++; continue }
      if (c === ')') {
        i++; flush()
        if (depth) { depth--; continue }
        if (close) return
        continue
      }
      if ((c === '<' || c === '>') && src[i + 1] === '(') { words.push(word()); continue }
      const fd = /^(?:\d+|&)(?=[<>])/.exec(src.slice(i, i + 12))
      if (fd && !(fd[0] === '&' && src[i + 1] !== '>')) { i += fd[0].length; redirect(); continue }
      if (c === '<' || c === '>') { redirect(); continue }
      if (';&|'.includes(c)) { while (i < n && ';&|'.includes(src[i])) i++; flush(); continue }
      words.push(word())
    }
  }

  // `>`, `>>`, `>|`, `>&`, `<`, `<>`, `<&`, `<<<`, `<<`, `<<-`; the target is not a command.
  function redirect() {
    const op = /^(?:<<-|<<<|<<|>>|>\||>&|<&|<>|[<>])/.exec(src.slice(i))[0]
    i += op.length
    while (i < n && blank(src[i])) i++
    const substitution = (src[i] === '<' || src[i] === '>') && src[i + 1] === '('
    if (i >= n || ends(src[i]) && !substitution) throw new Unreadable('redirect')
    const target = word()
    if (op === '<<' || op === '<<-') pending.push({ delim: target.text, strip: op === '<<-', quoted: target.quoted })
  }

  function bodies() {
    while (pending.length) {
      const { delim, strip, quoted } = pending.shift()
      const lines = []
      for (;;) {
        if (i >= n) throw new Unreadable('heredoc')
        let end = src.indexOf('\n', i)
        if (end < 0) end = n
        const line = src.slice(i, end)
        i = Math.min(end + 1, n)
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) break
        if (end === n) throw new Unreadable('heredoc')
        lines.push(line)
      }
      // An unquoted body expands like a double-quoted string, `$(…)` included. Read it
      // as one; the last command found is that string itself, which is only data.
      const body = lines.join('\n')
      if (!quoted && /[$`]/.test(body)) commands.push(...parseShell(`"${body.replace(/"/g, '\\"')}"`).slice(0, -1))
    }
  }

  function word() {
    const w = { text: '', quoted: false, dynamic: false }
    if ((src[i] === '<' || src[i] === '>') && src[i + 1] === '(') { i += 2; list(')'); w.dynamic = true }
    while (i < n && !ends(src[i])) {
      const c = src[i]
      if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue }
        w.text += src[i + 1] ?? ''; w.quoted = true; i += 2
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1)
        if (end < 0) throw new Unreadable('quote')
        w.text += src.slice(i + 1, end); w.quoted = true; i = end + 1
      } else if (c === '$' && src[i + 1] === "'") {
        i += 2; w.quoted = true
        for (;;) {
          if (i >= n) throw new Unreadable('quote')
          if (src[i] === "'") { i++; break }
          if (src[i] === '\\') i++
          w.text += src[i++] ?? ''
        }
      } else if (c === '"') {
        i++; w.quoted = true
        for (;;) {
          if (i >= n) throw new Unreadable('quote')
          const d = src[i]
          if (d === '"') { i++; break }
          if (d === '\\') {
            if ('$`"\\\n'.includes(src[i + 1])) { if (src[i + 1] !== '\n') w.text += src[i + 1]; i += 2 } else { w.text += d; i++ }
          } else if (d === '$') { if (dollar(w)) w.dynamic = true } else if (d === '`') { backtick(); w.dynamic = true } else { w.text += d; i++ }
        }
      } else if (c === '$') {
        if (dollar(w)) w.dynamic = true
      } else if (c === '`') {
        backtick(); w.dynamic = true
      } else { w.text += c; i++ }
    }
    return w
  }

  // Returns true when the `$` started an expansion rather than standing for itself.
  function dollar(w) {
    const next = src[i + 1]
    if (next === '(' && src[i + 2] === '(') { i = balanced(i + 1, '(', ')'); return true }
    if (next === '(') { i += 2; list(')'); return true }
    if (next === '{') { i = balanced(i + 1, '{', '}'); return true }
    const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(src.slice(i + 1))
    if (name) { i += 1 + name[0].length; return true }
    w.text += '$'; i++
    return false
  }
  function balanced(start, open, shut) {
    let depth = 0
    for (let j = start; j < n; j++) {
      if (src[j] === open) depth++
      else if (src[j] === shut && --depth === 0) return j + 1
    }
    throw new Unreadable('unclosed')
  }
  function backtick() {
    let inner = ''
    for (i++; ; i++) {
      if (i >= n) throw new Unreadable('backtick')
      if (src[i] === '`') { i++; break }
      if (src[i] === '\\' && '`$\\'.includes(src[i + 1])) i++
      inner += src[i]
    }
    commands.push(...parseShell(inner))
  }

  list(null)
  return commands
}

// ---- Judging one simple command ----------------------------------------------------

// Words that open or close a compound command; the real command follows them.
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until'])
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/

// Programs that run the command given after their own options. `values` are the
// options that take a separate argument; `skip` counts positionals before the command.
const WRAPPERS = {
  env: { values: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], assignments: true },
  command: { values: [] },
  builtin: { values: [] },
  nohup: { values: [] },
  time: { values: ['-o', '-f', '--output', '--format'] },
  nice: { values: ['-n', '--adjustment'] },
  timeout: { values: ['-s', '-k', '--signal', '--kill-after'], skip: 1 },
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  caffeinate: { values: ['-t', '-w'] },
  watch: { values: ['-n', '--interval'] },
  busybox: { values: [] },
  xargs: {
    values: ['-I', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '-J', '-R', '-S',
      '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'],
  },
}

// Steps over a wrapper's options. Returns the index of the first word after them, and
// the values seen, so `env -S '…'` and `command -v` can be judged on what they carry.
function options(words, start, values) {
  const takes = new Set(values)
  const seen = []
  let k = start
  while (k < words.length) {
    const t = words[k].text
    if (t === '--') return { next: k + 1, seen }
    if (!t.startsWith('-') || t === '-') break
    if (t.startsWith('--')) {
      const [flag, value] = t.split(/=(.*)/s)
      if (value === undefined && takes.has(flag)) { seen.push([flag, words[k + 1]?.text]); k += 2 } else { seen.push([flag, value]); k++ }
      continue
    }
    // A short cluster such as `-0n5` or `-n 5`: the first letter that takes a value
    // swallows the rest of the cluster, or the next word when nothing is left.
    let consumed = 1
    for (let p = 1; p < t.length; p++) {
      const flag = `-${t[p]}`
      if (!takes.has(flag)) { seen.push([flag]); continue }
      const rest = t.slice(p + 1)
      if (rest) seen.push([flag, rest]); else { seen.push([flag, words[k + 1]?.text]); consumed = 2 }
      break
    }
    k += consumed
  }
  return { next: k, seen }
}

const deny = command => ({ command, kind: 'denied' })

// The reason one simple command needs approval, or null.
function judge(words) {
  let k = 0
  while (k < words.length && (RESERVED.has(words[k].text) && !words[k].quoted || ASSIGNMENT.test(words[k].text))) k++
  if (k >= words.length) return null
  const first = words[k]
  // `$CMD x` or `$(which rm) x`: what runs is only decided when the line runs.
  if (first.dynamic) return { command: first.text || 'a computed command', kind: 'dynamic' }
  const name = first.text.replace(/^.+\//, '')
  if (DENIED.includes(name)) return deny(name)
  const rest = words.slice(k + 1)

  const wrapper = WRAPPERS[name]
  if (wrapper) {
    let { next, seen } = options(rest, 0, wrapper.values)
    if (name === 'command' && seen.some(([flag]) => flag === '-v' || flag === '-V')) return null
    const split = seen.find(([flag]) => flag === '-S' || flag === '--split-string')
    if (split) { const found = commandRisk(split[1] ?? ''); if (found) return found }
    if (wrapper.assignments) while (next < rest.length && ASSIGNMENT.test(rest[next].text)) next++
    next += wrapper.skip || 0
    return judge(rest.slice(next))
  }

  if (name === 'git') {
    const { next, seen } = options(rest, 0, ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])
    // `git -c alias.x='!rm -rf ~' x` runs a shell command the line never names.
    if (seen.some(([flag, value]) => (flag === '-c' || flag === '--config-env') && /^alias\./i.test(value || ''))) return { command: 'git -c alias', kind: 'dynamic' }
    if (rest[next]?.text === 'push') return deny('git push')
    return null
  }
  if (name === 'npm') {
    const { next } = options(rest, 0, ['-C', '-w', '--prefix', '--workspace', '--registry', '--userconfig', '--cache', '--tag', '--otp', '--access'])
    return rest[next]?.text === 'publish' ? deny('npm publish') : null
  }
  if (name === 'gh') {
    const positional = []
    for (let p = 0; p < rest.length && positional.length < 2; p++) {
      const t = rest[p].text
      if (t === '-R' || t === '--repo' || t === '--hostname') p++
      else if (!t.startsWith('-')) positional.push(t)
    }
    const [group, action] = positional
    if ((group === 'pr' || group === 'release') && (action === 'create' || action === 'merge')) return deny(`gh ${group} ${action}`)
    return null
  }
  if (name === 'find') {
    for (let p = 0; p < rest.length; p++) {
      const t = rest[p].text
      if (t === '-delete') return deny('find -delete')
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(t)) {
        let end = p + 1
        while (end < rest.length && !(rest[end].text === ';' || rest[end].text === '+')) end++
        const found = judge(rest.slice(p + 1, end))
        if (found) return found
        p = end
      }
    }
    return null
  }
  if (name === 'fd') {
    const at = rest.findIndex(w => ['-x', '-X', '--exec', '--exec-batch'].includes(w.text))
    return at < 0 ? null : judge(rest.slice(at + 1))
  }
  return null
}

// The first reason this command line needs approval, as { command, kind }, or null.
// `kind` is 'denied' for a listed command, 'dynamic' when the program is only named
// at run time, and 'unreadable' when the line cannot be read with confidence.
function commandRisk(command) {
  if (typeof command !== 'string' || !command.trim()) return null
  let commands
  try { commands = parseShell(command) } catch (error) {
    if (error instanceof Unreadable) return { command: 'shell syntax', kind: 'unreadable' }
    throw error
  }
  for (const words of commands) {
    const found = judge(words)
    if (found) return found
  }
  return null
}
function deniedCommand(command) {
  return commandRisk(command)?.command ?? null
}

// Returns null when Fleet may answer for the operator, or the reason it must ask.
function askReason(tool, input, mode = DEFAULT_MODE) {
  if (ALWAYS_ASK.has(tool)) return tool === 'AskUserQuestion' ? 'Claude is asking you a question' : 'Plan needs your review'
  if (mode === 'all') return null
  if (mode !== 'auto') return 'Approvals are set to ask every time'
  if (tool === 'Bash' || tool === 'BashOutput') {
    const risk = commandRisk(input?.command)
    if (risk?.kind === 'denied') return `\`${risk.command}\` is on the approval list`
    if (risk?.kind === 'dynamic') return `\`${risk.command}\` decides what runs only when the command runs`
    if (risk) return 'Fleet could not read this command with confidence'
  }
  return null
}
const normaliseMode = value => (MODES.includes(value) ? value : DEFAULT_MODE)

module.exports = { MODES, DEFAULT_MODE, DEFAULT_NEW_MODE, DENIED, ALWAYS_ASK, askReason, commandRisk, deniedCommand, normaliseMode }
