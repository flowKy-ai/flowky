// The one-time move from the plugin's former name (Autopilot 0.2.x) to FlowKy 0.3.0.
//
// This file and the health check are the only places that name the old
// folders: they must, to find them. Nothing here deletes anything: the old
// folders stay where they are, and the health check lists them as "old
// Autopilot state, safe to delete" so the user decides.
//
// Project state (`.claude/autopilot/` -> `.flowky/cache/`), at the first
// SessionStart after the upgrade:
//   - copied only through the safe writer (writeStateText: inside the project,
//     no link on the way, temporary file and rename, the cache's own
//     .gitignore with "*" written first);
//   - only top-level JSON files that carry this machine's stamp (the same
//     check every state read makes: `__stamp`, or `machine` for the Auto-Skill
//     Engine files). The free plugin configures no stamp, so it trusts none of
//     the old files and copies nothing: its old state was display-only and is
//     rebuilt at once. FlowKy Pro copies what its machine id vouches for;
//   - never a link: an old `.claude` or `.claude/autopilot` that is a symbolic
//     link or a junction is not followed, and a linked file is skipped;
//   - never over a file that already exists in `.flowky/cache/`;
//   - not carried over: snapshots (their copies and git refs belong to the old
//     name; 0.2.x kept the same rule for 0.2.0 snapshots), the map (rebuilt),
//     the handoff (written by the assistant, never trusted), the Auto-Skill
//     digest and answer (tied to a nonce of the old session), locks.
//   A record is kept in `.flowky/cache/migration.json`. A run made without a
//   stamp (the free plugin) is repeated once by FlowKy Pro, which can check one.
//
// Consents (FlowKy Pro): `<Claude folder>/autopilot-pro/consent.json` ->
// `~/.flowky/consent.json`, done by mods/engine-state.ts (readConsent), which
// uses readOldConsent below: read only, with the same trust rules as 0.2.2 (an
// absolute Claude folder outside the project, no link), the same shape check
// (a machine id of 16 or more hex digits, a projects object), and verify
// consents without per-kind checks dropped, as 0.2.2 already ignored them.

import type { Io } from './io'
import { join, readJson, readSafe } from './io'
import { trustedClaudeDir } from './home'
import { currentStamp, stampConfigured, stateDir, writeStateText } from './state'

/** The former project state folder. */
export const OLD_STATE_DIR = '.claude/autopilot'
/** The former project config files: no longer read. The user moves their content by hand (the plugin never writes outside .flowky/cache/). */
export const OLD_CONFIG_FILES: Record<string, string> = {
  '.claude/autopilot.json': '.flowky/config.json',
  '.claude/autopilot-policy.json': '.flowky/policy.json',
  '.claude/autopilot-prices.json': '.flowky/prices.json',
}
/** The former consent folder, below the user's Claude folder. */
export const OLD_CONSENT_DIR = 'autopilot-pro'
/** The record of the move, in .flowky/cache/. */
export const MIGRATION_FILE = 'migration.json'

const NOT_CARRIED: Record<string, string> = {
  'status.json': 'display only, rebuilt at once',
  'migration.json': 'the record of this move',
  'snapshots.json': 'snapshots are not carried over',
  'skills-digest.json': 'tied to an old session',
  'skills-distilled.json': 'tied to an old session',
  'project-map.md': 'rebuilt at every session start',
  'handoff.md': 'written by the assistant, never trusted',
}
const MAX_BYTES = 4 * 1024 * 1024

export type MigrationRecord = {
  version: 1
  at: number
  /** Whether old project state was found. */
  found: boolean
  /** Whether a stamp could be checked (false: nothing could be trusted, so nothing was copied). */
  stamped: boolean
  copied: string[]
  skipped: { name: string; why: string }[]
  refused?: string
}

export async function readMigration(io: Io, root: string): Promise<MigrationRecord | undefined> {
  const { value } = await readJson<MigrationRecord>(io, join(stateDir(io, root), MIGRATION_FILE), { root })
  return value && typeof value === 'object' && value.version === 1 ? value : undefined
}

const isLink = async (io: Io, path: string): Promise<boolean> => (io.isLink ? io.isLink(path).catch(() => true) : Promise.resolve(false))

/**
 * Copies the old project state once (see the header). Returns the record when this call did the
 * move, undefined when it had already been done. Never throws.
 */
export async function migrateProjectState(io: Io, root: string): Promise<MigrationRecord | undefined> {
  try {
    const before = await readMigration(io, root)
    const canStamp = stampConfigured()
    // Done before; a run that could not check a stamp is repeated once by a plugin that can.
    if (before && (before.stamped || !canStamp || !before.found)) return undefined
    const record: MigrationRecord = { version: 1, at: await io.now(), found: false, stamped: false, copied: [], skipped: [] }
    const claudeDir = join(root, '.claude')
    const old = join(root, OLD_STATE_DIR)
    if ((await isLink(io, claudeDir)) || (await isLink(io, old))) {
      record.found = true
      record.refused = `${(await isLink(io, claudeDir)) ? '.claude' : OLD_STATE_DIR} is a symbolic link or a junction: not followed, nothing copied`
    } else if ((await io.stat(old))?.kind === 'dir') {
      record.found = true
      const stamp = await currentStamp(io, root)
      record.stamped = stamp !== undefined
      const entries = await io.list(old).catch(() => [])
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const e of entries) {
        const skip = (why: string) => record.skipped.push({ name: e.name, why })
        if (e.name === '.gitignore' || e.name.endsWith('.lock') || e.name.includes('.tmp-')) continue
        if (NOT_CARRIED[e.name]) {
          skip(NOT_CARRIED[e.name]!)
          continue
        }
        if (e.kind === 'dir') {
          skip(e.name === 'snapshots' ? NOT_CARRIED['snapshots.json']! : 'a folder: not carried over')
          continue
        }
        if (e.kind !== 'file') {
          skip('a link or a special file: not followed')
          continue
        }
        if (!/^[A-Za-z0-9._-]+\.json$/.test(e.name)) {
          skip('not a state file')
          continue
        }
        const from = join(old, e.name)
        if (await isLink(io, from)) {
          skip('a link: not followed')
          continue
        }
        if (e.size > MAX_BYTES) {
          skip('too large')
          continue
        }
        if ((await io.stat(join(stateDir(io, root), e.name))) !== undefined) {
          skip('already present in .flowky/cache/')
          continue
        }
        if (!stamp) {
          skip('no stamp to check it against: not trusted')
          continue
        }
        const text = await readSafe(io, from, { maxBytes: 4 * 1024 * 1024, root })
        let value: unknown
        try {
          value = text === undefined ? undefined : JSON.parse(text)
        } catch {
          value = undefined
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          skip('not valid JSON')
          continue
        }
        const v = value as { __stamp?: unknown; machine?: unknown }
        if (v.__stamp !== stamp && v.machine !== stamp) {
          skip('not stamped by this machine: not trusted')
          continue
        }
        try {
          await writeStateText(io, root, e.name, text!)
          record.copied.push(e.name)
        } catch (err) {
          skip(`refused by the safe writer (${String(err).slice(0, 120)})`)
        }
      }
    }
    await writeStateText(io, root, MIGRATION_FILE, JSON.stringify(record, null, 2) + '\n')
    return record
  } catch {
    return undefined
  }
}

export type OldConsent = { machine: string; projects: Record<string, Record<string, unknown>> }

/** The 0.2.x consent file, read only and validated (see the header); undefined when absent, linked, untrusted or malformed. */
export async function readOldConsent(io: Io, root?: string): Promise<OldConsent | undefined> {
  const dir = trustedClaudeDir(io, root)
  if (!dir) return undefined
  const folder = join(dir, OLD_CONSENT_DIR)
  const file = join(folder, 'consent.json')
  if ((await isLink(io, folder)) || (await isLink(io, file))) return undefined
  const { value } = await readJson<{ machine?: unknown; projects?: unknown }>(io, file)
  if (!value || typeof value !== 'object' || typeof value.machine !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.machine)) return undefined
  const projects: OldConsent['projects'] = {}
  const raw = value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects) ? (value.projects as Record<string, unknown>) : {}
  for (const [key, entry] of Object.entries(raw)) {
    if (!/^[0-9a-f]{16}$/.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const kept: Record<string, unknown> = { ...(entry as Record<string, unknown>) }
    // 0.2.2 already ignored verify consents without per-kind checks (0.2.1 ones): they are not carried over.
    const verify = kept.verify as { checks?: unknown } | undefined
    if (verify !== undefined && (!verify || typeof verify !== 'object' || !verify.checks || typeof verify.checks !== 'object' || Array.isArray(verify.checks))) delete kept.verify
    projects[key] = kept
  }
  return { machine: value.machine, projects }
}

export type OldStateItem = { path: string; what: string }

/** What the former name left behind, for the health check ("old Autopilot state, safe to delete"). */
export async function oldStateItems(io: Io, root: string): Promise<OldStateItem[]> {
  const items: OldStateItem[] = []
  const old = join(root, OLD_STATE_DIR)
  if ((await isLink(io, old)) || (await io.stat(old)) !== undefined) items.push({ path: `${OLD_STATE_DIR}/`, what: 'old Autopilot state, safe to delete' })
  for (const [from, to] of Object.entries(OLD_CONFIG_FILES)) {
    if ((await io.stat(join(root, from)))?.kind === 'file') items.push({ path: from, what: `old Autopilot config, no longer read: move what you need to ${to}, then delete it` })
  }
  const claude = trustedClaudeDir(io, root)
  if (claude) {
    const dir = join(claude, OLD_CONSENT_DIR)
    if ((await isLink(io, dir)) || (await io.stat(dir)) !== undefined) items.push({ path: dir, what: 'old Autopilot consents, safe to delete once FlowKy Pro has copied them (or if you never used Pro)' })
  }
  return items
}
