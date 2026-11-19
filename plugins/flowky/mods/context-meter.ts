// Context size from what a hook can read. Without mods, the only source is the
// session transcript (JSONL) whose assistant rows carry the API's `usage`:
// the context a request was answered over is its uncached input plus cache
// writes plus cache reads. With mods, `session.measure` gives the same figure
// directly. Pure functions here; the drivers read the bytes.

import type { Io } from './io'
import { kilo } from './io'

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type AssistantUsage = { id?: string; model?: string; usage: Usage; isSidechain: boolean }

/** Tokens of context a request was answered over. */
export function contextTokens(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/** Assistant rows with usage in a piece of transcript (the first line may be cut: it is skipped). */
export function parseUsageRows(text: string): AssistantUsage[] {
  const rows: AssistantUsage[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let o: { type?: string; isSidechain?: boolean; isApiErrorMessage?: boolean; message?: { id?: string; model?: string; usage?: Usage } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type !== 'assistant' || o.isApiErrorMessage || !o.message?.usage) continue
    if (o.message.model === '<synthetic>') continue
    rows.push({ id: o.message.id, model: o.message.model, usage: o.message.usage, isSidechain: o.isSidechain === true })
  }
  return rows
}

/** The main thread's last measured context size, from the transcript's tail. */
export async function lastContextFromTranscript(io: Io, transcriptPath: string | undefined): Promise<number | undefined> {
  if (!transcriptPath) return undefined
  const st = await io.stat(transcriptPath)
  if (!st || st.kind !== 'file') return undefined
  const span = 512 * 1024
  const offset = Math.max(0, st.size - span)
  const tail = await io.readRange(transcriptPath, offset, st.size - offset)
  if (!tail) return undefined
  const rows = parseUsageRows(tail).filter(r => !r.isSidechain)
  const last = rows[rows.length - 1]
  return last ? contextTokens(last.usage) : undefined
}

export type HintState = { warnedAt?: number; lastTokens?: number }

/**
 * Whether to show the hint now: once when the context crosses the threshold,
 * and again only after it fell below 80 % of it (a /compact or /clear).
 */
export function nextHint(state: HintState, tokens: number, threshold: number): { show: boolean; state: HintState } {
  const rearmed = state.warnedAt !== undefined && tokens < threshold * 0.8 ? { ...state, warnedAt: undefined } : state
  if (tokens >= threshold && rearmed.warnedAt === undefined) {
    return { show: true, state: { ...rearmed, warnedAt: tokens, lastTokens: tokens } }
  }
  return { show: false, state: { ...rearmed, lastTokens: tokens } }
}

export function hintText(tokens: number, threshold: number, command: string): string {
  return (
    `Context is at ${kilo(tokens)} tokens (hint threshold ${kilo(threshold)}). Every request re-sends it. ` +
    `Run ${command} for a clean technical summary, then /compact or /clear and paste it back.`
  )
}

/** The request the handoff command puts in the prompt box. */
export const HANDOFF_REQUEST = [
  'Write a clean technical handoff of this session so I can compact or restart without losing anything.',
  'Use exactly these headings, short bullet points, no prose:',
  '1. Goal (one line)',
  '2. Decisions taken (with the reason for each)',
  '3. Files touched (path: what changed)',
  '4. Open items and known problems (commands that still fail, with the error)',
  '5. Next step (the very next action, concrete)',
  'Save the same text to .flowky/cache/handoff.md (overwrite it), then show it to me.',
].join('\n')
