// .gitignore rules: parsed per directory, matched in order, last match wins.
// Pure code; the scanner reads the files and hands their text here.

import { globToRegExp } from './glob'
import type { Matcher } from './glob'

export type IgnoreRule = {
  /** Directory of the .gitignore that holds the rule, relative to the root ('' for the root). */
  base: string
  re: Matcher
  negate: boolean
  dirOnly: boolean
}

/** Folders never worth walking, whatever .gitignore says. */
export const ALWAYS_SKIPPED = new Set(['.git', 'node_modules', '.hg', '.svn'])

export function parseGitignore(text: string, base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    line = line.replace(/^\\([#!])/, '$1')
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue
    // A slash at the start or in the middle anchors the pattern to its folder.
    const anchored = line.includes('/')
    const glob = anchored ? line.replace(/^\//, '') : `**/${line}`
    rules.push({ base, re: globToRegExp(glob), negate, dirOnly })
  }
  return rules
}

/** Whether `path` (relative to the root, POSIX) is ignored by the rules in force. */
export function isIgnored(rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean {
  let ignored = false
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    let rel: string
    if (r.base === '') rel = path
    else if (path.startsWith(r.base + '/')) rel = path.slice(r.base.length + 1)
    else continue
    if (r.re.test(rel)) ignored = !r.negate
  }
  return ignored
}
