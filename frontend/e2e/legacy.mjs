// The legacy app (public/) was removed at cutover (work package 6), so anything that shows
// or measures it needs a checkout from before the cutover: one that still has public/ and
// the fixture server (frontend/src/test/fixtures/capture.js). Point LEGACY_ROOT at it, for
// example a worktree of the last react-migration commit before the cutover merged:
//
//   git worktree add /tmp/fleet-legacy a8c8498
//   LEGACY_ROOT=/tmp/fleet-legacy node frontend/e2e/baseline/capture.mjs
//
// The fixture server needs no install there: it loads only Fleet's own modules.
import fs from 'node:fs'
import path from 'node:path'

const HOW =
  'The legacy side needs a checkout from before the cutover (it still has public/ and frontend/src/test/fixtures/capture.js). ' +
  'Create one with `git worktree add /tmp/fleet-legacy a8c8498` and set LEGACY_ROOT=/tmp/fleet-legacy.'

/** The pre-cutover checkout, or null when LEGACY_ROOT is unset. Throws if it is set but unusable. */
export function legacyRoot() {
  const root = process.env.LEGACY_ROOT
  if (!root) return null
  const resolved = path.resolve(root)
  for (const needed of ['public/index.html', 'frontend/src/test/fixtures/capture.js']) {
    if (!fs.existsSync(path.join(resolved, needed))) throw new Error(`LEGACY_ROOT=${root} has no ${needed}. ${HOW}`)
  }
  return resolved
}

/** The pre-cutover checkout; exits with instructions when there is none. */
export function requireLegacyRoot() {
  let root
  try {
    root = legacyRoot()
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  if (!root) {
    console.error(`LEGACY_ROOT is not set. ${HOW}`)
    process.exit(2)
  }
  return root
}

/** The fixture server script of the legacy checkout. */
export const legacyCapture = root => path.join(root, 'frontend/src/test/fixtures/capture.js')

export const LEGACY_HOW = HOW
