// The network-free bundle test (shared core: it runs in FlowKy and in the FlowKy Pro build).
//
// What the plugin ships and runs: dist/hook.mjs (the command hooks) and the TypeScript the mods
// layer loads directly (hooks/, mods/, cli/). None of it may import a network module or open a
// connection itself. Two exceptions are allowed by design, and neither is a network call made by
// this code:
//   1. FlowKy Pro's verifier runs the project's own check commands (npm, tsc, cargo, go, ...) after
//      the user consented to each one. Those programs may download on their own (an npm script, a
//      Cargo build script, a Go toolchain): the Pro README says so. They are child processes, so
//      this scan cannot see into them, and it does not try to.
//   2. FlowKy Pro's mods layer asks Claude Code's own model for the Auto-Skill distillation
//      (`$.model.complete`). That goes through Claude Code's connection to the user's model
//      provider, never to FlowKy. The test below allows it in hooks/register.tsx only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const NETWORK_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'http2', 'undici']
const IMPORT = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"](?:node:)?(${NETWORK_MODULES.join('|')})(?:/[^'"]*)?['"]`, 'g')
const CALLS = [/\bfetch\s*\(/g, /\bWebSocket\b/g, /\bXMLHttpRequest\b/g, /\bEventSource\b/g]

function shipped() {
  const files = []
  const walk = rel => {
    const dir = join(ROOT, rel)
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) files.push(r)
    }
  }
  for (const d of ['dist', 'hooks', 'mods', 'cli']) walk(d)
  return files
}

test('the shipped code imports no network module and opens no connection of its own', () => {
  const files = shipped()
  assert.ok(files.includes('dist/hook.mjs'), 'dist/hook.mjs is missing: run npm run build')
  assert.ok(files.some(f => f.startsWith('mods/')), 'no source found')
  const hits = []
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8')
    for (const m of text.matchAll(IMPORT)) hits.push(`${f}: imports ${m[0]}`)
    for (const re of CALLS) for (const m of text.matchAll(re)) hits.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(hits, [])
})

test('the scan catches what it is meant to catch', () => {
  for (const bad of ["import http from 'node:http'", 'import { request } from "https"', "const n = require('node:net')", "await import('undici')", "import tls from 'tls'"]) {
    assert.ok([...bad.matchAll(IMPORT)].length === 1, bad)
  }
  assert.ok(CALLS.some(re => [...'await fetch(url)'.matchAll(re)].length > 0))
  assert.ok(CALLS.some(re => [...'new WebSocket(u)'.matchAll(re)].length > 0))
  assert.equal([..."import { spawn } from 'node:child_process'".matchAll(IMPORT)].length, 0)
})

test('the only model call is the documented one: $.model.complete in hooks/register.tsx (FlowKy Pro), through Claude Code', () => {
  const callers = shipped().filter(f => f !== 'dist/hook.mjs' && /\$\.model\.complete\s*\(/.test(readFileSync(join(ROOT, f), 'utf8')))
  for (const f of callers) assert.equal(f, 'hooks/register.tsx', `${f} calls the model`)
  // The command hooks (dist) never call a model at all.
  assert.doesNotMatch(readFileSync(join(ROOT, 'dist', 'hook.mjs'), 'utf8'), /\.model\.complete\s*\(/)
})
