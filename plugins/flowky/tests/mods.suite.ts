// Enhanced layer: the mod handlers, driven through the engine's test kit.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/work/app'

function world(on: On, files: Record<string, string>) {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  // The engine hands paths over absolute and in the platform's spelling.
  const at = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.read', (_, e) => (files[at(e.path)] !== undefined ? { value: files[at(e.path)]! } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    files[at(e.path)] = e.text
    return { value: undefined as never }
  })
  on('fs.list', (_, e) => {
    const d = at(e.path)
    const names = new Map<string, boolean>()
    for (const p of Object.keys(files)) if (p.startsWith(d + '/')) names.set(p.slice(d.length + 1).split('/')[0]!, p.slice(d.length + 1).includes('/'))
    return { value: [...names].map(([name, isDir]) => ({ name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : files[`${d}/${name}`]!.length, mtimeMs: 0, isLink: false })) as never }
  })
  on('fs.stat', (_, e) => (files[at(e.path)] !== undefined ? { value: { kind: 'file', size: files[at(e.path)]!.length, mtimeMs: 0, isLink: false } as never } : { deny: 'ENOENT' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'linux' } as never }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.version', () => ({ value: { version: '2.1.327' } as never }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  return clock
}

test('session start registers the no-turn command and marks the mods layer active', async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/src/a.ts`]: 'x' }
  world(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const status = JSON.parse(files[`${ROOT}/.flowky/cache/status.json`]!) as { mods: { sessionId: string } }
  expect(status.mods.sessionId).toBe('sess-1')
  const { text } = await $.command.run({ command: 'flowky', args: 'health' } as never)
  expect(text).toContain('answered by the mods layer')
  expect(text).toContain('mods layer (status line, no-turn command): active in this session')
})

test('session.measure drives the status line and one toast at the threshold', async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/.flowky/config.json`]: JSON.stringify({ context: { thresholdTokens: 50000 } }) }
  world(on, files)
  const statuses: string[] = []
  const toasts: string[] = []
  on('ui.status', (_, e) => {
    statuses.push(String(e.text))
    return { value: undefined as never }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined as never }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const measure = (tokens: number) => $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as never)
  await measure(20000)
  await measure(55000)
  await measure(58000)
  expect(statuses[0]).toBe('FlowKy: context 20k / hint at 50k')
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('/flowky handoff')
})

test('handoff fills the prompt box and never submits unless switched on', async ($, on) => {
  world(on, {})
  const filled: string[] = []
  let submitted = 0
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: 0 } as never
  })
  on('prompt.submit', () => {
    submitted += 1
    return { text: '' } as never
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run({ command: 'flowky', args: 'handoff' } as never)
  expect(text).toContain('press Enter')
  expect(filled[0]).toContain('Files touched')
  expect(submitted).toBe(0)
})

test('review 2 (free): a repository config alone cannot switch on handoff auto-submit; only the user, typing the command, confirms it', async ($, on) => {
  // Old behaviour: "context": { "autoSubmit": true } in the project file made /flowky handoff send a message.
  const clock = world(on, { [`${ROOT}/.flowky/config.json`]: JSON.stringify({ context: { autoSubmit: true } }) })
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) as never }))
  on('store.set', (_, e) => {
    store.set((e as { key: string }).key, (e as { value: unknown }).value)
    return { value: undefined as never }
  })
  let submitted = 0
  on('prompt.fill', (_, e) => ({ isFilled: true, text: e.text, cursor: 0 }) as never)
  on('prompt.submit', () => {
    submitted += 1
    return { text: '' } as never
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const first = await $.command.run({ command: 'flowky', args: 'handoff' } as never)
  expect(first.text).toContain('press Enter')
  expect(submitted).toBe(0)
  // Run by a plugin (or the model), the confirmation is refused.
  const byPlugin = await $.command.run({ command: 'flowky', args: 'handoff auto on' } as never)
  expect(byPlugin.text).toContain('Only you can change this')
  await $.command.run({ command: 'flowky', args: 'handoff' } as never)
  expect(submitted).toBe(0)
  // Typed by the person: kept in the plugin's own store (the user's Claude folder), then it submits.
  const typed = await $.command.run({ command: 'flowky', args: 'handoff auto on', origin: { kind: 'composer' } } as never)
  expect(typed.text).toContain('confirmed by you')
  expect(store.get('handoffAutoSubmit')).toBe(true)
  const sent = await $.command.run({ command: 'flowky', args: 'handoff' } as never)
  expect(sent.text).toContain('submitted')
  await clock.advance(50)
  expect(submitted).toBe(1)
})

test('the guardrails commands answer in the mods layer with no model turn: config-doctor diagnoses, retry resets', async ($, on) => {
  const files: Record<string, string> = {
    [`${ROOT}/CLAUDE.md`]: '# P\n\n- You are a senior engineer.\n',
    [`${ROOT}/.flowky/cache/guard/session-sess-1.json`]: JSON.stringify({ v: 1, updatedAt: 1_800_000_000_000, epoch: 0, saidHeads: [], writes: {}, removed: {}, agents: { main: { '0123456789abcdef': { streak: 3, exit: 1, sig: 's', err: 'e', epoch: 0, network: false, paused: false, at: 1_800_000_000_000 } } } }),
  }
  world(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const before = files[`${ROOT}/CLAUDE.md`]
  const doctor = await $.command.run({ command: 'flowky', args: 'config-doctor' } as never)
  expect(doctor.text).toContain('WARNING persona-block  CLAUDE.md:3')
  expect(doctor.text).toContain('Nothing was changed.')
  expect(files[`${ROOT}/CLAUDE.md`]).toBe(before)
  const retry = await $.command.run({ command: 'flowky', args: 'retry' } as never)
  expect(retry.text).toContain('loop breaker reset for this session (1 failure count cleared)')
  expect(JSON.parse(files[`${ROOT}/.flowky/cache/guard/session-sess-1.json`]!).agents.main).toEqual({})
})
