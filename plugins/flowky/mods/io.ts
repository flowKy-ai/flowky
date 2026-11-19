// The one door to the outside world that the shared logic uses. Two drivers
// implement it: the Node driver behind the plugin's command hooks
// (cli/node-io.ts, works on every Claude Code with plugins) and the mod driver
// over `$` (hooks/register.ts, when the mods API is available). The logic in
// mods/ and hooks/ never touches Node or `$` directly, so one implementation
// serves both layers and the tests drive it with an in-memory Io.

export type EntryKind = 'file' | 'dir' | 'other'

export type Entry = { name: string; kind: EntryKind; size: number; mtimeMs: number }

export type Stat = { kind: EntryKind; size: number; mtimeMs: number }

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** The program could not be started (not installed, not on PATH). */
  notFound?: boolean
  /** The time box ran out and the program was stopped. */
  timedOut?: boolean
}

export type RunOptions = { cwd?: string; timeoutMs: number; stdin?: string; env?: Record<string, string> }

export interface Io {
  /** The whole text of a file, or undefined when it is missing or unreadable. */
  readText(path: string): Promise<string | undefined>
  /** At most `bytes` bytes from `offset` (default 0), as text. */
  readRange(path: string, offset: number, bytes: number): Promise<string | undefined>
  list(dir: string): Promise<Entry[]>
  stat(path: string): Promise<Stat | undefined>
  /** Removes a file outside any project (a leftover the plugin itself made, such as a temporary git index). */
  remove(path: string): Promise<void>
  /** Runs a program by argument vector, no shell, time-boxed; never throws. */
  run(argv: readonly string[], options: RunOptions): Promise<RunResult>
  now(): Promise<number>
  env(name: string): string | undefined
  platform: 'windows' | 'macos' | 'linux' | 'other'
  /**
   * The ONLY way the shared logic writes a file. The file must stay inside `root`: a path outside it,
   * a symbolic link on the way (any folder from `root` down, or the file itself) or a real path that
   * resolves outside is refused; the text goes to a temporary file that is then renamed over the
   * target (Node driver). Throws when refused. A driver without it cannot write.
   */
  writeInside?(root: string, path: string, text: string): Promise<void>
  /** Byte-exact copy of `from` to `to` (inside `root`, same checks as writeInside). Node driver only. */
  copyInside?(root: string, from: string, to: string): Promise<void>
  /**
   * Removes a file, or a folder with `recursive`, inside `root`, never through a symbolic link. With
   * `link`, a symbolic link (or junction) at `path` itself is removed, never what it points to. Node driver only.
   */
  removeInside?(root: string, path: string, opts?: { recursive?: boolean; link?: boolean }): Promise<void>
  /** Whether `path` itself is a symbolic link or a junction (not followed). Node driver only. */
  isLink?(path: string): Promise<boolean>
  /** Creates a file only if it does not exist yet (inside `root`); false when it exists. Used as a lock. */
  createExclusive?(root: string, path: string, text: string): Promise<boolean>
  /** Waits (lock retries). */
  sleep?(ms: number): Promise<void>
  /** A fast hash of a file's bytes (binary-safe), or undefined when missing. */
  hashFile?(path: string): Promise<string | undefined>
  /**
   * The user's own Claude folder (outside every project): read for the enabled-plugin settings and,
   * once, for the 0.2.x consent file that is migrated. Undefined when unknown.
   */
  userDir?(): string | undefined
  /**
   * The user's FlowKy folder: FLOWKY_HOME exactly as set (even when relative: the caller refuses it,
   * see mods/home.ts), else `~/.flowky`. Undefined when unknown.
   */
  flowkyHome?(): string | undefined
  /** Node driver only: loads a package from the PROJECT's node_modules (never the plugin's), or undefined. */
  loadProjectModule?(root: string, name: string): unknown
  /**
   * Set by the dispatcher for hooks that may run before the user trusted the folder (SessionStart):
   * nothing may then be written outside the project's ignored state folder (no machine id is created).
   */
  beforeTrust?: boolean
  /**
   * Set by the Node driver only when BOTH stdin and stdout are a terminal: a person typed the command.
   * The assistant's shell tool has no terminal, so the verbs that change a consent refuse without it.
   */
  interactive?: boolean
}

export function join(...parts: string[]): string {
  const cleaned = parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')))
  return cleaned.join('/').replace(/\\/g, '/')
}

export function dirname(path: string): string {
  const p = path.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i <= 0 ? p : p.slice(0, i)
}

export function basename(path: string): string {
  const p = path.replace(/\\/g, '/')
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Reads and parses a JSON file; undefined when missing, `{ error }` when broken. */
export async function readJson<T>(io: Io, path: string): Promise<{ value?: T; error?: string }> {
  const text = await io.readText(path)
  if (text === undefined) return {}
  try {
    return { value: JSON.parse(text) as T }
  } catch (err) {
    return { error: `${basename(path)} is not valid JSON (${String(err).slice(0, 120)})` }
  }
}

/** Short stable hash (FNV-1a, two seeds) of a text, as 16 hex digits. */
export function hash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** Rough token count of a text: about four characters a token for code and English. */
export function estimateTokens(text: string | number): number {
  const n = typeof text === 'number' ? text : text.length
  return Math.ceil(n / 4)
}

export function kilo(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
