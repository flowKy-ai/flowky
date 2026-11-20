// The mods driver of the Io door: the same shared logic, reached through `$`.

import type { EngineInterface } from 'claude-code'
import type { Io } from '../mods/io'
import { HOME_DIR_NAME } from '../mods/paths'

const posix = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * `userDir`: the user's Claude folder, derived from the session's own transcript path
 * (`<folder>/projects/<project>/<session>.jsonl`), never assumed. `flowkyHome`: the user's FlowKy
 * folder as flowkyHomeFor worked it out, or undefined.
 */
export function modIo($: EngineInterface, platform: Io['platform'], transcriptPath?: string, flowkyHome?: string): Io {
  const fold = (p: string) => (platform === 'windows' ? p.toLowerCase() : p)
  const userDir = (() => {
    const t = transcriptPath ? posix(transcriptPath) : ''
    const m = /^(.*)\/projects\/[^/]+\/[^/]+\.jsonl$/i.exec(t)
    return m ? m[1] : undefined
  })()
  return {
    userDir: () => userDir,
    flowkyHome: () => flowkyHome,
    async isLink(path) {
      const st = await $.fs.stat(path).catch(() => undefined)
      return Boolean(st?.isLink)
    },
    async writeInside(root, path, text, opts) {
      // The mods API cannot set file permissions: a write that asks for them is refused, never made wider.
      if (opts?.mode !== undefined || opts?.dirMode !== undefined) throw new Error(`refused: ${path} needs file permissions this driver cannot set`)
      // The mods API has no lstat-free rename: check every step for a link, then write.
      const r = posix(root)
      const p = posix(path)
      if (!fold(p).startsWith(fold(r) + '/') || p.split('/').includes('..')) throw new Error(`refused: ${path} is outside the project`)
      let at = r
      for (const part of p.slice(r.length + 1).split('/')) {
        at = `${at}/${part}`
        const st = await $.fs.stat(at).catch(() => undefined)
        if (st?.isLink) throw new Error(`refused: ${at} is a link`)
      }
      const real = await $.fs.stat(r, { resolve: true }).catch(() => undefined)
      const parent = await $.fs.stat(p.slice(0, p.lastIndexOf('/')), { resolve: true }).catch(() => undefined)
      const rr = (real as { realPath?: string } | undefined)?.realPath
      const pr = (parent as { realPath?: string } | undefined)?.realPath
      if (rr && pr && !(fold(posix(pr)) + '/').startsWith(fold(posix(rr)) + '/')) throw new Error(`refused: ${path} resolves outside the project`)
      await $.fs.write(path, text)
    },
    async readFile(path, o) {
      // The strict read through $: a plain file (not a link, not special), the size within the cap,
      // its folder's real path inside the root when given; then a read of at most that many bytes.
      const st = await $.fs.stat(path).catch(() => undefined)
      if (!st || st.isLink || st.kind !== 'file') return undefined
      const offset = Math.max(0, o.offset ?? 0)
      const avail = Math.max(0, st.size - offset)
      if (avail > o.maxBytes && !o.partial) return undefined
      if (o.root) {
        const real = (await $.fs.stat(posix(o.root), { resolve: true }).catch(() => undefined)) as { realPath?: string } | undefined
        const dir = posix(path).slice(0, posix(path).lastIndexOf('/'))
        const at = (await $.fs.stat(dir, { resolve: true }).catch(() => undefined)) as { realPath?: string } | undefined
        if (real?.realPath && at?.realPath) {
          const r = fold(posix(real.realPath))
          const d = fold(posix(at.realPath))
          if (d !== r && !d.startsWith(r + '/')) return undefined
        } else {
          // No real path given: no folder between the root and the file may be a link.
          const r = posix(o.root)
          if (dir !== r && !fold(dir).startsWith(fold(r) + '/')) return undefined
          let cur = r
          for (const part of dir.slice(r.length + 1).split('/').filter(Boolean)) {
            cur = `${cur}/${part}`
            if (part === '..' || (await $.fs.stat(cur).catch(() => undefined))?.isLink) return undefined
          }
        }
      }
      return $.fs.read(path, { offset, length: Math.min(o.maxBytes, avail, 16 * 1024 * 1024) }).then(
        t => (typeof t === 'string' ? t : undefined),
        () => undefined,
      )
    },
    async readText(path) {
      return this.readFile!(path, { maxBytes: 16 * 1024 * 1024 })
    },
    async readRange(path, offset, bytes) {
      return this.readFile!(path, { maxBytes: Math.min(bytes, 4 * 1024 * 1024), offset, partial: true })
    },
    async list(dir) {
      const entries = await $.fs.list(dir)
      return entries.map(e => ({ name: e.name, kind: e.kind === 'file' ? 'file' : e.kind === 'dir' ? 'dir' : 'other', size: e.size, mtimeMs: e.mtimeMs }))
    },
    async stat(path) {
      return $.fs.stat(path).then(
        s => ({ kind: s.kind === 'file' ? 'file' : s.kind === 'dir' ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs }),
        () => undefined,
      )
    },
    async run() {
      // The mods layer starts no process.
      return { exitCode: -1, stdout: '', stderr: 'not available in the mods layer', notFound: true }
    },
    async now() {
      return $.clock.now()
    },
    env() {
      // The mods layer keeps its state inside the project (.flowky/cache/).
      return undefined
    },
    platform,
  }
}

/**
 * The user's FlowKy folder as the mods layer sees it: FLOWKY_HOME when set (returned as set, so a
 * relative value is refused by mods/home.ts rather than replaced), else `<home>/.flowky`, else, when
 * the Claude folder is the usual `<home>/.claude`, its sibling `.flowky`. Undefined when unknown.
 */
export async function flowkyHomeFor($: EngineInterface, transcriptPath?: string): Promise<string | undefined> {
  const value = async (read: () => Promise<string | undefined>) => {
    try {
      const v = await read()
      return typeof v === 'string' && v !== '' ? posix(v) : undefined
    } catch {
      return undefined
    }
  }
  // Each name is a string literal: the mods API reads the variable names off the source.
  const configured = await value(() => $.env.get('FLOWKY_HOME'))
  if (configured !== undefined) return configured
  const home = (await value(() => $.env.get('HOME'))) ?? (await value(() => $.env.get('USERPROFILE')))
  if (home) return `${home}/${HOME_DIR_NAME}`
  const t = transcriptPath ? posix(transcriptPath) : ''
  const m = /^(.*)\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/i.exec(t)
  return m ? `${m[1]}/${HOME_DIR_NAME}` : undefined
}
