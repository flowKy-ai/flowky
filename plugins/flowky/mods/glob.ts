// Glob matching for project-relative POSIX paths: the subset of gitignore and
// skill `paths` syntax a project uses in practice. No `$` here: pure code.
//
//   *      any run of characters except "/"
//   **     any number of whole path segments (also none)
//   ?      one character except "/"
//   [abc]  a character class ([!abc] negates, a-z ranges)
//   {a,b}  alternatives (nesting allowed)
//
// Globs come from repositories (.gitignore, config files): they are matched
// by a small automaton walked over the path once (time proportional to the
// path length times the glob length), never by a backtracking regular
// expression, so "*a*a*a*a*c" cannot keep a hook busy. An invalid class such
// as [z-a] matches nothing; it never throws. More than 64 brace alternatives,
// or a glob over 1,000 characters, matches nothing.

/** A compiled glob: what gitignore rules and every path filter use. */
export type Matcher = { test(path: string): boolean }

type Tok =
  | { t: 'char'; c: string }
  | { t: 'any' } // ?
  | { t: 'class'; neg: boolean; ranges: [string, string][]; ok: boolean }
  | { t: 'star' } // * inside a segment
  | { t: 'globstar' } // **/ : zero or more whole segments
  | { t: 'rest' } // final ** : everything that is left

/** Expands `{a,b}` alternatives into a list of plain globs (at most 65; the caller refuses more than 64). */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  if (open < 0) return [glob]
  let depth = 0
  for (let i = open; i < glob.length; i++) {
    const c = glob[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        const inner = glob.slice(open + 1, i)
        const parts: string[] = []
        let level = 0
        let start = 0
        for (let j = 0; j < inner.length; j++) {
          const d = inner[j]
          if (d === '{') level += 1
          else if (d === '}') level -= 1
          else if (d === ',' && level === 0) {
            parts.push(inner.slice(start, j))
            start = j + 1
          }
        }
        parts.push(inner.slice(start))
        const head = glob.slice(0, open)
        const tail = glob.slice(i + 1)
        const out: string[] = []
        for (const p of parts) {
          out.push(...expandBraces(head + p + tail))
          if (out.length > 64) break
        }
        return out
      }
    }
  }
  return [glob]
}

function tokenize(glob: string): Tok[] {
  const toks: Tok[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      let j = i
      while (glob[j + 1] === '*') j++
      const run = j - i + 1
      const atStart = i === 0 || glob[i - 1] === '/'
      const atEnd = j + 1 === glob.length || glob[j + 1] === '/'
      i = j
      if (run >= 2 && atStart && atEnd) {
        if (j + 1 === glob.length) toks.push({ t: 'rest' })
        else {
          toks.push({ t: 'globstar' })
          i += 1 // the "/" after "**"
        }
      } else if (toks[toks.length - 1]?.t !== 'star') toks.push({ t: 'star' })
    } else if (c === '?') toks.push({ t: 'any' })
    else if (c === '[') {
      const close = glob.indexOf(']', i + 2)
      if (close < 0) {
        toks.push({ t: 'char', c: '[' })
        continue
      }
      let body = glob.slice(i + 1, close)
      const neg = body.startsWith('!') || body.startsWith('^')
      if (neg) body = body.slice(1)
      const ranges: [string, string][] = []
      let ok = true
      for (let k = 0; k < body.length; k++) {
        const a = body[k] === '\\' && k + 1 < body.length ? body[++k]! : body[k]!
        if (body[k + 1] === '-' && k + 2 < body.length) {
          const b = body[k + 2]!
          if (b < a) ok = false // [z-a]: an invalid class matches nothing
          ranges.push([a, b])
          k += 2
        } else ranges.push([a, a])
      }
      toks.push({ t: 'class', neg, ranges, ok })
      i = close
    } else if (c === '\\' && i + 1 < glob.length) toks.push({ t: 'char', c: glob[++i]! })
    else toks.push({ t: 'char', c })
  }
  return toks
}

function oneChar(tok: Tok, ch: string): boolean {
  if (ch === '/') return tok.t === 'char' && tok.c === '/'
  if (tok.t === 'char') return tok.c === ch
  if (tok.t === 'any') return true
  if (tok.t === 'class') {
    if (!tok.ok) return false
    const inside = tok.ranges.some(([a, b]) => ch >= a && ch <= b)
    return tok.neg ? !inside : inside
  }
  return false
}

/**
 * Thompson simulation. States: `i` = before token i; `-(i+1)` = inside a segment of the globstar at
 * token i (some characters of a segment read, its "/" not yet).
 */
function run(toks: Tok[], path: string): boolean {
  const close = (set: Set<number>): Set<number> => {
    const stack = [...set]
    while (stack.length) {
      const s = stack.pop()!
      if (s < 0) continue
      const tok = toks[s]
      if (tok && (tok.t === 'star' || tok.t === 'globstar' || tok.t === 'rest') && !set.has(s + 1)) {
        set.add(s + 1)
        stack.push(s + 1)
      }
    }
    return set
  }
  let cur = close(new Set([0]))
  for (const ch of path) {
    const next = new Set<number>()
    for (const s of cur) {
      if (s < 0) {
        const g = -s - 1
        if (ch === '/') next.add(g)
        else next.add(s)
        continue
      }
      const tok = toks[s]
      if (!tok) continue
      if (tok.t === 'rest') next.add(s)
      else if (tok.t === 'star') {
        if (ch !== '/') next.add(s)
      } else if (tok.t === 'globstar') next.add(ch === '/' ? s : -(s + 1))
      else if (oneChar(tok, ch)) next.add(s + 1)
    }
    if (next.size === 0) return false
    cur = close(next)
  }
  return cur.has(toks.length)
}

const NEVER: Matcher = { test: () => false }

/** A matcher for a glob relative to the project root ("src/**\/*.ts"). Never throws. */
export function globToRegExp(glob: string): Matcher {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (g.length > 1000) return NEVER
  const alternatives = expandBraces(g)
  if (alternatives.length > 64) return NEVER
  const compiled = alternatives.map(tokenize)
  return { test: (path: string) => compiled.some(t => run(t, path)) }
}

const cache = new Map<string, Matcher>()

/** Whether a project-relative path matches a glob. Paths are compared with "/". */
export function matchGlob(glob: string, path: string): boolean {
  let m = cache.get(glob)
  if (!m) {
    m = globToRegExp(glob)
    if (cache.size > 2000) cache.clear()
    cache.set(glob, m)
  }
  return m.test(toPosix(path))
}

export function matchAny(globs: readonly string[], path: string): boolean {
  return globs.some(g => matchGlob(g, path))
}

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** `path` relative to `root`, POSIX, or undefined when it is outside the root. Case-insensitive on drive paths. */
export function relativeTo(root: string, path: string): string | undefined {
  const r = toPosix(root).replace(/\/+$/, '')
  const p = toPosix(path)
  const isDrive = /^[a-z]:\//i.test(r)
  const same = isDrive ? p.toLowerCase().startsWith(r.toLowerCase() + '/') : p.startsWith(r + '/')
  if (same) return p.slice(r.length + 1)
  if (!/^([a-z]:)?\//i.test(p)) return p // already relative
  return undefined
}
