// The skills' commands as Claude Code checks them (behaviour review, findings 1 and 7). A skill
// runs its `!` command only when the command matches its `allowed-tools` Bash pattern. Claude Code
// fills in ${CLAUDE_SESSION_ID} in the command with the real id, so a pattern that names the
// placeholder never matches: /flowky:retry was refused ("Shell command permission check failed").
// Shared core test: it runs in FlowKy and in the FlowKy Pro build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SKILLS = join(ROOT, 'skills')
const PLUGIN_ROOT = 'C:/Users/dev/.claude/plugins/cache/flowky/0.4.0'
const SESSION = '1eb86f84-2c1d-4b8e-9a51-0f3e5c7d9a10'

/** Claude Code's Bash rule: the command, where `*` stands for any text (a trailing " *" also allows no argument). */
function allows(pattern, command) {
  const p = pattern.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT)
  if (p.endsWith(' *') && command === p.slice(0, -2)) return true
  const re = new RegExp('^' + p.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(command)
}

/** The Bash(...) patterns of an allowed-tools line. */
function patterns(line) {
  return [...String(line ?? '').matchAll(/Bash\(((?:[^()"]|"[^"]*")*)\)/g)].map(m => m[1])
}

function skillsWithCommands() {
  const out = []
  for (const name of readdirSync(SKILLS)) {
    const f = join(SKILLS, name, 'SKILL.md')
    if (!existsSync(f)) continue
    const text = readFileSync(f, 'utf8')
    const cmd = /!`([^`]+)`/.exec(text)?.[1]
    if (!cmd) continue
    const allowed = patterns(/^allowed-tools:(.*)$/m.exec(text)?.[1])
    out.push({ name, text, cmd, allowed })
  }
  return out
}

test('every skill command is allowed by its own allowed-tools line once Claude Code fills in the session id', () => {
  const skills = skillsWithCommands()
  assert.ok(skills.some(s => s.name === 'retry'))
  for (const s of skills) {
    const real = s.cmd.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT).replace(/\$\{CLAUDE_SESSION_ID\}/g, SESSION)
    assert.ok(s.allowed.length, `${s.name}: no allowed-tools Bash pattern`)
    assert.ok(s.allowed.some(p => allows(p, real)), `${s.name}: "${real}" is not allowed by ${s.allowed.map(p => `Bash(${p})`).join(', ')}`)
  }
  // The check bites on the line the review found.
  assert.equal(allows('node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" retry --session ${CLAUDE_SESSION_ID}', `node "${PLUGIN_ROOT}/dist/hook.mjs" retry --session ${SESSION}`), false)
})

test('the health skill passes the session id and tells the model to add nothing (no advice, no README read)', () => {
  const health = skillsWithCommands().find(s => s.name === 'health')
  assert.match(health.cmd, /health --session \$\{CLAUDE_SESSION_ID\}/)
  assert.match(health.text, /Add nothing/)
  assert.doesNotMatch(health.text, /README/)
})
