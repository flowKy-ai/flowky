// The guardrails' settings, from the "guardrails" section of .flowky/config.json, and the check
// for a second copy of the guard (the FlowKy VS Code extension's old project hook).
//
// .flowky/config.json is the REPOSITORY's file: whoever wrote the repository wrote it. So it can
// only make a guardrail quieter for that repository, never louder and never wordier:
//   - each guardrail can be switched off ("duplicateGuard": false or "off");
//   - the duplicate guard and the loop breaker can go from "pause-once" (the default, the most
//     that ever happens) down to "note" (context only, never a pause);
//   - the loop breaker's threshold can be raised (3 to 10), never lowered below 3;
//   - the duplicate guard can be told to ignore more names; an ignored name is only ever removed
//     from a report, never printed.
// No setting is copied into a message, and no setting can run a command or name a file to read.
//
//   "guardrails": {
//     "duplicateGuard": "pause-once" | "note" | "off" | false | { "mode": ..., "ignore": ["name", ...] },
//     "loopBreaker":    "pause-once" | "note" | "off" | false | { "mode": ..., "threshold": 3..10 },
//     "staleness":      true | false,
//     "configDoctor":   true | false     (false: no daily summary at session start; the command still answers)
//   }

import type { Io } from '../io'
import { join, readJson } from '../io'
import { CONFIG_PATH } from '../paths'

export type GuardMode = 'pause-once' | 'note' | 'off'

export type GuardrailsConfig = {
  duplicateGuard: { mode: GuardMode; ignore: Set<string> }
  loopBreaker: { mode: GuardMode; threshold: number }
  staleness: { enabled: boolean }
  configDoctor: { sessionSummary: boolean }
}

export const LOOP_THRESHOLD = 3
export const MAX_LOOP_THRESHOLD = 10
const MODES: readonly GuardMode[] = ['pause-once', 'note', 'off']
const NAME = /^[A-Za-z_$][\w$]{0,127}$/

export function defaultGuardrails(): GuardrailsConfig {
  return {
    duplicateGuard: { mode: 'pause-once', ignore: new Set() },
    loopBreaker: { mode: 'pause-once', threshold: LOOP_THRESHOLD },
    staleness: { enabled: true },
    configDoctor: { sessionSummary: true },
  }
}

function modeOf(v: unknown): GuardMode | undefined {
  if (v === false) return 'off'
  if (v === true) return 'pause-once'
  return typeof v === 'string' && (MODES as readonly string[]).includes(v) ? (v as GuardMode) : undefined
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** The guardrails section of a parsed config; anything unknown or out of range keeps the default. */
export function normalizeGuardrails(raw: unknown): GuardrailsConfig {
  const out = defaultGuardrails()
  const g = obj(obj(raw)?.guardrails)
  if (!g) return out
  const dup = g.duplicateGuard
  const dupObj = obj(dup)
  const dupMode = modeOf(dupObj ? dupObj.mode ?? dupObj.enabled : dup)
  if (dupMode) out.duplicateGuard.mode = dupMode
  if (dupObj && Array.isArray(dupObj.ignore)) {
    for (const n of dupObj.ignore.slice(0, 500)) if (typeof n === 'string' && NAME.test(n)) out.duplicateGuard.ignore.add(n)
  }
  const loop = g.loopBreaker
  const loopObj = obj(loop)
  const loopMode = modeOf(loopObj ? loopObj.mode ?? loopObj.enabled : loop)
  if (loopMode) out.loopBreaker.mode = loopMode
  const t = loopObj?.threshold
  if (typeof t === 'number' && Number.isInteger(t)) out.loopBreaker.threshold = Math.min(MAX_LOOP_THRESHOLD, Math.max(LOOP_THRESHOLD, t))
  const st = obj(g.staleness)
  const stOn = typeof g.staleness === 'boolean' ? g.staleness : typeof st?.enabled === 'boolean' ? st.enabled : undefined
  if (stOn !== undefined) out.staleness.enabled = stOn
  const cd = obj(g.configDoctor)
  const cdOn = typeof g.configDoctor === 'boolean' ? g.configDoctor : typeof cd?.sessionSummary === 'boolean' ? cd.sessionSummary : undefined
  if (cdOn !== undefined) out.configDoctor.sessionSummary = cdOn
  return out
}

export async function loadGuardrails(io: Io, root: string): Promise<GuardrailsConfig> {
  const st = await io.stat(join(root, CONFIG_PATH)).catch(() => undefined)
  if (!st || st.kind !== 'file' || st.size > 256 * 1024) return defaultGuardrails()
  const { value } = await readJson<unknown>(io, join(root, CONFIG_PATH))
  return normalizeGuardrails(value)
}

// ---- A second copy of the guard ----

/** The file name of the FlowKy VS Code extension's project hook. */
export const OLD_GUARD_SCRIPT = 'flowky-guard.mjs'
export const PROJECT_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'] as const

export type OldGuard = { file: string; events: string[] }

/** The hook events in a settings file whose command runs the extension's guard script. */
export function oldGuardEvents(settingsText: string | undefined): string[] {
  if (!settingsText) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsText.replace(/^\ufeff/, ''))
  } catch {
    return []
  }
  const hooks = obj(obj(parsed)?.hooks)
  if (!hooks) return []
  const events: string[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const hit = groups.some(g => {
      const handlers = obj(g)?.hooks
      return Array.isArray(handlers) && handlers.some(h => {
        const c = obj(h)
        const text = [c?.command, ...(Array.isArray(c?.args) ? c!.args as unknown[] : [])].filter(x => typeof x === 'string').join(' ')
        return text.includes(OLD_GUARD_SCRIPT)
      })
    })
    if (hit && /^[A-Za-z]{1,40}$/.test(event)) events.push(event)
  }
  return events
}

/** Where the project still wires the extension's old guard hook (read only; never changed here). */
export async function findOldGuard(io: Io, root: string): Promise<OldGuard[]> {
  const out: OldGuard[] = []
  for (const file of PROJECT_SETTINGS) {
    const p = join(root, file)
    const st = await io.stat(p).catch(() => undefined)
    if (!st || st.kind !== 'file' || st.size > 1024 * 1024) continue
    const events = oldGuardEvents(await io.readText(p))
    if (events.length) out.push({ file, events })
  }
  return out
}

export function oldGuardAdvice(found: OldGuard[]): string | undefined {
  if (!found.length) return undefined
  const where = found.map(f => `${f.file} (${f.events.join(', ')})`).join(' and ')
  return `The FlowKy VS Code extension's old project hook (${OLD_GUARD_SCRIPT}) is still wired in ${where}. With it and this plugin, every write would be checked twice, so the plugin's duplicate guard, loop breaker and staleness line stay quiet. To use the plugin's: open that file and delete each hook entry whose command contains "${OLD_GUARD_SCRIPT}" (the rest of the file stays as it is), then the file .flowky/hooks/${OLD_GUARD_SCRIPT} if nothing else uses it.`
}
