// Small JSON state that survives between hook processes: each command hook is
// a fresh process, so what one hook learns (the last context hint, the last
// scan) is written here for the next one and for the doctor.
//
// Where: .flowky/cache/ in the project, for both layers. That folder gets
// its own .gitignore containing "*" before anything else is written into it,
// so nothing the plugin writes is committed by accident. The rest of .flowky/
// belongs to the FlowKy VS Code extension, which commits parts of it on
// purpose: the plugin never writes there and never adds an ignore rule there
// (see mods/paths.ts).
//
// How: every write goes through Io.writeInside (inside the project, no
// symbolic link on the way, a temporary file renamed over the target), and a
// read-modify-write takes a simple lock file (`<name>.lock`, created
// exclusively, taken over when older than 10 s), so two hook processes do
// not lose each other's update. A driver that cannot write safely writes
// nothing (state is a convenience).
//
// Trust: a state file a repository commits is not ours. Where a stamp
// provider is configured (Pro: the machine id kept in the user's own FlowKy
// folder), every file is written with that stamp, and a file with another
// stamp or none is read as absent and reported to the doctor as foreign.

import type { Io } from './io'
import { join, readJson } from './io'
import { STATE_DIR } from './paths'

export { STATE_DIR }
export const STATE_GITIGNORE = '# Written by FlowKy: machine-local state, never commit it.\n*\n'

export function stateDir(_io: Io, root: string): string {
  return join(root, STATE_DIR)
}

/** The stamp of trusted state for this project root (Pro: the machine id, read only from a user folder outside `root`). */
type StampProvider = (io: Io, root: string) => Promise<string | undefined>
let stampProvider: StampProvider | undefined
/** `<root>|<name>` of the state files whose stamp did not match (for the doctor). */
export const foreignState = new Set<string>()

/** Pro: every state file carries the machine id; free: no stamp (its state is display-only). */
export function configureStateStamp(provider: StampProvider | undefined): void {
  stampProvider = provider
}

/** The configured stamp provider (tests put it back after replacing it). */
export function stateStampProvider(): StampProvider | undefined {
  return stampProvider
}

/** This machine's stamp for `root` (Pro: the machine id), or undefined when no stamp is configured or known. */
export async function currentStamp(io: Io, root: string): Promise<string | undefined> {
  return stampProvider ? stampProvider(io, root).catch(() => undefined) : undefined
}

/** Whether a stamp provider is configured (Pro). Without one, no state file is trusted beyond display. */
export function stampConfigured(): boolean {
  return stampProvider !== undefined
}

/** Display-only names, read whatever their stamp (SessionStart writes them before any machine id exists). */
const UNSTAMPED_OK = new Set(['status'])

/** Writes .flowky/cache/.gitignore ("*") when it is missing or was changed. */
export async function ensureIgnored(io: Io, root: string): Promise<void> {
  const p = join(stateDir(io, root), '.gitignore')
  if ((await io.readText(p)) === STATE_GITIGNORE) return
  if (!io.writeInside) throw new Error('this driver cannot write safely')
  await io.writeInside(root, p, STATE_GITIGNORE)
}

/** Writes a text file in the state folder (ignored, inside the project, no link, atomic). Throws when refused. */
export async function writeStateText(io: Io, root: string, file: string, text: string): Promise<void> {
  if (!io.writeInside) throw new Error('this driver cannot write safely')
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(file) || file.split('/').includes('..')) throw new Error(`refused state name ${file}`)
  await ensureIgnored(io, root)
  await io.writeInside(root, join(stateDir(io, root), file), text)
}

export async function readState<T extends object>(io: Io, root: string, name: string, fallback: T): Promise<T> {
  const { value } = await readJson<T & { __stamp?: string }>(io, join(stateDir(io, root), `${name}.json`))
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const { __stamp, ...rest } = value
  if (stampProvider && !UNSTAMPED_OK.has(name)) {
    const mine = await stampProvider(io, root).catch(() => undefined)
    if (!mine || __stamp !== mine) {
      foreignState.add(`${root}|${name}`)
      return fallback
    }
  }
  return { ...fallback, ...(rest as T) }
}

export async function writeState(io: Io, root: string, name: string, value: object): Promise<void> {
  try {
    const stamp = stampProvider ? await stampProvider(io, root).catch(() => undefined) : undefined
    if (stampProvider && !stamp && !UNSTAMPED_OK.has(name)) return // no machine id yet (before trust): nothing trusted to write
    const { __stamp: _old, ...plain } = value as { __stamp?: string }
    const body = stamp ? { ...plain, __stamp: stamp } : plain
    await writeStateText(io, root, `${name}.json`, JSON.stringify(body, null, 2) + '\n')
  } catch {
    // State is a convenience: a read-only disk or a refused path must not break a session.
  }
}

const LOCK_STALE_MS = 10_000
/** How long a writer waits for a lock by default before it runs anyway. */
export const LOCK_WAIT_MS = 1_000

/**
 * Runs `f` while holding `<name>.lock` in the state folder. A lock older than 10 s is taken over;
 * after `waitMs` of waiting (default about 1 s) it runs anyway. A lock that may be held for long
 * (the snapshot, up to its git budget) passes a longer `waitMs`.
 */
export async function withLock<T>(io: Io, root: string, name: string, f: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const lock = join(stateDir(io, root), `${name}.lock`)
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS
  let held = false
  if (io.createExclusive && io.writeInside) {
    try {
      await ensureIgnored(io, root)
      const started = await io.now()
      for (let i = 0; i < 2000 && !held; i++) {
        held = await io.createExclusive(root, lock, String(await io.now()))
        if (held) break
        const st = await io.stat(lock)
        const now = await io.now()
        if (st && now - st.mtimeMs > LOCK_STALE_MS) {
          await io.removeInside?.(root, lock).catch(() => undefined)
          continue
        }
        if (now - started >= waitMs) break
        await io.sleep?.(25)
      }
    } catch {
      held = false
    }
  }
  try {
    return await f()
  } finally {
    if (held) await io.removeInside?.(root, lock).catch(() => undefined)
  }
}

/** Reads, changes and writes one state file under its lock. */
export async function updateState<T extends object>(io: Io, root: string, name: string, fallback: T, change: (value: T) => void | Promise<void>, opts: { waitMs?: number } = {}): Promise<T> {
  return withLock(io, root, name, async () => {
    const value = await readState<T>(io, root, name, fallback)
    await change(value)
    await writeState(io, root, name, value)
    return value
  }, opts)
}

/** Keeps the newest `keep` session-*.json files; older ones are removed. */
export async function pruneSessions(io: Io, root: string, keep = 30): Promise<void> {
  if (!io.removeInside) return
  const entries = await io.list(stateDir(io, root)).catch(() => [])
  const sessions = entries.filter(e => e.kind === 'file' && /^session-[A-Za-z0-9_-]+\.json$/.test(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const e of sessions.slice(keep)) {
    await io.removeInside(root, join(stateDir(io, root), e.name)).catch(() => undefined)
  }
}

/** A session id safe in a file name. */
export function sessionKey(id: string | undefined): string {
  return `session-${(id ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown'}`
}

export type LiteStatus = {
  map?: { at: number; status: string; files?: number; elapsedMs?: number; partial?: string; reason?: string }
  context?: { at: number; tokens?: number; source: string; hinted?: boolean }
  /** The mods layer wrote this when it loaded in a session. */
  mods?: { at: number; sessionId: string; version: string }
  lastHook?: { at: number; event: string }
}
