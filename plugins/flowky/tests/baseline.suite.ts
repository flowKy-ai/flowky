// Baseline layer on its own: each command hook is fed the JSON input the hooks
// documentation describes, and its JSON output is checked. No mods involved.
// Shared core suite: FlowKy and FlowKy Pro both run it against their own
// dispatcher (hooks/baseline.ts) and identity (hooks/identity.ts).

import { expect, test } from 'claude-code/testing'

import { dispatch } from '../hooks/baseline'
import { HANDOFF_COMMAND } from '../hooks/identity'
import { expandBraces, matchGlob } from '../mods/glob'
import { isIgnored, parseGitignore } from '../mods/gitignore'
import { analyze, fingerprint, scanTree } from '../mods/project-map'
import { contextTokens, nextHint, parseUsageRows } from '../mods/context-meter'
import { memoryIo } from './memory-io'

const ROOT = '/work/app'

function project(): Record<string, string> {
  return {
    [`${ROOT}/.gitignore`]: 'node_modules\ndist/\n*.log\n!keep.log\n',
    [`${ROOT}/package.json`]: JSON.stringify({
      main: 'dist/index.js',
      scripts: { build: 'vite build', test: 'vitest run', typecheck: 'tsc --noEmit' },
      dependencies: { three: '^0.170.0', react: '^18.3.0', '@react-three/fiber': '^8.17.0' },
      devDependencies: { typescript: '^5.6.0', vite: '^5.4.0', vitest: '^2.1.0' },
    }),
    [`${ROOT}/package-lock.json`]: 'x'.repeat(300_000),
    [`${ROOT}/tsconfig.json`]: '{}',
    [`${ROOT}/src/main.tsx`]: 'export {}',
    [`${ROOT}/src/scene/World.tsx`]: 'export {}',
    [`${ROOT}/src/shaders/water.frag`]: 'void main(){}',
    [`${ROOT}/src/components/Button.tsx`]: 'export {}',
    [`${ROOT}/tests/world.test.ts`]: 'test',
    [`${ROOT}/public/models/ship.glb`]: 'binary',
    [`${ROOT}/dist/index.js`]: 'ignored',
    [`${ROOT}/node_modules/three/index.js`]: 'skipped',
    [`${ROOT}/debug.log`]: 'ignored',
    [`${ROOT}/keep.log`]: 'kept',
  }
}

test('globs: **, *, ?, classes and braces', () => {
  expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true)
  expect(matchGlob('src/**/*.ts', 'src/c.ts')).toBe(true)
  expect(matchGlob('src/*.ts', 'src/a/c.ts')).toBe(false)
  expect(matchGlob('**/*.{ts,tsx}', 'deep/x.tsx')).toBe(true)
  expect(matchGlob('file?.[ch]', 'file1.c')).toBe(true)
  expect(expandBraces('a.{b,{c,d}}')).toEqual(['a.b', 'a.c', 'a.d'])
})

test('.gitignore: last match wins, negation, directory-only rules, nested bases', () => {
  const rules = [...parseGitignore('*.log\n!keep.log\nbuild/\n/root-only.txt'), ...parseGitignore('secret.txt', 'pkg')]
  expect(isIgnored(rules, 'a/debug.log', false)).toBe(true)
  expect(isIgnored(rules, 'keep.log', false)).toBe(false)
  expect(isIgnored(rules, 'x/build', true)).toBe(true)
  expect(isIgnored(rules, 'x/build', false)).toBe(false)
  expect(isIgnored(rules, 'root-only.txt', false)).toBe(true)
  expect(isIgnored(rules, 'sub/root-only.txt', false)).toBe(false)
  expect(isIgnored(rules, 'pkg/secret.txt', false)).toBe(true)
  expect(isIgnored(rules, 'secret.txt', false)).toBe(false)
})

test('the scan respects .gitignore and finds stack, commands, 3D modules and heavy files', async () => {
  const io = memoryIo(project())
  const scan = await scanTree(io, ROOT, 1500, 1000)
  const paths = scan.files.map(f => f.path)
  expect(paths).toContain('keep.log')
  expect(paths.some(p => p.startsWith('dist/') || p.startsWith('node_modules/') || p === 'debug.log')).toBe(false)
  const facts = analyze(scan)
  expect(facts.commands).toEqual({ build: 'npm run build', test: 'npm test', typecheck: 'npm run typecheck' })
  expect(facts.is3D).toBe(true)
  expect(facts.visual.join(' | ')).toContain('3D: three.js')
  expect(facts.visual.join(' | ')).toContain('shaders: 1 file(s)')
  expect(facts.visual.join(' | ')).toContain('3D assets: 1 file(s) (glb)')
  expect(facts.heavy[0]).toContain('package-lock.json (lockfile')
  expect(facts.entryPoints).toContain('src/main.tsx')
})

test('the scan stops at its time budget and says so', async () => {
  const io = memoryIo(project(), { tick: 1000 })
  const scan = await scanTree(io, ROOT, 1500, 1000)
  expect(scan.partial).toBe(true)
  expect(scan.partialReason).toContain('time budget')
})

test('SessionStart writes a short, byte-stable map and adds it to the context; a second start rewrites nothing', async () => {
  const io = memoryIo(project())
  const input = { session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: ROOT, hook_event_name: 'SessionStart', source: 'startup' }
  const first = await dispatch(io, 'SessionStart', input, 'test')
  const map = io.files[`${ROOT}/.flowky/cache/project-map.md`]!
  expect(map.split('\n').length).toBeLessThanOrEqual(32)
  expect(map).not.toMatch(/\d{4}-\d{2}-\d{2}|\d+ ms/)
  const out = first.output as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(out.hookSpecificOutput.additionalContext).toContain(map)
  io.clock.now += 3_600_000
  io.files[`${ROOT}/src/main.tsx`] = 'export const changed = 1'
  await dispatch(io, 'SessionStart', input, 'test')
  expect(io.files[`${ROOT}/.flowky/cache/project-map.md`]).toBe(map)
  const status = JSON.parse(io.files[`${ROOT}/.flowky/cache/status.json`]!) as { map: { status: string } }
  expect(status.map.status).toBe('unchanged')
  io.files[`${ROOT}/src/new-file.ts`] = 'export {}'
  await dispatch(io, 'SessionStart', input, 'test')
  expect(io.files[`${ROOT}/.flowky/cache/project-map.md`]).not.toBe(map)
})

test('the map can be switched off', async () => {
  const files = { ...project(), [`${ROOT}/.flowky/config.json`]: JSON.stringify({ map: { enabled: false } }) }
  const io = memoryIo(files)
  const r = await dispatch(io, 'SessionStart', { cwd: ROOT, session_id: 's' }, 'test')
  expect(r.output).toBeUndefined()
  expect(io.files[`${ROOT}/.flowky/cache/project-map.md`]).toBeUndefined()
})

const row = (input: number, read: number, write: number, sidechain = false) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: { id: `m${input}`, model: 'claude-sonnet-5-5', usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  })

test('context is read from the transcript: uncached input + cache reads + cache writes of the last main-thread row', () => {
  const rows = parseUsageRows(['{"cut line', row(100, 20000, 500), row(5, 1, 1, true), 'not json'].join('\n'))
  expect(rows.length).toBe(2)
  expect(contextTokens(rows[0]!.usage)).toBe(20600)
  const a = nextHint({}, 61000, 60000)
  expect(a.show).toBe(true)
  expect(nextHint(a.state, 70000, 60000).show).toBe(false)
  const rearmed = nextHint(a.state, 30000, 60000)
  expect(nextHint(rearmed.state, 62000, 60000).show).toBe(true)
})

test('Stop shows the hint once past the threshold, never blocks, and stays silent below it', async () => {
  const transcript = '/t/s2.jsonl'
  const io = memoryIo({ ...project(), [transcript]: [row(100, 40000, 1000)].join('\n') })
  const input = { session_id: 's2', transcript_path: transcript, cwd: ROOT, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok' }
  expect((await dispatch(io, 'Stop', input, 'test')).output).toBeUndefined()
  io.files[transcript] += '\n' + row(200, 60000, 2000)
  const shown = (await dispatch(io, 'Stop', input, 'test')).output as Record<string, unknown>
  expect(String(shown.systemMessage)).toContain('62k tokens')
  expect(String(shown.systemMessage)).toContain(HANDOFF_COMMAND)
  expect(shown.decision).toBeUndefined()
  expect((await dispatch(io, 'Stop', input, 'test')).output).toBeUndefined()
})

test('a broken config never breaks a hook, and the health check says why', async () => {
  const io = memoryIo({ ...project(), [`${ROOT}/.flowky/config.json`]: '{ broken' })
  await dispatch(io, 'SessionStart', { cwd: ROOT, session_id: 's3' }, 'test')
  expect(io.files[`${ROOT}/.flowky/cache/project-map.md`]).toBeDefined()
  const health = await dispatch(io, 'health', { cwd: ROOT, session_id: 's3' }, 'Node test')
  expect(health.text).toContain('BROKEN, defaults in force')
  expect(health.text).toContain('Project map: ON')
  expect(health.text).toMatch(/mods layer \(status line, no-turn command[^)]*\): not detected/)
  expect(health.text).toContain('this plugin makes no network request of its own')
  expect(health.text).toContain('It is not affiliated with, endorsed or sponsored by Anthropic')
})

test('fingerprint ignores edits inside files but sees added files', async () => {
  const a = await scanTree(memoryIo(project()), ROOT, 1500, 1000)
  const changed = project()
  changed[`${ROOT}/src/main.tsx`] = 'export const x = 2'
  const b = await scanTree(memoryIo(changed), ROOT, 1500, 1000)
  expect(fingerprint(a)).toBe(fingerprint(b))
  changed[`${ROOT}/src/extra.ts`] = ''
  const c = await scanTree(memoryIo(changed), ROOT, 1500, 1000)
  expect(fingerprint(c)).not.toBe(fingerprint(a))
})
