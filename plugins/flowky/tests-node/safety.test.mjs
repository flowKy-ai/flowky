// The fixes of the independent safety review of 0.4.0 (F1 to F11), checked with real processes,
// real git and real links. Shared core test: it runs in FlowKy and in the FlowKy Pro build.
//
// Time: a hook here is given up to 2 minutes, so a busy machine never kills one (that is what made
// a run fail with no index written). Where a test bounds the time, the bound is Claude Code's own
// 15 s hook timeout, the contract that matters, and the fixed code is 10 to 100 times faster than it.
//
// File symbolic links need a privilege on Windows: those cases run where links can be created and
// say "skipped" with the reason elsewhere; the junction cases (folder links) run everywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { tempDir } from './tmp.mjs'

const PLUGIN = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const HOOK = join(PLUGIN, 'dist', 'hook.mjs')
const core = JSON.parse(readFileSync(join(PLUGIN, 'core.json'), 'utf8'))
const posix = p => p.replace(/\\/g, '/')

const HOOK_TIMEOUT_MS = 15000
function hook(arg, input, dir, env = {}, timeout = 120000) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [HOOK, arg], { input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } })
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : {}, raw: r.stdout, ms: Date.now() - t0, err: r.stderr }
}
const cli = (arg, dir, env = {}) => spawnSync(process.execPath, [HOOK, arg], { cwd: dir, input: '', encoding: 'utf8', timeout: 30000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } })

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function repo() {
  const dir = tempDir('flowky-safety-')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alphaHelper() {}\n')
  git(dir, ['init', '-q'])
  for (const [k, v] of [['user.email', 'test@example.invalid'], ['user.name', 'test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, ['config', k, v])
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'one'])
  return dir
}

function canSymlinkFiles() {
  const d = tempDir('flowky-linkprobe-')
  writeFileSync(join(d, 't'), 'x')
  try {
    symlinkSync(join(d, 't'), join(d, 'l'), 'file')
    return true
  } catch (err) {
    return `file symbolic links cannot be created here (${err.code})`
  }
}

// ---- F1: one shared reader for every read ----

test('F1: every read in the core goes through the shared reader (no direct readText, readRange, readFile or fs)', () => {
  const drivers = new Set(['cli/node-io.ts', 'hooks/mod-io.ts', 'mods/io.ts'])
  const bad = []
  for (const f of core.files.filter(f => /\.(ts|tsx)$/.test(f) && !f.startsWith('tests'))) {
    if (drivers.has(f)) continue
    const text = readFileSync(join(PLUGIN, f), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      if (/\.(readText|readRange|readFile)\s*\(/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      if (/from\s+['"](node:)?fs(\/promises)?['"]/.test(line)) bad.push(`${f}:${i + 1}: imports fs`)
    })
  }
  assert.deepEqual(bad, [])
  // The scan itself sees a bypass.
  assert.ok(/\.(readText|readRange|readFile)\s*\(/.test('const t = await io.readText(p)'))
})

test('F1: a config, a state file and a .gitignore linked to an endless or huge file never make a hook hang', { skip: (() => { const c = canSymlinkFiles(); return c === true ? false : `skipped: ${c}` })() }, () => {
  const dir = repo()
  const outside = tempDir('flowky-outside-')
  const huge = join(outside, 'huge.json')
  writeFileSync(huge, '{"map":{"enabled":false}}' + ' '.repeat(4 * 1024 * 1024))
  const endless = process.platform === 'win32' ? huge : '/dev/zero'
  mkdirSync(join(dir, '.flowky', 'cache'), { recursive: true })
  symlinkSync(endless, join(dir, '.flowky', 'config.json'), 'file')
  symlinkSync(endless, join(dir, '.flowky', 'cache', '.gitignore'), 'file')
  symlinkSync(endless, join(dir, '.flowky', 'cache', 'status.json'), 'file')
  for (const [ev, input] of [['SessionStart', { session_id: 's', cwd: dir, source: 'startup' }], ['Stop', { session_id: 's', cwd: dir }], ['PostToolUse', { session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm install x' }, tool_response: {} }]]) {
    const r = hook(ev, input, dir)
    assert.equal(r.code, 0, `${ev}: ${r.err}`)
    assert.ok(r.ms < HOOK_TIMEOUT_MS, `${ev} took ${r.ms} ms: Claude Code would have killed it`)
  }
  // The linked config was not read: the map is still on.
  assert.match(hook('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, dir).raw, /Project map/)
})

test('F1 and F7 (junctions): a config read through a linked folder is refused; a config over the cap is refused', () => {
  const dir = repo()
  const outside = tempDir('flowky-outside-')
  writeFileSync(join(outside, 'config.json'), JSON.stringify({ map: { enabled: false } }))
  symlinkSync(outside, join(dir, '.flowky'), 'junction')
  const r = hook('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, dir)
  assert.equal(r.code, 0)
  assert.match(r.raw, /Project map/, 'the config behind the junction was read')
  assert.deepEqual(readdirSync(outside), ['config.json'])
  const big = repo()
  mkdirSync(join(big, '.flowky'))
  writeFileSync(join(big, '.flowky', 'config.json'), JSON.stringify({ map: { enabled: false } }) + ' '.repeat(2 * 1024 * 1024))
  const b = hook('SessionStart', { session_id: 's', cwd: big, source: 'startup' }, big)
  assert.match(b.raw, /Project map/, 'a 2 MB config (the cap is 256 KB) was read')
})

test('F7 (junction): a reported definition behind a linked folder is never read, even when the index names it', () => {
  const dir = repo()
  const outside = tempDir('flowky-outside-')
  writeFileSync(join(outside, 'secret.ts'), 'export function leakyHelperName() { /* OUTSIDE-TEXT */ }\n')
  symlinkSync(outside, join(dir, 'vendor2'), 'junction')
  hook('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, dir)
  appendFileSync(join(dir, '.flowky', 'cache', 'index', 'symbols.tsv'), 'leakyHelperName\tfunction\tvendor2/secret.ts\t1\t1\t0123456789abcdef\n')
  const r = hook('PreToolUse', { session_id: 's', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'src', 'n.ts'), content: 'export function leakyHelperName() {}\n' } }, dir)
  assert.equal(r.raw, '')
  assert.doesNotMatch(r.raw, /OUTSIDE-TEXT/)
})

// ---- F2 and F5: one session-start deadline, linear patterns ----

test("F2: the reviewer's tree (40 files of 1 MB: a normal head, then hostile lines) starts within the deadline", () => {
  const dir = tempDir('flowky-perf-')
  mkdirSync(join(dir, 'src'))
  const head = 'export const x = 1\n'.repeat(3500)
  // 1,998 characters: under the 2,000 the old code still matched (the reviewer's input).
  const hostile = ('function' + ' '.repeat(1990) + '\n').repeat(Math.floor((1024 * 1024 - head.length - 1024) / 1999))
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'src', `f${i}.ts`), head + hostile)
  const r = hook('SessionStart', { session_id: 'p', cwd: dir, source: 'startup' }, dir)
  assert.equal(r.code, 0)
  assert.match(r.raw, /Project map/)
  // The 0.4.0 build took 98.7 s here; the fixed one about 1 s (4 s under a double test load).
  assert.ok(r.ms < HOOK_TIMEOUT_MS, `SessionStart took ${r.ms} ms: Claude Code would have killed it`)
  const meta = JSON.parse(readFileSync(join(dir, '.flowky', 'cache', 'index', 'meta.json'), 'utf8'))
  console.log(`reviewer's kind of tree: SessionStart ${r.ms} ms; index ${meta.indexedFiles}/${meta.fileCount} files in ${meta.elapsedMs} ms, complete: ${meta.complete}`)
})

test("F5: the repository's config cannot push session start past its deadline", () => {
  const dir = repo()
  mkdirSync(join(dir, '.flowky'))
  writeFileSync(join(dir, '.flowky', 'config.json'), JSON.stringify({ map: { timeBudgetMs: 10000, maxFiles: 500000 } }))
  for (let d = 0; d < 30; d++) {
    mkdirSync(join(dir, `d${d}`))
    for (let f = 0; f < 200; f++) writeFileSync(join(dir, `d${d}`, `f${f}.txt`), 'x')
  }
  const r = hook('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, dir)
  assert.equal(r.code, 0)
  assert.ok(r.ms < HOOK_TIMEOUT_MS, `${r.ms} ms`)
})

// ---- F3 and F8: the shared git runner ----

test('F3/F8: a repository git configuration and environment cannot make the plugin run anything', () => {
  const dir = repo()
  const scratch = tempDir('flowky-marker-')
  const marker = join(scratch, 'marker.txt')
  const markJs = join(scratch, 'mark.js')
  writeFileSync(markJs, "require('fs').appendFileSync(process.argv[2], process.argv[3] + '\\n')\n")
  const node = posix(process.execPath)
  const cmd = name => `"${node}" "${posix(markJs)}" "${posix(marker)}" ${name}`
  const hooksDir = join(dir, '.git', 'evil-hooks')
  mkdirSync(hooksDir)
  for (const h of ['post-checkout', 'post-index-change', 'reference-transaction', 'pre-commit', 'post-merge', 'fsmonitor-watchman']) writeFileSync(join(hooksDir, h), `#!/bin/sh\n${cmd(`hook-${h}`)}\n`, { mode: 0o755 })
  writeFileSync(join(dir, '.gitattributes'), '* diff=evil filter=evil\n')
  const config = {
    'core.fsmonitor': cmd('fsmonitor'),
    'core.pager': cmd('pager'),
    'pager.ls-files': cmd('pager-ls-files'),
    'core.hooksPath': posix(hooksDir),
    'diff.external': cmd('diff-external'),
    'diff.evil.textconv': cmd('textconv'),
    'filter.evil.clean': cmd('filter-clean'),
    'filter.evil.smudge': cmd('filter-smudge'),
    'credential.helper': `!${cmd('credential')}`,
    'core.sshCommand': cmd('ssh'),
    'core.askPass': cmd('askpass'),
    'alias.ls-files': `!${cmd('alias')}`,
    'remote.origin.url': `ext::${cmd('ext-transport')}`,
    'remote.origin.promisor': 'true',
    'remote.origin.partialclonefilter': 'blob:none',
    'protocol.ext.allow': 'always',
  }
  for (const [k, v] of Object.entries(config)) git(dir, ['config', k, v])
  git(dir, ['config', 'extensions.partialClone', 'origin'])
  git(dir, ['config', 'core.repositoryformatversion', '1'])
  // Positive control: plain git in this folder does run the repository's commands.
  spawnSync('git', ['diff', 'HEAD~0', '--', '.'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_PAGER: '' } })
  spawnSync('git', ['status'], { cwd: dir, encoding: 'utf8' })
  assert.ok(existsSync(marker), 'the setup does not make plain git run anything: the test would prove nothing')
  rmSync(marker)
  // The extension's index at a commit this clone does not have: rev-list and diff would want a lazy fetch.
  mkdirSync(join(dir, '.flowky', 'index'), { recursive: true })
  writeFileSync(join(dir, '.flowky', 'index', 'meta.json'), JSON.stringify({ commit: 'deadbeef'.repeat(5) }))
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1\n')
  // Variables a repository's Claude Code settings could set.
  const trace = join(scratch, 'git-trace.txt')
  const env = { GIT_TRACE: posix(trace), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: cmd('env-config'), GIT_EXTERNAL_DIFF: cmd('env-diff'), GIT_PAGER: cmd('env-pager'), GIT_SSH_COMMAND: cmd('env-ssh') }
  hook('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, dir, env)
  hook('UserPromptSubmit', { session_id: 's', cwd: dir, prompt: 'hi' }, dir, env)
  const health = cli('health', dir, env)
  assert.equal(health.status, 0)
  const ran = existsSync(marker) ? readFileSync(marker, 'utf8') : ''
  assert.equal(ran, '', `the repository made git run: ${ran}`)
  assert.ok(!existsSync(trace), 'an inherited GIT_* variable reached git (it wrote a trace file)')
})

test("F3: git is never taken from inside the project, even when the project's PATH puts it first", () => {
  const dir = repo()
  const first = git(dir, ['rev-parse', '--short', 'HEAD'])
  mkdirSync(join(dir, '.flowky', 'index'), { recursive: true })
  writeFileSync(join(dir, '.flowky', 'index', 'meta.json'), JSON.stringify({ commit: first }))
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git(dir, ['add', 'b.txt'])
  git(dir, ['commit', '-q', '-m', 'two'])
  const bin = join(dir, 'tools', 'bin')
  mkdirSync(bin, { recursive: true })
  // A fake git inside the project: a small program that is not git, so HEAD could not be read through it.
  if (process.platform === 'win32') copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), join(bin, 'git.exe'))
  else writeFileSync(join(bin, 'git'), '#!/bin/sh\necho not-git\nexit 1\n', { mode: 0o755 })
  const r = hook('SessionStart', { session_id: 's', cwd: dir, source: 'startup' }, dir, { PATH: `${bin}${delimiter}${process.env.PATH}` })
  assert.match(r.raw, new RegExp(`generated at ${first}, 1 commit before HEAD`), 'the real git was not used')
})

// ---- F4: the doctor's limits ----

test("F4: the doctor on the reviewer's input (1 MB of rules) ends fast and says when it stopped early", () => {
  const dir = tempDir('flowky-doctor-')
  const block = Array.from({ length: 20000 }, (_, i) => `- use x${i}`).join('\n').slice(0, 255 * 1024)
  writeFileSync(join(dir, 'CLAUDE.md'), block)
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, '.claude', 'rules', `r${i}.md`), block.replace(/use/g, i % 2 ? 'never use' : 'use'))
  for (let i = 0; i < 250; i++) writeFileSync(join(dir, '.claude', 'rules', `small${i}.md`), '- fine\n')
  const t0 = Date.now()
  const r = cli('config-doctor', dir)
  const ms = Date.now() - t0
  assert.equal(r.status, 0)
  // The 0.4.0 doctor took 39.7 s on this input; the bounded one stops at its own 6 s at most.
  assert.ok(ms < HOOK_TIMEOUT_MS, `${ms} ms`)
  assert.match(r.stdout, /PARTIAL: the doctor stopped early/)
  console.log(`doctor on 1 MB of rules and 253 files: ${ms} ms`)
})

// ---- F9: what the shipped code can start or load ----

test('F9: the shared Node driver loads no project module and removes nothing outside its root', () => {
  // FlowKy Pro adds both in its own per-plugin cli/io-extension.ts (project TypeScript after consent;
  // its temporary git index only). Where that file adds nothing (FlowKy), the bundle has neither.
  if (!/createRequire/.test(readFileSync(join(PLUGIN, 'cli', 'io-extension.ts'), 'utf8'))) assert.doesNotMatch(readFileSync(HOOK, 'utf8'), /createRequire|loadProjectModule\s*\(/)
  const driver = readFileSync(join(PLUGIN, 'cli', 'node-io.ts'), 'utf8')
  assert.doesNotMatch(driver, /async remove\(|loadProjectModule\(/)
})

// F11 is proved in memory (tests/guardrails.suite.ts, "F11: a large folder of data files..."): 30,500
// files on a real disk made the test depend on how fast the machine was (test stability).
