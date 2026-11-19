// The plugin's own symbol index: built by the plugin, for the duplicate guard, with no dependency
// and no network. The FlowKy VS Code extension writes its own index in .flowky/index/; a plugin
// user may not have the extension, and the plugin never writes there.
//
// Files (all in the ignored state folder, through the safe writer):
//   .flowky/cache/index/symbols.tsv  # header lines, then name\tkind\tpath\tline\texported\thash
//                                    (the extension's four columns, plus exported 0/1 and the
//                                    file's content hash; readers of the four columns still work)
//   .flowky/cache/index/files.tsv    path\tsize\tmtime\thash: what was parsed, for the next
//                                    incremental build
//   .flowky/cache/index/meta.json    {generator, version, builtAt, commit, fileCount, indexedFiles,
//                                    symbolCount, complete, elapsedMs, languages}
//   .flowky/cache/index/recent.json  files the agent wrote during the session, re-parsed at once
//                                    (PostToolUse), so a definition made a minute ago counts
//
// When: at SessionStart, from the same tree scan as the project map (.gitignore respected),
// incrementally: a file whose size and modification time did not change keeps its rows; the
// others are read, hashed and parsed until the time budget (2.5 s) runs out. Then the index is
// marked complete:false and the next session goes on. At most 30,000 candidate files.
//
// Trust: everything read back from these files is treated as hostile (a repository can commit
// anything, even below an ignored folder): every row is validated, the files are size-capped,
// and the duplicate guard re-reads each definition it reports from the source file itself
// before it names it (dup-guard.ts). A forged row can therefore hide a duplicate, never invent one.

import type { Io } from '../io'
import { join, readSafe } from '../io'
import type { Scan } from '../project-map'
import { STATE_DIR, writeStateText } from '../state'
import type { Definition, Kind, Lang } from './symbols'
import { LANGUAGE_NAMES, MAX_SOURCE_BYTES, classifyPath, definitions, generatedReason, languageOf } from './symbols'
import { digest } from './text'

export const INDEX_DIR = `${STATE_DIR}/index`
export const INDEX_FILES = { symbols: 'index/symbols.tsv', files: 'index/files.tsv', meta: 'index/meta.json', recent: 'index/recent.json' } as const
export const INDEX_BUDGET_MS = 2500
export const INDEX_MAX_FILES = 30_000
export const INDEX_VERSION = 1

const MAX_INDEX_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 300_000
const MAX_RECENT = 200
const NAME_RE = /^[A-Za-z_$][\w$]{0,127}$/
/** Plain path characters only; a row with anything else is dropped. */
export const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.\-/ +()[\]~#,]{1,300}$/
const KINDS = new Set<Kind>(['function', 'class', 'struct', 'enum', 'trait'])

export type IndexRow = { name: string; kind: Kind; path: string; line: number; exported: boolean; hash: string }
export type IndexMeta = {
  generator: 'flowky-plugin'
  version: number
  builtAt: number
  commit: string | null
  fileCount: number
  indexedFiles: number
  symbolCount: number
  complete: boolean
  elapsedMs: number
  languages: string[]
  /** Source files read but left out: with a generated marker, minified, or over 1 MB (behaviour review, finding 5). */
  skipped: { generated: number; minified: number; tooLarge: number }
}
type FileEntry = { size: number; mtime: number; hash: string; skipped?: 'generated' | 'minified' }

// ---- reading (hostile input) ----

function parseRows(text: string | undefined): IndexRow[] {
  const rows: IndexRow[] = []
  if (!text) return rows
  for (const line of text.split('\n')) {
    if (rows.length >= MAX_ROWS) break
    if (!line || line[0] === '#' || line.length > 1024) continue
    const [name, kind, path, ln, exported, hash] = line.replace(/\r$/, '').split('\t')
    if (!name || !NAME_RE.test(name) || !path || !PATH_RE.test(path) || !KINDS.has(kind as Kind)) continue
    const n = Number(ln)
    rows.push({
      name,
      kind: kind as Kind,
      path,
      line: Number.isInteger(n) && n > 0 && n < 10_000_000 ? n : 0,
      exported: exported === '1',
      hash: /^[0-9a-f]{16}$/.test(hash ?? '') ? hash! : '',
    })
  }
  return rows
}

function parseFiles(text: string | undefined): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>()
  if (!text) return out
  for (const line of text.split('\n')) {
    if (out.size >= INDEX_MAX_FILES * 2) break
    if (!line || line[0] === '#' || line.length > 1024) continue
    const [path, size, mtime, hash, skipped] = line.replace(/\r$/, '').split('\t')
    const s = Number(size)
    const m = Number(mtime)
    if (!path || !PATH_RE.test(path) || !Number.isFinite(s) || !Number.isFinite(m) || !/^[0-9a-f]{16}$/.test(hash ?? '')) continue
    out.set(path, { size: s, mtime: m, hash: hash!, ...(skipped === 'generated' || skipped === 'minified' ? { skipped } : {}) })
  }
  return out
}

/** Every read of this module: the shared reader, inside the project by real path (F1, F7). */
async function readCapped(io: Io, root: string, path: string, max: number): Promise<string | undefined> {
  return readSafe(io, path, { maxBytes: max, root })
}

export function parseMeta(value: unknown): IndexMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const int = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1e13 ? x : 0)
  if (v.generator !== 'flowky-plugin') return undefined
  return {
    generator: 'flowky-plugin',
    version: int(v.version),
    builtAt: int(v.builtAt),
    commit: typeof v.commit === 'string' && /^[0-9a-f]{40}$/.test(v.commit) ? v.commit : null,
    fileCount: int(v.fileCount),
    indexedFiles: int(v.indexedFiles),
    symbolCount: int(v.symbolCount),
    complete: v.complete === true,
    elapsedMs: int(v.elapsedMs),
    languages: Array.isArray(v.languages) ? v.languages.filter((l): l is string => typeof l === 'string' && /^[\w/ +#-]{1,40}$/.test(l)).slice(0, 10) : [],
    skipped: {
      generated: int((v.skipped as Record<string, unknown> | undefined)?.generated),
      minified: int((v.skipped as Record<string, unknown> | undefined)?.minified),
      tooLarge: int((v.skipped as Record<string, unknown> | undefined)?.tooLarge),
    },
  }
}

export async function readMeta(io: Io, root: string): Promise<IndexMeta | undefined> {
  const text = await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.meta), 64 * 1024)
  if (!text) return undefined
  try {
    return parseMeta(JSON.parse(text))
  } catch {
    return undefined
  }
}

type Recent = Record<string, { hash: string; rows: IndexRow[]; at: number }>

async function readRecent(io: Io, root: string): Promise<Map<string, { hash: string; rows: IndexRow[]; at: number }>> {
  const out = new Map<string, { hash: string; rows: IndexRow[]; at: number }>()
  const text = await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.recent), 2 * 1024 * 1024)
  if (!text) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [path, e] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_RECENT)) {
    if (!PATH_RE.test(path) || !e || typeof e !== 'object') continue
    const r = e as { hash?: unknown; rows?: unknown; at?: unknown }
    const rows = Array.isArray(r.rows) ? parseRows(r.rows.filter(x => typeof x === 'string').slice(0, 2000).join('\n')).filter(x => x.path === path) : []
    out.set(path, { hash: typeof r.hash === 'string' && /^[0-9a-f]{16}$/.test(r.hash) ? r.hash : '', rows, at: typeof r.at === 'number' ? r.at : 0 })
  }
  return out
}

export type SymbolLookup = {
  /** Every indexed definition of a name, with the session's own writes applied. */
  get(name: string): IndexRow[]
  size: number
}

/** The index as the duplicate guard reads it: the built rows, overlaid with the files written this session. */
export async function loadIndex(io: Io, root: string): Promise<SymbolLookup> {
  const rows = parseRows(await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.symbols), MAX_INDEX_BYTES))
  const recent = await readRecent(io, root)
  const byName = new Map<string, IndexRow[]>()
  const add = (r: IndexRow) => {
    let b = byName.get(r.name)
    if (!b) byName.set(r.name, (b = []))
    b.push(r)
  }
  for (const r of rows) if (!recent.has(r.path)) add(r)
  for (const e of recent.values()) for (const r of e.rows) add(r)
  return { get: name => byName.get(name) ?? [], size: byName.size }
}

// ---- building ----

function tsvRow(r: IndexRow): string {
  return `${r.name}\t${r.kind}\t${r.path}\t${r.line}\t${r.exported ? 1 : 0}\t${r.hash}`
}

function rowsOf(path: string, defs: Definition[], hash: string): IndexRow[] {
  return defs.map(d => ({ name: d.name, kind: d.kind, path, line: d.line, exported: d.exported, hash }))
}

/** Reads and parses one source file; undefined when it is not a source file to index. */
export async function parseSourceFile(io: Io, root: string, rel: string): Promise<{ rows: IndexRow[]; hash: string; skipped?: 'generated' | 'minified' } | undefined> {
  if (!PATH_RE.test(rel) || classifyPath(rel) !== 'source') return undefined
  const lang = languageOf(rel)
  const text = await readCapped(io, root, join(root, rel), MAX_SOURCE_BYTES)
  if (text === undefined) return undefined
  const hash = digest(text)
  const why = generatedReason(text)
  if (why) return { rows: [], hash, skipped: why }
  return { rows: rowsOf(rel, definitions(text, lang), hash), hash }
}

export type BuildOutcome = { meta: IndexMeta; written: boolean; parsed: number; reused: number }

/**
 * Builds or updates the index from a tree scan (the project map's). `commit` is HEAD as git gave
 * it (40 hex digits) or null. Throws only when the safe writer refuses; callers fail open.
 */
export async function buildIndex(io: Io, root: string, scan: Scan, opts: { commit: string | null; budgetMs?: number; maxFiles?: number }): Promise<BuildOutcome> {
  const started = await io.now()
  const deadline = started + (opts.budgetMs ?? INDEX_BUDGET_MS)
  const maxFiles = opts.maxFiles ?? INDEX_MAX_FILES
  const sources = scan.files.filter(f => PATH_RE.test(f.path) && classifyPath(f.path) === 'source')
  const tooLarge = sources.filter(f => f.size > MAX_SOURCE_BYTES).length
  const candidates = sources.filter(f => f.size <= MAX_SOURCE_BYTES).slice(0, maxFiles)
  const skippedAs = { generated: 0, minified: 0 }
  const prevFiles = parseFiles(await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.files), MAX_INDEX_BYTES))
  const prevRows = new Map<string, IndexRow[]>()
  for (const r of parseRows(await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.symbols), MAX_INDEX_BYTES))) {
    let b = prevRows.get(r.path)
    if (!b) prevRows.set(r.path, (b = []))
    b.push(r)
  }
  const files = new Map<string, FileEntry>()
  const rows: IndexRow[] = []
  const langs = new Set<Lang>()
  let complete = !scan.partial && scan.files.filter(f => classifyPath(f.path) === 'source').length <= maxFiles
  let parsed = 0
  let reused = 0
  let outOfTime = false
  // In batches of 32 reads at a time (sequential reads are the cost on Windows), results kept in scan order.
  const BATCH = 32
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    if (!outOfTime && (await io.now()) > deadline) outOfTime = true
    const results = await Promise.all(
      batch.map(async f => {
        const mtime = Math.round(f.mtimeMs ?? -1)
        const prev = prevFiles.get(f.path)
        if (prev && prev.size === f.size && prev.mtime === mtime && mtime >= 0) return { f, kind: 'reused' as const, entry: prev }
        // The deadline is checked for each file, not once per batch (review F2).
        if (outOfTime || (await io.now()) > deadline) {
          outOfTime = true
          return { f, kind: 'skipped' as const }
        }
        const one = await parseSourceFile(io, root, f.path)
        return one ? { f, kind: 'parsed' as const, entry: { size: f.size, mtime, hash: one.hash, skipped: one.skipped }, rows: one.rows } : { f, kind: 'none' as const }
      }),
    )
    for (const r of results) {
      const lang = languageOf(r.f.path)
      if (lang) langs.add(lang)
      if (r.kind === 'reused') {
        if (r.entry.skipped) skippedAs[r.entry.skipped]++
        files.set(r.f.path, r.entry)
        for (const row of prevRows.get(r.f.path) ?? []) rows.push(row)
        reused++
      } else if (r.kind === 'skipped') {
        // Not parsed this time: what the last build knew stays until the next session.
        complete = false
        for (const row of prevRows.get(r.f.path) ?? []) rows.push(row)
      } else if (r.kind === 'parsed') {
        parsed++
        if (r.entry.skipped) skippedAs[r.entry.skipped]++
        files.set(r.f.path, { size: r.entry.size, mtime: r.entry.mtime, hash: r.entry.hash, ...(r.entry.skipped ? { skipped: r.entry.skipped } : {}) })
        for (const row of r.rows) rows.push(row)
      }
    }
  }
  const meta: IndexMeta = {
    generator: 'flowky-plugin',
    version: INDEX_VERSION,
    builtAt: await io.now(),
    commit: opts.commit && /^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : null,
    fileCount: candidates.length,
    indexedFiles: files.size,
    symbolCount: rows.length,
    complete,
    elapsedMs: (await io.now()) - started,
    languages: [...langs].map(l => LANGUAGE_NAMES[l]).sort(),
    skipped: { ...skippedAs, tooLarge },
  }
  const symbolsText = `# FlowKy plugin symbol index (generated; never edit; safe to delete): name\tkind\tpath\tline\texported\thash\n${rows.map(tsvRow).join('\n')}${rows.length ? '\n' : ''}`
  const filesText = `# FlowKy plugin index files: path\tsize\tmtime\thash\tskipped\n${[...files].map(([p, e]) => `${p}\t${e.size}\t${e.mtime}\t${e.hash}${e.skipped ? `\t${e.skipped}` : ''}`).join('\n')}${files.size ? '\n' : ''}`
  let written = false
  const current = await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.symbols), MAX_INDEX_BYTES)
  if (current !== symbolsText) {
    await writeStateText(io, root, INDEX_FILES.symbols, symbolsText)
    written = true
  }
  if ((await readCapped(io, root, join(root, STATE_DIR, INDEX_FILES.files), MAX_INDEX_BYTES)) !== filesText) await writeStateText(io, root, INDEX_FILES.files, filesText)
  await writeStateText(io, root, INDEX_FILES.meta, JSON.stringify(meta, null, 2) + '\n')
  // What the session wrote is in the rows now, unless the build ran out of time before that file.
  const recent = await readRecent(io, root)
  if (recent.size) {
    const keep: Recent = {}
    for (const [p, e] of recent) if (files.get(p)?.hash !== e.hash) keep[p] = { hash: e.hash, rows: e.rows, at: e.at }
    await writeStateText(io, root, INDEX_FILES.recent, JSON.stringify(serializeRecent(keep)) + '\n')
  }
  return { meta, written, parsed, reused }
}

function serializeRecent(r: Recent): Record<string, { hash: string; rows: string[]; at: number }> {
  const out: Record<string, { hash: string; rows: string[]; at: number }> = {}
  for (const [p, e] of Object.entries(r)) out[p] = { hash: e.hash, rows: e.rows.map(tsvRow), at: e.at }
  return out
}

/** After the agent wrote a file: re-parse that one file now, so the index knows its definitions. */
export async function updateIndexedFile(io: Io, root: string, rel: string): Promise<void> {
  if (!PATH_RE.test(rel)) return
  const cls = classifyPath(rel)
  if (cls === 'unsupported' || cls === 'excluded') return
  const recent = await readRecent(io, root)
  const one = cls === 'source' ? await parseSourceFile(io, root, rel) : undefined
  // A test or generated file, or a deleted one, has no reusable definitions: an empty entry hides its old rows.
  const entry = { hash: one?.hash ?? '', rows: one?.rows ?? [], at: await io.now() }
  const all: Recent = {}
  for (const [p, e] of recent) if (p !== rel) all[p] = e
  all[rel] = entry
  const keys = Object.keys(all).sort((a, b) => all[b]!.at - all[a]!.at).slice(0, MAX_RECENT)
  const kept: Recent = {}
  for (const k of keys) kept[k] = all[k]!
  await writeStateText(io, root, INDEX_FILES.recent, JSON.stringify(serializeRecent(kept)) + '\n')
}
