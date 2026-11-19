// The safe writer's optional permissions (mods/io.ts WriteOptions), on the real Node driver.
// Shared core test: it runs in FlowKy and in the FlowKy Pro build.
//
// A write may ask for a file only its owner can read (`mode`, for example 0o600) and for the
// folders it creates to be the same (`dirMode`, 0o700). Without the option nothing changes: the
// plugin's own state files are written as before. The driver is bundled from cli/node-io.ts for
// this test only, into a temporary folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { tempDir } from './tmp.mjs'

const PLUGIN = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const POSIX = process.platform !== 'win32'
const bits = p => statSync(p).mode & 0o777

async function driver() {
  const out = join(tempDir('flowky-wm-build-'), 'node-io.mjs')
  await build({ entryPoints: [join(PLUGIN, 'cli', 'node-io.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node18', outfile: out, logLevel: 'silent' })
  return (await import(pathToFileURL(out).href)).nodeIo()
}

test('writeInside with a mode: the file has exactly those bits, created folders the dirMode, the text is intact', async () => {
  const io = await driver()
  const root = tempDir('flowky-wm-')
  const home = join(root, 'home')
  const file = join(home, 'sub', 'secret.json')
  await io.writeInside(home, file, '{"a":1}\n', { mode: 0o600, dirMode: 0o700 })
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n')
  // No temporary file is left behind.
  assert.deepEqual(readdirSync(join(home, 'sub')), ['secret.json'])
  if (!POSIX) return // Windows: the file inherits its folder's access list; the bits do not apply.
  assert.equal(bits(file), 0o600)
  assert.equal(bits(home), 0o700)
  assert.equal(bits(join(home, 'sub')), 0o700)
})

test('writeInside with a mode over an existing, wider file: the replacement has the mode', async t => {
  if (!POSIX) return t.skip('permission bits are POSIX only')
  const io = await driver()
  const root = tempDir('flowky-wm-over-')
  const file = join(root, 'f.json')
  writeFileSync(file, 'old')
  chmodSync(file, 0o644)
  await io.writeInside(root, file, 'new', { mode: 0o600 })
  assert.equal(readFileSync(file, 'utf8'), 'new')
  assert.equal(bits(file), 0o600)
})

test('writeInside without the option writes as before (the default bits, existing folders untouched)', async t => {
  const io = await driver()
  const root = tempDir('flowky-wm-plain-')
  mkdirSync(join(root, 'keep'))
  const file = join(root, 'keep', 'state.json')
  await io.writeInside(root, file, 'x')
  assert.equal(readFileSync(file, 'utf8'), 'x')
  if (!POSIX) return t.skip('permission bits are POSIX only')
  const umask = process.umask()
  assert.equal(bits(file), 0o666 & ~umask)
  assert.equal(bits(join(root, 'keep')), 0o777 & ~umask)
})

test('the safe writer still refuses outside its root, with or without a mode', async () => {
  const io = await driver()
  const root = tempDir('flowky-wm-out-')
  const outside = join(tempDir('flowky-wm-elsewhere-'), 'x.json')
  await assert.rejects(io.writeInside(root, outside, 'x', { mode: 0o600 }), /outside/)
  assert.equal(existsSync(outside), false)
})

test('the free plugin asks for no permissions: its own files are written as before', { skip: JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).name !== 'flowky' }, () => {
  const scan = dir => readdirSync(join(PLUGIN, dir), { recursive: true }).filter(f => /\.(ts|tsx)$/.test(f)).map(f => `${dir}/${f.replace(/\\/g, '/')}`)
  const drivers = new Set(['cli/node-io.ts', 'hooks/mod-io.ts', 'mods/io.ts'])
  const users = [...scan('hooks'), ...scan('mods'), ...scan('cli')].filter(f => !drivers.has(f) && /\bdirMode\b|\bmode:\s*0o/.test(readFileSync(join(PLUGIN, f), 'utf8')))
  assert.deepEqual(users, [])
})
