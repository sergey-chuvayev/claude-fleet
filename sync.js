'use strict'
// Answers for a page that already holds most of what it asks for. The session list
// and an open conversation used to come back whole on every refresh, nearly a megabyte
// every two seconds with nothing new in it. Now:
//   - nothing changed since the page's copy: 304 and no body;
//   - something changed: the full answer, except that list items the page already
//     holds (a session row, a message, a sub-agent) come back as their fingerprint.
// The page sends what it holds as ETag and X-Fleet-Known. It never loses anything: a
// fingerprint it does not recognise makes it ask again without them, for everything.
const { createHash } = require('node:crypto')

const fingerprint = text => createHash('sha1').update(text).digest('base64url').slice(0, 16)
const MAX_KNOWN = 64000 // header bytes; a page holds a few thousand fingerprints at most

function knownFrom(req) {
  const raw = req.headers['x-fleet-known']
  if (typeof raw !== 'string' || !raw || raw.length > MAX_KNOWN) return new Set()
  return new Set(raw.split(',').filter(h => /^[\w-]{16}$/.test(h)))
}

// `paths` name the arrays to pack, as dotted paths ('sessions', 'session.messages').
function at(value, path) { return path.split('.').reduce((v, k) => v?.[k], value) }
function withAt(value, path, replacement) {
  const [key, ...rest] = path.split('.')
  if (!value || typeof value !== 'object' || !(key in value)) return value
  return { ...value, [key]: rest.length ? withAt(value[key], rest.join('.'), replacement) : replacement }
}
function pack(value, paths, known) {
  let out = value
  for (const path of paths) {
    const list = at(value, path)
    if (!Array.isArray(list)) continue
    out = withAt(out, path, list.map(item => {
      const h = fingerprint(JSON.stringify(item))
      return known.has(h) ? { h } : { ...item, h }
    }))
  }
  return out
}

// The tag covers everything the page sees except `volatile` keys (generatedAt), so an
// unchanged list stays unchanged from one second to the next.
function tagOf(value, volatile = []) {
  if (!volatile.length) return `"${fingerprint(JSON.stringify(value))}"`
  const stable = { ...value }
  for (const key of volatile) delete stable[key]
  return `"${fingerprint(JSON.stringify(stable))}"`
}

function respond(req, res, value, { paths = [], volatile = [] } = {}) {
  const tag = tagOf(value, volatile)
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { etag: tag, 'cache-control': 'no-store' })
    return res.end()
  }
  const body = JSON.stringify(pack(value, paths, knownFrom(req)))
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', etag: tag })
  res.end(body)
}

module.exports = { respond, tagOf, pack, fingerprint, knownFrom }
