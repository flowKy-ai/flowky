// The four guardrails, behind one entry point that takes a normalised AgentEvent and returns a
// normalised Decision (spec 3.3). No agent's field names here: hooks/claude-adapter.ts maps
// Claude Code's hook input and output, and the tests run the same scenarios through a second,
// fake agent's adapter.
//
//   duplicate guard   beforeTool write|edit       mods/guardrails/dup-guard.ts
//   loop breaker      beforeTool shell, afterTool  mods/guardrails/loop-breaker.ts
//   staleness line    sessionStart, promptSubmit   mods/guardrails/staleness.ts
//   config doctor     a command, and a daily one-line summary at session start
//                                                  mods/guardrails/config-doctor.ts
//
// Fail open and silent: any error inside a guardrail gives an empty decision (the tool call goes
// ahead as if the plugin were not there), and the error is noted for the health check. A pause is
// made only when the plugin could also write down that it made it; otherwise it would repeat.

import type { Io } from '../mods/io'
import { join, readSafe } from '../mods/io'
import type { Scan } from '../mods/project-map'
import { scanTree } from '../mods/project-map'
import { readState, writeState, writeStateText } from '../mods/state'
import type { AgentEvent, Decision, ToolCall } from '../mods/guardrails/events'
import { NOTHING, combine } from '../mods/guardrails/events'
import type { GuardrailsConfig } from '../mods/guardrails/settings'
import { findOldGuard, loadGuardrails, oldGuardAdvice } from '../mods/guardrails/settings'
import { duplicateDecision, findCollisions, pauseKey } from '../mods/guardrails/dup-guard'
import { beforeShell, commandFingerprint, printedExitStatus, recordFailure, recordSuccess, resetStreaks } from '../mods/guardrails/loop-breaker'
import { INDEX_BUDGET_MS, INDEX_MAX_FILES, buildIndex, loadIndex, readMeta, updateIndexedFile } from '../mods/guardrails/symbol-index'
import { pruneGuardSessions, readSession, scrubOldErrorLines, withSession } from '../mods/guardrails/session-state'
import { driftSince, extensionCommit, headCommit, headFromFiles, movedLine, startLine } from '../mods/guardrails/staleness'
import { doctorReport, gatherDoctorInputs, runDoctor, summaryLine } from '../mods/guardrails/config-doctor'
import { clean, digest, relativeTo } from '../mods/guardrails/text'
import { classifyPath } from '../mods/guardrails/symbols'
import { withLock } from '../mods/state'
import { PLUGIN } from './identity'

export const RETRY_COMMAND = `/${PLUGIN}:retry`
export const DOCTOR_COMMAND = `/${PLUGIN}:config-doctor`
const DOCTOR_EVERY_MS = 24 * 60 * 60 * 1000

type ErrorNote = { at?: number; where?: string; message?: string }

async function noteError(io: Io, root: string, where: string, err: unknown): Promise<void> {
  await writeState(io, root, 'guard/last-error', { at: await io.now().catch(() => 0), where, message: clean(String((err as Error)?.message ?? err), 200).replace(/\n/g, ' ') }).catch(() => undefined)
}

async function failOpen(io: Io, root: string, where: string, f: () => Promise<Decision>): Promise<Decision> {
  try {
    return await f()
  } catch (err) {
    await noteError(io, root, where, err)
    return NOTHING
  }
}

/** Whether a whole message is the order "flowky retry" (case and a final period ignored). */
export function isRetryOrder(text: string): boolean {
  return /^\s*flowky\s+retry[.!]?\s*$/i.test(String(text ?? ''))
}

// ---- session start ----

async function lastDoctorRun(io: Io, root: string): Promise<number | undefined> {
  const text = await readSafe(io, join(root, '.flowky/cache/guard/doctor.json'), { maxBytes: 256, root })
  try {
    const at = (JSON.parse(text ?? '') as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined
  } catch {
    return undefined
  }
}

/**
 * One deadline for the whole SessionStart hook (review F2/F5): the map, the index, the git calls
 * and the doctor summary each take what is left of it, so the hook ends well before Claude Code's
 * 15 s timeout and its output (the map and the line) is never lost.
 */
export const SESSION_START_BUDGET_MS = 8000

export type StartFacts = { scan?: Scan; source?: string; deadline?: number }

/** Index build, staleness line and the daily doctor summary. `scan`: the project map's scan, reused. */
export async function guardrailsAtStart(io: Io, ev: Extract<AgentEvent, { kind: 'sessionStart' }>, facts: StartFacts = {}): Promise<Decision> {
  const root = ev.root
  const deadline = facts.deadline ?? (await io.now()) + SESSION_START_BUDGET_MS
  const left = async () => deadline - (await io.now())
  return failOpen(io, root, 'sessionStart', async () => {
    const cfg = await loadGuardrails(io, root)
    const old = await findOldGuard(io, root)
    await pruneGuardSessions(io, root).catch(() => undefined)
    await scrubOldErrorLines(io, root).catch(() => undefined)
    const head = (await left()) > 300 ? await headCommit(io, root, Math.min(2000, (await left()) - 200)) : undefined
    let own
    if (cfg.duplicateGuard.mode !== 'off' && !old.length && (await left()) > 1000) {
      // The map's scan is reused when it covered the tree; otherwise a scan of source files only.
      const scan = facts.scan && !facts.scan.partial ? facts.scan : await scanTree(io, root, Math.min(INDEX_BUDGET_MS, (await left()) - 1000), INDEX_MAX_FILES, { keep: p => classifyPath(p) === 'source' })
      own = (await buildIndex(io, root, scan, { commit: head ?? null, budgetMs: Math.max(0, Math.min(INDEX_BUDGET_MS, (await left()) - 800)) })).meta
    }
    if (head) await withSession(io, root, ev.session, s => {
      if (!s.head || ev.source !== 'compact') s.head = head
    })
    const parts: Decision[] = []
    if (cfg.staleness.enabled && !old.length) {
      const extCommit = head ? await extensionCommit(io, root) : undefined
      const extension = extCommit && head && (await left()) > 400 ? await driftSince(io, root, extCommit, head, Math.min(4000, (await left()) - 300)) : undefined
      const line = startLine({ own, extension })
      if (line) {
        // Claude gets the line at every session start (compact included); the person sees it once per
        // session (systemMessage: "Warning message shown to the user").
        const key = digest(line)
        // Not recorded (FlowKy Pro before the folder is trusted): it is shown again at the next start.
        const { result: firstTime } = await withSession(io, root, ev.session, s => {
          if (s.toldStart.includes(key)) return false
          s.toldStart.push(key)
          return true
        })
        parts.push({ contextForAgent: line, ...(firstTime ? { messageForUser: line } : {}) })
      }
    }
    if (cfg.configDoctor.sessionSummary && ev.source === 'startup' && (await left()) > 1500) {
      // Display-only and unstamped (it may be written before the folder is trusted): a forged file
      // can only make the daily summary quieter.
      const last = await lastDoctorRun(io, root)
      const now = await io.now()
      if (last === undefined || now - last > DOCTOR_EVERY_MS || last > now) {
        await writeStateText(io, root, 'guard/doctor.json', JSON.stringify({ at: now }) + '\n').catch(() => undefined)
        const inputs = await gatherDoctorInputs(io, root, { timeMs: Math.max(100, ((await left()) - 500) / 2) })
        const line = summaryLine(await runDoctor(inputs), DOCTOR_COMMAND)
        if (line) parts.push({ messageForUser: line })
      }
    }
    return combine(...parts)
  })
}

// ---- tool calls ----

async function beforeWrite(io: Io, ev: Extract<AgentEvent, { kind: 'beforeTool' }>, tool: Extract<ToolCall, { kind: 'write' | 'edit' }>, cfg: GuardrailsConfig): Promise<Decision> {
  const root = ev.root
  const target = relativeTo(root, tool.path)
  if (!target) return NOTHING
  const index = await loadIndex(io, root)
  const session = await readSession(io, root, ev.session)
  const { collisions, removed } = await findCollisions(io, {
    root,
    target,
    tool,
    index,
    config: cfg,
    removedThisSession: new Set(Object.keys(session.removed)),
  })
  if (!collisions.length && !removed.size) return NOTHING
  const pause = cfg.duplicateGuard.mode === 'pause-once' && collisions.length > 0
  // Once per file and name per session (the lead's rule after the behaviour review): after one pause
  // for X in F, every later write that defines X in F passes, whatever its text.
  const { result: fresh, saved } = await withSession(io, root, ev.session, (s, now) => {
    for (const n of removed) s.removed[n] = now
    if (!pause) return collisions
    const notYet = collisions.filter(c => s.writes[pauseKey(root, target, c.name)] === undefined)
    for (const c of notYet) s.writes[pauseKey(root, target, c.name)] = now
    return notYet
  })
  if (!collisions.length) return NOTHING
  if (!pause) return duplicateDecision(collisions, false)
  // A name already paused for this file passes, with nothing said. A pause that could not be recorded is not made.
  if (!fresh.length || !saved) return NOTHING
  return duplicateDecision(fresh, true)
}

export async function guardrailsOnEvent(io: Io, ev: AgentEvent): Promise<Decision> {
  if (ev.kind === 'sessionStart') return guardrailsAtStart(io, ev)
  const root = ev.root
  return failOpen(io, root, ev.kind, async () => {
    const cfg = await loadGuardrails(io, root)
    const loopOn = cfg.loopBreaker.mode !== 'off'
    const dupOn = cfg.duplicateGuard.mode !== 'off'
    if (ev.kind === 'promptSubmit') {
      if (isRetryOrder(ev.text)) {
        const { result: n } = await withSession(io, root, ev.session, s => resetStreaks(s))
        return { answerWithoutTurn: `FlowKy (no model turn): loop breaker reset for this session (${n} failure count${n === 1 ? '' : 's'} cleared). The next failure of any command starts again from one.` }
      }
      if (!cfg.staleness.enabled) return NOTHING
      const now = await headFromFiles(io, root)
      if (!now) return NOTHING
      const s = await readSession(io, root, ev.session)
      if (!s.head) {
        // Session start could not record HEAD (FlowKy Pro before the folder is trusted): the first prompt does.
        await withSession(io, root, ev.session, x => {
          x.head = now
        })
        return NOTHING
      }
      if (s.head === now || s.saidHeads.includes(now)) return NOTHING
      if ((await findOldGuard(io, root)).length) return NOTHING
      const from = s.head
      const { saved } = await withSession(io, root, ev.session, x => {
        x.saidHeads.push(now)
      })
      return saved ? { contextForAgent: movedLine(from, now), messageForUser: movedLine(from, now) } : NOTHING
    }
    if (ev.kind === 'stop') return NOTHING
    const tool = ev.tool
    if (!loopOn && !dupOn) return NOTHING
    if ((await findOldGuard(io, root)).length) return NOTHING
    if (ev.kind === 'beforeTool') {
      if ((tool.kind === 'write' || tool.kind === 'edit') && dupOn) return beforeWrite(io, ev, tool, cfg)
      if (tool.kind === 'shell' && cfg.loopBreaker.mode === 'pause-once') {
        const facts = { shell: tool.shell, command: tool.command, background: tool.background, cwd: ev.cwd, agent: ev.agent }
        const probe = await readSession(io, root, ev.session)
        if (!beforeShell(probe, await io.now(), facts, cfg).deny) return NOTHING
        const { result, saved } = await withSession(io, root, ev.session, (s, now) => beforeShell(s, now, facts, cfg))
        return saved ? result : NOTHING
      }
      return NOTHING
    }
    // afterTool
    if (tool.kind === 'shell') {
      if (!loopOn) return NOTHING
      const facts = { shell: tool.shell, command: tool.command, background: tool.background, cwd: ev.cwd, agent: ev.agent }
      if (ev.ok) {
        // A command line that prints its own exit status: a non-zero one printed is a failure.
        const printed = printedExitStatus(tool.command, ev.output)
        if (printed && printed.exitCode !== 0) {
          const { result } = await withSession(io, root, ev.session, (s, now) => recordFailure(s, now, { ...facts, output: printed.output, exitCode: printed.exitCode }, cfg))
          await scrubOldErrorLines(io, root).catch(() => undefined)
          return result
        }
        // A success ends that command's count; nothing to write when there is none.
        const probe = await readSession(io, root, ev.session)
        const key = commandFingerprint(tool.shell, tool.command, ev.cwd)
        if (!Object.values(probe.agents).some(b => b[key])) return NOTHING
        await withSession(io, root, ev.session, s => recordSuccess(s, facts))
        return NOTHING
      }
      const { result } = await withSession(io, root, ev.session, (s, now) => recordFailure(s, now, { ...facts, output: ev.error, exitCode: ev.exitCode, interrupted: ev.interrupted }, cfg))
      // A hook that stores an error line also erases the ones older than 24 hours, in every session file.
      await scrubOldErrorLines(io, root).catch(() => undefined)
      return result
    }
    if ((tool.kind === 'write' || tool.kind === 'edit' || tool.kind === 'notebook') && ev.ok) {
      // An edit does not reset the loop breaker (the lead's rule after the behaviour review).
      const rel = relativeTo(root, tool.path)
      if (dupOn && rel && tool.kind !== 'notebook') await withLock(io, root, 'index/recent', () => updateIndexedFile(io, root, rel))
    }
    return NOTHING
  })
}

// ---- commands ----

/** /flowky:retry: clears the loop breaker's counts for one session. */
export async function retryCommand(io: Io, root: string, session: string | undefined): Promise<string> {
  if (!session) return 'FlowKy: no session id was given, so nothing was reset. Type "flowky retry" as a whole message instead.'
  try {
    const { result: n, saved } = await withSession(io, root, session, s => resetStreaks(s))
    return saved ? `FlowKy: loop breaker reset for this session (${n} failure count${n === 1 ? '' : 's'} cleared).` : 'FlowKy: the loop breaker state could not be written (see the health check); nothing was reset.'
  } catch (err) {
    await noteError(io, root, 'retry', err)
    return 'FlowKy: the reset failed (see the health check).'
  }
}

/** /flowky:config-doctor: diagnoses only. */
export async function configDoctorCommand(io: Io, root: string, json = false): Promise<string> {
  try {
    const inputs = await gatherDoctorInputs(io, root)
    return doctorReport(await runDoctor(inputs), inputs, json)
  } catch (err) {
    await noteError(io, root, 'config-doctor', err)
    return 'FlowKy config doctor could not run (see the health check).'
  }
}

function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`
}

/** The guardrails' lines for the health check. */
export async function guardrailsHealthLines(io: Io, root: string): Promise<string[]> {
  const cfg = await loadGuardrails(io, root)
  const old = await findOldGuard(io, root)
  const meta = await readMeta(io, root)
  const now = await io.now()
  const lines: string[] = ['Guardrails:']
  const quiet = old.length ? ' (QUIET: a second copy of the guard is wired, see below)' : ''
  const mode = (m: string) => (m === 'off' ? 'OFF (guardrails in .flowky/config.json)' : `ON, mode ${m}`)
  lines.push(`  duplicate guard: ${mode(cfg.duplicateGuard.mode)}${quiet}`)
  if (cfg.duplicateGuard.mode !== 'off') {
    lines.push(
      meta
        ? `    index ${join('.flowky/cache', 'index')}: ${meta.symbolCount} definitions from ${meta.indexedFiles - meta.skipped.generated - meta.skipped.minified} source files read; left out: ${meta.skipped.generated} with a generated marker, ${meta.skipped.minified} minified, ${meta.skipped.tooLarge} over 1 MB${meta.indexedFiles < meta.fileCount ? `, ${meta.fileCount - meta.indexedFiles} not read yet` : ''}${meta.complete ? '' : ' (PARTIAL: continues at the next session start)'}; built ${ago(now, meta.builtAt)} in ${meta.elapsedMs} ms; languages: ${meta.languages.join(', ') || 'none found'}`
        : '    index: not built yet (built at the next session start)',
    )
  }
  lines.push(`  loop breaker: ${mode(cfg.loopBreaker.mode)}, after ${cfg.loopBreaker.threshold} identical failures${quiet}; reset with ${RETRY_COMMAND} or the message "flowky retry"`)
  const gitHere = (await io.stat(join(root, '.git')).catch(() => undefined)) !== undefined
  lines.push(`  staleness line: ${cfg.staleness.enabled ? `ON${gitHere ? '' : ' (no git repository here: nothing to compare)'}` : 'OFF (guardrails in .flowky/config.json)'}${quiet}`)
  lines.push(`  config doctor: ${DOCTOR_COMMAND} (diagnoses only); daily summary at session start ${cfg.configDoctor.sessionSummary ? 'on' : 'off'}`)
  const advice = oldGuardAdvice(old)
  if (advice) lines.push(`  WARNING: ${advice}`)
  const err = await readState<ErrorNote>(io, root, 'guard/last-error', {})
  if (typeof err.at === 'number' && typeof err.where === 'string' && now - err.at < 7 * 24 * 3600 * 1000)
    lines.push(`  last internal error (the call went ahead): ${clean(err.where, 40)} ${ago(now, err.at)}: ${clean(err.message ?? '', 200)}`)
  return lines
}
