// The user's own folders, outside every project, and when they can be trusted.
//
// - The FlowKy folder (`~/.flowky`, or `FLOWKY_HOME`) holds what a cloned
//   repository must never be able to supply: FlowKy Pro's consents and machine
//   id today, and the signed plan file later.
// - The Claude folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`) is read for two
//   things only: the settings that say which plugins are enabled, and the old
//   0.2.x consent file that is migrated once (mods/migrate.ts).
//
// A folder is trusted only when it is an absolute path and does not lie inside
// the project: a repository's own settings could otherwise point the variable
// at a file the repository ships. A FLOWKY_HOME that is relative is refused, not
// replaced by the default, so a mistake is visible in the health check instead
// of being silently papered over. The FlowKy folder is also refused when it is
// a symbolic link or a junction (checked by the callers that read or write in
// it, because that check needs the disk: see homeUsable).

import type { Io } from './io'

const posix = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const fold = (p: string) => (/^[a-z]:\//i.test(p) ? p.toLowerCase() : p)

/** `dir` when it is absolute and not inside (nor equal to) `root`; undefined otherwise. */
export function trustedFolder(dir: string | undefined, root?: string): string | undefined {
  const d = dir === undefined ? '' : posix(dir)
  if (!d || !/^([A-Za-z]:)?\//.test(d)) return undefined
  if (root) {
    const r = posix(root)
    if (fold(d) === fold(r) || fold(d).startsWith(fold(r) + '/')) return undefined
  }
  return d
}

/** The user's FlowKy folder when it can be trusted for this project. */
export function trustedHome(io: Io, root?: string): string | undefined {
  return trustedFolder(io.flowkyHome?.(), root)
}

/** The user's Claude folder when it can be trusted for this project (settings and the 0.2.x migration only). */
export function trustedClaudeDir(io: Io, root?: string): string | undefined {
  return trustedFolder(io.userDir?.(), root)
}

/** The FlowKy folder, when trusted and not a link (a missing folder is fine: it is created on first write). */
export async function homeUsable(io: Io, root?: string): Promise<string | undefined> {
  const home = trustedHome(io, root)
  if (!home) return undefined
  if (await (io.isLink?.(home) ?? Promise.resolve(false)).catch(() => true)) return undefined
  return home
}

/** One line for the health check: where the FlowKy folder is, or why it is not used. */
export function homeDescription(io: Io, root: string): string {
  const raw = io.flowkyHome?.()
  const home = trustedHome(io, root)
  if (home) return home
  if (raw === undefined || raw === '') return 'unknown (no home folder found)'
  return `REFUSED (${raw}): FLOWKY_HOME must be an absolute path outside the project`
}
