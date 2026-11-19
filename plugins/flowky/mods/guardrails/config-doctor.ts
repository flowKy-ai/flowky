// The configuration doctor (spec 6.4, decision D6: /flowky:config-doctor). It reads the
// project's instructions and Claude Code settings and says what to change and where. It only
// diagnoses: it never edits, creates or deletes a file.
//
// Checks 1 to 9 are the FlowKy VS Code extension's ConfigDoctor checks, with the same ids (so the
// site's "9 checks" stays true); 10 to 17 are the ones spec 6.4 adds; 18 and 19 read the settings
// (a settings file that is not JSON, and a second copy of the guard).
//
// Inputs (read only, each file at most 256 KB): ./CLAUDE.md, ./.claude/CLAUDE.md, ./CLAUDE.local.md,
// nested CLAUDE.md files (4 folder levels, at most 200), .claude/rules/**/*.md, AGENTS.md,
// ~/.claude/CLAUDE.md, .claude/skills/*/SKILL.md, the @imports of all of these (4 hops, inside the
// project or the user's Claude folder only), .claude/settings.json and .claude/settings.local.json,
// and package.json / Makefile for the command check.
// Noise control: lines in fenced code blocks are ignored; `<!-- flowky-doctor: ignore <id> -->` on
// the line above a line ignores that check there; at most 30 findings, errors first.

import type { Io } from '../io'
import { join, readSafe } from '../io'
import { ALWAYS_SKIPPED } from '../gitignore'
import { trustedClaudeDir } from '../home'
import { PROJECT_SETTINGS, oldGuardAdvice, oldGuardEvents } from './settings'
import { EXCLUDED_DIRS } from './symbols'
import { inline, posix } from './text'

export type Severity = 'error' | 'warning' | 'info'
export type Finding = { id: string; severity: Severity; file: string; line?: number; quote?: string; message: string; fix: string }
export type DoctorFile = { path: string; content: string; role: 'root-claude' | 'nested-claude' | 'local-claude' | 'user-claude' | 'rule' | 'skill' | 'agents' | 'import' }

export const MAX_FINDINGS = 30
const MAX_FILE_BYTES = 256 * 1024
const MAX_CLAUDE_MD_LINES = 200
const MAX_RULE_LINES = 120
const MIN_DUP_LINE_LENGTH = 40
/** Invoked skill bodies are kept after compaction up to 5,000 tokens (about 4 characters a token). */
const SKILL_CAP_CHARS = 5000 * 4

const PERSONA = /\byou are (?:an?|the)\s+(?:senior|expert|experienced|world-class|10x|principal|staff)\b/i
const OVER_VERIFICATION = [/\bdouble[- ]check\b/i, /\bthink (?:carefully|hard|step by step)\b/i, /\bbe (?:very )?(?:careful|thorough|meticulous)\b/i, /\bmake (?:absolutely )?sure to\b/i, /\balways verify\b/i, /\btake your time\b/i]
const LOAD_BEARING = [/\bnever\b/i, /\balways\b/i, /\bmust not\b/i, /\bmust\b/i, /\brequired\b/i, /\bdo not\b/i, /\bdon't\b/i, /\bsecurity\b/i]
const GENERAL_KNOWLEDGE = [/\breact hooks? (?:are|is|allow)\b/i, /\brest(?:ful)? apis? (?:are|use)\b/i, /\bgit (?:is|allows|branching)\b/i, /\btypescript is a\b/i, /\bwhat is [a-z]+\?/i]

// ---- reading the inputs ----

async function readSmall(io: Io, path: string, root?: string): Promise<string | undefined> {
  return readSafe(io, path, { maxBytes: MAX_FILE_BYTES, root })
}

function rawFrontmatter(content: string): string | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  return end === -1 ? null : content.slice(3, end)
}

/** `@path` imports of a memory file, outside code blocks and code spans. */
export function importsOf(content: string): string[] {
  const out: string[] = []
  let fence = false
  for (const raw of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const line = raw.replace(/`[^`]*`/g, '')
    for (const m of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w./~-]+\.\w{1,8})/g)) out.push(m[1]!)
    if (out.length > 50) break
  }
  return out
}

export type DoctorInputs = {
  files: DoctorFile[]
  settings: { path: string; text: string }[]
  scripts?: Set<string>
  makeTargets?: Set<string>
  exists: (rel: string) => Promise<boolean>
  /** Why the doctor stopped early (a limit below was reached), said in its report. */
  partial?: string
  /** The clock and the deadline the checks respect too. */
  now?: () => Promise<number>
  deadline?: number
}

/** The doctor's work limits (review F4): total bytes read, files read, folder entries listed, time. */
export const DOCTOR_LIMITS = { totalBytes: 1024 * 1024, files: 200, entries: 5000, timeMs: 3000 }

/** Reads everything the doctor looks at. Nothing is written. */
export async function gatherDoctorInputs(io: Io, root: string, opts: { timeMs?: number } = {}): Promise<DoctorInputs> {
  const files: DoctorFile[] = []
  const seen = new Set<string>()
  const deadline = (await io.now()) + Math.min(opts.timeMs ?? DOCTOR_LIMITS.timeMs, DOCTOR_LIMITS.timeMs)
  let partial: string | undefined
  let bytes = 0
  let listed = 0
  const stop = async (): Promise<boolean> => {
    if (partial) return true
    if (files.length >= DOCTOR_LIMITS.files) partial = `${DOCTOR_LIMITS.files} files read`
    else if (bytes >= DOCTOR_LIMITS.totalBytes) partial = `${DOCTOR_LIMITS.totalBytes / 1024} KB read`
    else if (listed >= DOCTOR_LIMITS.entries) partial = `${DOCTOR_LIMITS.entries} folder entries listed`
    else if ((await io.now()) > deadline) partial = `${DOCTOR_LIMITS.timeMs / 1000} s spent`
    return partial !== undefined
  }
  const list = async (dir: string) => {
    if (await stop()) return []
    const entries = await io.list(dir).catch(() => [])
    listed += entries.length
    return entries
  }
  const add = async (abs: string, display: string, role: DoctorFile['role']) => {
    const key = posix(abs).toLowerCase()
    if (seen.has(key) || (await stop())) return
    const text = await readSmall(io, abs, display.startsWith('~/') ? undefined : root)
    if (text === undefined) return
    seen.add(key)
    bytes += text.length
    files.push({ path: display, content: text.replace(/\r\n?/g, '\n'), role })
  }
  await add(join(root, 'CLAUDE.md'), 'CLAUDE.md', 'root-claude')
  await add(join(root, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md', 'root-claude')
  await add(join(root, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'local-claude')
  await add(join(root, 'AGENTS.md'), 'AGENTS.md', 'agents')
  const claudeDir = trustedClaudeDir(io, root)
  if (claudeDir) await add(join(claudeDir, 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'user-claude')
  // Nested CLAUDE.md files, 4 folder levels down, at most 200.
  let nested = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 4 || nested >= 200) return
    const entries = await list(rel ? join(root, rel) : root)
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (nested >= 200) return
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir' && !e.name.startsWith('.') && !ALWAYS_SKIPPED.has(e.name) && !EXCLUDED_DIRS.has(e.name)) await walk(p, depth + 1)
      else if (e.kind === 'file' && e.name === 'CLAUDE.md' && rel) {
        nested++
        await add(join(root, p), p, 'nested-claude')
      }
    }
  }
  await walk('', 0)
  // Rules (any depth below .claude/rules) and skills.
  const rules = async (rel: string, depth: number): Promise<void> => {
    if (depth > 6) return
    for (const e of await list(join(root, rel))) {
      const p = `${rel}/${e.name}`
      if (e.kind === 'dir') await rules(p, depth + 1)
      else if (e.kind === 'file' && /\.md$/i.test(e.name)) await add(join(root, p), p, 'rule')
    }
  }
  await rules('.claude/rules', 0)
  for (const e of await list(join(root, '.claude', 'skills'))) {
    if (e.kind === 'dir') await add(join(root, '.claude', 'skills', e.name, 'SKILL.md'), `.claude/skills/${e.name}/SKILL.md`, 'skill')
  }
  // @imports, 4 hops, inside the project or the user's Claude folder only.
  let frontier = files.filter(f => f.role !== 'skill' && f.role !== 'rule')
  for (let hop = 0; hop < 4 && frontier.length && files.length < 400; hop++) {
    const next: DoctorFile[] = []
    for (const f of frontier) {
      const base = f.path.startsWith('~/') ? undefined : f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
      for (const imp of importsOf(f.content)) {
        let abs: string | undefined
        let display: string | undefined
        if (imp.startsWith('~/.claude/') && claudeDir) {
          abs = join(claudeDir, imp.slice('~/.claude/'.length))
          display = imp
        } else if (!imp.startsWith('~') && !imp.startsWith('/') && base !== undefined) {
          const parts: string[] = base ? base.split('/') : []
          let ok = true
          for (const seg of imp.split('/')) {
            if (seg === '..') {
              if (!parts.length) ok = false
              parts.pop()
            } else if (seg !== '.' && seg) parts.push(seg)
          }
          if (ok && parts.length) {
            display = parts.join('/')
            abs = join(root, display)
          }
        }
        if (!abs || !display || display.split('/').includes('..')) continue
        const before = files.length
        await add(abs, display, 'import')
        if (files.length > before) next.push(files[files.length - 1]!)
      }
    }
    frontier = next
  }
  const settings: { path: string; text: string }[] = []
  for (const s of PROJECT_SETTINGS) {
    const text = await readSmall(io, join(root, s), root)
    if (text !== undefined) settings.push({ path: s, text })
  }
  let scripts: Set<string> | undefined
  const pkg = await readSmall(io, join(root, 'package.json'), root)
  if (pkg !== undefined) {
    try {
      const s = (JSON.parse(pkg) as { scripts?: unknown }).scripts
      scripts = new Set(s && typeof s === 'object' ? Object.keys(s as object) : [])
    } catch {
      scripts = undefined
    }
  }
  let makeTargets: Set<string> | undefined
  const make = (await readSmall(io, join(root, 'Makefile'), root)) ?? (await readSmall(io, join(root, 'makefile'), root))
  if (make !== undefined) makeTargets = new Set([...make.matchAll(/^([A-Za-z0-9_.\-/]+)\s*:(?!=)/gm)].map(m => m[1]!))
  const exists = async (rel: string) => {
    if (!rel || rel.split('/').includes('..')) return false
    return (await io.stat(join(root, rel)).catch(() => undefined)) !== undefined
  }
  return { files, settings, scripts, makeTargets, exists, partial, now: () => io.now(), deadline: deadline + DOCTOR_LIMITS.timeMs }
}

// ---- the checks ----

type Line = { text: string; n: number; ignored: Set<string> }

/** The lines that count: outside fenced code blocks, with the ignore comments applied. */
function linesOf(content: string): Line[] {
  const out: Line[] = []
  let fence = false
  let pending = new Set<string>()
  const lines = content.split('\n')
  let start = 0
  if (lines[0]?.startsWith('---')) {
    const end = lines.findIndex((l, i) => i > 0 && l.startsWith('---'))
    if (end > 0) start = end + 1
  }
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const ig = /<!--\s*flowky-doctor:\s*ignore\s+([\w-]+(?:[\s,]+[\w-]+)*)\s*-->/.exec(raw)
    if (ig) {
      pending = new Set(ig[1]!.split(/[\s,]+/))
      continue
    }
    // Cut to 2,000 characters: the patterns below must stay linear on a hostile one-line file.
    out.push({ text: raw.slice(0, 2000), n: i + 1, ignored: pending })
    if (raw.trim()) pending = new Set()
  }
  return out
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[`*_~[\]()>#:,.;!?"']/g, ' ').split(/\s+/).filter(Boolean)
}

function normalise(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s*/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isEmphasisScaffolding(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 12 && (line.match(/[A-Z]/g) ?? []).length / letters.length > 0.6) return true
  if ((line.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length >= 3) return true
  return (line.match(/\*\*/g) ?? []).length >= 6
}

const isBullet = (t: string) => /^\s*(?:[-*+]|\d+\.)\s/.test(t)
const quote = (t: string) => inline(t.trim(), 100)

/** Total lines of a memory file with its imports expanded (each file counted once). */
function linesWithImports(f: DoctorFile, byPath: Map<string, DoctorFile>, seen = new Set<string>(), depth = 0): number {
  if (seen.has(f.path) || depth > 4) return 0
  seen.add(f.path)
  let n = f.content.split('\n').length
  const base = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  for (const imp of importsOf(f.content)) {
    const parts: string[] = base ? base.split('/') : []
    for (const seg of imp.split('/')) seg === '..' ? parts.pop() : seg !== '.' && seg && parts.push(seg)
    const child = byPath.get(imp.startsWith('~/') ? imp : parts.join('/'))
    if (child) n += linesWithImports(child, byPath, seen, depth + 1)
  }
  return n
}

const PATH_TOKEN = /^(?:\.\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6}$|^(?:\.\/)?(?:src|lib|app|apps|packages|tests?|docs|scripts|tools|bin)\/[\w@./-]+$/
const RUN_COMMAND = /\b(npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)|\b(npm)\s+(test)\b|\bmake\s+([A-Za-z0-9_][\w.-]*)/g

export async function runDoctor(inputs: DoctorInputs): Promise<Finding[]> {
  const findings: Finding[] = []
  const push = (f: Finding, line?: Line) => {
    if (line?.ignored.has(f.id)) return
    findings.push(f)
  }
  const byPath = new Map(inputs.files.map(f => [f.path, f]))
  const all: { file: DoctorFile; line: Line }[] = []
  // The checks share the inputs' deadline: past it, the doctor stops and its report says so.
  const late = async () => {
    if (!inputs.now || inputs.deadline === undefined || (await inputs.now()) <= inputs.deadline) return false
    inputs.partial ??= `${(DOCTOR_LIMITS.timeMs * 2) / 1000} s spent`
    return true
  }

  let pathChecks = 0
  for (const file of inputs.files) {
    if (await late()) break
    const lines = linesOf(file.content)
    const isClaudeMd = file.role === 'root-claude' || file.role === 'nested-claude' || file.role === 'local-claude' || file.role === 'user-claude'
    const scoped = file.role === 'rule' && /^paths:/m.test(rawFrontmatter(file.content) ?? '')
    for (const line of lines) all.push({ file, line })

    // 1. claude-md-too-long (imports included: they load with the file).
    if (isClaudeMd) {
      const total = linesWithImports(file, byPath)
      if (total > MAX_CLAUDE_MD_LINES)
        push({ id: 'claude-md-too-long', severity: 'error', file: file.path, message: `${total} lines with its imports (target: under ${MAX_CLAUDE_MD_LINES}). It loads in full every session; imports do not reduce that cost.`, fix: 'Move procedures into a skill (loads on demand) and folder-specific facts into .claude/rules/ files.' })
    }
    // 2. rule-too-long
    if (file.role === 'rule' && file.content.split('\n').length > MAX_RULE_LINES)
      push({ id: 'rule-too-long', severity: 'warning', file: file.path, message: `${file.content.split('\n').length} lines: a rule this long has become documentation.`, fix: 'Keep rules to checkable statements; move the explanation into a skill.' })
    // 3. skill-missing-description
    if (file.role === 'skill') {
      const fm = rawFrontmatter(file.content)
      if (!fm || !/^description:\s*\S/m.test(fm))
        push({ id: 'skill-missing-description', severity: 'error', file: file.path, line: 1, message: 'No description in the frontmatter: it is the only thing Claude reads to decide when to load the skill.', fix: 'Add a "description:" line saying what the skill does and when to use it.' })
      // 12. skill-over-compaction-cap
      if (file.content.length > SKILL_CAP_CHARS) {
        const offsets: number[] = [0]
        for (const l of file.content.split('\n')) offsets.push(offsets[offsets.length - 1]! + l.length + 1)
        const late = lines.find(l => offsets[l.n - 1]! > SKILL_CAP_CHARS && LOAD_BEARING.some(re => re.test(l.text)))
        push({ id: 'skill-over-compaction-cap', severity: 'warning', file: file.path, line: late?.n, quote: late ? quote(late.text) : undefined, message: `About ${Math.round(file.content.length / 4)} tokens: after compaction an invoked skill is kept only up to about 5,000 tokens from its start${late ? ', and this must/never line is past that point' : ''}.`, fix: 'Put the rules that must hold at the top of the skill, and move reference material to a separate file the skill points to.' }, late)
      }
    }

    let scopedCount = 0
    let treeRun = 0
    for (const line of lines) {
      const t = line.text.trim()
      if (!t || t.startsWith('<!--')) {
        treeRun = 0
        continue
      }
      const where = { file: file.path, line: line.n, quote: quote(t) }
      // 4. persona-block
      if (PERSONA.test(t)) push({ id: 'persona-block', severity: 'warning', ...where, message: 'Persona framing ("you are a senior engineer") does not improve output and costs context every session.', fix: 'Delete the line; state the concrete standard instead.' }, line)
      // 5. over-verification
      if (OVER_VERIFICATION.some(re => re.test(t))) push({ id: 'over-verification', severity: 'warning', ...where, message: 'Verification prompting ("double-check", "think carefully") makes recent models over-verify and spend tokens for nothing.', fix: 'Delete the line; if the check must happen, enforce it with a hook.' }, line)
      // 6. restated-general-knowledge
      if (GENERAL_KNOWLEDGE.some(re => re.test(t))) push({ id: 'restated-general-knowledge', severity: 'info', ...where, message: 'Restates public knowledge the model already has.', fix: 'Delete the line; keep only what is specific to this project.' }, line)
      // 7. emphasis-scaffolding
      if (isEmphasisScaffolding(t)) push({ id: 'emphasis-scaffolding', severity: 'info', ...where, message: 'Heavy emphasis (capitals, emoji markers, bold everywhere): when everything is critical, nothing is.', fix: 'Use plain sentences; keep emphasis for the one or two real hazards.' }, line)
      // 8. load-bearing-in-scoped-rule
      if (scoped && isBullet(line.text) && LOAD_BEARING.some(re => re.test(t)) && scopedCount < 3) {
        scopedCount++
        push({ id: 'load-bearing-in-scoped-rule', severity: 'warning', ...where, message: 'An absolute instruction in a rule with paths: frontmatter. Path-scoped rules are dropped at compaction and come back only when a matching file is read again.', fix: 'Move it to the project-root CLAUDE.md or to a rule without paths:, or enforce it with a hook.' }, line)
      }
      // 11. load-bearing-in-nested-claude-md
      if (file.role === 'nested-claude' && /\b(never|always|must)\b/i.test(t) && isBullet(line.text))
        push({ id: 'load-bearing-in-nested-claude-md', severity: 'warning', ...where, message: 'An absolute instruction in a nested CLAUDE.md: nested files are not re-injected after compaction; they reload only when Claude reads a file in that folder again.', fix: 'Move it to the project-root CLAUDE.md if it must always hold.' }, line)
      // 13. dead-path (literal tokens only)
      for (const tok of t.match(/`[^`\s]{3,200}`|(?:^|\s)(?:\.\/)?[\w@.-]+\/[\w@./-]+\.[A-Za-z0-9]{1,6}(?=[\s,.;:)]|$)/g) ?? []) {
        const p = tok.replace(/`/g, '').trim().replace(/[.,;:)]+$/, '').replace(/^@/, '')
        if (!PATH_TOKEN.test(p) || /[*<>{}$]|^https?:|:\/\//.test(p)) continue
        if (++pathChecks > 300) break
        const rel = p.replace(/^\.\//, '')
        const base = file.path.includes('/') && !file.path.startsWith('.claude/') && !file.path.startsWith('~/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
        if ((await inputs.exists(rel)) || (base && (await inputs.exists(`${base}/${rel}`)))) continue
        push({ id: 'dead-path', severity: 'warning', ...where, message: `Names ${inline(p, 80)}, which does not exist in the project.`, fix: 'Correct the path or delete the reference.' }, line)
      }
      // 14. dead-command
      for (const m of t.matchAll(RUN_COMMAND)) {
        const script = m[2] ?? m[4]
        const target = m[5]
        if (script && inputs.scripts && !inputs.scripts.has(script))
          push({ id: 'dead-command', severity: 'warning', ...where, message: `Names the script "${inline(script, 40)}", which package.json does not define.`, fix: 'Correct the command or add the script to package.json.' }, line)
        if (target && inputs.makeTargets && !inputs.makeTargets.has(target))
          push({ id: 'dead-command', severity: 'warning', ...where, message: `Names "make ${inline(target, 40)}", which the Makefile does not define.`, fix: 'Correct the command or add the target to the Makefile.' }, line)
      }
      // 15. directory-tree-in-context
      if (isClaudeMd) {
        if (/[\u251c\u2514]\u2500\u2500/.test(line.text)) treeRun = Math.max(treeRun + 1, 5)
        else if (/^\s{2,}[\w.@-]+\/?\s*(#.*)?$/.test(line.text) || /^\s*[-*]\s+`?[\w.@-]+\/`?\s*$/.test(line.text)) treeRun++
        else treeRun = 0
        if (treeRun === 5) push({ id: 'directory-tree-in-context', severity: 'info', ...where, message: 'A directory tree drawing: it goes stale and costs context every session; Claude can list folders itself.', fix: 'Replace it with one sentence per folder that matters, or delete it.' }, line)
      }
    }
  }

  // 9. duplicated-instruction and 10. near-duplicate-instruction
  const bullets = all.filter(x => isBullet(x.line.text) && x.file.role !== 'skill')
  const exact = new Map<string, { file: DoctorFile; line: Line }[]>()
  for (const b of bullets) {
    const n = normalise(b.line.text)
    if (n.length < MIN_DUP_LINE_LENGTH) continue
    let bucket = exact.get(n)
    if (!bucket) exact.set(n, (bucket = []))
    bucket.push(b)
  }
  const reported = new Set<string>()
  for (const occ of exact.values()) {
    if (new Set(occ.map(o => o.file.path)).size < 2) continue
    const [first, ...rest] = occ
    for (const o of occ) reported.add(`${o.file.path}:${o.line.n}`)
    push({ id: 'duplicated-instruction', severity: 'warning', file: first!.file.path, line: first!.line.n, quote: quote(first!.line.text), message: `The same instruction is also in ${rest.map(r => `${r.file.path}:${r.line.n}`).join(', ')}; copies cost context in each layer and drift apart.`, fix: 'Keep one copy, in the narrowest layer that always loads when it is needed.' }, first!.line)
  }
  const long = bullets.map(b => ({ ...b, w: new Set(words(normalise(b.line.text))) })).filter(b => b.w.size >= 8).slice(0, 1500)
  let near = 0
  for (let i = 0; i < long.length && near < 10; i++) {
    if (i % 100 === 0 && (await late())) break
    for (let j = i + 1; j < long.length && near < 10; j++) {
      const a = long[i]!
      const b = long[j]!
      if (reported.has(`${a.file.path}:${a.line.n}`) && reported.has(`${b.file.path}:${b.line.n}`)) continue
      if (a.file.path === b.file.path && Math.abs(a.line.n - b.line.n) < 30) continue
      let inter = 0
      for (const w of a.w) if (b.w.has(w)) inter++
      const jac = inter / (a.w.size + b.w.size - inter)
      if (jac < 0.85 || normalise(a.line.text) === normalise(b.line.text)) continue
      near++
      push({ id: 'near-duplicate-instruction', severity: 'info', file: a.file.path, line: a.line.n, quote: quote(a.line.text), message: `Nearly the same instruction as ${b.file.path}:${b.line.n}.`, fix: 'Merge them into one.' }, a.line)
    }
  }

  // 16. agents-md-shadowed
  const agents = inputs.files.find(f => f.role === 'agents')
  const rootClaude = inputs.files.filter(f => f.role === 'root-claude')
  if (agents && rootClaude.length && !rootClaude.some(f => importsOf(f.content).some(i => /(^|\/)AGENTS\.md$/.test(i))))
    findings.push({ id: 'agents-md-shadowed', severity: 'warning', file: 'AGENTS.md', message: 'AGENTS.md exists next to a CLAUDE.md, and Claude Code reads AGENTS.md only when CLAUDE.md imports it.', fix: `Add the line "@AGENTS.md" to ${rootClaude[0]!.path}, or move what matters into it.` })

  // 17. contradiction-candidate
  const claims: { pol: 'pos' | 'neg'; subj: string; file: string; line: Line; text: string }[] = []
  for (const x of all) {
    if (x.file.role === 'skill') continue
    const t = x.line.text.toLowerCase().replace(/[`*_]/g, '')
    for (const m of t.matchAll(/\b(always|never|do not|don't|must not|must)\s+(use|run|commit|call|add|edit|write|push|import|create|delete)\s+([\w.@/-]+(?:\s+[\w.@/-]+)?)/g)) {
      const neg = m[1] === 'never' || m[1] === 'do not' || m[1] === "don't" || m[1] === 'must not'
      claims.push({ pol: neg ? 'neg' : 'pos', subj: `${m[2]} ${m[3]}`, file: x.file.path, line: x.line, text: x.line.text })
    }
    for (const m of t.matchAll(/(?:^|[.;:]\s+|^\s*[-*]\s+)(use|run)\s+([\w.@/-]+(?:\s+[\w.@/-]+)?)/g)) claims.push({ pol: 'pos', subj: `${m[1]} ${m[2]}`, file: x.file.path, line: x.line, text: x.line.text })
  }
  // Negative claims indexed by subject: one pass, not positives x claims (review F4).
  const negatives = new Map<string, typeof claims>()
  for (const c of claims) if (c.pol === 'neg') (negatives.get(c.subj) ?? negatives.set(c.subj, []).get(c.subj)!).push(c)
  let contra = 0
  for (const p of claims) {
    if (contra >= 5) break
    if (p.pol !== 'pos') continue
    const n = negatives.get(p.subj)?.find(c => !(c.file === p.file && c.line.n === p.line.n))
    if (!n) continue
    contra++
    push({ id: 'contradiction-candidate', severity: 'info', file: p.file, line: p.line.n, quote: quote(p.text), message: `May contradict ${n.file}:${n.line.n} ("${quote(n.text)}"): one says to ${p.subj}, the other not to. A candidate, not a verdict.`, fix: 'Read both lines and keep the one that is true, or say when each applies.' }, p.line)
  }

  // 18. settings-invalid-json and 19. second-guard
  for (const s of inputs.settings) {
    try {
      const v = JSON.parse(s.text.replace(/^\ufeff/, ''))
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    } catch (err) {
      findings.push({ id: 'settings-invalid-json', severity: 'error', file: s.path, message: `Not a valid JSON object (${inline(String((err as Error).message ?? err), 80)}): Claude Code cannot use the settings in it.`, fix: 'Fix the JSON syntax (a missing comma or quote is the usual cause).' })
    }
  }
  const old = inputs.settings.map(s => ({ file: s.path, events: oldGuardEvents(s.text) })).filter(x => x.events.length)
  const advice = oldGuardAdvice(old)
  if (advice) findings.push({ id: 'second-guard', severity: 'error', file: old.map(o => o.file).join(', '), message: 'A second copy of the FlowKy guard is wired here: every write would be checked twice.', fix: advice })

  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
}

/** The short report the command prints. */
export function doctorReport(findings: Finding[], inputs: DoctorInputs, json = false): string {
  const shown = findings.slice(0, MAX_FINDINGS)
  // Every text that can hold a repository's file name is cleaned here (review F6).
  const safe = shown.map(f => ({ ...f, file: inline(f.file, 200), message: inline(f.message, 600), fix: inline(f.fix, 800) }))
  if (json) return JSON.stringify({ files: inputs.files.map(f => inline(f.path, 200)), findings: safe, more: Math.max(0, findings.length - shown.length), partial: inputs.partial ?? null }, null, 2)
  const count = (s: Severity) => findings.filter(f => f.severity === s).length
  const lines: string[] = []
  lines.push(`FlowKy config doctor: ${inputs.files.length} instruction file(s) and ${inputs.settings.length} settings file(s) read; ${findings.length ? `${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s)` : 'nothing to change'}. Nothing was changed.`)
  if (inputs.partial) lines.push(`PARTIAL: the doctor stopped early (${inputs.partial}); what follows covers what it read before that.`)
  for (const f of safe) {
    lines.push('')
    lines.push(`${f.severity.toUpperCase()} ${f.id}  ${f.file}${f.line ? `:${f.line}` : ''}`)
    if (f.quote) lines.push(`  > ${f.quote}`)
    lines.push(`  ${f.message}`)
    lines.push(`  Change: ${f.fix}`)
  }
  if (findings.length > shown.length) lines.push('', `... and ${findings.length - shown.length} more (the first ${MAX_FINDINGS} are shown, errors first).`)
  lines.push('', 'Ignore one line: put <!-- flowky-doctor: ignore <id> --> on the line above it. For a semantic review of contradictions, run /doctor prompt-audit.')
  return lines.join('\n')
}

/** For the daily summary at session start: only errors count. */
export function summaryLine(findings: Finding[], command: string): string | undefined {
  const errors = findings.filter(f => f.severity === 'error')
  if (!errors.length) return undefined
  return `FlowKy config doctor: ${errors.length} problem${errors.length === 1 ? '' : 's'} in your Claude configuration (${[...new Set(errors.map(e => e.id))].join(', ')}). Run ${command}.`
}
