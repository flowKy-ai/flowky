// The health check: what is active, and why something is not. Shared by the
// baseline (the health skill runs `node dist/hook.mjs health`) and the mods
// layer (/flowky health answers with no model turn). It reads; it never
// changes anything.

import type { Io } from '../mods/io'
import { join, kilo } from '../mods/io'
import { CONFIG_PATH, loadConfig } from '../mods/config'
import { LEGACY_MAP_PATH, MAP_PATH, fingerprintOf } from '../mods/project-map'
import { STATE_DIR, STATE_GITIGNORE, readState, stateDir } from '../mods/state'
import type { LiteStatus } from '../mods/state'
import { PLUGIN, VERSION } from './identity'
import { INDEPENDENCE, bothEnabledLine, migrationLines } from './health-common'

export { VERSION }

function ago(now: number, at: number | undefined): string {
  if (at === undefined) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

export type HealthFacts = {
  /** Which driver is answering: the Node command hooks, or the mods layer. */
  layer: 'baseline' | 'mods'
  runtime?: string
  sessionId?: string
}

export async function healthReport(io: Io, root: string, facts: HealthFacts): Promise<string> {
  const now = await io.now()
  const lines: string[] = []
  const { config, error, found } = await loadConfig(io, root)
  const status = await readState<LiteStatus>(io, root, 'status', {})
  lines.push(`${PLUGIN} ${VERSION} health check (answered by the ${facts.layer === 'mods' ? 'mods layer' : 'baseline command hooks'})`)
  lines.push(`Project root: ${root}`)
  lines.push(`Runtime: ${facts.runtime ?? 'unknown'}`)
  lines.push(
    `Config ${CONFIG_PATH}: ${error ? `BROKEN, defaults in force (${error})` : found ? 'found and valid' : 'not present, defaults in force'}`,
  )
  const ignoredOk = (await io.readText(join(stateDir(io, root), '.gitignore'))) === STATE_GITIGNORE
  lines.push(`State folder: ${stateDir(io, root)} (map and small JSON files; ${ignoredOk ? 'its own .gitignore ("*") keeps it out of commits' : 'its .gitignore ("*") is written at the next hook'}; safe to delete). Nothing else in .flowky/ is written by the plugin.`)
  const both = await bothEnabledLine(io, root).catch(() => undefined)
  if (both) lines.push(both)

  const mods = status.mods
  const modsActive = mods !== undefined && (facts.layer === 'mods' || (facts.sessionId !== undefined && mods.sessionId === facts.sessionId))
  lines.push('')
  lines.push('Layers:')
  lines.push(`  baseline (command hooks, skills): ${status.lastHook ? `active, last hook ${status.lastHook.event} ${ago(now, status.lastHook.at)}` : 'no hook has run in this project yet (is Node on PATH? see README, "Requirements")'}`)
  lines.push(
    `  mods layer (status line, no-turn command): ${modsActive ? `active in this session (loaded ${ago(now, mods!.at)})` : mods ? `seen in another session ${ago(now, mods.at)}, not detected in this one` : 'not detected (needs a Claude Code with the mods API and mods allowed; everything else works without it)'}`,
  )

  lines.push('')
  const map = await io.readText(join(root, MAP_PATH))
  if (!config.map.enabled) lines.push('Project map: OFF (map.enabled is false in the config)')
  else {
    const m = status.map
    const detail = m
      ? `${m.status} ${ago(now, m.at)}${m.files !== undefined ? `, ${m.files} files in ${m.elapsedMs ?? '?'} ms` : ''}${m.partial ? `, PARTIAL (${m.partial})` : ''}${m.reason ? `, ${m.reason}` : ''}`
      : 'no scan recorded yet (the SessionStart hook writes it)'
    lines.push(`Project map: ON, ${detail}`)
    lines.push(`  ${MAP_PATH}: ${map ? `${map.split('\n').length - 1} lines, fingerprint ${fingerprintOf(map) ?? 'missing'}` : 'not written yet'}`)
    if ((await io.stat(join(root, LEGACY_MAP_PATH)))?.kind === 'file') lines.push(`  ${LEGACY_MAP_PATH} (where the former name's 0.1.0 wrote it) is no longer read or written: old Autopilot state, safe to delete, or keep it as your own notes`)
    lines.push(`  added to Claude's context at session start: ${config.map.addToContext ? 'yes' : 'no (map.addToContext is false)'}`)
  }
  if (!config.context.enabled) lines.push('Context hygiene: OFF (context.enabled is false in the config)')
  else {
    const c = status.context
    lines.push(
      `Context hygiene: ON, threshold ${kilo(config.context.thresholdTokens)} tokens; last measure ${c ? `${c.tokens !== undefined ? kilo(c.tokens) : '?'} tokens ${ago(now, c.at)} from ${c.source}${c.hinted ? ', hint shown' : ''}` : 'none yet (measured when Claude finishes a turn)'}`,
    )
    lines.push(`  auto-submit of the handoff request: ${config.context.autoSubmit ? 'requested by .flowky/config.json; it submits only after you confirm it with the handoff auto on command (mods layer only)' : 'off: the request is only placed in the prompt box'}`)
  }
  lines.push('')
  const tracked = await io.run(['git', 'ls-files', '--', STATE_DIR, LEGACY_MAP_PATH, '.claude/handoff.md'], { cwd: root, timeoutMs: 3000 })
  if (tracked.exitCode === 0 && tracked.stdout.trim()) lines.push(`FLAG: plugin files are committed in this repository (the plugin regenerates or ignores them; remove them from git): ${tracked.stdout.trim().split(/\r?\n/).slice(0, 6).join(', ')}`)
  const moved = await migrationLines(io, root).catch(() => [])
  if (moved.length) lines.push('', ...moved)
  lines.push('')
  lines.push('Privacy: this plugin makes no network request of its own, and no model call.')
  lines.push('Before trust: in a claude -p or SDK session, or a folder under a trusted parent, Claude Code runs plugin hooks without the trust dialog; the SessionStart hook then writes only inside the ignored state folder.')
  lines.push('')
  lines.push(INDEPENDENCE)
  return lines.join('\n')
}
