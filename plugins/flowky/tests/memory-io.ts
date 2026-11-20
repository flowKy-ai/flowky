// An in-memory Io for the tests: a small disk, a clock that moves by hand,
// and a scripted process runner.

import type { Entry, Io, RunOptions, RunResult } from '../mods/io'

export type Disk = Record<string, string>

export type MemoryIo = Io & {
  files: Disk
  clock: { now: number }
  runs: { argv: string[]; options: RunOptions }[]
  /** Paths that stand for symbolic links: writeInside refuses them and anything below them. */
  links: Set<string>
  /** Modification times by path (default: the clock). */
  mtimes: Record<string, number>
  /** The permission bits a write asked for, by path (writeInside's `mode`). */
  modes: Record<string, number>
}

export function memoryIo(
  files: Disk = {},
  opts: { env?: Record<string, string>; run?: (argv: readonly string[], options: RunOptions) => RunResult; now?: number; tick?: number; userDir?: string | null; flowkyHome?: string | null } = {},
): MemoryIo {
  const clock = { now: opts.now ?? 1_800_000_000_000 }
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const runs: MemoryIo['runs'] = []
  const links = new Set<string>()
  const mtimes: Record<string, number> = {}
  const modes: Record<string, number> = {}
  const io: MemoryIo = {
    files,
    clock,
    runs,
    links,
    mtimes,
    modes,
    async writeInside(root, path, text, opts) {
      const r = norm(root)
      const p = norm(path)
      if (!p.startsWith(r + '/') || p.split('/').includes('..')) throw new Error(`refused: ${path} is outside`)
      for (const l of links) if (p === l || p.startsWith(l + '/')) throw new Error(`refused: ${l} is a link`)
      files[p] = text
      if (opts?.mode !== undefined) modes[p] = opts.mode
      else delete modes[p]
    },
    async copyInside(root, from, to) {
      const src = files[norm(from)]
      if (src === undefined) throw new Error(`ENOENT ${from}`)
      await io.writeInside!(root, to, src)
    },
    async removeInside(root, path, o) {
      const r = norm(root)
      const p = norm(path)
      if (!p.startsWith(r + '/') || p.split('/').includes('..')) throw new Error(`refused: ${path} is outside`)
      for (const l of links) if (p === l || p.startsWith(l + '/')) throw new Error(`refused: ${l} is a link`)
      if (files[p] !== undefined) delete files[p]
      else if (o?.recursive) for (const k of Object.keys(files)) if (k.startsWith(p + '/')) delete files[k]
    },
    async createExclusive(root, path, text) {
      if (files[norm(path)] !== undefined) return false
      await io.writeInside!(root, path, text)
      return true
    },
    async sleep(ms) {
      clock.now += ms
    },
    async hashFile(path) {
      const t = files[norm(path)]
      return t === undefined ? undefined : `h${t.length}-${[...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`
    },
    userDir() {
      return opts.userDir === null ? undefined : (opts.userDir ?? '/home/user/.claude')
    },
    flowkyHome() {
      return opts.flowkyHome === null ? undefined : (opts.flowkyHome ?? '/home/user/.flowky')
    },
    async isLink(path) {
      return links.has(norm(path))
    },
    async readText(path) {
      return files[norm(path)]
    },
    async readRange(path, offset, bytes) {
      const t = files[norm(path)]
      return t === undefined ? undefined : t.slice(offset, offset + bytes)
    },
    async list(dir) {
      const d = norm(dir)
      const seen = new Map<string, Entry>()
      for (const [p, text] of Object.entries(files)) {
        if (!p.startsWith(d + '/')) continue
        const rest = p.slice(d.length + 1)
        const name = rest.split('/')[0]!
        if (rest.includes('/')) seen.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0 })
        else seen.set(name, { name, kind: 'file', size: text.length, mtimeMs: mtimes[`${d}/${name}`] ?? clock.now })
      }
      if (seen.size === 0 && !Object.keys(files).some(p => p.startsWith(d + '/'))) throw new Error('ENOENT')
      return [...seen.values()]
    },
    async stat(path) {
      const p = norm(path)
      if (files[p] !== undefined) return { kind: 'file', size: files[p]!.length, mtimeMs: mtimes[p] ?? clock.now }
      if (Object.keys(files).some(f => f.startsWith(p + '/'))) return { kind: 'dir', size: 0, mtimeMs: 0 }
      return undefined
    },
    async remove(path) {
      delete files[norm(path)]
    },
    async run(argv, options) {
      runs.push({ argv: [...argv], options })
      return opts.run ? opts.run(argv, options) : { exitCode: -1, stdout: '', stderr: '', notFound: true }
    },
    async now() {
      clock.now += opts.tick ?? 0
      return clock.now
    },
    env(name) {
      return opts.env?.[name]
    },
    platform: 'linux',
  }
  return io
}
