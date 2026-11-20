// The one door to the outside world that the shared logic uses. Two drivers
// implement it: the Node driver behind the plugin's command hooks
// (cli/node-io.ts, works on every Claude Code with plugins) and the mod driver
// over `$` (hooks/register.ts, when the mods API is available). The logic in
// mods/ and hooks/ never touches Node or `$` directly, so one implementation
// serves both layers and the tests drive it with an in-memory Io.

export type EntryKind = 'file' | 'dir' | 'other'

export type Entry = { name: string; kind: EntryKind; size: number; mtimeMs: number }

export type Stat = { kind: EntryKind; size: number; mtimeMs: number }

export type ListOptions = { stat?: (name: string) => boolean; until?: number }

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** The program could not be started (not installed, not on PATH). */
  notFound?: boolean
  /** The time box ran out and the program was stopped. */
  timedOut?: boolean
}

export type RunOptions = {
  cwd?: string
  timeoutMs: number
  stdin?: string
  env?: Record<string, string>
  /** Inherited variables whose name starts with one of these prefixes are not passed on (case-insensitive). */
  dropEnv?: string[]
  /** The program must not be found in this folder or below it (a repository's own git.exe, say). */
  programOutside?: string
}

/**
 * How the shared reader reads a file. `maxBytes` caps what is read; a file with more than that from
 * `offset` is refused, unless `partial` (then the first `maxBytes` from `offset` are read). With
 * `root`, the file's real path (every folder resolved) must lie inside the real path of `root`.
 */
export type ReadOptions = { maxBytes: number; offset?: number; partial?: boolean; root?: string }

/**
 * Optional permissions for writeInside, for a file only its owner may read (for example `0o600`).
 * `mode`: the written file's permission bits, exactly. `dirMode`: the bits of the folders the writer
 * creates for it (existing folders are left as they are). POSIX only: on Windows the file keeps the
 * access list it inherits from its folder (the user profile's, for a file under the user's folder).
 * A driver that cannot apply them refuses the write rather than write the file more widely readable.
 * The plugin's own state files do not use them.
 */
export type WriteOptions = { mode?: number; dirMode?: number }

export interface Io {
  /**
   * Driver primitives behind readSafe (below). Shared logic never calls them directly: a test
   * (tests-node/read-sites.test.mjs) fails on a call outside this file and the drivers.
   * The Node driver refuses links and special files here too, and caps readText at 16 MB.
   */
  readText(path: string): Promise<string | undefined>
  readRange(path: string, offset: number, bytes: number): Promise<string | undefined>
  /**
   * The strict read (Node and mods drivers): a regular file only (never a symbolic link, a
   * junction, a device or a pipe, so it never blocks), at most `maxBytes`, and inside `root` by
   * real path when given. Undefined when refused, missing or unreadable.
   */
  readFile?(path: string, opts: ReadOptions): Promise<string | undefined>
  /**
   * The entries of a folder. `stat` says which file names need their size and time (the others
   * come back with size 0 and mtimeMs -1, so a folder of 30,000 data files costs one readdir);
   * `until` is a time (io.now) after which no more file is statted (those come back the same way).
   */
  list(dir: string, opts?: ListOptions): Promise<Entry[]>
  stat(path: string): Promise<Stat | undefined>
  /**
   * Removes a file the plugin itself made outside the state folder (FlowKy Pro's temporary git
   * index). Not in the shared Node driver: FlowKy Pro adds a confined one for its own use.
   */
  remove?(path: string): Promise<void>
  /** Runs a program by argument vector, no shell, time-boxed; never throws. */
  run(argv: readonly string[], options: RunOptions): Promise<RunResult>
  now(): Promise<number>
  env(name: string): string | undefined
  platform: 'windows' | 'macos' | 'linux' | 'other'
  /**
   * The ONLY way the shared logic writes a file. The file must stay inside `root`: a path outside it,
   * a symbolic link on the way (any folder from `root` down, or the file itself) or a real path that
   * resolves outside is refused; the text goes to a temporary file that is then renamed over the
   * target (Node driver). Throws when refused. A driver without it cannot write. `opts`: see WriteOptions.
   */
  writeInside?(root: string, path: string, text: string, opts?: WriteOptions): Promise<void>
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
  /**
   * Loads a package from the PROJECT's node_modules, which runs repository code. Not in the shared
   * Node driver: only FlowKy Pro adds it, used after the user's consent.
   */
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

/**
 * THE way shared logic reads a file (a repository can supply any path it reads): a regular file
 * only (no symbolic link or junction, no device, pipe or folder, so a read never blocks), at most
 * `maxBytes`, and, with `root`, a real path inside the project. Drivers with the strict primitive
 * (readFile) do it in one place; for the others (the tests' memory driver) the same rules are
 * applied here with stat, isLink and readRange. Undefined when refused, missing or unreadable.
 */
export async function readSafe(io: Io, path: string, opts: ReadOptions): Promise<string | undefined> {
  if (io.readFile) return io.readFile(path, opts).catch(() => undefined)
  if (await (io.isLink ? io.isLink(path) : Promise.resolve(false)).catch(() => true)) return undefined
  const st = await io.stat(path).catch(() => undefined)
  if (!st || st.kind !== 'file') return undefined
  const offset = Math.max(0, opts.offset ?? 0)
  const avail = Math.max(0, st.size - offset)
  if (avail > opts.maxBytes && !opts.partial) return undefined
  if (opts.root && io.isLink) {
    const r = opts.root.replace(/\\/g, '/').replace(/\/+$/, '')
    const p = path.replace(/\\/g, '/')
    if (!p.toLowerCase().startsWith(r.toLowerCase() + '/')) return undefined
    let at = r
    for (const part of p.slice(r.length + 1).split('/').slice(0, -1)) {
      at = `${at}/${part}`
      if (part === '..' || (await io.isLink(at).catch(() => true))) return undefined
    }
  }
  return io.readRange(path, offset, Math.min(opts.maxBytes, avail)).catch(() => undefined)
}

/** Default cap for the small JSON files the plugin reads (config, state, settings). */
export const SMALL_FILE_BYTES = 1024 * 1024

/** A whole text file through readSafe, up to 16 MB (the plain readText's cap). */
export function readWhole(io: Io, path: string, root?: string): Promise<string | undefined> {
  return readSafe(io, path, { maxBytes: 16 * 1024 * 1024, root })
}

/** Reads (through readSafe) and parses a JSON file; undefined when missing or refused, `{ error }` when broken. */
export async function readJson<T>(io: Io, path: string, opts: Partial<ReadOptions> = {}): Promise<{ value?: T; error?: string }> {
  const text = await readSafe(io, path, { maxBytes: SMALL_FILE_BYTES, ...opts })
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
