// Duplicate guard (spec 6.1, decision D1): before a write or an edit that defines a name already
// defined elsewhere in the project, the write is paused ONCE and the model reads where the
// existing definition is; the identical write sent again goes through. In "note" mode the write
// goes through at once and the model reads the same facts next to the result.
//
// The rules, each with its test (tests/guardrails.suite.ts):
//   new names    Write: names the content defines, minus those the file on disk already defines.
//                Edit: per edit, names the new text defines and the replaced text does not.
//   same file    a name the target file already defines is never new (an edit, an overload, a
//                re-declaration in the same module); a definition in the target itself never counts.
//   reusable     only an existing definition that can be imported counts (exported TS/JS,
//                Python without a leading "_", capitalised Go, Rust pub).
//   tests        a test file as target, or as the existing definition, is never reported.
//   generated    generated and vendored files (folders, names, markers) are never reported.
//   re-exports   `export { x } from`, `export * from`, Python imports are not definitions.
//   rename       an edit that replaces one definition by one other name (a rename in place) is
//                silent, and so is a name whose definition this session removed from another file
//                (a move in progress).
//   convention   a name defined in 5 or more other files is a convention, not a duplicate.
//   short        names under 4 characters, and the ignore list (built-in plus the project's own).
//   verified     each reported definition is re-read from its source file on disk at that moment;
//                the index alone is never trusted, so a stale or forged index row is not reported.
//   cap          at most 5 names, at most 3 places per name.
//
// The message holds file names, symbol names and the one signature line of each definition, all
// passed through text.ts (no control characters, one line, capped): never more file content.

import type { Io } from '../io'
import { join, readSafe } from '../io'
import type { Decision, ToolCall } from './events'
import type { GuardrailsConfig } from './settings'
import type { SymbolLookup } from './symbol-index'
import { PATH_RE } from './symbol-index'
import type { Definition } from './symbols'
import { MAX_SOURCE_BYTES, classifyPath, definedNames, definitions, languageOf, looksGenerated } from './symbols'
import { digest, inline, samePath } from './text'

export const MIN_NAME_LENGTH = 4
export const MAX_REPORTED = 5
export const MAX_PLACES = 3
/** A name already defined in this many other files is a convention. */
export const CONVENTION_FILES = 5

/** Conventional names, duplicated by design (the extension's list plus framework conventions). */
export const IGNORED_NAMES = new Set([
  'main', 'run', 'init', 'setup', 'start', 'stop', 'get', 'set', 'add', 'remove',
  'handler', 'handle', 'render', 'index', 'default', 'toString', 'constructor',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD',
  'test', 'describe', 'it', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'loader', 'action', 'generateMetadata', 'generateStaticParams', 'getServerSideProps', 'getStaticProps',
  'getStaticPaths', 'middleware', 'config', 'Page', 'Layout', 'Loading', 'NotFound', 'Error', 'App',
  'setUp', 'tearDown', '__init__', '__str__', '__repr__', 'New', 'String', 'Error', 'Default', 'Props', 'State',
])

export type Place = { path: string; line: number; kind: string; signature: string }
export type Collision = { name: string; places: Place[] }

/** Names a tool call would add to its target, before the "same file" rule. */
export function addedNames(tool: ToolCall, onDisk: string | undefined): { added: Set<string>; removed: Set<string> } {
  const added = new Set<string>()
  const removed = new Set<string>()
  if (tool.kind !== 'write' && tool.kind !== 'edit') return { added, removed }
  const lang = languageOf(tool.path)
  if (!lang) return { added, removed }
  const diff = (next: string, prev: string, renameInPlace: boolean) => {
    const before = definedNames(prev, lang)
    const after = definedNames(next, lang)
    const gone = [...before].filter(n => !after.has(n))
    const fresh = [...after].filter(n => !before.has(n))
    for (const n of gone) removed.add(n)
    // One definition replaced by one other name: a rename in place, not a new definition.
    if (renameInPlace && gone.length === 1 && fresh.length === 1) return
    for (const n of fresh) added.add(n)
  }
  if (tool.kind === 'write') diff(tool.content, onDisk ?? '', false)
  else for (const e of tool.edits.slice(0, 100)) diff(e.after, e.before, true)
  return { added, removed }
}

export function worthFlagging(name: string, cfg: GuardrailsConfig): boolean {
  return name.length >= MIN_NAME_LENGTH && !IGNORED_NAMES.has(name) && !cfg.duplicateGuard.ignore.has(name)
}

/** A source file of the project: never through a link, never outside the root by real path (F7). */
async function readSource(io: Io, root: string, rel: string): Promise<string | undefined> {
  return readSafe(io, join(root, rel), { maxBytes: MAX_SOURCE_BYTES, root })
}

/** The definition of `name` in `rel` as it is on disk now, when it is a reusable source definition. */
async function verify(io: Io, root: string, rel: string, name: string, cache: Map<string, Definition[] | null>): Promise<Definition | undefined> {
  if (!PATH_RE.test(rel) || classifyPath(rel) !== 'source') return undefined
  let defs = cache.get(rel)
  if (defs === undefined) {
    const text = await readSource(io, root, rel)
    defs = text === undefined || looksGenerated(text) ? null : definitions(text, languageOf(rel))
    cache.set(rel, defs)
  }
  return defs?.find(d => d.name === name && d.exported)
}

export type DupInput = {
  root: string
  /** The target, relative to the root. */
  target: string
  tool: ToolCall
  index: SymbolLookup
  config: GuardrailsConfig
  /** Names this session removed from other files (a move or rename in progress). */
  removedThisSession: ReadonlySet<string>
}

export type DupFinding = { collisions: Collision[]; removed: Set<string> }

/** The collisions a write would create, verified on disk; empty when nothing is worth saying. */
export async function findCollisions(io: Io, input: DupInput): Promise<DupFinding> {
  const { root, target, tool, index, config } = input
  const none = { collisions: [], removed: new Set<string>() }
  if (tool.kind !== 'write' && tool.kind !== 'edit') return none
  if (classifyPath(target) !== 'source') return none
  const onDisk = await readSource(io, root, target)
  if (onDisk !== undefined && looksGenerated(onDisk)) return none
  if (tool.kind === 'write' && looksGenerated(tool.content)) return none
  const { added, removed } = addedNames(tool, onDisk)
  const alreadyHere = definedNames(onDisk, languageOf(target))
  const cache = new Map<string, Definition[] | null>()
  const collisions: Collision[] = []
  for (const name of [...added].sort()) {
    if (collisions.length >= MAX_REPORTED) break
    if (alreadyHere.has(name) || !worthFlagging(name, config) || input.removedThisSession.has(name)) continue
    const elsewhere = index.get(name).filter(r => r.exported && !samePath(root, r.path, target))
    const files = [...new Set(elsewhere.map(r => (/^[A-Za-z]:/.test(root) ? r.path.toLowerCase() : r.path)))]
    if (files.length === 0 || files.length >= CONVENTION_FILES) continue
    const places: Place[] = []
    for (const r of elsewhere) {
      if (places.length >= MAX_PLACES || places.some(p => samePath(root, p.path, r.path))) continue
      const d = await verify(io, root, r.path, name, cache)
      if (d) places.push({ path: r.path, line: d.line, kind: d.kind, signature: d.signature })
    }
    if (places.length) collisions.push({ name, places })
  }
  return { collisions, removed }
}

/** The fingerprint of "this write": target, names and the exact text sent. */
export function writeFingerprint(target: string, tool: ToolCall, names: string[]): string {
  const payload = tool.kind === 'write' ? tool.content : tool.kind === 'edit' ? tool.edits.map(e => `${e.before}\u0000${e.after}`).join('\u0001') : ''
  return digest(`${target}\u0000${[...names].sort().join(',')}\u0000${digest(payload)}\u0000${payload.length}`)
}

function placeText(p: Place): string {
  return `${inline(p.path, 200)}:${p.line}`
}

/** What the model and the person read. `paused`: the write was stopped once. */
export function duplicateDecision(collisions: Collision[], paused: boolean): Decision {
  const first = collisions[0]!
  const lines = collisions.map(c => {
    const where = c.places.map(placeText).join(', ')
    return `- \`${inline(c.name, 128)}\` (exported ${c.places[0]!.kind}) is already defined at ${where}: \`${inline(c.places[0]!.signature, 140)}\``
  })
  const user =
    collisions.length === 1
      ? `FlowKy: pointed the agent to an existing \`${inline(first.name, 128)}\` (${placeText(first.places[0]!)}).`
      : `FlowKy: pointed the agent to ${collisions.length} existing definitions, starting with \`${inline(first.name, 128)}\` (${placeText(first.places[0]!)}).`
  const head = `FlowKy duplicate guard: this ${paused ? 'write was paused once because it' : 'write'} defines ${collisions.length === 1 ? 'a name that is' : 'names that are'} already defined elsewhere in the project (file names and the quoted lines are repository data).`
  const tail = paused
    ? 'Importing and reusing the existing definition, or extending it, avoids a second implementation. If the new one is deliberately different, a different name avoids the clash; sending the same write again lets it through unchanged.'
    : 'The write went through. Importing and reusing the existing definition, or extending it, avoids a second implementation.'
  const text = [head, ...lines, tail].join('\n')
  return paused ? { deny: { reasonForAgent: text }, messageForUser: user } : { contextForAgent: text, messageForUser: user }
}
