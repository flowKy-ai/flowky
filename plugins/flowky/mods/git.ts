// The one way the plugin runs git (FlowKy and FlowKy Pro): every call goes through runGit.
//
// A folder can carry its own .git/config (an archive, a shared drive, a template), and a
// repository's Claude Code settings can set environment variables. Neither may make git run a
// program or reach the network when FlowKy asks it a question. So every call:
//   - is an argument vector, no shell, with a bounded time;
//   - passes, before the subcommand, the switches that turn off what a configuration can make git
//     execute: the file-system monitor, the pager, hooks, external diff and text conversion
//     drivers, credential helpers and askpass, ssh and every transport (protocol.allow=never, so a
//     partial clone cannot fetch missing objects either), and the untracked cache;
//   - drops every inherited GIT_* variable (GIT_DIR, GIT_CONFIG_*, GIT_EXEC_PATH, GIT_SSH...) and
//     sets its own (no optional locks, no prompt, no lazy fetch, a plain pager, C locale);
//   - finds git on PATH outside the project folder (never a git.exe the repository ships).
// Aliases cannot replace git's own subcommands, and the plugin only calls built-in ones.

import type { Io, RunResult } from './io'

export const GIT_TIMEOUT_MS = 2000

/** `-c` switches applied to every call (tests check them one by one). */
export const GIT_SAFETY = [
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.pager=cat',
  'core.hooksPath=/dev/null/flowky-no-hooks',
  'core.askPass=',
  'core.sshCommand=false',
  'credential.helper=',
  'diff.external=',
  'protocol.allow=never',
  'fetch.recurseSubmodules=false',
  'submodule.recurse=false',
  'maintenance.auto=false',
  'gc.auto=0',
] as const

export const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
}

/** The full argument vector for `git <args>`. */
export function gitArgv(args: readonly string[]): string[] {
  return ['git', '--no-pager', ...GIT_SAFETY.flatMap(c => ['-c', c]), ...args]
}

/**
 * Runs git in `root`. `extra.env` adds variables of the caller's own (FlowKy Pro's temporary
 * index); `extra.config` adds `-c` switches. Never throws (Io.run does not).
 */
export async function runGit(io: Io, root: string, args: readonly string[], extra: { timeoutMs?: number; env?: Record<string, string>; config?: string[]; stdin?: string } = {}): Promise<RunResult> {
  const argv = gitArgv([...(extra.config ?? []).flatMap(c => ['-c', c]), ...args])
  return io.run(argv, {
    cwd: root,
    timeoutMs: Math.max(100, extra.timeoutMs ?? GIT_TIMEOUT_MS),
    env: { ...GIT_ENV, ...(extra.env ?? {}) },
    dropEnv: ['GIT_'],
    programOutside: root,
    stdin: extra.stdin,
  })
}

/** The trimmed output of a successful call, or undefined. */
export async function gitOutput(io: Io, root: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string | undefined> {
  const r = await runGit(io, root, args, { timeoutMs })
  return r.exitCode === 0 && !r.timedOut ? r.stdout.trim() : undefined
}
