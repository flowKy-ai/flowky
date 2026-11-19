// FlowKy, ENHANCED layer: loaded only by a Claude Code whose mods API
// is available and allowed. Everything essential already runs in the baseline
// layer (command hooks in hooks.json + skills); this module adds what only a
// mod can do, with the same shared logic:
//   - /flowky [health|map|handoff|config-doctor|retry]: answered at once, with no model turn
//   - a status-line meter of the context, from session.measure
//   - the context hint as a toast as soon as the threshold is crossed
//   - handoff: the summary request placed in the prompt box (or submitted, if
//     context.autoSubmit asks for it AND the user confirmed it with
//     `/flowky handoff auto on`, kept in this plugin's own store in the
//     user's Claude folder: a repository's config alone cannot switch it on)
// It writes a marker so the health check can say which layers are active.

import type { EngineInterface, Register } from 'claude-code'

import { loadConfig } from '../mods/config'
import { HANDOFF_REQUEST, hintText, nextHint } from '../mods/context-meter'
import type { HintState } from '../mods/context-meter'
import type { Io } from '../mods/io'
import { kilo } from '../mods/io'
import { refreshMap } from '../mods/project-map'
import { readState, writeState } from '../mods/state'
import type { LiteStatus } from '../mods/state'
import { VERSION, healthReport } from './health'
import { COMMAND } from './identity'
import { configDoctorCommand, retryCommand } from './guardrails'
import { modIo } from './mod-io'


let root = '.'
let io: Io | undefined
let hint: HintState = {}

async function ioFor($: EngineInterface): Promise<Io> {
  if (io) return io
  const info = await $.session.info().catch(() => undefined)
  const p = info?.platform
  io = modIo($, p === 'windows' ? 'windows' : p === 'macos' ? 'macos' : p === 'linux' || p === 'wsl' ? 'linux' : 'other')
  return io
}

/** The user's own confirmation of context.autoSubmit, in this plugin's store (in the user's Claude folder, outside every project). */
const AUTO_SUBMIT_KEY = 'handoffAutoSubmit'

/** Whether Claude Code stamped this command as the person's own (Enter at the prompt, or the Remote Control bridge). */
function typedByPerson(origin: { kind: string } | undefined): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge'
}

/**
 * Submits the handoff request only when the project config asks for it (context.autoSubmit) AND the
 * user confirmed it with `/flowky handoff auto on`: a repository's .flowky/config.json
 * alone cannot make the plugin send a message (review 2).
 */
async function handoff($: EngineInterface, requested: boolean): Promise<string> {
  const confirmed = (await $.store.get(AUTO_SUBMIT_KEY).catch(() => undefined)) === true
  if (requested && confirmed) {
    // A command hook may not submit (the host refuses: it would wait on the turn the hook holds): just after it.
    $.clock.after(10, () => void $.prompt.submit({ text: HANDOFF_REQUEST }).catch(() => undefined))
    return 'Handoff request submitted (context.autoSubmit is on and confirmed by you).'
  }
  const filled = await $.prompt.fill({ text: HANDOFF_REQUEST, mode: 'replace' }).catch(() => undefined)
  return filled?.isFilled
    ? 'The handoff request is in your prompt box: press Enter to send it, then /compact or /clear.'
    : `Your client has no prompt box this mod can fill. Send this message yourself:\n\n${HANDOFF_REQUEST}`
}

async function setAutoSubmit($: EngineInterface, on: boolean, origin: { kind: string } | undefined): Promise<string> {
  if (!typedByPerson(origin)) return 'Only you can change this, by typing the command yourself.'
  await $.store.set(AUTO_SUBMIT_KEY, on)
  return on
    ? 'Handoff auto-submit confirmed by you (kept in your Claude folder, not in the project). It takes effect while .flowky/config.json also says "context": { "autoSubmit": true }.'
    : 'Handoff auto-submit is off: the request is only placed in your prompt box.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    root = (e.cwd || (await $.session.cwd().catch(() => '.'))).replace(/\\/g, '/')
    const local = await ioFor($)
    await $.command.register({
      name: 'flowky',
      description: 'FlowKy: health (default), map (rescan now), handoff (request a clean summary; handoff auto on|off), config-doctor (check the Claude configuration), retry (reset the loop breaker). No model turn.',
      argumentHint: '[health|map|handoff [auto on|off]|config-doctor|retry]',
      immediate: true,
    })
    const status = await readState<LiteStatus>(local, root, 'status', {})
    status.mods = { at: await $.clock.now(), sessionId: await $.session.id().catch(() => '?'), version: VERSION }
    await writeState(local, root, 'status', status)
    return started
  })

  on('session.measure', async ($, e, next) => {
    const done = await next(e)
    const tokens = e.context.tokens
    if (tokens === undefined) return done
    const local = await ioFor($)
    const { config } = await loadConfig(local, root)
    if (!config.context.enabled) return done
    const threshold = config.context.thresholdTokens
    $.ui.status(`FlowKy: context ${kilo(tokens)} / hint at ${kilo(threshold)}`)
    const r = nextHint(hint, tokens, threshold)
    hint = r.state
    if (r.show) $.ui.toast(`FlowKy: ${hintText(tokens, threshold, `/${COMMAND} handoff`)}`, { timeoutMs: 20_000 })
    return done
  })

  on('command.run', { command: 'flowky' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase().split(/\s+/)[0] ?? ''
    const local = await ioFor($)
    if (verb === 'handoff') {
      const sub = e.args.trim().toLowerCase().split(/\s+/).slice(1).join(' ')
      if (sub === 'auto on' || sub === 'auto off') return { text: await setAutoSubmit($, sub === 'auto on', e.origin), isTextDisplayOnly: true }
      const { config } = await loadConfig(local, root)
      return { text: await handoff($, config.context.autoSubmit), isTextDisplayOnly: true }
    }
    if (verb === 'map') {
      const { config } = await loadConfig(local, root)
      const r = await refreshMap(local, root, { budgetMs: config.map.timeBudgetMs, maxFiles: config.map.maxFiles })
      return { text: `Project map ${r.status}${r.reason ? ` (${r.reason})` : ''}.\n${r.text ?? ''}`, isTextDisplayOnly: true }
    }
    if (verb === 'config-doctor') return { text: await configDoctorCommand(local, root), isTextDisplayOnly: true }
    if (verb === 'retry') {
      const id = await $.session.id().catch(() => undefined)
      return { text: await retryCommand(local, root, typeof id === 'string' ? id : undefined), isTextDisplayOnly: true }
    }
    if (verb !== '' && verb !== 'health') {
      return { text: `Unknown subcommand "${verb}". Use: /${COMMAND} health | map | handoff | config-doctor | retry`, isTextDisplayOnly: true }
    }
    const version = await $.session.version().catch(() => undefined)
    return {
      text: await healthReport(local, root, { layer: 'mods', runtime: `Claude Code ${version?.version ?? '?'} (mods API)` }),
      isTextDisplayOnly: true,
    }
  })
}
