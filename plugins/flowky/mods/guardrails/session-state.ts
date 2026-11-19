// What the guardrails remember between hook processes, per session:
//   .flowky/cache/guard/session-<id>.json
// written through the shared state helpers (safe writer: inside the project, no link on the way,
// temporary file and rename; a lock file for read-modify-write). Bounded: at most 50 paused
// writes, 200 removed names, 10 agents with 40 commands each, and 64 KB in all (the oldest
// commands go first). Sessions not touched for 7 days are deleted at session start, and at most
// the 30 newest are kept.
//
// The file is read back as hostile input: rebuilt field by field into prototype-free records, so
// a corrupt or forged file is an empty state, never a crash and never a reason to block.

import type { Io } from '../io'
import { join } from '../io'
import { STATE_DIR, readState, stateDir, updateState } from '../state'

export const GUARD_DIR = 'guard'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_SESSIONS = 30
const MAX_WRITES = 50
const MAX_REMOVED = 200
const MAX_AGENTS = 10
const MAX_COMMANDS = 40
export const MAX_STATE_BYTES = 64 * 1024

export type CommandState = {
  streak: number
  exit: number | null
  sig: string
  err: string
  epoch: number
  network: boolean
  paused: boolean
  at: number
}

export type GuardSession = {
  v: 1
  updatedAt: number
  /** Raised by every change of the project the agent made (a write, an edit, a shell command that is not read-only). */
  epoch: number
  /** HEAD at session start (40 hex digits), for the mid-session line. */
  head?: string
  /** HEAD values already reported during the session. */
  saidHeads: string[]
  /** Duplicate-guard pauses already made: fingerprint -> time. */
  writes: Record<string, number>
  /** Names whose definition this session removed from a file: name -> time (a move or a rename in progress). */
  removed: Record<string, number>
  /** Per agent ("main" or a sub-agent id): failure streaks per command fingerprint. */
  agents: Record<string, Record<string, CommandState>>
}

export function emptySession(now: number): GuardSession {
  return { v: 1, updatedAt: now, epoch: 0, saidHeads: [], writes: Object.create(null), removed: Object.create(null), agents: Object.create(null) }
}

const KEY = /^[\w.:@/-]{1,200}$/

/** File name of a session's state (the id reduced to safe characters). */
export function sessionFile(session: string): string {
  const id = String(session || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown'
  return `${GUARD_DIR}/session-${id}`
}

export function agentKey(agent: string | undefined): string {
  const a = typeof agent === 'string' ? agent.replace(/[^\w.:@-]/g, '').slice(0, 80) : ''
  return a ? `agent:${a}` : 'main'
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

/** Rebuilds a session from whatever was on disk; anything odd is dropped. */
export function sanitizeSession(raw: unknown, now: number): GuardSession {
  const s = emptySession(now)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return s
  const updatedAt = num(r.updatedAt, 0)
  if (now - updatedAt > SESSION_TTL_MS || updatedAt > now + 60_000) return s
  s.updatedAt = updatedAt
  const epoch = num(r.epoch, 0)
  s.epoch = Number.isInteger(epoch) && epoch >= 0 && epoch < 1e9 ? epoch : 0
  if (typeof r.head === 'string' && /^[0-9a-f]{40}$/.test(r.head)) s.head = r.head
  if (Array.isArray(r.saidHeads)) s.saidHeads = r.saidHeads.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h)).slice(-10)
  const rec = (v: unknown, max: number, keyOk: (k: string) => boolean): Record<string, number> => {
    const out: Record<string, number> = Object.create(null)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out
    for (const [k, t] of Object.entries(v as Record<string, unknown>).slice(0, max * 2)) if (keyOk(k) && typeof t === 'number' && Number.isFinite(t)) out[k] = t
    return out
  }
  s.writes = rec(r.writes, MAX_WRITES, k => /^[0-9a-f]{16,64}$/.test(k))
  s.removed = rec(r.removed, MAX_REMOVED, k => /^[A-Za-z_$][\w$]{0,127}$/.test(k))
  if (r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents)) {
    for (const [ak, cmds] of Object.entries(r.agents as Record<string, unknown>).slice(0, MAX_AGENTS * 2)) {
      if (!KEY.test(ak) || !cmds || typeof cmds !== 'object' || Array.isArray(cmds)) continue
      const out: Record<string, CommandState> = Object.create(null)
      for (const [ck, c] of Object.entries(cmds as Record<string, unknown>).slice(0, MAX_COMMANDS * 2)) {
        if (!/^[0-9a-f]{16}$/.test(ck) || !c || typeof c !== 'object') continue
        const x = c as Record<string, unknown>
        const streak = num(x.streak, 0)
        out[ck] = {
          streak: Number.isInteger(streak) && streak > 0 && streak < 1000 ? streak : 0,
          exit: typeof x.exit === 'number' && Number.isInteger(x.exit) ? x.exit : null,
          sig: typeof x.sig === 'string' ? x.sig.slice(0, 300) : '',
          err: typeof x.err === 'string' ? x.err.slice(0, 300) : '',
          epoch: num(x.epoch, -1),
          network: x.network === true,
          paused: x.paused === true,
          at: num(x.at, updatedAt),
        }
      }
      s.agents[ak] = out
    }
  }
  return s
}

function keepNewest<T>(record: Record<string, T>, max: number, at: (v: T) => number): void {
  const keys = Object.keys(record)
  if (keys.length <= max) return
  keys.sort((a, b) => at(record[b]!) - at(record[a]!))
  for (const k of keys.slice(max)) delete record[k]
}

/** Applies the bounds in place; returns the session. */
export function boundSession(s: GuardSession): GuardSession {
  keepNewest(s.writes, MAX_WRITES, t => t)
  keepNewest(s.removed, MAX_REMOVED, t => t)
  for (const k of Object.keys(s.agents)) keepNewest(s.agents[k]!, MAX_COMMANDS, c => c.at)
  const newestOf = (cmds: Record<string, CommandState>) => Math.max(0, ...Object.values(cmds).map(c => c.at))
  keepNewest(s.agents, MAX_AGENTS, newestOf)
  for (const k of Object.keys(s.agents)) {
    const cmds = s.agents[k]!
    for (const ck of Object.keys(cmds)) if (cmds[ck]!.err.length > 300) cmds[ck]!.err = cmds[ck]!.err.slice(0, 300)
  }
  // Whatever happens, the file stays small: drop the oldest commands, then the oldest writes.
  // Measured as written (indented), so the file on disk is what is bounded.
  while (JSON.stringify(s, null, 2).length > MAX_STATE_BYTES) {
    const all = Object.entries(s.agents).flatMap(([a, cmds]) => Object.entries(cmds).map(([k, c]) => ({ a, k, at: c.at })))
    if (all.length) {
      const oldest = all.sort((x, y) => x.at - y.at)[0]!
      delete s.agents[oldest.a]![oldest.k]
      continue
    }
    const w = Object.keys(s.writes)
    if (w.length) {
      keepNewest(s.writes, w.length - 1, t => t)
      continue
    }
    const r = Object.keys(s.removed)
    if (r.length) {
      keepNewest(s.removed, r.length - 1, t => t)
      continue
    }
    break
  }
  return s
}

/**
 * Reads, changes and writes a session's state under its lock. `change` returns whatever the caller
 * needs. `saved` is false when the state could not be written (a refused path, a read-only disk):
 * a pause that cannot be remembered must not be made, or it would repeat on every send.
 */
export async function withSession<T>(io: Io, root: string, session: string, change: (s: GuardSession, now: number) => T): Promise<{ result: T; saved: boolean }> {
  const name = sessionFile(session)
  const now = await io.now()
  let result!: T
  let saved = false
  let written = false
  await updateState<Record<string, unknown>>(io, root, name, {}, async raw => {
    const s = sanitizeSession(raw, now)
    result = change(s, now)
    s.updatedAt = now
    boundSession(s)
    for (const k of Object.keys(raw)) delete raw[k]
    Object.assign(raw, s)
    written = true
  })
  if (written) {
    // updateState swallows write errors: check that what we meant to keep is on disk.
    const back = await io.readText(join(stateDir(io, root), `${name}.json`)).catch(() => undefined)
    saved = typeof back === 'string' && back.includes(`"updatedAt": ${now}`)
  }
  return { result, saved }
}

/** Read only (no lock, no write). A state file another machine stamped (FlowKy Pro) reads as empty. */
export async function readSession(io: Io, root: string, session: string): Promise<GuardSession> {
  const now = await io.now()
  const st = await io.stat(join(stateDir(io, root), `${sessionFile(session)}.json`)).catch(() => undefined)
  if (!st || st.kind !== 'file' || st.size > MAX_STATE_BYTES * 4) return emptySession(now)
  return sanitizeSession(await readState<Record<string, unknown>>(io, root, sessionFile(session), {}), now)
}

/** Deletes session files untouched for 7 days, and keeps the 30 newest. */
export async function pruneGuardSessions(io: Io, root: string): Promise<void> {
  if (!io.removeInside) return
  const dir = join(root, STATE_DIR, GUARD_DIR)
  const entries = await io.list(dir).catch(() => [])
  const now = await io.now()
  const files = entries.filter(e => e.kind === 'file' && /^session-[A-Za-z0-9_-]{1,64}\.json$/.test(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const [i, e] of files.entries()) {
    if (i >= MAX_SESSIONS || now - e.mtimeMs > SESSION_TTL_MS) await io.removeInside(root, join(dir, e.name)).catch(() => undefined)
  }
}
