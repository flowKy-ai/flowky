// The Node driver of the Io door, used by the command hooks (dist/hook.mjs).
//
// Writes: only writeInside / copyInside / removeInside / createExclusive, each
// confined to a root folder, refusing symbolic links on the way and real paths
// that resolve outside it; file writes go through a temporary file and a rename.
//
// Processes: a bare program name is never resolved from the working folder
// (Windows searches it first, and a repository could ship a git.exe, node.exe or
// cmd.exe there): `node` is the running Node binary, `cmd` is %ComSpec% or
// System32\cmd.exe, and anything else is looked up on PATH with the working
// folder, relative entries and empty entries left out.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsc, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join as pathJoin, relative, resolve, sep } from 'node:path'

import type { Entry, Io, ReadOptions, RunOptions, RunResult, Stat } from '../mods/io'
import { HOME_DIR_NAME } from '../mods/paths'

function kindOf(s: { isFile(): boolean; isDirectory(): boolean }): Entry['kind'] {
  return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'
}

const WIN = process.platform === 'win32'
const same = (a: string, b: string) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b)

const inside = (dir: string, folder: string) => {
  const rel = relative(resolve(folder), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolves a program to an absolute path without ever looking in `cwd`; undefined when not found.
 * With `outside`, a PATH entry in that folder or below it is skipped too (a repository's own git).
 */
export async function resolveProgram(cmd: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env, outside?: string): Promise<string | undefined> {
  if (isAbsolute(cmd)) return cmd
  if (cmd.includes('/') || cmd.includes('\\')) return undefined // a relative path would be read from the working folder
  const name = cmd.toLowerCase()
  if (name === 'node' || name === 'node.exe') return process.execPath
  if (WIN && (name === 'cmd' || name === 'cmd.exe')) {
    const spec = env.ComSpec ?? env.COMSPEC
    if (spec && isAbsolute(spec) && /\\cmd\.exe$/i.test(spec)) return spec
    return pathJoin(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe')
  }
  const work = cwd ? resolve(cwd) : undefined
  const entries = String(env.PATH ?? env.Path ?? '').split(delimiter)
  // Without a shell, Windows can only start .exe and .com files.
  const exts = WIN ? (/\.(exe|com)$/i.test(cmd) ? [''] : ['.exe', '.com']) : ['']
  for (const raw of entries) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!entry || !isAbsolute(entry)) continue
    if (work && same(resolve(entry), work)) continue
    if (outside && inside(WIN ? entry.toLowerCase() : entry, WIN ? outside.toLowerCase() : outside)) continue
    for (const e of exts) {
      const candidate = pathJoin(entry, cmd + e)
      const st = await fs.stat(candidate).catch(() => undefined)
      if (st?.isFile()) return candidate
    }
  }
  return undefined
}

/** Leaves in PATH only absolute entries that are not the working folder (every spelling of the key). */
export function sanitizePath(env: NodeJS.ProcessEnv, cwd: string | undefined): void {
  const work = cwd ? resolve(cwd) : undefined
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== 'PATH' || typeof env[key] !== 'string') continue
    env[key] = env[key]!
      .split(delimiter)
      .filter(raw => {
        const entry = raw.trim().replace(/^"(.*)"$/, '$1')
        return entry !== '' && isAbsolute(entry) && !(work && same(resolve(entry), work))
      })
      .join(delimiter)
  }
}

/** Checks that `path` may be written under `root`; creates the missing folders. Returns the absolute target. */
async function checkedTarget(root: string, path: string): Promise<string> {
  const base = resolve(root)
  const target = resolve(path)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refused: ${path} is outside ${root}`)
  const baseSt = await fs.lstat(base).catch(() => undefined)
  if (!baseSt) await fs.mkdir(base, { recursive: true })
  else if (!baseSt.isDirectory() && !baseSt.isSymbolicLink()) throw new Error(`refused: ${root} is not a folder`)
  // No symbolic link (or junction) on the way: each folder from the root down, then the file itself.
  let at = base
  for (const part of rel.split(sep).slice(0, -1)) {
    at = pathJoin(at, part)
    const st = await fs.lstat(at).catch(() => undefined)
    if (!st) await fs.mkdir(at)
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refused: ${at} is a link or not a folder`)
  }
  const existing = await fs.lstat(target).catch(() => undefined)
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`refused: ${path} is a link or not a file`)
  const inner = relative(await fs.realpath(base), await fs.realpath(dirname(target)))
  if (inner.startsWith('..') || isAbsolute(inner)) throw new Error(`refused: ${path} resolves outside ${root}`)
  return target
}

async function renameInto(tmp: string, target: string): Promise<void> {
  try {
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

const tmpName = (target: string) => `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`

/** Cap of the plain readText: no file the plugin reads is this large. */
const TEXT_CAP_BYTES = 16 * 1024 * 1024

/**
 * The strict read: lstat says a regular file (a symbolic link, a junction, a device, a pipe or a
 * folder is refused), the size fits, the real folder is inside `root` when given, and the file is
 * opened non-blocking and without following a link, then checked again on the open handle.
 */
async function strictRead(path: string, o: ReadOptions, realCache: Map<string, string>): Promise<string | undefined> {
  const real = async (p: string) => {
    let r = realCache.get(p)
    if (r === undefined) {
      r = await fs.realpath(p)
      realCache.set(p, r)
    }
    return r
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const st = await fs.lstat(path)
    if (!st.isFile()) return undefined
    const offset = Math.max(0, o.offset ?? 0)
    const avail = Math.max(0, st.size - offset)
    if (avail > o.maxBytes && !o.partial) return undefined
    if (o.root) {
      const rel = relative(await real(resolve(o.root)), await real(dirname(resolve(path))))
      if (rel.startsWith('..') || isAbsolute(rel)) return undefined
    }
    handle = await fs.open(path, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0) | (fsc.O_NOFOLLOW ?? 0))
    const hs = await handle.stat()
    if (!hs.isFile() || (hs.ino && st.ino && hs.ino !== st.ino)) return undefined
    const buf = Buffer.alloc(Math.min(o.maxBytes, avail))
    let read = 0
    while (read < buf.length) {
      const { bytesRead } = await handle.read(buf, read, buf.length - read, offset + read)
      if (bytesRead <= 0) break
      read += bytesRead
    }
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function nodeIo(): Io {
  const realCache = new Map<string, string>()
  return {
    async readFile(path, opts) {
      return strictRead(path, opts, realCache)
    },
    // The plain primitives get the same refusals (no link, no special file), with a 16 MB cap.
    async readText(path) {
      return strictRead(path, { maxBytes: TEXT_CAP_BYTES }, realCache)
    },
    async readRange(path, offset, bytes) {
      return strictRead(path, { maxBytes: Math.max(0, bytes), offset, partial: true }, realCache)
    },
    async list(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      // The files' sizes and times are read 32 at a time (one after the other is slow on Windows).
      const out: Entry[] = []
      for (let i = 0; i < entries.length; i += 32) {
        const batch = await Promise.all(
          entries.slice(i, i + 32).map(async (e): Promise<Entry> => {
            if (e.isSymbolicLink()) return { name: e.name, kind: 'other', size: 0, mtimeMs: 0 }
            if (e.isFile()) {
              const st = await fs.stat(`${dir}/${e.name}`).catch(() => undefined)
              return { name: e.name, kind: 'file', size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 }
            }
            return { name: e.name, kind: e.isDirectory() ? 'dir' : 'other', size: 0, mtimeMs: 0 }
          }),
        )
        out.push(...batch)
      }
      return out
    },
    async stat(path): Promise<Stat | undefined> {
      try {
        const s = await fs.stat(path)
        return { kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return undefined
      }
    },
    async run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
      const [cmd, ...args] = argv
      if (!cmd) return { exitCode: -1, stdout: '', stderr: 'empty command', notFound: true }
      const env: NodeJS.ProcessEnv = { ...process.env }
      // A variable a repository could set through its Claude Code settings (GIT_DIR, GIT_CONFIG_*...).
      if (options.dropEnv?.length) for (const k of Object.keys(env)) if (options.dropEnv.some(p => k.toUpperCase().startsWith(p.toUpperCase()))) delete env[k]
      if (options.env) Object.assign(env, options.env)
      // cmd.exe itself looks in the current folder before PATH unless this is set.
      if (WIN) env.NoDefaultCurrentDirectoryInExePath = '1'
      // The child (cmd.exe, npm, a compiler) searches PATH too: hand it only absolute entries, never
      // an empty or relative one, nor the working folder, which would make it look in the repository.
      sanitizePath(env, options.cwd)
      const program = await resolveProgram(cmd, options.cwd, env, options.programOutside)
      if (!program) return { exitCode: -1, stdout: '', stderr: `${cmd} not found on PATH (the working folder is never searched)`, notFound: true }
      return new Promise(resolvePromise => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const done = (r: RunResult) => {
          if (!settled) {
            settled = true
            resolvePromise(r)
          }
        }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(program, args, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (err) {
          return done({ exitCode: -1, stdout: '', stderr: String(err), notFound: true })
        }
        const timer = setTimeout(() => {
          child.kill()
          done({ exitCode: -1, stdout, stderr, timedOut: true })
        }, options.timeoutMs)
        child.stdout?.on('data', d => {
          if (stdout.length < 2_000_000) stdout += String(d)
        })
        child.stderr?.on('data', d => {
          if (stderr.length < 2_000_000) stderr += String(d)
        })
        child.on('error', err => {
          clearTimeout(timer)
          done({ exitCode: -1, stdout, stderr: String(err), notFound: (err as NodeJS.ErrnoException).code === 'ENOENT' })
        })
        child.on('close', code => {
          clearTimeout(timer)
          done({ exitCode: code ?? -1, stdout, stderr })
        })
        child.stdin?.on('error', () => undefined)
        if (options.stdin !== undefined) child.stdin?.end(options.stdin)
        else child.stdin?.end()
      })
    },
    async now() {
      return Date.now()
    },
    env(name) {
      return process.env[name]
    },
    async writeInside(root, path, text) {
      const target = await checkedTarget(root, path)
      const tmp = tmpName(target)
      await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
      await renameInto(tmp, target)
    },
    async copyInside(root, from, to) {
      const target = await checkedTarget(root, to)
      const src = await fs.lstat(from)
      if (!src.isFile()) throw new Error(`refused: ${from} is a link or not a file`)
      const tmp = tmpName(target)
      await fs.copyFile(from, tmp, 1 /* COPYFILE_EXCL */)
      await renameInto(tmp, target)
    },
    async removeInside(root, path, opts) {
      const base = resolve(root)
      const target = resolve(path)
      const rel = relative(base, target)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refused: ${path} is outside ${root}`)
      let at = base
      for (const part of rel.split(sep).slice(0, -1)) {
        at = pathJoin(at, part)
        const st = await fs.lstat(at).catch(() => undefined)
        if (!st) return
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refused: ${at} is a link or not a folder`)
      }
      const st = await fs.lstat(target).catch(() => undefined)
      if (!st) return
      if (st.isSymbolicLink() && opts?.link) {
        // The link itself, never its target (a junction to a folder is removed with rmdir on Windows).
        await fs.unlink(target).catch(() => fs.rmdir(target))
        return
      }
      if (st.isSymbolicLink()) throw new Error(`refused: ${path} is a link`)
      if (st.isDirectory()) {
        if (!opts?.recursive) throw new Error(`refused: ${path} is a folder`)
        await fs.rm(target, { recursive: true, force: true })
      } else await fs.rm(target, { force: true })
    },
    async isLink(path) {
      const st = await fs.lstat(path).catch(() => undefined)
      return Boolean(st?.isSymbolicLink())
    },
    async createExclusive(root, path, text) {
      const target = await checkedTarget(root, path)
      try {
        await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      }
    },
    sleep(ms) {
      return new Promise(r => setTimeout(r, ms))
    },
    async hashFile(path) {
      try {
        return createHash('sha256').update(await fs.readFile(path)).digest('hex').slice(0, 32)
      } catch {
        return undefined
      }
    },
    userDir() {
      const configured = process.env.CLAUDE_CONFIG_DIR
      if (configured) return configured.replace(/\\/g, '/')
      const home = homedir()
      return home ? pathJoin(home, '.claude').replace(/\\/g, '/') : undefined
    },
    flowkyHome() {
      // Returned as set, even when relative: mods/home.ts refuses it instead of guessing.
      const configured = process.env.FLOWKY_HOME
      if (configured) return configured.replace(/\\/g, '/')
      const home = homedir()
      return home ? pathJoin(home, HOME_DIR_NAME).replace(/\\/g, '/') : undefined
    },
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'other',
  }
}
