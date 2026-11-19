// Stop: measure the main conversation's context from the transcript's last
// usage row and, past the threshold, show the user one hint (systemMessage).
// It never blocks the stop, never submits anything and adds nothing to
// Claude's context. Time budget: one tail read of at most 512 KB (~10 ms).

import type { Io } from '../mods/io'
import { loadConfig } from '../mods/config'
import { hintText, lastContextFromTranscript, nextHint } from '../mods/context-meter'
import type { HintState } from '../mods/context-meter'
import { readState, sessionKey, updateState } from '../mods/state'
import type { LiteStatus } from '../mods/state'
import type { HookInput, HookOutput } from './session-start'
import { projectRoot } from './session-start'

/** `command`: the plugin's own handoff skill (`/flowky:handoff` or `/flowky-pro:handoff`), named in the hint. */
export async function onStopContext(io: Io, input: HookInput, command: string): Promise<HookOutput> {
  const root = projectRoot(io, input)
  const { config } = await loadConfig(io, root)
  if (!config.context.enabled) return undefined
  const tokens = await lastContextFromTranscript(io, input.transcript_path)
  if (tokens === undefined) return undefined
  const key = sessionKey(input.session_id)
  const session = await readState<HintState>(io, root, key, {})
  const { show, state } = nextHint(session, tokens, config.context.thresholdTokens)
  await updateState<HintState>(io, root, key, {}, s => {
    s.warnedAt = state.warnedAt
    s.lastTokens = state.lastTokens
  })
  const now = await io.now()
  await updateState<LiteStatus>(io, root, 'status', {}, status => {
    status.context = { at: now, tokens, source: 'transcript usage (Stop hook)', hinted: show || session.warnedAt !== undefined }
    status.lastHook = { at: now, event: 'Stop' }
  })
  return show ? { systemMessage: `FlowKy: ${hintText(tokens, config.context.thresholdTokens, command)}` } : undefined
}
