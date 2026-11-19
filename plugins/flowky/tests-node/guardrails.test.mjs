// The guardrails as Claude Code runs them: a real Node process of dist/hook.mjs per event, with
// stdin JSON shaped exactly as the hooks reference documents it, on a temporary project with a
// real git repository. On Windows the paths are sent with backslashes, as Claude Code sends them.
// (Shared core test: it runs in FlowKy and in the FlowKy Pro build.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tempDir } from './tmp.mjs'

const PLUGIN = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const HOOK = join(PLUGIN, 'dist', 'hook.mjs')
const hooksJson = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'))
/** The argument the plugin's hooks.json gives the hook for this event and tool (FlowKy Pro uses its own name for one). */
function argFor(event, tool) {
  for (const group of hooksJson.hooks[event] ?? []) {
    const m = group.matcher
    const matches = !m || m === '*' || m.split('|').includes(tool)
    if (!matches) continue
    for (const h of group.hooks) {
      if (h.async || h.asyncRewake) continue
      const arg = /dist\/hook\.mjs\\?"\s+(\w+)/.exec(h.command)?.[1]
      if (arg) return arg
    }
  }
  return undefined
}

function hook(event, input, dir, env = {}) {
  const arg = argFor(event, input.tool_name)
  assert.ok(arg, `hooks.json declares no synchronous ${event} hook for ${input.tool_name ?? 'any tool'}`)
  const r = spawnSync(process.execPath, [HOOK, arg], { input: JSON.stringify({ hook_event_name: event, transcript_path: join(dir, 't.jsonl'), permission_mode: 'default', ...input }), encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout ? JSON.parse(r.stdout) : {}
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function project({ repo = true } = {}) {
  const dir = tempDir('flowky-guard-')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  mkdirSync(join(dir, 'src', 'app'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  writeFileSync(join(dir, 'src', 'lib', 'safe-redirect.ts'), 'import { x } from "./x"\n\nexport function safeRedirectPath(target: string): string {\n  return target\n}\n')
  writeFileSync(join(dir, 'src', 'app', 'main.ts'), 'export {}\n')
  if (repo) {
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 'test@example.invalid'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['config', 'commit.gpgsign', 'false'])
    git(dir, ['config', 'core.autocrlf', 'false'])
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', 'one'])
  }
  return dir
}

const start = (dir, session = 's1', source = 'startup') => hook('SessionStart', { session_id: session, cwd: dir, source }, dir)
const native = (dir, rel) => join(dir, ...rel.split('/'))
const DUP = 'export function safeRedirectPath(u: string) {\n  return u\n}\n'

test('duplicate guard: paused once with file and line, the identical write then passes (native path separators)', () => {
  const dir = project()
  start(dir)
  assert.ok(existsSync(join(dir, '.flowky', 'cache', 'index', 'symbols.tsv')))
  const input = { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: native(dir, 'src/app/login.ts'), content: DUP }, tool_use_id: 'toolu_1' }
  if (sep === '\\') assert.match(input.tool_input.file_path, /\\src\\app\\login\.ts$/)
  const first = hook('PreToolUse', input, dir)
  assert.equal(first.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /`safeRedirectPath` \(exported function\) is already defined at src\/lib\/safe-redirect\.ts:3/)
  assert.match(first.systemMessage, /pointed the agent to an existing `safeRedirectPath`/)
  assert.deepEqual(hook('PreToolUse', input, dir), {})
  // Edit and MultiEdit (older versions) too.
  const edit = hook('PreToolUse', { session_id: 's1', cwd: dir, tool_name: 'Edit', tool_input: { file_path: native(dir, 'src/app/main.ts'), old_string: 'export {}', new_string: 'export function safeRedirectPath() {}' } }, dir)
  assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny')
  // Another session: the pause is once per file and name per session, and main.ts was paused just above.
  const multi = hook('PreToolUse', { session_id: 's2', cwd: dir, tool_name: 'MultiEdit', tool_input: { file_path: native(dir, 'src/app/main.ts'), edits: [{ old_string: 'export {}', new_string: '// x\nexport function safeRedirectPath() {}' }] } }, dir)
  assert.equal(multi.hookSpecificOutput.permissionDecision, 'deny')
})

test('duplicate guard: a file written this session is indexed at once by PostToolUse; note mode never pauses', () => {
  const dir = project()
  start(dir)
  writeFileSync(join(dir, 'src', 'app', 'fresh.ts'), 'export function brandNewHelper() {}\n')
  assert.deepEqual(hook('PostToolUse', { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: native(dir, 'src/app/fresh.ts'), content: '' }, tool_response: { filePath: native(dir, 'src/app/fresh.ts'), type: 'create' } }, dir), {})
  const r = hook('PreToolUse', { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: native(dir, 'src/b.ts'), content: 'export function brandNewHelper() {}\n' } }, dir)
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /src\/app\/fresh\.ts:1/)
  mkdirSync(join(dir, '.flowky'), { recursive: true })
  writeFileSync(join(dir, '.flowky', 'config.json'), JSON.stringify({ guardrails: { duplicateGuard: 'note' } }))
  const note = hook('PreToolUse', { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: native(dir, 'src/c.ts'), content: DUP } }, dir)
  assert.equal(note.hookSpecificOutput.permissionDecision, undefined)
  assert.match(note.hookSpecificOutput.additionalContext, /The write went through/)
})

const FAIL = 'Exit code 1\nsrc/api/user.ts:42:7 - error TS2345: Argument of type \'string\' is not assignable.\nFound 1 error.'

for (const tool of ['Bash', 'PowerShell']) {
  test(`loop breaker (${tool}): the third identical failure reaches the model; the next run is paused once; then it runs`, () => {
    const dir = project()
    start(dir)
    const pre = { session_id: 's1', cwd: dir, tool_name: tool, tool_input: { command: 'npm test', description: 'Run tests', run_in_background: false } }
    const fail = { ...pre, error: FAIL, is_interrupt: false, duration_ms: 120 }
    for (let i = 1; i <= 3; i++) {
      assert.deepEqual(hook('PreToolUse', pre, dir), {})
      const out = hook('PostToolUseFailure', fail, dir)
      if (i < 3) assert.deepEqual(out, {})
      else {
        assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure')
        assert.match(out.hookSpecificOutput.additionalContext, /has failed 3 times in a row with the same error \(exit code 1\)/)
        assert.match(out.hookSpecificOutput.additionalContext, /error TS2345: Argument of type 'string' is not assignable/)
      }
    }
    const fourth = hook('PreToolUse', pre, dir)
    assert.equal(fourth.hookSpecificOutput.permissionDecision, 'deny')
    assert.deepEqual(hook('PreToolUse', pre, dir), {})
  })
}

test('loop breaker: "flowky retry" as a whole message and the retry command reset the count; a success resets it', () => {
  const dir = project()
  start(dir)
  const pre = { session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } }
  for (let i = 0; i < 3; i++) hook('PostToolUseFailure', { ...pre, error: FAIL, is_interrupt: false }, dir)
  const said = hook('UserPromptSubmit', { session_id: 's1', cwd: dir, prompt: 'flowky retry' }, dir)
  assert.equal(said.decision, 'block')
  assert.match(said.reason, /loop breaker reset for this session \(1 failure count cleared\)/)
  assert.deepEqual(hook('PreToolUse', pre, dir), {})
  for (let i = 0; i < 3; i++) hook('PostToolUseFailure', { ...pre, error: FAIL, is_interrupt: false }, dir)
  const cli = spawnSync(process.execPath, [HOOK, 'retry', '--session', 's1'], { cwd: dir, input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } })
  assert.match(cli.stdout, /loop breaker reset for this session \(1 failure count cleared\)/)
  assert.deepEqual(hook('PreToolUse', pre, dir), {})
  hook('PostToolUseFailure', { ...pre, error: FAIL, is_interrupt: false }, dir)
  hook('PostToolUseFailure', { ...pre, error: FAIL, is_interrupt: false }, dir)
  hook('PostToolUse', { ...pre, tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false } }, dir)
  assert.deepEqual(hook('PostToolUseFailure', { ...pre, error: FAIL, is_interrupt: false }, dir), {})
})

test('loop breaker: edit, run, same failure trips at the third failure; a sub-agent is counted apart; a printed exit status counts', () => {
  const dir = project()
  start(dir)
  const pre = { session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } }
  const edit = { session_id: 's1', cwd: dir, tool_name: 'Edit', tool_input: { file_path: native(dir, 'src/app/main.ts'), old_string: 'a', new_string: 'b' }, tool_response: {} }
  hook('PostToolUseFailure', { ...pre, error: FAIL }, dir)
  hook('PostToolUse', edit, dir)
  hook('PostToolUseFailure', { ...pre, error: FAIL }, dir)
  hook('PostToolUse', edit, dir)
  // A sub-agent's failures do not add to the main thread's count.
  hook('PostToolUseFailure', { ...pre, error: FAIL, agent_id: 'sub-1', agent_type: 'Explore' }, dir)
  hook('PostToolUseFailure', { ...pre, error: FAIL, agent_id: 'sub-1', agent_type: 'Explore' }, dir)
  assert.match(hook('PostToolUseFailure', { ...pre, error: FAIL }, dir).hookSpecificOutput.additionalContext, /3 times/)
  assert.match(hook('PostToolUseFailure', { ...pre, error: FAIL, agent_id: 'sub-1', agent_type: 'Explore' }, dir).hookSpecificOutput.additionalContext, /3 times/)
  // The model's own spelling in the behaviour review: the shell reports success, the line says EXIT:1.
  const hidden = { session_id: 's2', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test > /dev/null 2>&1; echo "EXIT:$?"' }, tool_response: { stdout: 'EXIT:1', stderr: '\nShell cwd was reset to ' + dir, interrupted: false, isImage: false, noOutputExpected: false } }
  assert.deepEqual(hook('PostToolUse', hidden, dir), {})
  assert.deepEqual(hook('PostToolUse', hidden, dir), {})
  assert.match(hook('PostToolUse', hidden, dir).hookSpecificOutput.additionalContext, /has failed 3 times in a row with the same error \(exit code 1\)/)
})

test('staleness line: the extension index generated before HEAD gives one line; a hostile commit is never handed to git', () => {
  const dir = project()
  const first = git(dir, ['rev-parse', '--short', 'HEAD'])
  mkdirSync(join(dir, '.flowky', 'index'), { recursive: true })
  writeFileSync(join(dir, '.flowky', 'index', 'meta.json'), JSON.stringify({ commit: first }))
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'a.md'), 'x\n')
  git(dir, ['add', 'docs'])
  git(dir, ['commit', '-q', '-m', 'two'])
  const ctx = start(dir).hookSpecificOutput.additionalContext
  assert.match(ctx, new RegExp(`generated at ${first}, 1 commit before HEAD \\([0-9a-f]{7}\\)\\. Changed since then: docs/\\.`))
  assert.match(start(dir, 's1', 'compact').hookSpecificOutput.additionalContext, /generated at/)
  for (const commit of ['--output=pwned', `${first}..HEAD`, 'HEAD~1']) {
    writeFileSync(join(dir, '.flowky', 'index', 'meta.json'), JSON.stringify({ commit }))
    assert.doesNotMatch(start(dir).hookSpecificOutput.additionalContext, /VS Code extension/)
    assert.ok(!existsSync(join(dir, 'pwned')))
    assert.deepEqual(readdirSync(dir).filter(n => /pwned|\.\./.test(n)), [])
  }
})

test('staleness line: silent outside a git repository and with no index; HEAD moving mid-session gives one line once', () => {
  const plain = project({ repo: false })
  mkdirSync(join(plain, '.flowky', 'index'), { recursive: true })
  writeFileSync(join(plain, '.flowky', 'index', 'meta.json'), JSON.stringify({ commit: 'abcdef1' }))
  assert.doesNotMatch(start(plain).hookSpecificOutput.additionalContext, /VS Code extension|HEAD/)
  const dir = project()
  assert.doesNotMatch(start(dir).hookSpecificOutput.additionalContext, /VS Code extension/)
  assert.deepEqual(hook('UserPromptSubmit', { session_id: 's1', cwd: dir, prompt: 'hi' }, dir), {})
  writeFileSync(join(dir, 'new.txt'), 'n\n')
  git(dir, ['add', 'new.txt'])
  git(dir, ['commit', '-q', '-m', 'mid'])
  assert.match(hook('UserPromptSubmit', { session_id: 's1', cwd: dir, prompt: 'hi' }, dir).hookSpecificOutput.additionalContext, /HEAD moved during this session/)
  assert.deepEqual(hook('UserPromptSubmit', { session_id: 's1', cwd: dir, prompt: 'hi' }, dir), {})
})

test('config doctor: the command prints a short report with what to change and where, and writes nothing', () => {
  const dir = project({ repo: false })
  writeFileSync(join(dir, 'CLAUDE.md'), '# P\n\n- You are a senior engineer.\n- See src/missing/x.ts first.\n')
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.flowky/hooks/flowky-guard.mjs"' }] }] } }))
  const listing = () => JSON.stringify(readdirSync(dir, { recursive: true }).sort())
  const before = listing()
  const r = spawnSync(process.execPath, [HOOK, 'config-doctor'], { cwd: dir, input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /ERROR second-guard {2}\.claude\/settings\.json/)
  assert.match(r.stdout, /WARNING persona-block {2}CLAUDE\.md:3/)
  assert.match(r.stdout, /WARNING dead-path {2}CLAUDE\.md:4/)
  assert.match(r.stdout, /Change: /)
  assert.equal(listing(), before)
  // The second copy of the guard keeps the plugin's guardrails quiet, and the health check says why.
  start(dir)
  assert.deepEqual(hook('PreToolUse', { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: native(dir, 'src/z.ts'), content: DUP } }, dir), {})
  const health = spawnSync(process.execPath, [HOOK, 'health'], { cwd: dir, input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } })
  assert.match(health.stdout, /duplicate guard: ON, mode pause-once \(QUIET/)
  assert.match(health.stdout, /delete each hook entry whose command contains "flowky-guard\.mjs"/)
})

test('fail open: garbage stdin, a corrupt state file, a hostile index and a linked state folder never block', () => {
  const dir = project()
  start(dir)
  for (const raw of ['{not json', '', '[]', 'null']) {
    const r = spawnSync(process.execPath, [HOOK, 'PreToolUse'], { input: raw, encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
  writeFileSync(join(dir, '.flowky', 'cache', 'guard', 'session-s1.json'), '{"v":1,"updatedAt":"x","agents":{"main":"boom"}}')
  writeFileSync(join(dir, '.flowky', 'cache', 'index', 'symbols.tsv'), '\u0000\u0001'.repeat(1000) + '\nsafeRedirectPath\tfunction\t../outside.ts\t1\t1\t\nsafeRedirectPath\tfunction\tsrc/lib/safe-redirect.ts\t999\t1\t\n')
  const r = hook('PreToolUse', { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: native(dir, 'src/n.ts'), content: DUP } }, dir)
  // The forged line number is replaced by the real one, read from the file.
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /src\/lib\/safe-redirect\.ts:3/)
  assert.doesNotMatch(r.hookSpecificOutput.permissionDecisionReason, /outside|999/)
  // A state folder that became a link during the session (session start removes a linked one): no
  // pause, since it could not be remembered, and nothing is written outside.
  const linked = project()
  const outside = tempDir('flowky-outside-')
  start(linked)
  rmSync(join(linked, '.flowky', 'cache'), { recursive: true, force: true })
  symlinkSync(outside, join(linked, '.flowky', 'cache'), 'junction')
  assert.deepEqual(hook('PreToolUse', { session_id: 's1', cwd: linked, tool_name: 'Write', tool_input: { file_path: native(linked, 'src/n.ts'), content: DUP } }, linked), {})
  assert.deepEqual(readdirSync(outside), [])
})

test('the index: 10,000 files within the session-start budget, then incrementally', () => {
  const dir = project({ repo: false })
  for (let d = 0; d < 100; d++) {
    mkdirSync(join(dir, 'src', `m${d}`), { recursive: true })
    for (let f = 0; f < 100; f++) writeFileSync(join(dir, 'src', `m${d}`, `f${f}.ts`), `export function fn_${d}_${f}() {}\nexport class Klass${d}x${f} {}\n`)
  }
  const t0 = Date.now()
  const out = hook('SessionStart', { session_id: 'big', cwd: dir, source: 'startup' }, dir, {})
  const first = Date.now() - t0
  const meta = JSON.parse(readFileSync(join(dir, '.flowky', 'cache', 'index', 'meta.json'), 'utf8'))
  assert.ok(out.hookSpecificOutput)
  assert.ok(meta.fileCount >= 10000, `files ${meta.fileCount}`)
  const t1 = Date.now()
  start(dir, 'big2')
  const second = Date.now() - t1
  const meta2 = JSON.parse(readFileSync(join(dir, '.flowky', 'cache', 'index', 'meta.json'), 'utf8'))
  // Either it was complete the first time, or the second session continued it.
  assert.ok(meta.complete || meta2.indexedFiles > meta.indexedFiles, JSON.stringify({ meta, meta2 }))
  // The bound is Claude Code's 15 s hook timeout (the contract); the session start's own deadline is 8 s.
  assert.ok(first < 15000 && second < 15000, `first ${first} ms, second ${second} ms`)
  console.log(`index of ${meta.fileCount} files: first session start ${first} ms (complete: ${meta.complete}, ${meta.indexedFiles} parsed), second ${second} ms (${meta2.indexedFiles} files, complete: ${meta2.complete})`)
})

test('hooks.json declares every guardrail event the reference names, with the shell and edit tools matched', () => {
  for (const [event, tools] of [['PreToolUse', ['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell']], ['PostToolUse', ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']], ['PostToolUseFailure', ['Bash', 'PowerShell']], ['UserPromptSubmit', [undefined]], ['SessionStart', [undefined]]]) {
    for (const tool of tools) assert.ok(argFor(event, tool), `${event} ${tool ?? ''}`)
  }
  for (const groups of Object.values(hooksJson.hooks)) for (const g of groups) for (const h of g.hooks) assert.match(h.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/hook\.mjs" \w+$/)
})
