// Git-aware staleness line (spec 6.3), local git data only: no fetch, no network.
//
// What is measured, and when:
//   - session start (every source, compact included, so the line survives compaction):
//       * the plugin's own index, when the time budget left it partial ("index partial, N of M files");
//       * the FlowKy VS Code extension's committed index (.flowky/index/meta.json), when it was
//         generated at a commit other than HEAD: how many commits since, and which top-level
//         folders changed (git rev-list --count, git diff --name-only, 2 s each).
//     The plugin's own map and index are rebuilt at every session start, so they never lag HEAD
//     then; their commit is recorded for the next check.
//   - each prompt: HEAD is read from .git/HEAD and the ref files (no process). If it moved since
//     the session started (a checkout, a pull, a commit), one line says so, once per new HEAD.
// Silent when there is no git repository, no index, or nothing to say.
//
// "Never wrong": a stored commit is used only when it is 7 to 40 lowercase hex digits, so it can
// never be read by git as an option or a range; HEAD must come back as 40 hex digits; a count is
// printed only when git answered with a plain integer, else that part is left out. git runs with
// GIT_OPTIONAL_LOCKS=0 and core.fsmonitor off, and only plumbing that reads objects
// (rev-parse, rev-list, diff between two commits): nothing that runs a repository's hooks.

import type { Io } from '../io'
import { join, readSafe } from '../io'
import { gitOutput } from '../git'
import type { IndexMeta } from './symbol-index'
import { inline } from './text'

export const EXTENSION_META = '.flowky/index/meta.json'
const GIT_BUDGET_MS = 2000

export function isCommitId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v)
}

const sameCommit = (a: string, b: string) => a === b || (a.length !== b.length && (a.startsWith(b) || b.startsWith(a)))

/** Through the shared git runner (mods/git.ts); `timeoutMs` is what is left of the session-start deadline. */
export async function git(io: Io, root: string, args: string[], timeoutMs = GIT_BUDGET_MS): Promise<string | undefined> {
  return gitOutput(io, root, args, Math.min(GIT_BUDGET_MS, timeoutMs))
}

/** HEAD as 40 hex digits, through git; undefined outside a repository or without git. */
export async function headCommit(io: Io, root: string, timeoutMs = GIT_BUDGET_MS): Promise<string | undefined> {
  const h = await git(io, root, ['rev-parse', '--verify', '--quiet', 'HEAD'], timeoutMs)
  return h && /^[0-9a-f]{40}$/.test(h) ? h : undefined
}

/** HEAD from the files in .git, with no process (for each prompt). Undefined when it cannot be read plainly. */
export async function headFromFiles(io: Io, root: string): Promise<string | undefined> {
  const gitDir = join(root, '.git')
  const st = await io.stat(gitDir).catch(() => undefined)
  if (st?.kind !== 'dir') return undefined
  const head = (await readSafe(io, join(gitDir, 'HEAD'), { maxBytes: 512, root }))?.trim()
  if (!head) return undefined
  if (/^[0-9a-f]{40}$/.test(head)) return head
  const m = /^ref: (refs\/[\w./-]{1,200})$/.exec(head)
  if (!m || m[1]!.split('/').includes('..')) return undefined
  const loose = (await readSafe(io, join(gitDir, m[1]!), { maxBytes: 128, root }))?.trim()
  if (loose && /^[0-9a-f]{40}$/.test(loose)) return loose
  const packed = await readSafe(io, join(gitDir, 'packed-refs'), { maxBytes: 4 * 1024 * 1024, root })
  if (!packed) return undefined
  for (const line of packed.split('\n')) {
    const [sha, ref] = line.trim().split(' ')
    if (ref === m[1] && sha && /^[0-9a-f]{40}$/.test(sha)) return sha
  }
  return undefined
}

export type Drift = { commit: string; head: string; behind?: number; changed: string[] }

/** How far HEAD is from `commit` (validated first; undefined when there is nothing true to say). */
export async function driftSince(io: Io, root: string, commit: unknown, head: string, timeoutMs = GIT_BUDGET_MS): Promise<Drift | undefined> {
  if (!isCommitId(commit) || !/^[0-9a-f]{40}$/.test(head) || sameCommit(commit, head)) return undefined
  const count = await git(io, root, ['rev-list', '--count', `${commit}..${head}`], timeoutMs / 2)
  const behind = count !== undefined && /^\d{1,9}$/.test(count) ? Number(count) : undefined
  const listing = await git(io, root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', commit, head, '--'], timeoutMs / 2)
  const changed = listing === undefined ? [] : topLevelFolders(listing)
  if (behind === undefined && listing === undefined) return undefined
  if (behind === 0 && changed.length === 0) return undefined
  return { commit, head, behind, changed }
}

export function topLevelFolders(listing: string, max = 6): string[] {
  const tops = new Set<string>()
  for (const line of listing.split('\n')) {
    const l = line.trim()
    if (!l || l.length > 400) continue
    const parts = l.split('/')
    const top = parts.length > 1 ? `${parts[0]}/` : parts[0]!
    if (/^[\w@.\-+ ()[\]~#,]{1,80}\/?$/.test(top)) tops.add(top)
  }
  const all = [...tops].sort()
  return all.length > max ? [...all.slice(0, max), `and ${all.length - max} more`] : all
}

/** The session-start line, or undefined. */
export function startLine(facts: { own?: IndexMeta; extension?: Drift }): string | undefined {
  const parts: string[] = []
  const own = facts.own
  if (own && !own.complete) parts.push(`FlowKy index partial (${own.indexedFiles} of ${own.fileCount} source files; it continues at the next session start), so the duplicate guard may miss names from the rest.`)
  const ext = facts.extension
  if (ext) {
    const since = ext.behind !== undefined ? `, ${ext.behind} commit${ext.behind === 1 ? '' : 's'} before HEAD (${ext.head.slice(0, 7)})` : `; HEAD is now ${ext.head.slice(0, 7)}`
    const where = ext.changed.length ? ` Changed since then: ${ext.changed.map(c => inline(c, 80)).join(', ')}.` : ''
    parts.push(`FlowKy: the VS Code extension's project map (.flowky/index) was generated at ${ext.commit.slice(0, 7)}${since}.${where} Its skill files can be out of date in those folders; the files themselves are the reference.`)
  }
  return parts.length ? parts.join(' ') : undefined
}

/** The mid-session line, or undefined. */
export function movedLine(from: string, to: string): string {
  return `FlowKy: HEAD moved during this session, from ${from.slice(0, 7)} to ${to.slice(0, 7)} (a checkout, pull or commit). The project map and the symbol index were built at ${from.slice(0, 7)} and are rebuilt at the next session start; files may have changed since.`
}

/** The extension's committed index metadata, read as hostile input (only its commit is used). */
export async function extensionCommit(io: Io, root: string): Promise<string | undefined> {
  const p = join(root, EXTENSION_META)
  const text = await readSafe(io, p, { maxBytes: 64 * 1024, root })
  try {
    const v = JSON.parse(text ?? '') as { commit?: unknown }
    return isCommitId(v?.commit) ? v.commit : undefined
  } catch {
    return undefined
  }
}
