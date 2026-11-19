// The shared core's contract (core.json), checked in every plugin built from it: FlowKy (this
// folder) and FlowKy Pro (its assembled build, which carries the same core.json at the pinned
// commit). A core file may import only core files and the per-plugin interface files, so that any
// plugin providing the interface builds; and every listed file exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const core = JSON.parse(readFileSync(join(ROOT, 'core.json'), 'utf8'))
const posix = p => p.replace(/\\/g, '/')

test('core.json lists existing files, once each, and an interface the plugin provides', () => {
  assert.ok(Array.isArray(core.files) && core.files.length > 10)
  assert.equal(new Set(core.files).size, core.files.length, 'a file is listed twice')
  for (const f of core.files) assert.ok(existsSync(join(ROOT, f)), `core file ${f} is missing`)
  for (const f of Object.keys(core.interface)) {
    assert.ok(!core.files.includes(f), `${f} is both core and per-plugin`)
    assert.ok(existsSync(join(ROOT, f)), `this plugin does not provide ${f}`)
  }
})

test('a core file imports only core files and the per-plugin interface', () => {
  const allowed = new Set([...core.files, ...Object.keys(core.interface)])
  const bad = []
  for (const f of core.files.filter(f => /\.(ts|tsx|mjs)$/.test(f))) {
    const text = readFileSync(join(ROOT, f), 'utf8')
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2]
      const base = posix(normalize(join(dirname(f), spec)))
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`].find(c => allowed.has(c) || existsSync(join(ROOT, c)))
      if (!target || !allowed.has(target)) bad.push(`${f} imports ${spec}`)
    }
  }
  assert.deepEqual(bad, [])
})
