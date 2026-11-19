// The parts of the health check that FlowKy and FlowKy Pro print the same way.

import type { Io } from '../mods/io'
import { join, readJson } from '../mods/io'
import { trustedClaudeDir } from '../mods/home'
import { oldStateItems, readMigration } from '../mods/migrate'

/** The independence notice: every README, every plugin.json description and the health check carry it. */
export const INDEPENDENCE =
  'FlowKy is an independent product. It is not affiliated with, endorsed or sponsored by Anthropic, or by the makers of the other tools named here. Claude and Claude Code are trademarks of Anthropic, PBC.'

/** The catalogue both plugins are listed in, and their names in it. */
export const CATALOGUE = 'flowky'
export const FREE_PLUGIN = 'flowky'
export const PRO_PLUGIN = 'flowky-pro'

type Enabled = Record<string, boolean>

async function enabledIn(io: Io, path: string): Promise<Enabled> {
  const { value } = await readJson<{ enabledPlugins?: unknown }>(io, path)
  const raw = value && typeof value === 'object' ? value.enabledPlugins : undefined
  const out: Enabled = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === 'boolean') out[k] = v
  return out
}

/**
 * Whether both FlowKy plugins are enabled for this project, read from the Claude Code settings files
 * (user, then project, then local; a later file wins). FlowKy Pro contains everything FlowKy does,
 * so running both doubles every hook. Read only; undefined when nothing says both.
 */
export async function bothEnabledLine(io: Io, root: string): Promise<string | undefined> {
  const files: string[] = []
  const claude = trustedClaudeDir(io, root)
  if (claude) files.push(join(claude, 'settings.json'))
  files.push(join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json'))
  const merged: Enabled = {}
  for (const f of files) Object.assign(merged, await enabledIn(io, f).catch(() => ({})))
  const free = merged[`${FREE_PLUGIN}@${CATALOGUE}`] === true
  const pro = merged[`${PRO_PLUGIN}@${CATALOGUE}`] === true
  if (!free || !pro) return undefined
  return `WARNING: both ${FREE_PLUGIN} and ${PRO_PLUGIN} are enabled. FlowKy Pro already contains everything FlowKy does, so every hook runs twice. Disable one: /plugin disable ${FREE_PLUGIN}@${CATALOGUE}`
}

/** The lines about the move from the former name: what was copied, and what is left to delete. */
export async function migrationLines(io: Io, root: string): Promise<string[]> {
  const lines: string[] = []
  const record = await readMigration(io, root)
  if (record?.found) {
    const what = record.refused
      ? `refused (${record.refused})`
      : `${record.copied.length} state file(s) copied to .flowky/cache/${record.stamped ? '' : ' (no machine stamp to check old files against, so none was trusted)'}${record.skipped.length ? `, ${record.skipped.length} left behind` : ''}`
    lines.push(`Move from the former name (Autopilot 0.2.x): ${what}`)
  }
  const items = await oldStateItems(io, root).catch(() => [])
  for (const item of items) lines.push(`  ${item.path}: ${item.what}`)
  return lines
}
