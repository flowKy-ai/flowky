// Regression tests of SECURITY_REVIEW_2 (0.2.2) for the shared code, with real Node processes and
// real files; each one fails on the 0.2.1 build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDir } from './tmp.mjs'

const HERE = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const HOOK = join(HERE, '..', 'dist', 'hook.mjs')
const WIN = process.platform === 'win32'

function hook(root, event, input) {
  const r = spawnSync(process.execPath, [HOOK, event], { cwd: root, input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  return { out: r.stdout, err: r.stderr }
}

test('review 2 minor: a linked .flowky/cache (where handoff.md is written) is removed at SessionStart, never followed', t => {
  const root = tempDir('flowky-r2-link-')
  const outside = tempDir('flowky-r2-out-')
  writeFileSync(join(outside, 'keep.txt'), 'outside\n')
  mkdirSync(join(root, '.flowky'), { recursive: true })
  try {
    symlinkSync(outside, join(root, '.flowky', 'cache'), WIN ? 'junction' : 'dir')
  } catch (err) {
    t.skip(`cannot create a link here: ${err.code}`)
    return
  }
  hook(root, 'SessionStart', { session_id: 's' })
  assert.deepEqual(readdirSync(outside), ['keep.txt'])
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside\n')
  assert.ok(existsSync(join(root, '.flowky', 'cache', 'project-map.md')), 'the state folder is a real folder again')
})

test('review 2 minor: a test file leaves no folder in the temp folder', () => {
  const temp = tempDir('flowky-r2-temp-')
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
  delete env.NODE_TEST_CONTEXT // run it as a test run of its own, not as a child of this one
  const r = spawnSync(process.execPath, ['--test', join(HERE, 'hook.test.mjs')], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass [1-9]/)
  assert.deepEqual(readdirSync(temp), [])
})
