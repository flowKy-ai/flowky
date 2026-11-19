// .flowky/config.json: every setting has a default, so the file is optional.
// A broken file never breaks a session: the defaults apply and the health check
// says why. The plugin only reads this file; the user writes and commits it.

import type { Io } from './io'
import { join, readJson } from './io'
import { CONFIG_PATH } from './paths'

export type LiteConfig = {
  map: {
    enabled: boolean
    /** Wall-clock budget of the scan, in milliseconds. */
    timeBudgetMs: number
    /** Stop after this many files. */
    maxFiles: number
    /** Add the map to Claude's context at session start (SessionStart additionalContext). */
    addToContext: boolean
  }
  context: {
    enabled: boolean
    /** Show the hint once the context holds this many tokens. */
    thresholdTokens: number
    /** /flowky handoff submits the summary request itself instead of filling the prompt box (mods layer only). */
    autoSubmit: boolean
  }
}

export const DEFAULT_CONFIG: LiteConfig = {
  map: { enabled: true, timeBudgetMs: 1500, maxFiles: 20000, addToContext: true },
  context: { enabled: true, thresholdTokens: 60000, autoSubmit: false },
}

export { CONFIG_PATH }

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function section(raw: unknown, key: string): Record<string, unknown> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
  return o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
}

/** Merges a parsed file over the defaults, clamping every number to a sane range. */
export function normalizeConfig(raw: unknown): LiteConfig {
  const m = section(raw, 'map')
  const c = section(raw, 'context')
  const d = DEFAULT_CONFIG
  return {
    map: {
      enabled: bool(m.enabled, d.map.enabled),
      timeBudgetMs: num(m.timeBudgetMs, d.map.timeBudgetMs, 100, 10000),
      maxFiles: num(m.maxFiles, d.map.maxFiles, 100, 500000),
      addToContext: bool(m.addToContext, d.map.addToContext),
    },
    context: {
      enabled: bool(c.enabled, d.context.enabled),
      thresholdTokens: num(c.thresholdTokens, d.context.thresholdTokens, 5000, 2000000),
      autoSubmit: bool(c.autoSubmit, d.context.autoSubmit),
    },
  }
}

export async function loadConfig(io: Io, root: string): Promise<{ config: LiteConfig; error?: string; found: boolean }> {
  const { value, error } = await readJson<unknown>(io, join(root, CONFIG_PATH), { maxBytes: 256 * 1024, root })
  return { config: normalizeConfig(value), error, found: value !== undefined || error !== undefined }
}
