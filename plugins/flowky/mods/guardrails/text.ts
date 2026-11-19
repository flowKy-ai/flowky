// Repository text that reaches a message: file names, symbol names, one signature line and the
// first line of a failed command's output. Every such piece goes through these helpers: control
// and invisible formatting characters removed (bidirectional overrides included), one line, no
// backticks (the messages put names inside `code`), and a hard length cap.

/** Control characters, zero-width and bidirectional formatting characters, line and paragraph separators. */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g

/** Strips invisible characters, keeps newlines (\r\n becomes \n) and tabs, caps the length. */
export function clean(text: unknown, max = 300): string {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, '')
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s
}

/** One line, no backticks, collapsed whitespace, capped: safe inside `code` in a message. */
export function inline(text: unknown, max = 160): string {
  return clean(String(text ?? '').replace(/[\n\t]/g, ' '), max * 2)
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** A short hex digest of a text (FNV-1a, two seeds, 16 hex digits): fingerprints only, never security. */
export function digest(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

const WINDOWS_PATH = /^[A-Za-z]:[\\/]|^\\\\/

/** Forward slashes, no trailing slash. */
export function posix(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Whether paths of this root compare without case (a Windows drive path). */
export function caseless(root: string): boolean {
  return WINDOWS_PATH.test(root) || /^[A-Za-z]:$/.test(root)
}

/**
 * `path` relative to `root`, with forward slashes, or undefined when it is outside the root (or
 * not a usable path). Accepts both separators on both sides: an agent on Windows sends backslash
 * paths; a relative path is taken as relative to the root. A `..` segment is refused.
 */
export function relativeTo(root: string, path: string): string | undefined {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\u0000')) return undefined
  const r = posix(root)
  const p = posix(path)
  const fold = caseless(r) || caseless(p) ? (s: string) => s.toLowerCase() : (s: string) => s
  let rel: string
  if (/^([A-Za-z]:)?\//.test(p)) {
    if (!r || !fold(p).startsWith(fold(r) + '/')) return undefined
    rel = p.slice(r.length + 1)
  } else rel = p.replace(/^(\.\/)+/, '')
  if (!rel || rel.split('/').some(s => s === '..' || s === '')) return undefined
  return rel
}

/** Whether two project-relative paths name the same file (case-insensitive on a Windows root). */
export function samePath(root: string, a: string, b: string): boolean {
  return caseless(root) ? a.toLowerCase() === b.toLowerCase() : a === b
}
